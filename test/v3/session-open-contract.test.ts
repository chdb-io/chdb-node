import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, queryAsync, drainPending } from '../../index.js'

// When new Session() refuses, and how the caller gets unstuck.
//
// libchdb binds one data directory per process. Opening a session therefore
// destroys the in-memory default connection, and a connection destroyed while an
// operation is still running on it aborts the engine for the rest of the process
// — on macOS the worker can stay blocked inside libchdb and never settle. The
// constructor is synchronous and cannot wait, so it refuses.
//
// Awaiting your own promise is not always possible. An aborted call rejects
// straight away while the engine keeps computing, and close() returns before the
// connection is really gone. drainPending() is the wait for both.

// Forces per-row work so the query is still running on the next line. count()
// over numbers() is answered from the range in ~5ms and would make these pass
// without ever entering the state they exist to test.
const SLOW = 'SELECT max(sipHash64(number)) FROM numbers(20000000)'
const tmpDir = (tag: string) => mkdtempSync(join(tmpdir(), `chdb-contract-${tag}-`))

describe('new Session() while the default connection is busy', () => {
  it('refuses, and opens after the query is awaited', async () => {
    const p = queryAsync(SLOW, { format: 'CSV' })
    expect(() => new Session()).toThrow(/still running on the default connection/)

    await p
    const s = new Session()
    s.close()
  }, 60_000)

  // The bookkeeping is a counter, so its accuracy is entirely a question of when
  // it is decremented: a tick late and a caller who has awaited their own query
  // is refused for a connection that is already free. The release is registered
  // ahead of any caller's handler for that reason, and extra microtask hops here
  // would catch a change that moved it behind one.
  it('never refuses after the await, however many microtasks are in between', async () => {
    for (const hops of [0, 1, 3, 8]) {
      await queryAsync(SLOW, { format: 'CSV' })
      for (let i = 0; i < hops; i++) await Promise.resolve()
      const s = new Session()
      s.close()
    }
  }, 60_000)

  it('refuses after an abort, where there is no promise left to await', async () => {
    const ac = new AbortController()
    const p = queryAsync(SLOW, { format: 'CSV', signal: ac.signal })
    ac.abort()
    await p.catch(() => {}) // rejects at once; the engine is still computing

    // The rejection is not the end of the operation, so the refusal stands and
    // the caller has nothing of their own left to wait on.
    expect(() => new Session()).toThrow(/drainPending/)

    await drainPending()
    const s = new Session()
    s.close()
  }, 60_000)
})

describe('new Session() at a different path while a close is still landing', () => {
  it('refuses with the close already made, and opens after draining', async () => {
    const a = tmpDir('a')
    const b = tmpDir('b')

    const first = new Session(a)
    const q = first.queryAsync(SLOW, { format: 'CSV' })
    first.close() // returns, but cannot destroy the connection under the query

    // Left to the engine this is "only one active data directory per process;
    // close the current session" — advice the caller has already followed.
    expect(() => new Session(b)).toThrow(/still releasing/)

    await q.catch(() => {})
    await drainPending()
    const second = new Session(b)
    second.close()
  }, 60_000)

  it('allows the same path, which needs no wait at all', async () => {
    const a = tmpDir('same')

    const first = new Session(a)
    const q = first.queryAsync(SLOW, { format: 'CSV' })
    first.close() // deferred, exactly as above

    // Connections to one directory coexist by design, and the deferred teardown
    // releases a connection rather than the directory. Refusing here would
    // reject a supported pattern for no reason.
    const alongside = new Session(a)
    alongside.close()

    await q.catch(() => {})
    await drainPending()
  }, 60_000)
})
