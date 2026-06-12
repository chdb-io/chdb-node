import { describe, it, expect, afterEach } from 'vitest'
import { queryAsync, queryBindAsync, Session } from '../../index.js'

// Brute-force concurrency / abort stress for the async paths, to flush out
// deadlocks, use-after-free, and leaks. Sleeps are inserted at the "landing"
// points (after abort/timeout storms) to let the background native work — which
// keeps running after an honest cancel — drain before the next phase, since the
// process shares a single libchdb connection.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const HEAVY = (n: number) => `SELECT count() FROM numbers(${n})`

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
  })

  it('survives a timeout storm and recovers', async () => {
    const codes = await Promise.all(
      Array.from({ length: 24 }, () =>
        queryAsync(HEAVY(2_000_000_000), { timeout: 5 }).then(() => 'ok', (e: any) => e.code),
      ),
    )
    expect(codes.every((c) => c === 'CHDB_TIMEOUT')).toBe(true)
    expect((await queryAsync('SELECT 8', { format: 'CSV' })).text().trim()).toBe('8')
  })
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
  })

  it('opening a new session while a default-conn query is in flight is safe (60x)', async () => {
    for (let i = 0; i < 60; i++) {
      const p = queryAsync(HEAVY(60_000_000), { format: 'CSV' }).then((r) => r.text().trim(), () => 'err')
      await sleep(i % 4)
      const s = new Session()
      const r = await p
      expect(r === '60000000' || r === 'err').toBe(true)
      s.close()
    }
  })
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
