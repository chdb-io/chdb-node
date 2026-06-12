import { describe, it, expect, afterEach } from 'vitest'
import { queryAsync, queryBindAsync, Session } from '../../index.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// A query heavy enough (~100ms sync) to (a) let the event loop tick during it
// and (b) outlast a tiny timeout/abort.
const HEAVY = 'SELECT count() FROM numbers(300000000)'

describe('queryAsync basics', () => {
  it('resolves a ChdbResult with text()/json()/metrics', async () => {
    const r = await queryAsync('SELECT 1 AS a', { format: 'CSV' })
    expect(r.text().trim()).toBe('1')
    expect(typeof r.elapsed).toBe('number')
    expect(typeof r.rowsRead).toBe('number')

    const j = await queryAsync('SELECT 1 AS a', { format: 'JSONEachRow' })
    expect(j.json()).toEqual({ a: 1 })

    expect(r.bytes()).toBeInstanceOf(Uint8Array)
  })

  it('binds parameters via queryBindAsync', async () => {
    const r = await queryBindAsync('SELECT {id:UInt32} + 1 AS v', { id: 41 })
    expect(r.text().trim()).toBe('42')
  })

  it('surfaces engine errors as typed rejections', async () => {
    await expect(queryAsync('SELECT * FROM no_such_table_async')).rejects.toMatchObject({
      name: 'ChdbQueryError',
      code: 'CHDB_QUERY',
    })
  })

  it('does not block the event loop', async () => {
    let ticks = 0
    const iv = setInterval(() => { ticks++ }, 1)
    try {
      const r = await queryAsync(HEAVY)
      expect(r.text().trim()).toBe('300000000')
    } finally {
      clearInterval(iv)
    }
    // If the query had frozen libuv, the 1ms interval could not have fired.
    expect(ticks).toBeGreaterThan(0)
  })
})

describe('queryAsync cancellation (honest single-shot)', () => {
  // Each test leaves a native query running ~100ms in the background; drain it
  // before the next registry-touching test to avoid a concurrent-close race.
  afterEach(async () => { await sleep(300) })

  it('rejects with ChdbAbortError when the signal aborts', async () => {
    const ac = new AbortController()
    const p = queryAsync(HEAVY, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError', code: 'CHDB_ABORT' })
  })

  it('rejects immediately for an already-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(queryAsync('SELECT 1', { signal: ac.signal })).rejects.toMatchObject({
      code: 'CHDB_ABORT',
    })
  })

  it('rejects with ChdbTimeoutError on timeout', async () => {
    await expect(queryAsync(HEAVY, { timeout: 5 })).rejects.toMatchObject({
      name: 'ChdbTimeoutError',
      code: 'CHDB_TIMEOUT',
    })
  })
})

describe('Session async methods', () => {
  let session: Session | undefined
  afterEach(() => { session?.close(); session = undefined })

  it('queryAsync / queryBindAsync work against a session', async () => {
    session = new Session()
    session.query('CREATE TABLE t (id UInt32) ENGINE = MergeTree() ORDER BY id')
    session.query('INSERT INTO t VALUES (10),(20),(30)')

    const r = await session.queryAsync('SELECT sum(id) FROM t')
    expect(r.text().trim()).toBe('60')

    const b = await session.queryBindAsync('SELECT count() FROM t WHERE id >= {min:UInt32}', { min: 20 })
    expect(b.text().trim()).toBe('2')
  })

  it('rejects queryAsync after the session is closed', async () => {
    const s = new Session()
    s.close()
    await expect(s.queryAsync('SELECT 1')).rejects.toMatchObject({ code: 'CHDB_CLOSED' })
  })
})
