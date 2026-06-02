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
