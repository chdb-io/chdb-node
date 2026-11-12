import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { Binary, Dictionary, Int32, Table, Utf8, vectorFromArray } from 'apache-arrow'
import { registerArrowReader, registerArrowSource, Session, drainPending } from '../../../index.js'

function batch(values: number[]) {
  return new Table({ x: vectorFromArray(values, new Int32()) }).batches[0]!
}

describe('registerArrowReader — bounded C Stream input', () => {
  // chdb-core#321/#323: rc.3 must release the registration schema exactly
  // once; this regression gate is no longer conditional on the engine version.
  it(
    'releases the schema returned during C Stream registration', async () => {
      const native = require('../../../build/Release/chdb_node.node') as {
        ArrowLifetimeStats(): { schemaReleased: number }
      }
      const session = new Session()
      const before = native.ArrowLifetimeStats().schemaReleased
      const source = await registerArrowReader([batch([1])], { session })
      try {
        expect(native.ArrowLifetimeStats().schemaReleased - before).toBeGreaterThanOrEqual(1)
      } finally {
        await source.close()
        session.close()
      }
    },
  )

  it('is one-shot and releases its TSFN so a child process exits naturally', () => {
    const script = `
      const a = require('apache-arrow'), m = require('./index.js');
      (async () => {
        const s = new m.Session();
        const batch = new a.Table({x: a.vectorFromArray([1], new a.Int32())}).batches[0];
        const h = await m.registerArrowReader([batch], {session:s});
        try {
          const sql = "SELECT x FROM arrowstream('" + h.name + "')";
          const one = await s.queryAsync(sql, {format:'CSV'});
          const two = await s.queryAsync(sql, {format:'CSV'});
          if (one.text().trim() !== '1' || two.text().trim() !== '') throw Error('reader replayed');
        } finally { await h.close(); s.close(); await m.drainPending(); }
        console.log('done');
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toContain('done')
  })

  it('runs one C Data release callback for each delivered batch', async () => {
    const native = require('../../../build/Release/chdb_node.node') as {
      ArrowLifetimeStats(): { delivered: number; released: number }
    }
    const session = new Session()
    async function* batches() {
      for (let i = 0; i < 12; i++) yield batch([i])
    }
    const before = native.ArrowLifetimeStats()
    const source = await registerArrowReader(batches(), { session })
    try {
      const result = await session.queryAsync(
        `SELECT sum(x) FROM arrowstream('${source.name}')`, { format: 'CSV' },
      )
      expect(result.text().trim()).toBe('66')
      await source.producerDone
    } finally {
      await source.close()
      session.close()
      await drainPending()
    }
    for (let i = 0; i < 50; i++) {
      const state = native.ArrowLifetimeStats()
      if (state.released - before.released === 12) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const after = native.ArrowLifetimeStats()
    expect(after.delivered - before.delivered).toBe(12)
    expect(after.released - before.released).toBe(12)
  })

  it('consumes async RecordBatches in a single SQL query without IPC', async () => {
    const session = new Session()
    async function* batches() {
      yield batch([1, 2])
      yield batch([3, 4])
      yield batch([5])
    }
    const source = await registerArrowReader(batches(), { session })
    try {
      const result = await session.queryAsync(
        `SELECT x FROM arrowstream('${source.name}') ORDER BY x`, { format: 'JSONEachRow' },
      )
      expect(result.text().trim().split('\n').map((line) => JSON.parse(line).x)).toEqual([1, 2, 3, 4, 5])
      await source.producerDone
    } finally {
      await source.close()
      session.close()
      await drainPending()
    }
  })

  it('bounds prefetched batches even when the engine retains earlier arrays', async () => {
    const session = new Session()
    let produced = 0
    async function* batches() {
      for (let i = 0; i < 40; i++) {
        produced++
        yield batch([i])
      }
    }
    const source = await registerArrowReader(batches(), { session })
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(produced).toBeLessThanOrEqual(4) // schema + two queued + one pending push
      const result = await session.queryAsync(
        `SELECT sum(x) FROM arrowstream('${source.name}') ORDER BY sum(x)`, { format: 'CSV' },
      )
      expect(result.text().trim()).toBe('780')
      await source.producerDone
      expect(produced).toBe(40)
    } finally {
      await source.close()
      session.close()
      await drainPending()
    }
  })

  it('uses an empty reader schema and propagates producer failures', async () => {
    const session = new Session()
    const schema = batch([]).schema
    const empty = await registerArrowReader({
      schema,
      async *[Symbol.asyncIterator]() {},
    }, { session })
    try {
      const count = await session.queryAsync(
        `SELECT count() FROM arrowstream('${empty.name}')`, { format: 'CSV' },
      )
      expect(count.text().trim()).toBe('0')
    } finally {
      await empty.close()
    }
    async function* broken() {
      yield batch([1])
      throw new Error('producer failed')
    }
    const failing = await registerArrowReader(broken(), { session })
    try {
      await expect(session.queryAsync(
        `SELECT x FROM arrowstream('${failing.name}')`, { format: 'CSV' },
      )).rejects.toThrow(/producer failed/)
      await expect(failing.producerDone).rejects.toThrow(/producer failed/)
    } finally {
      await failing.close()
      session.close()
      await drainPending()
    }
  })

  it('registers an empty reader with a supported dictionary schema', async () => {
    const session = new Session()
    const schema = new Table({ s: vectorFromArray(['a'], new Dictionary(new Utf8(), new Int32())) }).schema
    const source = await registerArrowReader({ schema, async *[Symbol.asyncIterator]() {} }, { session })
    try {
      const result = await session.queryAsync(`SELECT count() FROM arrowstream('${source.name}')`, { format: 'CSV' })
      expect(result.text().trim()).toBe('0')
    } finally { await source.close(); session.close(); await drainPending() }
  })

  it('unblocks SQL when a producer rejects with null', async () => {
    const session = new Session()
    async function* broken() { yield batch([1]); throw null }
    const source = await registerArrowReader(broken(), { session })
    try {
      await expect(session.queryAsync(`SELECT x FROM arrowstream('${source.name}')`, { format: 'CSV' }))
        .rejects.toThrow(/null/)
      await expect(source.producerDone).rejects.toBeNull()
    } finally { await source.close(); session.close(); await drainPending() }
  })

  it('rejects a dictionary-to-plain schema change in a reader and materialized batches', async () => {
    const session = new Session()
    const dictionary = new Table({ x: vectorFromArray(['a'], new Dictionary(new Utf8(), new Int32())) }).batches[0]!
    const plain = batch([1]) // same field and Int32 index format, but no dictionary
    const differentValues = new Table({
      x: vectorFromArray([new Uint8Array([65])], new Dictionary(new Binary(), new Int32())),
    }).batches[0]!
    expect(() => registerArrowSource({ batches: [dictionary, plain] } as Table, { session }))
      .toThrow(/schemas must match/)
    expect(() => registerArrowSource({ batches: [dictionary, differentValues] } as Table, { session }))
      .toThrow(/schemas must match/)
    const source = await registerArrowReader([dictionary, plain], { session })
    try {
      await expect(session.queryAsync(`SELECT x FROM arrowstream('${source.name}')`, { format: 'CSV' }))
        .rejects.toThrow(/schema changed/)
      await expect(source.producerDone).rejects.toThrow(/schema changed/)
    } finally { await source.close(); session.close(); await drainPending() }
  })

  it('rejects synchronous SQL before a JS producer can deadlock the event loop', () => {
    const script = `
      const a = require('apache-arrow'), m = require('./index.js');
      (async () => {
        const s = new m.Session();
        const b = new a.Table({x: a.vectorFromArray([1], new a.Int32())}).batches[0];
        async function* batches() { for (let i = 0; i < 10; i++) yield b; }
        const h = await m.registerArrowReader(batches(), {session:s});
        const sql = "SELECT count() FROM arrowstream('" + h.name + "')";
        try {
          for (const run of [() => s.query(sql), () => s.queryBind(sql, {})]) {
            try { run(); throw Error('sync query unexpectedly ran'); }
            catch (e) { if (!/requires an async query/.test(e.message)) throw e; }
          }
          const result = await s.queryAsync(sql, {format:'CSV'});
          if (result.text().trim() !== '10') throw Error('async query failed');
        } finally { await h.close(); s.close(); await m.drainPending(); }
        console.log('done');
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toContain('done')
  })

  it('can stream direct Arrow output from a live async reader without blocking its producer', () => {
    const script = `
      const a = require('apache-arrow'), m = require('./index.js');
      (async () => {
        const s = new m.Session();
        const b = new a.Table({x: a.vectorFromArray([1], new a.Int32())}).batches[0];
        async function* batches() { for (let i = 0; i < 10; i++) yield b; }
        const h = await m.registerArrowReader(batches(), {session:s});
        try {
          const out = s.queryArrowStream("SELECT sum(x) AS total FROM arrowstream('" + h.name + "')");
          const rows = [];
          for await (const part of out) rows.push(...part.toArray());
          if (rows[0].total !== 10n) throw Error('wrong result: ' + String(rows[0].total));
        } finally { await h.close(); s.close(); await m.drainPending(); }
        console.log('done');
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toContain('done')
  })

  it('rejects a changed schema and cleans up after cancellation', async () => {
    const session = new Session()
    async function* changed() {
      yield batch([1])
      yield new Table({ y: vectorFromArray([2], new Int32()) }).batches[0]!
    }
    const invalid = await registerArrowReader(changed(), { session })
    try {
      await expect(session.queryAsync(
        `SELECT x FROM arrowstream('${invalid.name}')`, { format: 'CSV' },
      )).rejects.toThrow(/schema changed/)
      await expect(invalid.producerDone).rejects.toThrow(/schema changed/)
    } finally {
      await invalid.close()
    }

    async function* slow() {
      yield batch([1])
      await new Promise((resolve) => setTimeout(resolve, 50))
      yield batch([2])
    }
    const cancelled = await registerArrowReader(slow(), { session })
    try {
      const query = session.queryAsync(
        `SELECT sum(x) FROM arrowstream('${cancelled.name}')`, { format: 'CSV' },
      )
      const rejection = expect(query).rejects.toThrow(/Arrow reader cancelled/)
      await cancelled.close()
      await rejection
      await drainPending()
      const healthy = await session.queryAsync('SELECT 7', { format: 'CSV' })
      expect(healthy.text().trim()).toBe('7')
    } finally {
      await cancelled.close()
      session.close()
      await drainPending()
    }
  })

  it('does not wait for a non-cooperative async producer on close', async () => {
    const session = new Session()
    async function* stuck() {
      yield batch([1])
      await new Promise<void>(() => {})
    }
    const source = await registerArrowReader(stuck(), { session })
    try {
      const query = session.queryAsync(
        `SELECT sum(x) FROM arrowstream('${source.name}')`, { format: 'CSV' },
      )
      const rejected = expect(query).rejects.toThrow(/cancelled/)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await Promise.race([
        source.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('close hung')), 200)),
      ])
      await rejected
    } finally {
      await source.close()
      session.close()
      await drainPending()
    }
  })
})
