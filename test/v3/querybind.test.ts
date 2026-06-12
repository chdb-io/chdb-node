import { describe, it, expect, afterEach } from 'vitest'
import { query, queryBind, Session } from '../../index.js'

const t = (sql: string, params: Record<string, unknown>): string =>
  queryBind(sql, params, 'TabSeparated').replace(/\n$/, '')

describe('queryBind path A (server-side chdb_query_with_params)', () => {
  it('binds numeric, string, bigint and boolean params', () => {
    expect(t('SELECT {id:UInt32}', { id: 42 })).toBe('42')
    expect(t('SELECT {n:Int64}', { n: 9007199254740993n })).toBe('9007199254740993')
    expect(t("SELECT concat('Hello ', {name:String})", { name: 'Alice' })).toBe('Hello Alice')
    expect(t('SELECT {b:Bool}', { b: true })).toBe('true')
  })

  it('binds DateTime, Array and Map params', () => {
    expect(t('SELECT {ts:DateTime}', { ts: new Date(Date.UTC(2026, 4, 1, 12, 0, 0)) })).toBe(
      '2026-05-01 12:00:00',
    )
    expect(t('SELECT arraySum({xs:Array(UInt32)})', { xs: [1, 2, 3, 4] })).toBe('10')
    const row = JSON.parse(
      queryBind(
        'SELECT {m:Map(String, Array(UInt8))} AS m',
        { m: { abc: Uint8Array.from([1, 2, 3]) } },
        'JSONEachRow',
      ).trim(),
    )
    expect(row.m).toEqual({ abc: [1, 2, 3] })
  })

  it('treats injection payloads as inert bound data (no interpolation)', () => {
    const payloads = ["'; DROP TABLE x; --", 'a\\b', "a' OR 1=1 --", 'tab\tend']
    for (const p of payloads) {
      // length() of the bound value equals the JS length -> it is one string,
      // nothing executed. Server-side binding has no escaping surface at all.
      const got = t('SELECT length({s:String})', { s: p })
      expect(got).toBe(String(Buffer.byteLength(p)))
    }
  })

  it('rejects unsafe-integer / null params with a typed ChdbBindError', () => {
    try {
      queryBind('SELECT {n:Int64}', { n: 1e21 }, 'CSV')
      expect.unreachable('expected ChdbBindError')
    } catch (e: any) {
      expect(e.name).toBe('ChdbBindError')
      expect(e.code).toBe('CHDB_BIND')
    }
    try {
      queryBind('SELECT {n:Int64}', { n: null }, 'CSV')
      expect.unreachable('expected ChdbBindError')
    } catch (e: any) {
      expect(e.name).toBe('ChdbBindError')
    }
  })

  it('surfaces engine errors as typed query errors', () => {
    try {
      // type mismatch: bind a non-numeric string to a UInt32 placeholder
      queryBind('SELECT {id:UInt32}', { id: 'not-a-number' }, 'CSV')
      expect.unreachable('expected a query/bind error')
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error)
      expect(String(e.code)).toMatch(/^CHDB_/)
    }
  })
})

describe('Session.queryBind (Item 5 fix — was an unconditional throw in v2)', () => {
  let session: Session | undefined
  afterEach(() => {
    session?.close()
    session = undefined
  })

  it('binds parameters against a session connection', () => {
    session = new Session()
    session.query('CREATE TABLE t (id UInt32) ENGINE = MergeTree() ORDER BY id')
    session.query('INSERT INTO t VALUES (1),(2),(3)')
    const out = session
      .queryBind('SELECT count() FROM t WHERE id > {id:UInt32}', { id: 1 }, 'CSV')
      .trim()
    expect(out).toBe('2')
  })
})
