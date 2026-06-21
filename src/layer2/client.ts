/**
 * `ChdbClickHouseClient` — the byte-compat surface of `@clickhouse/client`'s
 * `ClickHouseClient` (design §2). A thin translation layer: every method maps
 * its params onto Layer 1's Session API and rewraps the result/error into the
 * shapes clickhouse-js callers expect. No HTTP/socket code lives here.
 */

import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { ChdbResultSet } from './result_set'
import { wrapError } from './error_map'
import { assertNoClusterTopology } from './sql_guard'
import { buildSettingsPrefix } from './settings'
import { formatQueryParams } from './params'
import { isJSONFamily } from './formats'
import { validateIdentifier } from '../serialize'
import { ChdbClosedError, ChdbInsertError } from '../errors'
import type { Layer1Session } from './layer1'
import type { InternalClientConfig } from './create_client'
import type {
  ClickHouseSummary,
  CommandParams,
  CommandResult,
  DataFormat,
  ExecParams,
  ExecParamsWithValues,
  ExecResult,
  InsertParams,
  InsertResult,
  PingParams,
  PingResult,
  QueryParams,
  QueryParamsWithFormat,
} from './types'

interface NativeMetrics {
  rowsRead: number
  bytesRead: number
  elapsed: number
}

function nsFromElapsed(elapsed: number | undefined): string {
  return String(Math.max(0, Math.round((elapsed || 0) * 1e9)))
}

/** Synthesize a {@link ClickHouseSummary} from Layer 1 read-path metrics. */
function readSummary(m: NativeMetrics): ClickHouseSummary {
  const rr = String(m.rowsRead || 0)
  const rb = String(m.bytesRead || 0)
  return {
    read_rows: rr,
    read_bytes: rb,
    written_rows: '0',
    written_bytes: '0',
    total_rows_to_read: '0',
    result_rows: rr,
    result_bytes: rb,
    elapsed_ns: nsFromElapsed(m.elapsed),
  }
}

/** Synthesize a {@link ClickHouseSummary} for an insert. */
function writeSummary(rowsWritten: number, bytesRead: number, elapsed: number): ClickHouseSummary {
  const rw = String(rowsWritten || 0)
  return {
    read_rows: rw,
    read_bytes: String(bytesRead || 0),
    written_rows: rw,
    written_bytes: String(bytesRead || 0),
    total_rows_to_read: '0',
    result_rows: '0',
    result_bytes: '0',
    elapsed_ns: nsFromElapsed(elapsed),
  }
}

function isNodeReadable(v: unknown): v is Readable {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { pipe?: unknown }).pipe === 'function' &&
    typeof (v as { on?: unknown }).on === 'function'
  )
}

async function drainStream(
  stream: Readable,
): Promise<{ kind: 'rows'; rows: unknown[] } | { kind: 'raw'; data: string } | { kind: 'empty' }> {
  const chunks: unknown[] = []
  let objectMode: boolean | null = null
  for await (const chunk of stream) {
    if (objectMode === null) {
      objectMode = !(Buffer.isBuffer(chunk) || typeof chunk === 'string')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return { kind: 'empty' }
  if (objectMode) return { kind: 'rows', rows: chunks }
  const data = chunks
    .map((c) => (Buffer.isBuffer(c) ? c.toString('utf8') : String(c)))
    .join('')
  return { kind: 'raw', data }
}

/** Build the column clause for a raw-data INSERT (mirrors Layer 1 insert). */
function columnsClause(columns: InsertParams['columns']): string {
  if (!columns) return ''
  if (Array.isArray(columns)) {
    return ` (${columns.map(validateIdentifier).join(', ')})`
  }
  return ` (* EXCEPT (${columns.except.map(validateIdentifier).join(', ')}))`
}

export class ChdbClickHouseClient {
  readonly #cfg: InternalClientConfig
  #closed = false
  #dbApplied = false
  #dbPromise: Promise<void> | undefined

  constructor(cfg: InternalClientConfig) {
    this.#cfg = cfg
  }

  #ensureOpen(): void {
    if (this.#closed) throw new ChdbClosedError('the chDB client has been closed')
  }

  /** Acquire the underlying session and lazily apply the configured database. */
  async #session(): Promise<Layer1Session> {
    this.#ensureOpen()
    const session = this.#cfg.acquire()
    if (this.#cfg.database && !this.#dbApplied) {
      if (this.#dbPromise === undefined) {
        const db = validateIdentifier(this.#cfg.database)
        this.#dbPromise = session.queryAsync(`USE ${db}`, { format: 'CSV' }).then(() => {
          this.#dbApplied = true
        })
      }
      try {
        await this.#dbPromise
      } catch (e) {
        // A failed USE must not poison the client: clear the memoized (rejected)
        // promise so the next operation retries instead of replaying the error.
        this.#dbPromise = undefined
        throw e
      }
    }
    return session
  }

  #queryOpts(params: { abort_signal?: AbortSignal }): { signal?: AbortSignal; timeout?: number } {
    const o: { signal?: AbortSignal; timeout?: number } = {}
    if (params.abort_signal) o.signal = params.abort_signal
    // request_timeout → query deadline; NOT defaulted to 30s (design §4.1).
    if (this.#cfg.requestTimeout !== undefined) o.timeout = this.#cfg.requestTimeout
    return o
  }

  /**
   * Run a SELECT-like statement. Default format `JSON`. `query_params` →
   * server-side binding; otherwise plain. Returns a {@link ChdbResultSet}.
   */
  async query<Format extends DataFormat = 'JSON'>(
    params: QueryParamsWithFormat<Format>,
  ): Promise<ChdbResultSet<Format>> {
    this.#ensureOpen()
    assertNoClusterTopology(params.query)
    const format = (params.format ?? 'JSON') as string
    const query_id = params.query_id ?? randomUUID()
    try {
      const session = await this.#session()
      // Byte-compat: the ClickHouse server (and thus clickhouse-js) defaults
      // output_format_json_quote_64bit_integers=1, so Int64/UInt64 come back as
      // strings in JSON (lossless). chDB defaults it OFF, which would let
      // JSON.parse silently truncate big ints — so we inject the server default
      // for JSON-family output. The user can still override it via
      // clickhouse_settings.
      const jsonDefaults = isJSONFamily(format)
        ? { output_format_json_quote_64bit_integers: 1 }
        : undefined
      const sql =
        buildSettingsPrefix(jsonDefaults, this.#cfg.clientSettings, params.clickhouse_settings) +
        params.query
      const opts = { ...this.#queryOpts(params), format }
      const raw = params.query_params
        ? await session.queryBindAsync(sql, formatQueryParams(params.query_params), {
            ...opts,
            preformatted: true,
          })
        : await session.queryAsync(sql, opts)
      return new ChdbResultSet<Format>(raw.bytes(), format, query_id)
    } catch (e) {
      throw wrapError(e)
    }
  }

  /** Execute a no-output statement (DDL, custom inserts). Body is discarded. */
  async command(params: CommandParams): Promise<CommandResult> {
    this.#ensureOpen()
    assertNoClusterTopology(params.query)
    const query_id = params.query_id ?? randomUUID()
    try {
      const session = await this.#session()
      const sql =
        buildSettingsPrefix(this.#cfg.clientSettings, params.clickhouse_settings) + params.query
      const raw = await session.queryAsync(sql, { ...this.#queryOpts(params), format: 'CSV' })
      return {
        query_id,
        response_headers: {},
        http_status_code: 200,
        summary: readSummary(raw),
      }
    } catch (e) {
      throw wrapError(e)
    }
  }

  /**
   * Like {@link command}, but returns the output as a `stream` (over the
   * materialized bytes). `values` (a custom-INSERT data stream) are appended
   * after the `FORMAT` clause the caller put in `query`.
   */
  async exec(params: ExecParams | ExecParamsWithValues): Promise<ExecResult> {
    this.#ensureOpen()
    assertNoClusterTopology(params.query)
    const query_id = params.query_id ?? randomUUID()
    try {
      const session = await this.#session()
      let sql =
        buildSettingsPrefix(this.#cfg.clientSettings, params.clickhouse_settings) + params.query
      const values = (params as ExecParamsWithValues).values
      if (values !== undefined && values !== null) {
        const drained = await drainStream(values)
        if (drained.kind === 'raw') sql = `${sql}\n${drained.data}`
        else if (drained.kind === 'rows')
          sql = `${sql}\n${drained.rows.map((r) => JSON.stringify(r)).join('\n')}`
      }
      const raw = await session.queryAsync(sql, { ...this.#queryOpts(params), format: 'CSV' })
      const stream = Readable.from([Buffer.from(raw.bytes())])
      return {
        stream,
        query_id,
        response_headers: {},
        http_status_code: 200,
        summary: readSummary(raw),
      }
    } catch (e) {
      throw wrapError(e)
    }
  }

  /**
   * Insert rows. Default format `JSONCompactEachRow`. Accepts all four
   * clickhouse-js value forms (array / stream / `InputJSON` / records). An empty
   * array short-circuits to `{ executed: false }` with an empty `query_id`.
   */
  async insert<T>(params: InsertParams<Readable, T>): Promise<InsertResult> {
    this.#ensureOpen()
    const query_id = params.query_id ?? randomUUID()
    try {
      const session = await this.#session()
      const norm = await this.#normalizeInsertValues(params.values)

      if (norm.kind === 'empty') {
        return { executed: false, query_id: '', response_headers: {}, http_status_code: 200 }
      }

      // Both row arrays and raw streams insert via a FORMAT-tailed dataset, never
      // SQL `VALUES`. clickhouse-js inserts the same way, so the engine's FORMAT
      // parser — not a hand-built VALUES literal — decodes complex types (arrays,
      // maps, tuples, Nested, JSON), which the VALUES path mis-encoded.
      const table = validateIdentifier(params.table)
      let data: string
      let rowCount: number | undefined
      let format: string
      if (norm.kind === 'rows') {
        const rows = norm.rows
        // Reject an `undefined` cell (the one JS-level guard kept): JSON.stringify
        // would silently drop the key (objects) or coerce it to null (arrays), so
        // an accidentally-missing field would land as a column default. An
        // explicit `null` is honored — it serializes to JSON null and binds as
        // ClickHouse NULL, matching clickhouse-js.
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i]
          const cells = Array.isArray(r) ? r : Object.values(r as Record<string, unknown>)
          if (cells.some((v) => v === undefined)) {
            throw new ChdbInsertError(
              `undefined value in insert row ${i}; pass null for an explicit NULL`,
            )
          }
        }
        // clickhouse-js encodes object rows as JSONEachRow and positional arrays
        // as JSONCompactEachRow (its default); infer from the row shape when the
        // caller does not pin a format.
        format = (params.format ??
          (Array.isArray(rows[0]) ? 'JSONCompactEachRow' : 'JSONEachRow')) as string
        data = rows.map((r) => JSON.stringify(r)).join('\n')
        rowCount = rows.length
      } else {
        format = (params.format ?? 'JSONCompactEachRow') as string
        data = norm.data
      }
      const sql =
        buildSettingsPrefix(this.#cfg.clientSettings, params.clickhouse_settings) +
        `INSERT INTO ${table}${columnsClause(params.columns)} FORMAT ${format}\n${data}`
      const raw = await session.queryAsync(sql, { ...this.#queryOpts(params), format: 'CSV' })
      return {
        executed: true,
        query_id,
        response_headers: {},
        http_status_code: 200,
        // The inline INSERT channel does not report an engine row ledger, so for
        // row arrays the written count is the number of rows submitted (same as
        // the prior VALUES path); for a raw stream it is left to readSummary.
        summary:
          rowCount === undefined
            ? readSummary(raw)
            : writeSummary(rowCount, raw.bytesRead ?? 0, raw.elapsed ?? 0),
      }
    } catch (e) {
      throw wrapError(e)
    }
  }

  async #normalizeInsertValues(
    values: unknown,
  ): Promise<{ kind: 'empty' } | { kind: 'rows'; rows: unknown[] } | { kind: 'raw'; data: string }> {
    if (Array.isArray(values)) {
      return values.length === 0 ? { kind: 'empty' } : { kind: 'rows', rows: values }
    }
    if (isNodeReadable(values)) {
      const drained = await drainStream(values)
      if (drained.kind === 'empty') return { kind: 'empty' }
      if (drained.kind === 'rows') return drained.rows.length ? drained : { kind: 'empty' }
      return drained
    }
    if (values && typeof values === 'object') {
      const obj = values as { meta?: unknown; data?: unknown }
      // InputJSON { meta, data }
      if (Array.isArray(obj.data) && Array.isArray(obj.meta)) {
        return obj.data.length ? { kind: 'rows', rows: obj.data } : { kind: 'empty' }
      }
      // InputJSONObjectEachRow: Record<string, T> → rows are the values
      const rows = Object.values(values as Record<string, unknown>)
      return rows.length ? { kind: 'rows', rows } : { kind: 'empty' }
    }
    return { kind: 'empty' }
  }

  /** Health check via `SELECT 1`. Never throws — errors land in the result. */
  async ping(params?: PingParams): Promise<PingResult> {
    try {
      if (this.#closed) {
        return { success: false, error: new ChdbClosedError('the chDB client has been closed') }
      }
      const session = await this.#session()
      const opts: { signal?: AbortSignal; format: string } = { format: 'CSV' }
      if (params && 'abort_signal' in params && params.abort_signal) {
        opts.signal = params.abort_signal
      }
      await session.queryAsync('SELECT 1', opts)
      return { success: true }
    } catch (e) {
      return { success: false, error: wrapError(e) }
    }
  }

  /** Release this client's connection reference. Idempotent; never throws. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#cfg.release()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}
