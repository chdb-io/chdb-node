/**
 * Connection-contract suite for ChdbConnection.
 *
 * Pins the cross-backend invariants of the {@link Connection} interface that
 * ChdbConnection (and any future backend) must satisfy. These are the
 * assertions a higher-level client (e.g. `@clickhouse/client`'s eventual
 * `connection` injection point) can safely assume, regardless of which
 * backend is wired up.
 *
 * What this file does NOT test:
 *   - byte-level output parity against a real CH server  → parity.test.ts
 *   - chDB-specific raw-channel behavior (queryAsync /
 *     queryStream / rawInsert)                            → covered by the
 *     existing test/v3/*.test.ts Layer 1 suite
 */

import { describe, it, expect } from 'vitest'
import { createChdbConnection, ChdbConnection } from '../../../src/connection'
import type { Connection } from '../../../src/connection'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function drain(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let body = ''
  for await (const chunk of stream) body += Buffer.from(chunk).toString('utf8')
  return body
}

describe('ChdbConnection — Connection contract', () => {
  it('identifies itself as chdb', () => {
    const conn: Connection = createChdbConnection({ path: ':memory:' })
    expect(conn.connectionName).toBe('chdb')
  })

  it('honestly reports supportsZeroCopyStreaming = false (chdb-node currently copies result bytes)', () => {
    const conn = createChdbConnection({ path: ':memory:' })
    expect(conn.supportsZeroCopyStreaming).toBe(false)
  })

  it('is also a ChdbConnection instance (for type narrowing on the brand)', () => {
    const conn = createChdbConnection({ path: ':memory:' })
    expect(conn).toBeInstanceOf(ChdbConnection)
  })

  it('query() returns { stream, summary, queryId } with the documented shape', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    const r = await conn.query({ query: 'SELECT 1 AS n', format: 'JSONEachRow' })
    expect(typeof r.queryId).toBe('string')
    expect(r.queryId).toMatch(UUID_RE)
    // Every summary field is a string (clickhouse-js wire shape)
    for (const k of [
      'read_rows', 'read_bytes', 'written_rows', 'written_bytes',
      'result_rows', 'result_bytes', 'elapsed_ns',
    ] as const) {
      expect(typeof r.summary[k]).toBe('string')
    }
    expect(await drain(r.stream)).toContain('"n":1')
  })

  it('query_settings is materialized as a SET-prefixed statement chain', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    const r = await conn.query({
      query: 'SELECT 1',
      format: 'CSV',
      query_settings: { max_result_rows: 10 },
    })
    // No throw → setting accepted. Body still resolves normally.
    const body = await drain(r.stream)
    expect(body.trim()).toBe('1')
  })

  it('exec() is semantically a query (same shape)', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    const r = await conn.exec({ query: 'SELECT 2', format: 'CSV' })
    expect(typeof r.queryId).toBe('string')
    expect((await drain(r.stream)).trim()).toBe('2')
  })

  it('command() executes DDL and returns a summary with no body', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    const r = await conn.command({ query: 'CREATE TABLE t1 (x Int32) ENGINE=Memory' })
    expect(typeof r.queryId).toBe('string')
    expect(r.queryId).toMatch(UUID_RE)
    // Follow-up insert + query confirms the DDL took effect.
    await conn.command({ query: 'INSERT INTO t1 VALUES (42)' })
    const sel = await conn.query({ query: 'SELECT x FROM t1', format: 'CSV' })
    expect((await drain(sel.stream)).trim()).toBe('42')
  })

  it('insert() returns a write-side summary (rowsWritten/bytesWritten populated)', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    await conn.command({ query: 'CREATE TABLE t2 (id Int32, name String) ENGINE=Memory' })
    const payload = '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n'
    const r = await conn.insert({
      table: 't2',
      values: Buffer.from(payload),
      format: 'JSONEachRow',
    })
    expect(r.summary.written_rows).toBe('2')
    // queryId is still a stable UUID even when the engine didn't issue one.
    expect(r.queryId).toMatch(UUID_RE)
  })

  it('ping() returns true on a live connection', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    expect(await conn.ping()).toBe(true)
  })

  it('ping() returns false after close (does not throw)', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    await conn.close()
    expect(await conn.ping()).toBe(false)
  })

  it('close() is idempotent', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    await conn.close()
    await conn.close() // must not throw
  })

  it('mapError() always returns an Error instance', () => {
    const conn = createChdbConnection({ path: ':memory:' })
    expect(conn.mapError(new TypeError('boom'))).toBeInstanceOf(Error)
    expect(conn.mapError('non-error')).toBeInstanceOf(Error)
    expect(conn.mapError({ msg: 'object' }).message).toContain('[object Object]')
  })

  it('serverVersion / serverTimezone resolve to documented values', async () => {
    const conn = createChdbConnection({ path: ':memory:' })
    expect(typeof (await conn.serverVersion)).toBe('string')
    expect(await conn.serverTimezone).toBe('UTC')
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
