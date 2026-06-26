/**
 * Lazy accessor for the Layer 1 runtime (the package's CommonJS entry,
 * `index.js`). The fluent builder is a sibling of the pluggable Connection
 * surface (`chdb/connection`): it
 * compiles a chain to `{ sql, parameters }` and forwards execution to Layer 1's
 * `queryBindAsync` / `Session`. It never touches the native addon directly.
 *
 * The require is lazy (resolved on first call, not at module load) so the
 * load-time cycle is broken: `index.js` re-exports this surface at its bottom,
 * while this module pulls Layer 1 back in. By the time any builder terminal
 * actually runs, `index.js`'s exports are fully populated.
 */

import type { ChdbResult } from '../result'

export interface RuntimeQueryOptions {
  format?: string
  signal?: AbortSignal
  timeout?: number
  /**
   * When set, the `parameters` passed to `queryBindAsync` are already the
   * engine's `{name: literal}` bound map and are bound verbatim. The fluent
   * compiler always pre-serializes its values (so it owns the JS→ClickHouse
   * type mapping), so it always sets this.
   */
  preformatted?: boolean
}

export interface RuntimeStreamOptions {
  format?: string
  signal?: AbortSignal
}

/**
 * The subset of Layer 1's ChdbQueryStream the fluent `.stream()` terminal uses:
 * a row-level async iterator plus explicit cancellation.
 */
export interface RuntimeRowStream<O = unknown> {
  /** Lazily yields one parsed row at a time across all chunks. */
  rows(): AsyncIterableIterator<O>
  /** Cancel the stream and release the native cursor (best effort). */
  cancel(): void
}

export interface RuntimeInsertParams {
  table: string
  values: ReadonlyArray<Record<string, unknown> | ReadonlyArray<unknown>>
  columns?: ReadonlyArray<string> | { except: ReadonlyArray<string> }
}

export interface RuntimeInsertSummary {
  rowsWritten: number
  bytesRead: number
  elapsed: number
}

/** The subset of Layer 1's Session surface the fluent builder uses. */
export interface RuntimeSession {
  readonly path: string
  readonly isTemp: boolean
  readonly open: boolean
  queryAsync(query: string, opts?: RuntimeQueryOptions): Promise<ChdbResult>
  queryBindAsync(query: string, params: object, opts?: RuntimeQueryOptions): Promise<ChdbResult>
  insert(params: RuntimeInsertParams): Promise<RuntimeInsertSummary>
  queryStream(query: string, opts?: RuntimeStreamOptions): unknown
  queryStreamBind(query: string, params: object, opts?: RuntimeStreamOptions): RuntimeRowStream
  close(): void
}

export interface RuntimeSessionCtor {
  new (path?: string, opts?: { installSignalHandlers?: boolean }): RuntimeSession
}

/** One column passed to `_arrowRegisterColumns` (Arrow C Data Interface layout). */
export interface RuntimeArrowColumn {
  name: string
  /** Arrow format string: 'i' Int32, 'l' Int64, 'g' Float64, 'b' Bool, 'u' Utf8. */
  format: string
  length: number
  nullCount: number
  /** `[validity bitmap | null, data, offsets?]`. Offsets is Utf8-only. */
  buffers: ReadonlyArray<Buffer | null>
}

export interface Runtime {
  Session: RuntimeSessionCtor
  queryAsync(query: string, opts?: RuntimeQueryOptions): Promise<ChdbResult>
  queryBindAsync(query: string, params: object, opts?: RuntimeQueryOptions): Promise<ChdbResult>
  insert(params: RuntimeInsertParams): Promise<RuntimeInsertSummary>
  /** Register a JS columnar dataset as `arrowstream('<tableName>')`. */
  _arrowRegisterColumns(
    connection: unknown,
    tableName: string,
    columns: ReadonlyArray<RuntimeArrowColumn>,
  ): void
  /** Remove a previously registered arrow table. */
  _arrowUnregister(connection: unknown, tableName: string): void
}

let cached: Runtime | undefined

export function runtime(): Runtime {
  if (cached === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = require('../../index.js') as Runtime
  }
  return cached
}
