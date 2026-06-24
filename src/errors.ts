/**
 * Typed error model for the low-level binding.
 *
 * Iron rules encoded here:
 *  1. Every failure surfaced to JS is a typed `ChdbError` subclass — never a
 *     bare `Error`, never a silent swallow.
 *  2. `.cause` preserves the originating error (ES2022); Layer 2 may re-wrap as
 *     `ClickHouseError` but must keep `.cause` intact.
 *  3. A native ClickHouse error code routes to the most specific subclass; an
 *     unrecognised code falls back to `ChdbQueryError` but still preserves
 *     `clickhouseCode` (it is never downgraded to an untyped Error).
 *
 * `code` is the stable machine-readable discriminator; `clickhouseCode` is the
 * raw ClickHouse exception code (e.g. 62) when one is available.
 */

export interface ChdbErrorOptions {
  /** Originating error, preserved on `.cause` (ES2022). */
  cause?: unknown
  /** Raw ClickHouse exception code, when known. */
  clickhouseCode?: number
}

export abstract class ChdbError extends Error {
  /** Stable machine-readable code, e.g. `'CHDB_QUERY'`. */
  abstract readonly code: string
  /** Raw ClickHouse exception code (e.g. 57), when available. */
  readonly clickhouseCode?: number

  constructor(message: string, options?: ChdbErrorOptions) {
    // Only pass `cause` to super when defined, so `.cause` stays absent
    // (rather than `undefined`) when there is no underlying error.
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    // Restore the prototype chain (TS classes extending built-ins lose it when
    // compiled to older targets / run through some bundlers) so `instanceof`
    // works for every subclass.
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = new.target.name
    if (options?.clickhouseCode !== undefined) {
      this.clickhouseCode = options.clickhouseCode
    }
  }
}

/** `chdb_query` returned a result carrying an error. */
export class ChdbQueryError extends ChdbError {
  readonly code: string = 'CHDB_QUERY'
}

/** ClickHouse code is in the syntax class (62, …). Subdivision of query error. */
export class ChdbSyntaxError extends ChdbQueryError {
  override readonly code = 'CHDB_SYNTAX'
}

/** connect failed, or the single-active-connection constraint was violated. */
export class ChdbConnectionError extends ChdbError {
  readonly code = 'CHDB_CONNECTION'
}

/** Operation attempted on an already-closed session. */
export class ChdbClosedError extends ChdbError {
  readonly code = 'CHDB_CLOSED'
}

/** Stream fetch / cancel / free failed. */
export class ChdbStreamError extends ChdbError {
  readonly code: string = 'CHDB_STREAM'
}

/** Arrow IPC parse / scan path failure. Subdivision of stream error. */
export class ChdbArrowError extends ChdbStreamError {
  override readonly code = 'CHDB_ARROW'
}

/** queryBind parameter serialization / type / identifier validation failed. */
export class ChdbBindError extends ChdbError {
  readonly code = 'CHDB_BIND'
}

/**
 * The fluent query builder could not turn a chain into SQL — e.g. a SELECT with
 * no source, an unsupported expression, or an empty IN list. This is the only
 * net-new error the builder layer introduces: it is raised while building SQL,
 * before any query runs, so it never carries a ClickHouse code. Runtime failures
 * (syntax, connection, timeout, …) still surface as the existing classes above.
 */
export class ChdbCompileError extends ChdbError {
  readonly code = 'CHDB_COMPILE'
}

/** Progress snapshot carried by streaming-insert callbacks and errors (payload-side ledger). */
export interface InsertProgress {
  /** Rows flushed to the engine so far (non-empty payload lines; exact for line-delimited formats). */
  rowsSent: number
  /** Payload bytes flushed so far. */
  bytesSent: number
  /** Chunks flushed so far. */
  chunks: number
}

/**
 * Streaming-insert failure discriminator (streaming-insert backpressure model):
 *  - 'source-error'          the source stream errored or closed prematurely
 *  - 'backpressure-overflow' an un-pausable source overran the bounded buffer
 *  - 'write-failure'         a chunk's INSERT failed in the engine
 *  - 'row-too-large'         a single row exceeded maxRowBytes (no row boundary found)
 * (A stalled producer surfaces as ChdbTimeoutError with reason 'stall'.)
 */
export type InsertFailureReason =
  | 'source-error'
  | 'backpressure-overflow'
  | 'write-failure'
  | 'row-too-large'

export interface ChdbInsertErrorOptions extends ChdbErrorOptions {
  reason?: InsertFailureReason
  /** 1-based row number the engine failed at (absolute across a streamed insert). */
  failedAtRow?: number
  progress?: InsertProgress
}

/** Insert serialization / execution / timeout. Subdivision of query error. */
export class ChdbInsertError extends ChdbQueryError {
  override readonly code = 'CHDB_INSERT'
  readonly reason?: InsertFailureReason
  readonly failedAtRow?: number
  readonly progress?: InsertProgress

  constructor(message: string, options?: ChdbInsertErrorOptions) {
    super(message, options)
    if (options?.reason !== undefined) this.reason = options.reason
    if (options?.failedAtRow !== undefined) this.failedAtRow = options.failedAtRow
    if (options?.progress !== undefined) this.progress = options.progress
  }
}

/** AbortSignal fired. `.name` is `'AbortError'` to match the web platform. */
export class ChdbAbortError extends ChdbError {
  readonly code = 'CHDB_ABORT'
  readonly progress?: InsertProgress
  constructor(
    message = 'The operation was aborted',
    options?: ChdbErrorOptions & { progress?: InsertProgress },
  ) {
    super(message, options)
    this.name = 'AbortError'
    if (options?.progress !== undefined) this.progress = options.progress
  }
}

/** Query exceeded its deadline (watchdog), or a streamed-insert source stalled. */
export class ChdbTimeoutError extends ChdbError {
  readonly code = 'CHDB_TIMEOUT'
  /** 'stall' when a streaming-insert producer went idle past stallTimeout. */
  readonly reason?: 'stall'
  readonly progress?: InsertProgress

  constructor(
    message: string,
    options?: ChdbErrorOptions & { reason?: 'stall'; progress?: InsertProgress },
  ) {
    super(message, options)
    if (options?.reason !== undefined) this.reason = options.reason
    if (options?.progress !== undefined) this.progress = options.progress
  }
}

/** Loader could not find a native subpackage for this platform/arch/libc. */
export class ChdbPlatformUnsupportedError extends ChdbError {
  readonly code = 'CHDB_PLATFORM'
}

/** Main package / native subpackage version mismatch. */
export class ChdbBinaryVersionMismatchError extends ChdbError {
  readonly code = 'CHDB_ABI'
}

/** Native panic fallback — surfaced as a typed error, never crashing the process. */
export class ChdbInternalError extends ChdbError {
  readonly code = 'CHDB_INTERNAL'
}

/** Type guard for the whole hierarchy. */
export function isChdbError(value: unknown): value is ChdbError {
  return value instanceof ChdbError
}

/**
 * ClickHouse exception codes that map to {@link ChdbSyntaxError}.
 * Kept deliberately narrow (true parse-time syntax) and extensible; everything
 * else stays a {@link ChdbQueryError} with `clickhouseCode` preserved.
 *
 * 62 = SYNTAX_ERROR.
 */
const SYNTAX_CLASS_CODES: ReadonlySet<number> = new Set([62])

/**
 * Parse the leading `Code: <n>.` prefix that ClickHouse / chdb error messages
 * carry, e.g. `"Code: 62. DB::Exception: Syntax error: ..."`.
 * Returns `undefined` when no code prefix is present.
 */
export function parseClickHouseCode(message: string): number | undefined {
  const m = /^Code:\s*(\d+)\b/.exec(message)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/**
 * Map a raw native error (message + optional code) to the most specific query
 * error subclass. Unrecognised codes fall back to {@link ChdbQueryError} while
 * still preserving `clickhouseCode` — never downgraded to an untyped Error.
 *
 * @param message native error text (becomes the JS error message)
 * @param clickhouseCode explicit code; when omitted it is parsed from `message`
 * @param cause optional originating error preserved on `.cause`
 */
export function mapNativeError(
  message: string,
  clickhouseCode?: number,
  cause?: unknown,
): ChdbQueryError {
  const code = clickhouseCode ?? parseClickHouseCode(message)
  const options: ChdbErrorOptions = { clickhouseCode: code, cause }
  if (code !== undefined && SYNTAX_CLASS_CODES.has(code)) {
    return new ChdbSyntaxError(message, options)
  }
  return new ChdbQueryError(message, options)
}
