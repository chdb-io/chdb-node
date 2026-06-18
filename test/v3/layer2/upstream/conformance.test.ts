/**
 * clickhouse-js pipeline conformance (design §6①), backend-swappable via
 * `_backend.ts`. Every assertion is about *true ClickHouse semantics*, so it
 * must hold identically whether the client is embedded chDB (default) or a real
 * clickhouse-server (`CHDB_UPSTREAM_BACKEND=server`).
 *
 * Mirrors the ✅ "runs as-is" set from the design: select / select_result /
 * query_binding / insert / exec_and_command / data_types / error_parsing /
 * totals / ping. The ⚠️/❌ families are excluded (see README.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeClient, tableName, BACKEND } from './_backend.js'

describe(`upstream conformance [backend=${BACKEND}]`, () => {
  let client: Awaited<ReturnType<typeof makeClient>>

  // A fresh client per test (not a beforeAll-shared one): the global afterEach
  // safety net force-closes every open chDB session after each test to stop a
  // leak from cascading across files (see test/v3/setup.ts), which would tear
  // down a session shared across `it()` blocks. Each test here is self-contained
  // (unique table names, dropped in-test), so per-test clients change nothing
  // semantically and hold for both the embedded and server backends.
  beforeEach(async () => {
    client = await makeClient()
  })
  afterEach(async () => {
    await client.close()
  })

  // ── select / select_result ──────────────────────────────────────────────
  it('select default format is JSON (ResponseJSON)', async () => {
    const rs = await client.query({ query: 'SELECT 1 AS a, 2 AS b' })
    const j = await rs.json()
    expect(j.data).toEqual([{ a: 1, b: 2 }])
    expect(j.rows).toBe(1)
    expect(Array.isArray(j.meta)).toBe(true)
  })

  it('JSONEachRow → array of rows', async () => {
    const rs = await client.query({
      query: 'SELECT toUInt32(number) AS n FROM numbers(3)',
      format: 'JSONEachRow',
    })
    expect(await rs.json()).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
  })

  it('CSV → text(); json() throws', async () => {
    const rs1 = await client.query({ query: 'SELECT 1 AS a, 2 AS b', format: 'CSV' })
    expect((await rs1.text()).trim()).toBe('1,2')
    const rs2 = await client.query({ query: 'SELECT 1', format: 'CSV' })
    await expect(rs2.json()).rejects.toThrow()
  })

  it('stream() yields Row[] for a streamable format', async () => {
    const rs = await client.query({
      query: 'SELECT toUInt32(number) AS n FROM numbers(3)',
      format: 'JSONEachRow',
    })
    const seen: number[] = []
    for await (const rows of rs.stream()) {
      for (const row of rows) seen.push((row.json() as { n: number }).n)
    }
    expect(seen).toEqual([0, 1, 2])
  })

  // ── query_binding ────────────────────────────────────────────────────────
  it('query_params bind by declared type', async () => {
    const rs = await client.query({
      query: 'SELECT {s:String} AS s, {n:UInt32} AS n',
      query_params: { s: "o'brien", n: 7 },
      format: 'JSONEachRow',
    })
    expect(await rs.json()).toEqual([{ s: "o'brien", n: 7 }])
  })

  // ── exec_and_command / insert ──────────────────────────────────────────────
  it('command DDL + insert + select round-trip', async () => {
    const t = tableName('conf_ins')
    await client.command({ query: `DROP TABLE IF EXISTS ${t}` })
    await client.command({ query: `CREATE TABLE ${t} (a UInt32, b String) ENGINE = Memory` })
    const r = await client.insert({
      table: t,
      values: [
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ],
      format: 'JSONEachRow',
    })
    expect(r.executed).toBe(true)
    const rs = await client.query({ query: `SELECT * FROM ${t} ORDER BY a`, format: 'JSONEachRow' })
    expect(await rs.json()).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ])
    await client.command({ query: `DROP TABLE IF EXISTS ${t}` })
  })

  it('empty-array insert short-circuits to {executed:false}', async () => {
    const t = tableName('conf_empty')
    await client.command({ query: `DROP TABLE IF EXISTS ${t}` })
    await client.command({ query: `CREATE TABLE ${t} (a UInt32) ENGINE = Memory` })
    const r = await client.insert({ table: t, values: [] })
    expect(r.executed).toBe(false)
    await client.command({ query: `DROP TABLE IF EXISTS ${t}` })
  })

  // ── data_types ─────────────────────────────────────────────────────────────
  it('data types round-trip with ClickHouse JSON semantics', async () => {
    const rs = await client.query({
      query: `SELECT
        toInt32(-5) AS i32,
        toInt64(9007199254740993) AS i64,
        toFloat64(1.5) AS f,
        'hello' AS s,
        [1, 2, 3] AS arr,
        toNullable(NULL) AS n,
        toDateTime('2024-01-02 03:04:05', 'UTC') AS dt`,
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as Array<Record<string, unknown>>
    const row = rows[0]!
    expect(row.i32).toBe(-5) // 32-bit → number
    expect(row.i64).toBe('9007199254740993') // 64-bit → string (lossless)
    expect(row.f).toBe(1.5)
    expect(row.s).toBe('hello')
    expect(row.arr).toEqual([1, 2, 3])
    expect(row.n).toBeNull()
    expect(row.dt).toBe('2024-01-02 03:04:05')
  })

  // ── totals ───────────────────────────────────────────────────────────────
  it('WITH TOTALS populates ResponseJSON.totals', async () => {
    const t = tableName('conf_totals')
    await client.command({ query: `DROP TABLE IF EXISTS ${t}` })
    await client.command({ query: `CREATE TABLE ${t} (g UInt8, v UInt32) ENGINE = Memory` })
    await client.insert({
      table: t,
      values: [
        { g: 1, v: 10 },
        { g: 1, v: 20 },
        { g: 2, v: 5 },
      ],
      format: 'JSONEachRow',
    })
    const rs = await client.query({
      query: `SELECT g, toUInt32(sum(v)) AS s FROM ${t} GROUP BY g WITH TOTALS ORDER BY g`,
      format: 'JSON',
    })
    const j = await rs.json()
    expect(j.data).toEqual([
      { g: 1, s: 30 },
      { g: 2, s: 5 },
    ])
    expect(j.totals).toEqual({ g: 0, s: 35 })
    await client.command({ query: `DROP TABLE IF EXISTS ${t}` })
  })

  // ── error_parsing ──────────────────────────────────────────────────────────
  it('error code/type are byte-compat (UNKNOWN_TABLE = 60)', async () => {
    try {
      await client.query({ query: 'SELECT * FROM definitely_missing_conf_table' })
      throw new Error('should have thrown')
    } catch (e) {
      // Assert on the byte-compat fields, NOT the class (the class differs by
      // backend: chdb's ClickHouseError vs @clickhouse/client's — both expose
      // code/type identically, which is the point).
      const err = e as { code?: string; type?: string }
      expect(err.code).toBe('60')
      expect(err.type).toBe('UNKNOWN_TABLE')
    }
  })

  // ── ping ───────────────────────────────────────────────────────────────────
  it('ping resolves to {success:true}', async () => {
    expect(await client.ping()).toEqual({ success: true })
  })
})
