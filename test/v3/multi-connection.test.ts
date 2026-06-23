/**
 * Multi-connection behavior (feat/layer1-multi-connection).
 *
 * Before this change, the native registry was a single slot: a second Session to
 * the SAME path refcount-collapsed onto one shared connection, and a different
 * path was rejected. Now each Session owns an independent connection to the one
 * process-wide EmbeddedServer, so same-path sessions coexist and run
 * non-parameterized queries in PARALLEL, while a *different* data directory is
 * still rejected. Parameterized queries are serialized process-wide (the bundled
 * libchdb does not isolate parameter state per connection under true
 * parallelism). This mirrors the chdb-python model (multiple Connection objects
 * to the same path) verified empirically.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as os from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chdb = require('../../index.js')
const { Session } = chdb

function tmpPath(): string {
  return mkdtempSync(join(os.tmpdir(), 'chdb-mc-test-'))
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('multi-connection: same-path coexistence', () => {
  it('opens N Sessions to the SAME path simultaneously (previously rejected)', () => {
    const dir = tmpPath(); dirs.push(dir)
    const sessions = Array.from({ length: 4 }, () => new Session(dir))
    try {
      for (const s of sessions) {
        expect(s.open).toBe(true)
        expect(s.query('SELECT 1', 'CSV').trim()).toBe('1')
      }
    } finally {
      for (const s of sessions) s.close()
    }
  })

  it('shares data across distinct same-path connections', () => {
    const dir = tmpPath(); dirs.push(dir)
    const a = new Session(dir)
    const b = new Session(dir)
    try {
      a.query('CREATE TABLE shared (x Int64) ENGINE = MergeTree ORDER BY x', 'CSV')
      a.query('INSERT INTO shared VALUES (7)', 'CSV')
      // b is a SEPARATE connection but the same EmbeddedServer → sees the table.
      expect(b.query('EXISTS TABLE shared', 'CSV').trim()).toBe('1')
      expect(b.query('SELECT sum(x) FROM shared', 'CSV').trim()).toBe('7')
    } finally {
      a.close(); b.close()
    }
  })

  it('still rejects a DIFFERENT data directory while one is live', () => {
    const d1 = tmpPath(); dirs.push(d1)
    const d2 = tmpPath(); dirs.push(d2)
    const a = new Session(d1)
    try {
      // Assert on the stable .name/.code contract — the Layer 1 entrypoint does
      // not re-export the error class itself (matches registry.test.ts:54).
      let thrown: unknown
      try { new Session(d2) } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).name).toBe('ChdbConnectionError')
      expect((thrown as { code?: string }).code).toBe('CHDB_CONNECTION')
    } finally {
      a.close()
    }
    // After the first is closed, a different path binds fine (server unbinds).
    const b = new Session(d2)
    expect(b.query('SELECT 1', 'CSV').trim()).toBe('1')
    b.close()
  })
})

describe('multi-connection: parameterized queries under concurrency are correct', () => {
  // Fired concurrently across distinct same-path connections. The bundled
  // libchdb does not isolate parameter set/reset per connection under true
  // parallelism, so index.js serializes ALL parameterized queries through one
  // process-wide chain; this asserts no value is ever clobbered (code 456) and
  // the engine is never corrupted, whatever the interleaving.
  it('never clobbers parameters across concurrent same-path connections', async () => {
    const dir = tmpPath(); dirs.push(dir)
    const N = 8
    const ITERS = 60
    const sessions = Array.from({ length: N }, () => new Session(dir))
    try {
      const workers = sessions.map((s, tid) =>
        (async () => {
          for (let i = 0; i < ITERS; i++) {
            const x = tid * 1_000_000 + i
            const y = 7 * x + 13
            const r = await s.queryBindAsync(
              'SELECT {a:Int64} AS a, {b:Int64} AS b',
              { a: String(x), b: String(y) },
              { format: 'CSV' },
            )
            const [gotA, gotB] = r.text().trim().split(',').map((v: string) => Number(v))
            expect(gotA).toBe(x)
            expect(gotB).toBe(y)
          }
        })(),
      )
      await Promise.all(workers)
    } finally {
      for (const s of sessions) s.close()
    }
  })
})

describe('multi-connection: concurrent execution is correct', () => {
  // Real parallel SPEEDUP measurements live out of the default suite: CI installs
  // the PUBLISHED @chdb/lib-* prebuilt (still the old single-connection registry),
  // and the loader prefers it over build/Release, so no wall-clock speedup is
  // observable in CI until those platform packages are republished from this
  // source. The deterministic correctness check below is what gates the model.
  const HEAVY = 'SELECT sum(sipHash64(number)) FROM numbers(20000000) SETTINGS max_threads = 1'
  const K = 4

  it('runs K concurrent same-path queries and all return the correct result', async () => {
    const dir = tmpPath(); dirs.push(dir)
    const sessions = Array.from({ length: K }, () => new Session(dir))
    try {
      const expected = (await sessions[0].queryAsync(HEAVY, { format: 'CSV' })).text().trim()
      const results = await Promise.all(
        sessions.map((s) => s.queryAsync(HEAVY, { format: 'CSV' }).then((r: { text(): string }) => r.text().trim())),
      )
      for (const r of results) expect(r).toBe(expected)
    } finally {
      for (const s of sessions) s.close()
    }
  })
})

describe('multi-connection: parameter chain cancellation pre-check', () => {
  // Param queries are serialized through a single process-wide chain. A request
  // whose AbortSignal fires WHILE it is still waiting its turn behind earlier
  // queries must not dispatch the native call when it finally reaches the head —
  // the caller already observed CHDB_ABORT, and silently running queued DDL/DML
  // afterwards would be a surprising side effect (the review-flagged behavior).
  it('does not dispatch a queued param query whose AbortSignal already fired', async () => {
    const dir = tmpPath(); dirs.push(dir)
    const s = new Session(dir)
    try {
      const HEAVY_PARAM = 'SELECT count() FROM numbers({n:UInt64}) WHERE sipHash64(number) % 2 = 0 SETTINGS max_threads = 1'
      const head = s.queryBindAsync(HEAVY_PARAM, { n: '50000000' }, { format: 'CSV' })
      const ctrls = Array.from({ length: 3 }, () => new AbortController())
      const queued = ctrls.map((c, i) =>
        s.queryBindAsync('SELECT {x:Int64}', { x: String(i + 1) }, { format: 'CSV', signal: c.signal }))
      for (const c of ctrls) c.abort()
      const settled = await Promise.allSettled(queued)
      for (const r of settled) {
        expect(r.status).toBe('rejected')
        const e = (r as PromiseRejectedResult).reason
        // ChdbAbortError sets .name to 'AbortError' (web AbortController parity);
        // .code is the stable cross-class contract.
        expect((e as { code?: string }).code).toBe('CHDB_ABORT')
      }
      await head
      const tail = await s.queryBindAsync('SELECT {x:Int64}', { x: '42' }, { format: 'CSV' })
      expect(tail.text().trim()).toBe('42')
    } finally {
      s.close()
    }
  })
})

