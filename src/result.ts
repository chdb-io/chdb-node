/**
 * Result of an async query (design §3.1/§3.4). Wraps the raw output bytes plus
 * engine metrics. `text()` / `json()` are lazy views over the same buffer.
 */
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
}
