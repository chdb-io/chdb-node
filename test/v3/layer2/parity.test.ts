import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient as createChdb } from '../../../index.js'

// Test design ② — output parity with a real ClickHouse server.
//
// Opt-in: set CHDB_PARITY_URL to a running clickhouse-server HTTP endpoint
// (e.g. `CHDB_PARITY_URL=http://localhost:8123`). In CI this is wired to a
// docker clickhouse-server; locally it skips. We run the SAME query through the
// real @clickhouse/client (HTTP) and our embedded chdb client, then assert the
// decoded results are equal — proving "output is the same as ClickHouse".
const PARITY_URL = process.env.CHDB_PARITY_URL

// Normalize away the fields that are legitimately environment-specific
// (query_id, timings) before comparing — the whitelist itself is narrow on
// purpose (design §6②).
function normalizeResponseJSON(j: any): any {
  const { query_id: _q, statistics: _s, ...rest } = j ?? {}
  return rest
}

describe.skipIf(!PARITY_URL)('server output parity (②)', () => {
  // Fresh clients per test, not beforeAll-shared: the global afterEach safety
  // net force-closes every open chDB session after each test (see
  // test/v3/setup.ts), which would tear down a session shared across cases. The
  // server client (HTTP) is unaffected by that chDB-only cleanup, but is created
  // here too for symmetry. Lazy import keeps the dev dependency off the path
  // when the suite is skipped.
  let chServer: any
  let chdb: ReturnType<typeof createChdb>

  beforeEach(async () => {
    const { createClient } = await import('@clickhouse/client')
    // Match how clickhouse-js's OWN integration suite configures its client:
    // output_format_json_quote_64bit_integers=1, so 64-bit ints come back as
    // lossless strings ("clickhouse by default returns UInt64 as string to be
    // safe" — clickhouse-js's own test comment). Layer 2 injects the same
    // setting for JSON-family output, so this is the apples-to-apples baseline;
    // without it the bare server client would emit lossy JS numbers and the
    // comparison would be against a config clickhouse-js never ships its tests
    // with.
    chServer = createClient({
      url: PARITY_URL,
      clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
    })
    chdb = createChdb({ url: 'chdb://memory' })
  })
  afterEach(async () => {
    await chdb.close()
    if (chServer) await chServer.close()
  })

  const JSON_QUERIES = [
    'SELECT 1 AS a, 2 AS b',
    "SELECT 'hello' AS s, toInt32(-5) AS i",
    'SELECT toInt64(9007199254740993) AS big',
    'SELECT toUInt64(18446744073709551615) AS u',
    'SELECT [1,2,3] AS arr, map(1,2) AS m',
    'SELECT number AS n FROM numbers(5) ORDER BY n',
    'SELECT toDateTime(\'2024-01-02 03:04:05\', \'UTC\') AS dt',
    'SELECT NULL AS n, toNullable(7) AS x',
    'SELECT sum(number) AS s FROM numbers(1000)',
  ]

  it.each(JSON_QUERIES)('JSON parity: %s', async (query) => {
    const [a, b] = await Promise.all([
      chServer.query({ query, format: 'JSON' }).then((r: any) => r.json()),
      chdb.query({ query, format: 'JSON' }).then((r) => r.json()),
    ])
    expect(normalizeResponseJSON(b)).toEqual(normalizeResponseJSON(a))
  })

  it.each(['SELECT 1 AS a, 2 AS b', "SELECT 'x,y' AS s"])('CSV byte parity: %s', async (query) => {
    const [a, b] = await Promise.all([
      chServer.query({ query, format: 'CSV' }).then((r: any) => r.text()),
      chdb.query({ query, format: 'CSV' }).then((r) => r.text()),
    ])
    expect(b).toBe(a)
  })

  it('error code/type parity (UNKNOWN_TABLE)', async () => {
    const grab = async (run: () => Promise<unknown>) => {
      try {
        await run()
        return null
      } catch (e: any) {
        return { code: e.code, type: e.type }
      }
    }
    const a = await grab(() => chServer.query({ query: 'SELECT * FROM no_such_table_xyz' }))
    const b = await grab(() => chdb.query({ query: 'SELECT * FROM no_such_table_xyz' }))
    expect(b).toEqual(a)
  })
})
