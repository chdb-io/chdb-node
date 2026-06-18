/**
 * Structural type surface for Layer 2, mirroring `@clickhouse/client` 1:1
 * (design §2). These are defined locally (not imported from clickhouse-js) so
 * the package has no runtime dependency on it — clickhouse-js is a peer used
 * only as `import type` in the compile-time compatibility tests. The CI suite
 * asserts these stay structurally assignable to the upstream types.
 */

import type { Readable } from 'stream'
import type { Row } from './result_set'

// ─────────────────────────── Formats ───────────────────────────

export type StreamableJSONDataFormat =
  | 'JSONEachRow'
  | 'JSONStringsEachRow'
  | 'JSONCompactEachRow'
  | 'JSONCompactStringsEachRow'
  | 'JSONCompactEachRowWithNames'
  | 'JSONCompactEachRowWithNamesAndTypes'
  | 'JSONCompactStringsEachRowWithNames'
  | 'JSONCompactStringsEachRowWithNamesAndTypes'
  | 'JSONEachRowWithProgress'

export type RecordsJSONFormat = 'JSONObjectEachRow'

export type SingleDocumentJSONFormat =
  | 'JSON'
  | 'JSONStrings'
  | 'JSONCompact'
  | 'JSONCompactStrings'
  | 'JSONColumnsWithMetadata'

export type RawDataFormat =
  | 'CSV'
  | 'CSVWithNames'
  | 'CSVWithNamesAndTypes'
  | 'TabSeparated'
  | 'TabSeparatedRaw'
  | 'TabSeparatedWithNames'
  | 'TabSeparatedWithNamesAndTypes'
  | 'CustomSeparated'
  | 'CustomSeparatedWithNames'
  | 'CustomSeparatedWithNamesAndTypes'
  | 'Parquet'

export type JSONDataFormat =
  | StreamableJSONDataFormat
  | SingleDocumentJSONFormat
  | RecordsJSONFormat

export type DataFormat = JSONDataFormat | RawDataFormat

// ─────────────────────── ClickHouse value types ───────────────────────

/** Permissive, structurally compatible with clickhouse-js `ClickHouseSettings`. */
export type ClickHouseSettings = Record<string, string | number | boolean | undefined>

export type ResponseHeaders = Record<string, string | string[] | undefined>

export interface ClickHouseSummary {
  read_rows: string
  read_bytes: string
  written_rows: string
  written_bytes: string
  total_rows_to_read: string
  result_rows: string
  result_bytes: string
  elapsed_ns: string
  real_time_microseconds?: string
}

export interface ResponseJSON<T = unknown> {
  data: Array<T>
  query_id?: string
  totals?: T
  extremes?: Record<string, any>
  meta?: Array<{ name: string; type: string }>
  statistics?: { elapsed: number; rows_read: number; bytes_read: number }
  rows?: number
  rows_before_limit_at_least?: number
}

export interface InputJSON<T = unknown> {
  meta: { name: string; type: string }[]
  data: T[]
}
export type InputJSONObjectEachRow<T = unknown> = Record<string, T>

export type InsertValues<Stream, T = unknown> =
  | ReadonlyArray<T>
  | Stream
  | InputJSON<T>
  | InputJSONObjectEachRow<T>

export type NonEmptyArray<T> = [T, ...T[]]

// ─────────────────────────── Query params ───────────────────────────

export interface BaseQueryParams {
  /** Engine-level settings; HTTP-only keys are ignored (design §4.2). */
  clickhouse_settings?: ClickHouseSettings
  /** `{name:Type}` placeholders → Layer 1 server-side binding. */
  query_params?: Record<string, unknown>
  /** Single-shot: rejects early; streaming: real cancellation between chunks. */
  abort_signal?: AbortSignal
  /** Passed through; a client UUID is generated if absent. */
  query_id?: string
  /** → Layer 1 Session semantics (design §4.1). */
  session_id?: string
  /** Ignored (no RBAC in embedded). */
  role?: string | Array<string>
  /** Ignored (no auth layer in embedded). */
  auth?: { username: string; password: string } | { access_token: string }
  /** Ignored (no HTTP transport). */
  http_headers?: Record<string, string>
}

export interface QueryParams extends BaseQueryParams {
  query: string
  format?: DataFormat
}

export type QueryParamsWithFormat<Format extends DataFormat> = Omit<QueryParams, 'format'> & {
  format?: Format
}

export type ExecParams = BaseQueryParams & {
  query: string
  /** Ignored (no response compression in embedded). */
  decompress_response_stream?: boolean
  /** Ignored. */
  ignore_error_response?: boolean
}

export type ExecParamsWithValues = ExecParams & {
  values: Readable
}

export type CommandParams = ExecParams

export interface InsertColumnsExcept {
  except: NonEmptyArray<string>
}

export interface InsertParams<Stream = Readable, T = unknown> extends BaseQueryParams {
  table: string
  values: InsertValues<Stream, T>
  /** Default `JSONCompactEachRow`. */
  format?: DataFormat
  columns?: NonEmptyArray<string> | InsertColumnsExcept
}

export type PingParams =
  | ({ select: false } & Pick<BaseQueryParams, 'abort_signal' | 'http_headers'>)
  | ({ select: true } & Omit<BaseQueryParams, 'query_params'>)

// ─────────────────────────── Results ───────────────────────────

export type WithHttpStatusCode = { http_status_code?: number }
export type WithClickHouseSummary = { summary?: ClickHouseSummary }
export type WithResponseHeaders = { response_headers: ResponseHeaders }

export type CommandResult = { query_id: string } & WithClickHouseSummary &
  WithResponseHeaders &
  WithHttpStatusCode

export type InsertResult = {
  executed: boolean
  query_id: string
} & WithClickHouseSummary &
  WithResponseHeaders &
  WithHttpStatusCode

export type ExecResult = {
  stream: Readable
  query_id: string
} & WithResponseHeaders &
  WithHttpStatusCode &
  WithClickHouseSummary

export type PingResult = { success: true } | { success: false; error: Error }

export type { Row }

// ─────────────────────────── Config ───────────────────────────

/**
 * `createClient` options. Mirrors `@clickhouse/client`'s
 * `NodeClickHouseClientConfigOptions` for the fields that are meaningful (or
 * deliberately ignored) in embedded mode. The default `url` is `chdb://memory`
 * (vs. clickhouse-js's `http://localhost:8123`).
 */
export interface ChdbClientConfigOptions {
  /** `chdb://memory` (default) or `chdb:///abs/path`. A non-chdb scheme throws. */
  url?: string | URL
  /** @deprecated alias of {@link url} (clickhouse-js parity). */
  host?: string
  /** Default database (applied via `USE` on the underlying connection). */
  database?: string
  /** Engine-level settings applied to every statement (HTTP-only keys ignored). */
  clickhouse_settings?: ClickHouseSettings
  /** → query deadline; NOT defaulted to 30s (design §4.1). */
  request_timeout?: number
  /** → Layer 1 Session semantics. */
  session_id?: string
  /** Ignored (no auth). */
  username?: string
  /** Ignored (no auth). */
  password?: string
  /** Ignored (no auth). */
  access_token?: string
  /** Ignored (no RBAC). */
  role?: string | Array<string>
  /** Ignored (no HTTP transport). */
  max_open_connections?: number
  /** Ignored. */
  keep_alive?: { enabled?: boolean }
  /** Ignored. */
  compression?: { request?: boolean; response?: boolean }
  /** Ignored. */
  http_headers?: Record<string, string>
  /** Ignored. */
  application?: string
  /** Ignored (no proxy/HTTP path). */
  pathname?: string
  /** Optional logger (not wired to a transport; reserved). */
  log?: { level?: number }
  /** Reserved (clickhouse-js custom JSON handling). */
  json?: { parse?: (text: string) => unknown; stringify?: (v: unknown) => string }
}
