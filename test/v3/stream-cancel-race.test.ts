import { describe, it, expect } from 'vitest'
import { Session, queryAsync } from '../../index.js'
// @ts-expect-error — internal test helper, not in the type surface
import { _drainPendingOps } from '../../index.js'

// Teardown landing on a stream fetch that is still running.
//
// A fetch runs on a libuv thread against the session's connection. StreamCancel
// destroys the stream handle synchronously and CloseConnection destroys the
// connection, and the fetch worker reads both without holding a lock, so either
// one landing mid-fetch pulls the memory out from under the worker. libchdb
// answers that by aborting the shared in-process engine, which fails every later
// query in the process, and on macOS can leave the worker blocked inside
// chdb_stream_fetch_result so its promise never settles.
//
// All of it was reachable because streaming was the one native async path that
// never registered itself in pendingNativeOps, so neither close() nor the
// suite-wide teardown drain knew a fetch was in flight.
//
// One row that needs a real per-row computation, so the first fetch takes about a
// second and teardown lands well inside it. count() over numbers() returns in
// ~15ms — fast enough that these would pass whether the races are handled or not.
const SLOW_ONE_ROW = 'SELECT max(sipHash64(number)) FROM numbers(200000000)'

// The macOS symptom was a fetch whose promise never settled. Bound the wait so
// that failure reads as this assertion rather than as a suite timeout.
async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<'settled' | 'hung'> {
  let timer: NodeJS.Timeout
  const hung = new Promise<'hung'>((r) => { timer = setTimeout(() => r('hung'), ms) })
  const settled = p.then(() => 'settled' as const, () => 'settled' as const)
  try {
    return await Promise.race([settled, hung])
  } finally {
    clearTimeout(timer!)
  }
}

describe('teardown that lands on an in-flight stream fetch', () => {
  it('cancel() waits for the fetch instead of destroying the handle under it', async () => {
    const s = new Session()
    try {
      const stream = s.queryStream(SLOW_ONE_ROW, { format: 'JSONEachRow' })
      const it = stream[Symbol.asyncIterator]()

      // next() runs the generator body up to the await, so the fetch is dispatched
      // before it returns and is still running on the next line. Asserted rather
      // than assumed: if a change ever makes the fetch settle first, this test
      // would quietly stop covering the race it exists for.
      const first = it.next()
      expect((stream as unknown as { _inflight: unknown })._inflight).toBeTruthy()

      stream.cancel()
      expect(await settlesWithin(first, 20_000)).toBe('settled')
      await _drainPendingOps() // let the deferred destroy land

      // The engine survived, and the cancelled stream was released cleanly enough
      // that the session takes another one.
      const rows: number[] = []
      for await (const row of s
        .queryStream('SELECT number AS n FROM numbers(3)')
        .rows<{ n: number }>()) {
        rows.push(row.n)
      }
      expect(rows).toEqual([0, 1, 2])
    } finally {
      s.close()
    }
  }, 60_000)

  it('close() releases the stream and defers the connection until the fetch drains', async () => {
    const s = new Session()
    const stream = s.queryStream(SLOW_ONE_ROW, { format: 'JSONEachRow' })
    const it = stream[Symbol.asyncIterator]()

    const first = it.next()
    expect((stream as unknown as { _inflight: unknown })._inflight).toBeTruthy()

    s.close() // must cancel the stream and hold the connection until the fetch ends
    expect(await settlesWithin(first, 20_000)).toBe('settled')
    await _drainPendingOps()

    // Standalone query() refuses to run while any session connection is still
    // registered ("a session (path=…) is active"), so this answering proves both
    // that the engine is alive and that the deferred teardown released the
    // connection instead of leaking it into the rest of the process.
    const r = await queryAsync('SELECT 1', { format: 'CSV' })
    expect(r.text().trim()).toBe('1')
  }, 60_000)
})
