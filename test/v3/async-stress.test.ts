import { describe, it, expect, afterEach } from 'vitest'
import { queryAsync, queryBindAsync, Session } from '../../index.js'

// Brute-force concurrency / abort stress for the async paths, to flush out
// deadlocks, use-after-free, and leaks. Sleeps are inserted at the "landing"
// points (after abort/timeout storms) to let the background native work — which
// keeps running after an honest cancel — drain before the next phase, since the
// process shares a single libchdb connection.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const HEAVY = (n: number) => `SELECT count() FROM numbers(${n})`

// HEAVY is not heavy: the engine answers count() over numbers() from the range
// itself, so HEAVY(60_000_000) returns in about 5ms — less than the sleeps below
// it. Any case that needs a query to still be running when the next line
// executes has to force per-row work, or it tests nothing on a fast machine and
// only sometimes tests anything on a slow one. ~120ms, comfortably longer than
// the 0-3ms sleeps.
const SLOW = 'SELECT max(sipHash64(number)) FROM numbers(20000000)'

// The storm/race cases below run dozens of heavy queries in sequence and take
// ~15-30s on a fast runner. Give them a generous timeout so a slow/loaded CI
// runner never hits the 30s default and kills a test mid-flight — a test killed
// at its timeout is torn down without the global afterEach draining its in-flight
// native op, which then collides with the next test on the single in-process
// engine and aborts it (code 236), cascading failures into every later file.
// (Plain queryAsync is tracked for drain; withAbortTimeout tracks every async
// query. This comment used to claim it was not.)
const STRESS_TIMEOUT_MS = 120_000

describe('async concurrency — correctness & no deadlock', () => {
  it('runs 64 concurrent default-connection queries with no cross-contamination', async () => {
    const N = 64
    const out = await Promise.all(
      Array.from({ length: N }, (_, i) => queryAsync(`SELECT ${i} AS v`, { format: 'CSV' })),
    )
    out.forEach((r, i) => expect(r.text().trim()).toBe(String(i)))
  })

  it('runs 64 concurrent queries on one session with correct per-query results', async () => {
    const s = new Session()
    try {
      s.query('CREATE TABLE t (i UInt32) ENGINE = Memory')
      s.query('INSERT INTO t SELECT number FROM numbers(1000)')
      const N = 64
      const out = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          s.queryAsync(`SELECT count() FROM t WHERE i < ${i + 1}`, { format: 'CSV' }),
        ),
      )
      out.forEach((r, i) => expect(Number(r.text().trim())).toBe(i + 1))
    } finally {
      s.close()
    }
  })

  it('mixes concurrent non-param + parameterized queries on one session correctly', async () => {
    // Parameterized queries set connection-level param state, so the binding
    // serializes them per connection; this must hold even when interleaved with
    // concurrent non-parameterized queries. (Streaming concurrently with point
    // queries on the same connection is a separate, unsupported case.)
    const s = new Session()
    try {
      const tasks: Promise<unknown>[] = []
      for (let i = 0; i < 24; i++) {
        tasks.push(s.queryAsync(`SELECT ${i} AS v`, { format: 'CSV' }).then((r) => expect(r.text().trim()).toBe(String(i))))
        tasks.push(s.queryBindAsync('SELECT {n:UInt32}+1 AS v', { n: i }, { format: 'CSV' }).then((r) => expect(r.text().trim()).toBe(String(i + 1))))
      }
      await Promise.all(tasks)
    } finally {
      s.close()
    }
  })

  it('runs 48 concurrent parameterized queries with no param-state clobbering', async () => {
    // Regression for the concurrent-param race (was: wrong values / code 456
    // "Substitution not set"). Now serialized per connection.
    const out = await Promise.all(
      Array.from({ length: 48 }, (_, i) =>
        queryBindAsync('SELECT {n:UInt32} AS v', { n: i }, { format: 'CSV' }),
      ),
    )
    out.forEach((r, i) => expect(r.text().trim()).toBe(String(i)))
  })
})

describe('async cancellation storms (no crash / no hang)', () => {
  afterEach(async () => { await sleep(600) }) // drain background native work

  it('survives an abort storm and recovers', async () => {
    const codes = await Promise.all(
      Array.from({ length: 40 }, () => {
        const ac = new AbortController()
        const p = queryAsync(HEAVY(400_000_000), { signal: ac.signal }).then(() => 'ok', (e: any) => e.code)
        ac.abort()
        return p
      }),
    )
    expect(codes.every((c) => c === 'CHDB_ABORT')).toBe(true)
    // recovers after the storm
    expect((await queryAsync('SELECT 7', { format: 'CSV' })).text().trim()).toBe('7')
  }, STRESS_TIMEOUT_MS)

  it('survives a timeout storm and recovers', async () => {
    const codes = await Promise.all(
      Array.from({ length: 24 }, () =>
        queryAsync(HEAVY(2_000_000_000), { timeout: 5 }).then(() => 'ok', (e: any) => e.code),
      ),
    )
    expect(codes.every((c) => c === 'CHDB_TIMEOUT')).toBe(true)
    expect((await queryAsync('SELECT 8', { format: 'CSV' })).text().trim()).toBe('8')
  }, STRESS_TIMEOUT_MS)
})

describe('lifecycle race: close / registry mutation during an in-flight query', () => {
  afterEach(async () => { await sleep(600) })

  it('closing a session while its async query is in flight does not crash (100x)', async () => {
    for (let i = 0; i < 100; i++) {
      const s = new Session()
      s.query('CREATE TABLE t (n UInt32) ENGINE = Memory')
      const p = s.queryAsync(HEAVY(60_000_000), { format: 'CSV' }).then(() => 'ok', (e: any) => e.code || 'err')
      await sleep(i % 5) // widen the race window around worker dispatch
      s.close()
      const r = await p
      expect(typeof r).toBe('string') // resolved 'ok' or a typed error code — never a crash
    }
  }, STRESS_TIMEOUT_MS)

  // This used to assert that opening a session mid-query was safe. It is not:
  // the session takes the process's one data directory, which destroys the
  // default connection the query is running on, and the engine does not survive
  // that. It aborts for the rest of the process, and on macOS the worker can
  // stay blocked inside libchdb so the query's promise never settles — which
  // surfaced far away, as the suite-wide afterEach drain timing out at 30s and
  // every later test in the file reporting "a session is active".
  //
  // The constructor is synchronous and cannot wait for the query, so it refuses.
  // An error naming what to await is worth more than a wait nobody asked for.
  it('refuses to open a session while a default-conn query is in flight, and opens once it drains (12x)', async () => {
    for (let i = 0; i < 12; i++) {
      const p = queryAsync(SLOW, { format: 'CSV' })
      await sleep(i % 4)

      let opened: Session | null = null
      try {
        opened = new Session()
      } catch (e) {
        expect((e as Error).message).toMatch(/still running on the default connection/)
      } finally {
        opened?.close() // if it did open, do not leak it into the next test
      }
      expect(opened).toBeNull() // the refusal is the contract, not best-effort

      // The query itself is untouched by the refusal, and the session opens as
      // soon as it has drained — no lingering state, no retry backoff needed.
      expect((await p).text().trim()).toMatch(/^\d+$/)
      const s = new Session()
      s.close()
    }
  }, STRESS_TIMEOUT_MS)
})

describe('async path memory (no leak on the query path)', () => {
  it('1500 sequential async queries stay memory-bounded', async () => {
    const g = (globalThis as any).gc as undefined | (() => void)
    if (g) { g(); g() }
    const before = process.memoryUsage().rss
    for (let i = 0; i < 1500; i++) {
      const r = await queryAsync('SELECT 1', { format: 'CSV' })
      void r.bytes().length
    }
    if (g) { g(); g() }
    const deltaMB = (process.memoryUsage().rss - before) / 1048576
    // the async query path itself does not leak (observed ~1MB/3000); generous
    // bound tolerates allocator high-water + the no-gc case under vitest.
    expect(deltaMB).toBeLessThan(60)
  })
})
