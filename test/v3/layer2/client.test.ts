import { describe, it, expect } from 'vitest'
import { createClient, ChdbResultSet, ChdbClickHouseClient } from '../../../index.js'

describe('ChdbClickHouseClient — 6 methods', () => {
  it('createClient returns a client; default url is in-memory', async () => {
    const c = createClient()
    expect(c).toBeInstanceOf(ChdbClickHouseClient)
    const rs = await c.query({ query: 'SELECT 1 AS n', format: 'JSONEachRow' })
    expect(rs).toBeInstanceOf(ChdbResultSet)
    expect(await rs.json()).toEqual([{ n: 1 }])
    await c.close()
  })

  it('query default format is JSON (single-document ResponseJSON)', async () => {
    const c = createClient()
    try {
      const rs = await c.query({ query: 'SELECT 1 AS n' })
      const j = (await rs.json()) as { data: unknown[] }
      expect(j.data).toEqual([{ n: 1 }])
    } finally {
      await c.close()
    }
  })

  it('query_params bind via server-side binding', async () => {
    const c = createClient()
    try {
      const rs = await c.query({
        query: 'SELECT toUInt32({a:UInt32} + {b:UInt32}) AS s',
        query_params: { a: 20, b: 22 },
        format: 'JSONEachRow',
      })
      expect(await rs.json()).toEqual([{ s: 42 }])
    } finally {
      await c.close()
    }
  })

  it('command runs DDL and returns a CommandResult', async () => {
    const c = createClient()
    try {
      const r = await c.command({ query: 'CREATE TABLE c_t (a UInt32) ENGINE = Memory' })
      expect(typeof r.query_id).toBe('string')
      expect(r.query_id.length).toBeGreaterThan(0)
      expect(r.response_headers).toEqual({})
      expect(r.http_status_code).toBe(200)
    } finally {
      await c.close()
    }
  })

  it('insert: object rows, array rows, columns, default format', async () => {
    const c = createClient()
    try {
      await c.command({ query: 'CREATE TABLE ins (a UInt32, b String) ENGINE = Memory' })
      const r1 = await c.insert({ table: 'ins', values: [{ a: 1, b: 'x' }], format: 'JSONEachRow' })
      expect(r1.executed).toBe(true)
      expect(r1.summary?.written_rows).toBe('1')
      // positional rows with explicit columns
      await c.insert({ table: 'ins', values: [[2, 'y']], columns: ['a', 'b'] })
      const rs = await c.query({ query: 'SELECT * FROM ins ORDER BY a', format: 'JSONEachRow' })
      expect(await rs.json()).toEqual([
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ])
    } finally {
      await c.close()
    }
  })

  it('insert: empty array short-circuits to {executed:false, query_id:""}', async () => {
    const c = createClient()
    try {
      await c.command({ query: 'CREATE TABLE e (a UInt32) ENGINE = Memory' })
      const r = await c.insert({ table: 'e', values: [] })
      expect(r.executed).toBe(false)
      expect(r.query_id).toBe('')
    } finally {
      await c.close()
    }
  })

  it('insert: InputJSON {meta,data} and JSONObjectEachRow record forms', async () => {
    const c = createClient()
    try {
      await c.command({ query: 'CREATE TABLE m (a UInt32, b String) ENGINE = Memory' })
      await c.insert({
        table: 'm',
        values: { meta: [{ name: 'a', type: 'UInt32' }], data: [{ a: 10, b: 'p' }] } as never,
      })
      await c.insert({ table: 'm', values: { row1: { a: 11, b: 'q' } } as never })
      const rs = await c.query({ query: 'SELECT * FROM m ORDER BY a', format: 'JSONEachRow' })
      expect(await rs.json()).toEqual([
        { a: 10, b: 'p' },
        { a: 11, b: 'q' },
      ])
    } finally {
      await c.close()
    }
  })

  it('exec returns a consumable stream of bytes', async () => {
    const c = createClient()
    try {
      const r = await c.exec({ query: 'SELECT 1 AS n FORMAT JSONEachRow' })
      let text = ''
      for await (const chunk of r.stream) text += chunk.toString()
      expect(text.trim()).toBe('{"n":1}')
    } finally {
      await c.close()
    }
  })

  it('ping never throws and returns success on a healthy engine', async () => {
    const c = createClient()
    try {
      expect(await c.ping()).toEqual({ success: true })
    } finally {
      await c.close()
    }
  })

  it('close is idempotent; query after close rejects', async () => {
    const c = createClient()
    await c.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    await c.close()
    await c.close() // idempotent
    await expect(c.query({ query: 'SELECT 1' })).rejects.toThrow()
  })

  it('Symbol.asyncDispose closes the client', async () => {
    const c = createClient()
    await c[Symbol.asyncDispose]()
    await expect(c.query({ query: 'SELECT 1' })).rejects.toThrow()
  })

  it('stateful temp tables persist across queries on the same client (session-like)', async () => {
    const c = createClient()
    try {
      await c.command({ query: 'CREATE TABLE s (a UInt32) ENGINE = Memory' })
      await c.insert({ table: 's', values: [{ a: 5 }], format: 'JSONEachRow' })
      const rs = await c.query({ query: 'SELECT toUInt32(sum(a)) AS t FROM s', format: 'JSONEachRow' })
      expect(await rs.json()).toEqual([{ t: 5 }])
    } finally {
      await c.close()
    }
  })
})
