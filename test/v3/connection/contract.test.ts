/**
 * Connection-contract suite for ChdbConnection.
 *
 * Pins the cross-backend invariants of the public `Connection<Stream.Readable>`
 * contract (the one re-exported from `@clickhouse/client-common`) that
 * ChdbConnection must satisfy. The assertions here use the snake_case
 * Connection-layer shape (`query_id`, `response_headers`, `http_status_code`,
 * `summary`) — the Client layer above translates to camelCase before
 * user-facing code sees it, but that's a layer above this.
 *
 * What this file does NOT test:
 *   - byte-level output parity against a real ClickHouse server
 *     → tests/clickhouse-js/runner.mjs
 *   - chDB-specific raw-channel behavior (queryAsync / queryStream /
 *     rawInsert) → existing test/v3/*.test.ts Layer 1 suite
 */

import { Readable } from 'stream'
import { describe, it, expect } from 'vitest'
import { createChdbConnection, ChdbConnection } from '../../../src/connection'
import type { Connection } from '../../../src/connection'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function drainReadable(stream: Readable): Promise<string> {
  let body = ''
  for await (const chunk of stream) {
    body += Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
  return body
}

describe('ChdbConnection — Connection contract', () => {
  it('satisfies Connection<Stream.Readable> assignment', () => {
    // Compile-time assignment is the strongest check; if ChdbConnection ever
    // drifts from the upstream interface this won't typecheck.
    const conn: Connection<Readable> = createChdbConnection({ path: ':memory:' })
    expect(conn.connectionName).toBe('chdb')
  })

  it('is also a ChdbConnection instance (for type narrowing on the brand)', () => {
    const conn = createChdbConnection({ path: ':memory:' })
    expect(conn).toBeInstanceOf(ChdbConnection)
  })

  it('query() returns { stream, query_id, response_headers, http_status_code }', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    const r = await conn.query({
      query: 'SELECT 1 AS n FORMAT JSONEachRow',
    })
    // Snake_case Connection-layer shape (matches @clickhouse/client-common).
    expect(typeof r.query_id).toBe('string')
    expect(r.query_id).toMatch(UUID_RE)
    expect(r.response_headers).toEqual({})
    expect(r.http_status_code).toBe(200)
    expect(await drainReadable(r.stream)).toContain('"n":1')
  })

  it('honors clickhouse_settings via SET-prefix (default_format → format opt)', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    // Use upstream's real settings field — default_format routes to chdb's
    // queryAsync format option (HTTP backend uses it as a URL param).
    const r = await conn.query({
      query: 'SELECT 1',
      clickhouse_settings: { default_format: 'CSV' as never },
    })
    const body = await drainReadable(r.stream)
    expect(body.trim()).toBe('1')
  })

  it('exec() returns query result shape PLUS summary', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    const r = await conn.exec({ query: 'SELECT 2 FORMAT CSV' })
    expect(typeof r.query_id).toBe('string')
    expect(r.summary.read_rows).toMatch(/^\d+$/)
    expect((await drainReadable(r.stream)).trim()).toBe('2')
  })

  it('command() executes DDL and returns base result + summary, no stream', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    const r = await conn.command({ query: 'CREATE TABLE t1 (x Int32) ENGINE=Memory' })
    expect(r.query_id).toMatch(UUID_RE)
    expect(typeof r.summary.elapsed_ns).toBe('string')
    // ConnCommandResult has no `stream` field — only base result + summary.
    expect('stream' in r).toBe(false)

    await conn.command({ query: 'INSERT INTO t1 VALUES (42)' })
    const sel = await conn.query({ query: 'SELECT x FROM t1 FORMAT CSV' })
    expect((await drainReadable(sel.stream)).trim()).toBe('42')
  })

  it('insert() takes a pre-built INSERT query + values and returns summary', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    await conn.command({ query: 'CREATE TABLE t2 (id Int32, name String) ENGINE=Memory' })
    const payload = '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n'
    // ConnInsertParams expects { query, values: string | Stream } — the
    // Client layer above translates user-facing `{ table, format, values }`
    // into the `INSERT INTO t2 FORMAT JSONEachRow` query string before
    // this point. Pass values as `string` (the simplest valid form).
    const r = await conn.insert({
      query: 'INSERT INTO t2 FORMAT JSONEachRow',
      values: payload,
    })
    expect(r.query_id).toMatch(UUID_RE)
    // Summary is populated with the documented stringly-typed numeric fields.
    // The exact written_rows value is engine-dependent (chdb's native
    // INSERT path doesn't always report it); we assert SHAPE here and
    // verify the data landed via a follow-up SELECT below.
    expect(typeof r.summary.written_rows).toBe('string')
    expect(typeof r.summary.elapsed_ns).toBe('string')

    const sel = await conn.query({ query: 'SELECT count() FROM t2 FORMAT CSV' })
    expect((await drainReadable(sel.stream)).trim()).toBe('2')
  })

  it('ping() returns ConnPingResult { success: true } when live', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    const r = await conn.ping({ select: false })
    expect(r.success).toBe(true)
  })

  it('ping() returns { success: false, error } after close (does not throw)', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    await conn.close()
    const r = await conn.ping({ select: false })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toBeInstanceOf(Error)
  })

  it('close() is idempotent', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    await conn.close()
    await conn.close() // must not throw
  })

  it('mapError() coerces any thrown value into an Error', () => {
    // Not on the Connection interface but mirrors clickhouse-js's
    // NodeBaseConnection.mapError convention; useful for callers.
    const conn = createChdbConnection({ path: ':memory:' })
    expect(conn.mapError(new TypeError('boom'))).toBeInstanceOf(Error)
    expect(conn.mapError('non-error')).toBeInstanceOf(Error)
    expect(conn.mapError({ msg: 'object' }).message).toContain('object Object')
  })

  it('.chdb extension surface is present with documented methods', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    expect(conn.chdb).toBeDefined()
    expect(typeof conn.chdb.session.path).toBe('string')
    expect(typeof conn.chdb.session.isTemp).toBe('boolean')
    expect(typeof conn.chdb.queryAsync).toBe('function')
    expect(typeof conn.chdb.queryStream).toBe('function')
    expect(typeof conn.chdb.rawInsert).toBe('function')
    expect(typeof conn.chdb.streamInsert).toBe('function')

    // Raw queryAsync surfaces native ChdbResult views (bytes/text/json)
    const native = await conn.chdb.queryAsync('SELECT 1 AS n', { format: 'JSON' })
    expect(native.rowsRead).toBe(1)
    const parsed = native.json<{ data: Array<{ n: number }> }>()
    expect(parsed.data[0]?.n).toBe(1)
  })
})

describe('ChdbConnection — query() materialization invariant', () => {
  it('rejects at await when the SQL fails (eager-buffered semantics)', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    // BAD_FUNCTION(): the engine has no such function, so this must reject at
    // await — not push an error chunk into the Readable. This pins the
    // byte-compat semantics clickhouse-js expects of Connection.query today.
    await expect(
      conn.query({ query: 'SELECT BAD_FUNCTION()' })
    ).rejects.toThrow()
  })
})
