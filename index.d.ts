/**
 * Executes a query using the chdb addon.
 * 
 * @param query The query string to execute.
 * @param format The format for the query result, default is "CSV".
 * @returns The query result as a string.
 */
export function query(query: string, format?: string): string;

/**
 * Executes a query with parameters using the chdb addon.
 * 
 * @param query The query string to execute.
 * @param binding arguments for parameters defined in the query.
 * @param format The format for the query result, default is "CSV".
 * @returns The query result as a string.
 */
export function queryBind(query:string, args: object, format?:string): string;

/**
 * Options for async queries.
 */
export interface QueryOptions {
  /** Output format (default "CSV"). */
  format?: string;
  /**
   * Abort the query. NOTE: single-shot queries cannot be truly interrupted —
   * aborting rejects early while the underlying computation finishes in the
   * background.
   */
  signal?: AbortSignal;
  /** Reject after this many milliseconds (same honest single-shot semantics). */
  timeout?: number;
}

/**
 * Result of an async query: raw bytes plus engine metrics, with lazy text/json
 * views over the same buffer.
 */
export interface ChdbResult {
  readonly elapsed: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  bytes(): Uint8Array;
  text(): string;
  json<T = unknown>(): T;
  /**
   * Parse the result as an Arrow Table (use with `{ format: 'arrow' }`).
   * Requires the optional `apache-arrow` peer dependency. Returns an
   * apache-arrow `Table` (typed as `unknown` to avoid a hard dependency).
   */
  toArrow(): unknown;
}

/**
 * Executes a query asynchronously (non-blocking; runs off the event loop).
 */
export function queryAsync(query: string, opts?: QueryOptions): Promise<ChdbResult>;

/**
 * Executes a parameterized query asynchronously (server-side binding).
 */
export function queryBindAsync(query: string, params: object, opts?: QueryOptions): Promise<ChdbResult>;

/**
 * Parameters for {@link insert} / {@link Session.insert}.
 */
export interface InsertParams {
  /** Target table (optionally db-qualified). */
  table: string;
  /** Rows: array of objects, or array of positional value arrays. */
  values: ReadonlyArray<Record<string, unknown> | ReadonlyArray<unknown>>;
  /** Explicit column list, or `{ except }` to exclude columns (positional rows). */
  columns?: ReadonlyArray<string> | { except: ReadonlyArray<string> };
}

/**
 * Summary returned by an insert.
 */
export interface InsertSummary {
  rowsWritten: number;
  bytesRead: number;
  elapsed: number;
}

/**
 * Raw insert formats (v1: text formats; the format name is whitelisted, never
 * passed through). TSV/TSVWithNames are aliases of TabSeparated*.
 */
export type RawInsertFormat =
  | 'JSONEachRow' | 'JSONCompactEachRow'
  | 'CSV' | 'CSVWithNames'
  | 'TSV' | 'TabSeparated' | 'TSVWithNames' | 'TabSeparatedWithNames';

/**
 * Stream-insert formats: line-delimited only. These formats escape raw
 * newlines inside values, so a raw '\n' is always a row boundary and every
 * re-chunked INSERT payload stays independently valid. CSV (raw newlines legal
 * inside quoted fields) and WithNames variants (header cannot repeat per
 * chunk) are excluded — use a single-shot Buffer insert for those.
 */
export type StreamInsertFormat = 'JSONEachRow' | 'JSONCompactEachRow' | 'TSV' | 'TabSeparated';

/**
 * Parameters for the raw passthrough insert: the payload stays bytes
 * (off the V8 heap for Buffer/Uint8Array), is handed to the native side
 * zero-copy, and the engine's multithreaded parser does all the parsing — JS
 * never builds an object tree from the payload.
 *
 * Contract: do NOT mutate the Buffer until the returned promise settles (same
 * contract as fs.write). A string payload is accepted as a small-payload
 * convenience only — it is already a V8 string, so prefer Buffers end to end.
 */
export interface RawInsertParams {
  /** Target table (optionally db-qualified). */
  table: string;
  /** Raw payload bytes in the declared format. */
  values: Buffer | Uint8Array | string;
  /** Payload format (required; whitelisted). */
  format: RawInsertFormat;
  /** Explicit column list: INSERT INTO t (a, b) FORMAT ... */
  columns?: ReadonlyArray<string>;
  /** Per-insert settings (e.g. input_format_skip_unknown_fields: 1). */
  settings?: Record<string, string | number | boolean>;
  /** Early-settle abort (the underlying write still completes; the payload stays pinned until it does). */
  signal?: AbortSignal;
  /** Early-settle timeout in ms (same honest single-shot semantics). */
  timeout?: number;
}

/**
 * Summary of a raw insert. Two ledgers by design:
 * - rowsWritten/bytesWritten — engine-side write progress (includes cascaded
 *   materialized-view writes, same semantics as HTTP X-ClickHouse-Summary).
 * - rowsSent/bytesSent — payload-side: non-empty payload lines (exact for
 *   line-delimited formats; undefined for the CSV family) and payload bytes.
 */
export interface RawInsertSummary {
  rowsWritten: number;
  bytesWritten: number;
  rowsSent?: number;
  bytesSent: number;
  elapsed: number;
}

/** Progress snapshot for streaming inserts (payload-side ledger). */
export interface InsertProgress {
  rowsSent: number;
  bytesSent: number;
  chunks: number;
}

/**
 * Parameters for the backpressured streaming insert. The source is consumed
 * pull-based: at most one bounded chunk is buffered and each chunk's INSERT is
 * awaited before the next pull, so a fast producer is throttled to the chDB
 * write rate (backpressure is flow-control, never an error). Failures surface
 * as typed errors that always settle the promise: source-error / stall /
 * backpressure-overflow / write-failure / row-too-large / abort — each
 * carrying a progress snapshot. Semantics are at-least-once: already-flushed
 * chunks are not rolled back.
 */
export interface StreamInsertParams {
  table: string;
  /** Byte stream: Node Readable or any AsyncIterable of Buffer/Uint8Array/string chunks. */
  values: NodeJS.ReadableStream | AsyncIterable<Buffer | Uint8Array | string>;
  format: StreamInsertFormat;
  columns?: ReadonlyArray<string>;
  settings?: Record<string, string | number | boolean>;
  /** Target chunk size (default 8 MiB). */
  maxChunkBytes?: number;
  /** Single-row ceiling; exceeded without a row boundary => row-too-large (default 64 MiB). */
  maxRowBytes?: number;
  /** Bounded-buffer ceiling for un-pausable Readables => backpressure-overflow (default 64 MiB). */
  maxBufferedBytes?: number;
  /** Producer idle deadline => ChdbTimeoutError{reason:'stall'}. Off by default. */
  stallTimeout?: number;
  /** Called after each flushed chunk. */
  onProgress?: (p: InsertProgress) => void;
  signal?: AbortSignal;
  /** Per-chunk timeout in ms. */
  timeout?: number;
}

/** Summary of a streaming insert (both ledgers accumulated across chunks). */
export interface StreamInsertSummary {
  rowsWritten: number;
  bytesWritten: number;
  rowsSent: number;
  bytesSent: number;
  chunks: number;
  elapsed: number;
}

/**
 * Inserts rows via an inline multi-row INSERT (default connection). Async; never
 * reads stdin.
 */
export function insert(params: InsertParams): Promise<InsertSummary>;
/** raw passthrough insert (default connection). */
export function insert(params: RawInsertParams): Promise<RawInsertSummary>;
/** Backpressured streaming insert (default connection). */
export function insert(params: StreamInsertParams): Promise<StreamInsertSummary>;

/**
 * Options for {@link Session.queryStream}.
 */
export interface StreamOptions {
  /** Output format (default "JSONEachRow"). rows() needs a JSON row format. */
  format?: string;
  /** Abort between chunks (real cancellation for streaming). */
  signal?: AbortSignal;
}

/**
 * One materialized chunk of a streaming result.
 */
export interface StreamChunk {
  readonly numRows: number;
  readonly numBytes: number;
  /** Raw chunk bytes in the chosen format. */
  raw(): Uint8Array;
  /** UTF-8 text of the chunk. */
  text(): string;
  /** Parsed rows (requires a JSON row format). */
  rows<T = unknown>(): T[];
}

/**
 * AsyncIterable over streaming result chunks. Cancelled/freed automatically on
 * completion, early break, throw, or an explicit cancel().
 */
export interface ChdbQueryStream extends AsyncIterable<StreamChunk> {
  readonly closed: boolean;
  /** Row-level async iterator (flattens chunk.rows()). */
  rows<T = unknown>(): AsyncIterableIterator<T>;
  /** Node Readable (object mode) over rows. */
  toReadable(): import('stream').Readable;
  /** Cancel the stream and release resources. */
  cancel(): void;
}

/**
 * Options for constructing a {@link Session}.
 */
export interface SessionOptions {
  /**
   * Opt-in: install SIGINT/SIGTERM handlers that close this session. Default
   * is `false` (a library must not steal the user's signals). These handlers
   * never call `process.exit`; the app decides how to terminate.
   */
  installSignalHandlers?: boolean;
}

/**
 * Session class for managing queries and temporary paths.
 */
export class Session {
  /**
   * The path used for the session. This could be a temporary path or a provided path.
   */
  path: string;

  /**
   * Indicates whether the path is a temporary directory or not.
   */
  isTemp: boolean;

  /**
   * The opaque native connection handle, or null after cleanup().
   */
  connection: unknown;

  /**
   * Creates a new session. If no path is provided, a temporary directory is created.
   *
   * @param path Optional path for the session. If not provided, a temporary directory is used.
   * @param opts Optional session options.
   */
  constructor(path?: string, opts?: SessionOptions);

  /**
   * True while the native connection is live (i.e. not yet closed).
   */
  get open(): boolean;

  /**
   * Executes a session-bound query.
   * 
   * @param query The query string to execute.
   * @param format The format for the query result, default is "CSV".
   * @returns The query result as a string.
   */
  query(query: string, format?: string): string;

  /**
   * Executes a query with parameters using the chdb addon.
   * 
   * @param query The query string to execute.
   * @param binding arguments for parameters defined in the query.
   * @param format The format for the query result, default is "CSV".
   * @returns The query result as a string.
   */

  queryBind(query:string, args: object, format?: string): string;

  /**
   * Executes a session-bound query asynchronously (non-blocking).
   */
  queryAsync(query: string, opts?: QueryOptions): Promise<ChdbResult>;

  /**
   * Executes a session-bound parameterized query asynchronously.
   */
  queryBindAsync(query: string, params: object, opts?: QueryOptions): Promise<ChdbResult>;

  /**
   * Inserts rows via an inline multi-row INSERT. Async; never reads stdin.
   */
  insert(params: InsertParams): Promise<InsertSummary>;
  /** raw passthrough insert on this session's connection. */
  insert(params: RawInsertParams): Promise<RawInsertSummary>;
  /** Backpressured streaming insert on this session's connection. */
  insert(params: StreamInsertParams): Promise<StreamInsertSummary>;

  /**
   * Streams a query result chunk-by-chunk (only one active stream per session).
   */
  queryStream(query: string, opts?: StreamOptions): ChdbQueryStream;

  /**
   * Closes the session: releases the native connection and, for a temporary
   * session, removes the temporary directory. Idempotent and never throws.
   */
  close(): void;

  /**
   * Alias for {@link Session.close} (v2 compatibility).
   */
  cleanup(): void;

  /**
   * `using` support: closes the session on scope exit.
   */
  [Symbol.dispose](): void;
}

/**
 * Diagnostic version information for the package, the loaded libchdb, and the
 * current runtime.
 */
export function version(): {
  chdb: string;
  libchdb: string;
  platform: string;
  arch: string;
  napi?: number;
};
