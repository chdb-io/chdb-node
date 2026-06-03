/**
 * Result of an async query (design §3.1/§3.4). Wraps the raw output bytes plus
 * engine metrics. `text()` / `json()` are lazy views over the same buffer.
 */
import { ChdbArrowError } from './errors'

export interface RawResult {
  bytes: Uint8Array
  elapsed: number
  rowsRead: number
  bytesRead: number
}

const decoder = new TextDecoder('utf-8')

export class ChdbResult {
  /** Query wall-clock time in seconds (engine-reported). */
  readonly elapsed: number
  /** Rows in the result set (engine-reported). */
  readonly rowsRead: number
  /** Bytes of the result set in internal representation (engine-reported). */
  readonly bytesRead: number

  #bytes: Uint8Array
  #text?: string

  constructor(raw: RawResult) {
    this.#bytes = raw.bytes
    this.elapsed = raw.elapsed
    this.rowsRead = raw.rowsRead
    this.bytesRead = raw.bytesRead
  }

  /** Raw output bytes (e.g. Arrow IPC, Parquet, or text in the chosen format). */
  bytes(): Uint8Array {
    return this.#bytes
  }

  /** UTF-8 decode of the output (for text formats: CSV / JSON / TSV / …). */
  text(): string {
    if (this.#text === undefined) this.#text = decoder.decode(this.#bytes)
    return this.#text
  }

  /** JSON.parse of {@link text} — use with a JSON output format. */
  json<T = unknown>(): T {
    return JSON.parse(this.text()) as T
  }

  /**
   * Parse the bytes as an Arrow Table (use with `{ format: 'arrow' }`, which
   * emits the Arrow IPC stream). Requires the optional `apache-arrow` peer
   * dependency; throws ChdbArrowError if it is not installed or the bytes are
   * not valid Arrow IPC.
   *
   * v1 is the M1 path: bytes are owned by JS (copied off the engine), so the
   * returned Table is safe to hold. The M2 zero-copy path (chdb_query_arrow +
   * external ArrayBuffers) is a separate opt-in, not yet wired.
   *
   * @returns an apache-arrow `Table` (typed loosely to avoid a hard dependency).
   */
  toArrow(): unknown {
    let arrow: { tableFromIPC: (b: Uint8Array) => unknown }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      arrow = require('apache-arrow')
    } catch {
      throw new ChdbArrowError(
        "apache-arrow is not installed; run `npm i apache-arrow` to use toArrow(), or use bytes()",
      )
    }
    try {
      return arrow.tableFromIPC(this.#bytes)
    } catch (e) {
      throw new ChdbArrowError(`failed to parse Arrow IPC result: ${(e as Error).message}`, { cause: e })
    }
  }
}
