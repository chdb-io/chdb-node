/**
 * `.chdb` extension namespace — chDB-specific escape hatches.
 *
 * These methods expose chdb-node's native surface that does NOT fit on the
 * cross-backend {@link Connection} interface (which by design is shaped after
 * `@clickhouse/client`'s public Connection contract). They are reachable as
 * `connection.chdb.*` on a ChdbConnection instance, and let users:
 *
 *   - bypass the materialize-then-Readable shape of `Connection.query` and
 *     work directly with the native single-shot ChdbResult (`bytes()`,
 *     `text()`, `json()`, `toArrow()` — including the apache-arrow path
 *     for `format: 'arrow'`);
 *   - run a real streaming query through `Session.queryStream` (chunked
 *     output in the chosen format, lazily fetched on the libuv thread);
 *   - do raw passthrough inserts where the V8 Buffer is handed to the
 *     native side zero-copy and chDB's multithreaded parser does the work
 *     (matches the byte-compat semantics of chdb-node's `Session.insert`
 *     raw form);
 *   - read session metadata (the on-disk path, `isTemp`).
 *
 * Why a separate namespace rather than additional methods on {@link Connection}?
 *
 *   The Connection interface is the cross-backend contract: same shape will
 *   be implemented by future backends and consumed by `@clickhouse/client`'s
 *   eventual `connection` injection point. chDB-only capabilities do not
 *   belong on that contract — they live here, scoped under `.chdb`, so a
 *   higher-level client can statically narrow on the brand and surface
 *   `client.chdb.queryAsync` exclusively when the connection is a chdb one.
 *
 * The set of methods exposed here is intentionally LIMITED to what chdb-node
 * actually supports today. Aspirational features (Python() table function,
 * UDF registration) are not present because chdb-node does not expose them
 * yet; they will be added when chdb-node lands the underlying native
 * support.
 */

import type {
  ChdbResult as RootChdbResult,
  ChdbQueryStream as RootChdbQueryStream,
  QueryOptions as RootQueryOptions,
  StreamOptions as RootStreamOptions,
  RawInsertParams as RootRawInsertParams,
  RawInsertSummary as RootRawInsertSummary,
  StreamInsertParams as RootStreamInsertParams,
  StreamInsertSummary as RootStreamInsertSummary,
} from '../../index'

/**
 * Read-only session metadata. Same data Layer 1's {@link Session} exposes —
 * just surfaced under `.chdb.session` to make the connection-level access
 * pattern obvious.
 */
export interface ChdbSessionInfo {
  /** Filesystem path the underlying chDB session is bound to. */
  readonly path: string
  /** True when the session is using a process-managed temp directory. */
  readonly isTemp: boolean
}

/**
 * The `.chdb` extension namespace. Reachable as
 * `chdbConnection.chdb` on instances of {@link ChdbConnection}.
 *
 * Methods are thin wrappers around the corresponding Layer 1 Session
 * methods, preserving their full option surface (signal, timeout, format,
 * etc.) and their return shapes so existing chdb-node users can migrate
 * to the pluggable Connection without losing access to the native API.
 */
export interface ChdbExtension {
  /** Session metadata (path, isTemp). */
  readonly session: ChdbSessionInfo

  /**
   * Single-shot async query — returns the native {@link ChdbResult} with
   * `bytes() / text() / json() / toArrow()` views over the same buffer.
   * Use this when you want the result as bytes or apache-arrow Table
   * without going through {@link Connection.query}'s Readable shape.
   */
  queryAsync(sql: string, opts?: RootQueryOptions): Promise<RootChdbResult>

  /**
   * True streaming query — returns a {@link ChdbQueryStream} that yields
   * one {@link StreamChunk} per native fetch. The chosen format must be a
   * streaming-friendly format (default: `'JSONEachRow'`). Only one active
   * stream per session.
   */
  queryStream(sql: string, opts?: RootStreamOptions): RootChdbQueryStream

  /**
   * Raw passthrough insert: the payload Buffer is handed to the native
   * side zero-copy, and chDB's multithreaded parser does all the parsing.
   * The payload must already be in the declared FORMAT (whitelisted —
   * see Layer 1's RawInsertFormat).
   */
  rawInsert(params: RootRawInsertParams): Promise<RootRawInsertSummary>

  /**
   * Backpressured streaming insert — the source is consumed pull-based,
   * with at most one bounded chunk buffered, so a fast producer is
   * throttled to the chDB write rate. Returns aggregate progress.
   */
  streamInsert(params: RootStreamInsertParams): Promise<RootStreamInsertSummary>
}

/**
 * Build a {@link ChdbExtension} bound to a Layer 1 Session. Internal to
 * chdb-node; users obtain a ChdbExtension via `chdbConnection.chdb`.
 */
export function makeChdbExtension(session: {
  path: string
  isTemp: boolean
  queryAsync: (sql: string, opts?: RootQueryOptions) => Promise<RootChdbResult>
  queryStream: (sql: string, opts?: RootStreamOptions) => RootChdbQueryStream
  insert: (params: object) => Promise<unknown>
}): ChdbExtension {
  const sessionInfo: ChdbSessionInfo = Object.freeze({
    get path() {
      return session.path
    },
    get isTemp() {
      return session.isTemp
    },
  })
  return {
    session: sessionInfo,
    queryAsync: (sql, opts) => session.queryAsync(sql, opts),
    queryStream: (sql, opts) => session.queryStream(sql, opts),
    rawInsert: (params) => session.insert(params) as Promise<RootRawInsertSummary>,
    streamInsert: (params) => session.insert(params) as Promise<RootStreamInsertSummary>,
  }
}
