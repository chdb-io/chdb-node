import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Session } from '../../index.js'

let session: Session
beforeEach(() => { session = new Session() })
afterEach(() => { session.close() })

describe('Session.insert (Item 6: inline INSERT ... VALUES, async, no stdin)', () => {
  it('inserts object rows and reports a summary', async () => {
    session.query('CREATE TABLE t (id UInt32, name String) ENGINE = MergeTree() ORDER BY id')
    const s = await session.insert({
      table: 't',
      values: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    })
    expect(s.rowsWritten).toBe(2)
    expect(typeof s.elapsed).toBe('number')
    expect(session.query('SELECT count() FROM t', 'CSV').trim()).toBe('2')
    expect(session.query("SELECT name FROM t WHERE id = 2", 'CSV').trim()).toBe('"Bob"')
  })

  it('inserts positional array rows with an explicit column list', async () => {
    session.query('CREATE TABLE t (a UInt32, b String) ENGINE = Memory')
    const s = await session.insert({ table: 't', values: [[1, 'x'], [2, 'y']], columns: ['a', 'b'] })
    expect(s.rowsWritten).toBe(2)
    expect(session.query('SELECT sum(a) FROM t', 'CSV').trim()).toBe('3')
  })

  it('inserts complex types without hanging (#26 / chdb#152)', async () => {
    session.query(
      'CREATE TABLE t (id UInt32, tags Array(String), meta Map(String, UInt8)) ENGINE = MergeTree() ORDER BY id',
    )
    const s = await session.insert({
      table: 't',
      values: [
        { id: 1, tags: ['a', 'b'], meta: { x: 1, y: 2 } },
        { id: 2, tags: [], meta: {} },
      ],
    })
    expect(s.rowsWritten).toBe(2)
    const rows = session
      .query('SELECT id, tags, meta FROM t ORDER BY id', 'JSONEachRow')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(rows[0]).toEqual({ id: 1, tags: ['a', 'b'], meta: { x: 1, y: 2 } })
    expect(rows[1]).toEqual({ id: 2, tags: [], meta: {} })
  })

  it('preserves bigint and Date values exactly', async () => {
    session.query('CREATE TABLE t (id Int64, ts DateTime) ENGINE = MergeTree() ORDER BY id')
    await session.insert({
      table: 't',
      values: [{ id: 9007199254740993n, ts: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) }],
    })
    expect(session.query('SELECT toString(id), toString(ts) FROM t', 'TabSeparated').trim()).toBe(
      '9007199254740993\t2026-01-02 03:04:05',
    )
  })

  it('handles a larger batch in one statement', async () => {
    session.query('CREATE TABLE big (n UInt32) ENGINE = Memory')
    const rows = Array.from({ length: 5000 }, (_, i) => ({ n: i }))
    const s = await session.insert({ table: 'big', values: rows })
    expect(s.rowsWritten).toBe(5000)
    expect(session.query('SELECT count(), sum(n) FROM big', 'CSV').trim()).toBe('5000,12497500')
  })

  it('returns a zero summary for empty input', async () => {
    session.query('CREATE TABLE t (a UInt32) ENGINE = Memory')
    const s = await session.insert({ table: 't', values: [] })
    expect(s).toEqual({ rowsWritten: 0, bytesRead: 0, elapsed: 0 })
  })

  it('rejects an invalid table identifier with ChdbInsertError', async () => {
    await expect(session.insert({ table: 'bad table', values: [{ a: 1 }] })).rejects.toMatchObject({
      name: 'ChdbInsertError',
      code: 'CHDB_INSERT',
    })
  })

  it('wraps engine errors (missing table) as ChdbInsertError', async () => {
    await expect(
      session.insert({ table: 'no_such_table_for_insert', values: [{ a: 1 }] }),
    ).rejects.toMatchObject({ name: 'ChdbInsertError', code: 'CHDB_INSERT' })
  })
})
