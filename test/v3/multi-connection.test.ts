/**
 * Multi-connection behavior (feat/layer1-multi-connection).
 *
 * Before this change, the native registry was a single slot: a second Session to
 * the SAME path refcount-collapsed onto one shared connection, and a different
 * path was rejected. Now each Session owns an independent connection to the one
 * process-wide EmbeddedServer, so same-path sessions coexist, run queries in
 * PARALLEL, and never clobber each other's parameter state — while a *different*
 * data directory is still rejected. This mirrors the chdb-python model (multiple
 * Connection objects to the same path running in parallel) verified empirically.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as os from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chdb = require('../../index.js')
const { Session, createClient } = chdb

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
      expect(() => new Session(d2)).toThrow(chdb.ChdbConnectionError)
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

describe('multi-connection: concurrent execution', () => {
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

  // True parallel SPEEDUP: each Session owns an independent connection, so K
  // single-threaded queries run concurrently instead of serializing on one shared
  // connection's mutex (the pre-multi-connection behavior). Lenient threshold +
  // multi-core guard for non-flakiness; the measured speedup is ~3-4x on 4 cores.
  it.skipIf((os.cpus()?.length ?? 1) < 4)(
    'concurrent same-path queries are faster than serial',
    async () => {
      const dir = tmpPath(); dirs.push(dir)
      const solo = new Session(dir)
      const t0 = performance.now()
      for (let i = 0; i < K; i++) await solo.queryAsync(HEAVY, { format: 'CSV' })
      const serial = performance.now() - t0
      solo.close()

      const sessions = Array.from({ length: K }, () => new Session(dir))
      const t1 = performance.now()
      await Promise.all(sessions.map((s) => s.queryAsync(HEAVY, { format: 'CSV' })))
      const concurrent = performance.now() - t1
      for (const s of sessions) s.close()

      expect(concurrent).toBeLessThan(serial * 0.7)
    },
    30000,
  )
})

describe('multi-connection: Layer 2 clients run in parallel and share memory', () => {
  it('two chdb://memory clients share state and both execute', async () => {
    const a = createClient({ url: 'chdb://memory' })
    const b = createClient({ url: 'chdb://memory' })
    try {
      await a.command({ query: 'CREATE TABLE l2shared (x Int64) ENGINE = MergeTree ORDER BY x' })
      await a.insert({ table: 'l2shared', values: [{ x: 1 }, { x: 2 }], format: 'JSONEachRow' })
      // b is a distinct connection over the shared memory dir → sees a's table.
      const rs = await b.query({ query: 'SELECT sum(x) AS s FROM l2shared', format: 'JSONEachRow' })
      const rows = (await rs.json()) as Array<{ s: string }>
      expect(Number(rows[0]!.s)).toBe(3)
    } finally {
      await a.close(); await b.close()
    }
  })

  it('concurrent queries across two memory clients all resolve correctly', async () => {
    const a = createClient({ url: 'chdb://memory' })
    const b = createClient({ url: 'chdb://memory' })
    try {
      const results = await Promise.all([
        a.query({ query: 'SELECT {n:Int64} AS n', query_params: { n: 11 }, format: 'JSONEachRow' }),
        b.query({ query: 'SELECT {n:Int64} AS n', query_params: { n: 22 }, format: 'JSONEachRow' }),
        a.query({ query: 'SELECT {n:Int64} AS n', query_params: { n: 33 }, format: 'JSONEachRow' }),
        b.query({ query: 'SELECT {n:Int64} AS n', query_params: { n: 44 }, format: 'JSONEachRow' }),
      ])
      const vals = await Promise.all(results.map(async (rs) => {
        const rows = (await rs.json()) as Array<{ n: string }>
        return Number(rows[0]!.n)
      }))
      expect(vals).toEqual([11, 22, 33, 44])
    } finally {
      await a.close(); await b.close()
    }
  })
})
