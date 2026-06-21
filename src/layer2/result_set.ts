/**
 * `ChdbResultSet` — byte-compat with `@clickhouse/client`'s `BaseResultSet`
 * (design §3). Unlike clickhouse-js (which wraps a live HTTP body stream), we
 * wrap the **fully materialized result buffer** that Layer 1's async query path
 * already produced. That makes engine errors surface eagerly at `await
 * client.query(...)` (matching upstream) and lets multiple result sets coexist
 * without the single-active-stream constraint.
 *
 * The public surface and semantics are identical to upstream:
 *  - `text()` — full output as a string.
 *  - `json<T>()` — format-dispatched: streamable→`T[]`, single-doc→
 *    `ResponseJSON<T>`, records→`Record<string,T>`, raw→throws.
 *  - `stream()` — a Node Readable (object mode) that yields `Row[]` chunks, with
 *    cross-chunk half-row carry-over handled by the exact same newline Transform
 *    clickhouse-js uses. Only valid for streamable formats.
 *  - `Row.text` is a PROPERTY, `Row.json()` is a METHOD (upstream's asymmetry —
 *    reproduced faithfully).
 *  - consumed-once: a second terminal call throws, like upstream.
 */

import { Readable, Transform, pipeline } from 'stream'
import {
  isStreamableFormat,
  isStreamableJSONFamily,
  isSingleDocumentJSONFamily,
  isRecordsJSONFamily,
} from './formats'

const NEWLINE = 0x0a
const decoder = new TextDecoder('utf-8')

const CONSUMED_MESSAGE = 'Stream has been already consumed'
const CLOSED_MESSAGE = 'ResultSet has been closed'

/** byte-compat with clickhouse-js `Row`. */
export interface Row<JSONType = unknown> {
  /** Raw text of the row (a PROPERTY, not a method — matches upstream). */
  text: string
  /** Parsed row; throws on a non-JSON (raw) format, exactly like upstream. */
  json<T = JSONType>(): T
}

/**
 * Build the newline-splitting object-mode Transform that turns a byte stream
 * into a stream of `Row[]`. This is clickhouse-js's exact algorithm: it carries
 * an incomplete trailing line across chunk boundaries (`incompleteChunks`) and
 * pushes one `Row[]` per source chunk. Exported so the carry-over invariant can
 * be unit-tested against arbitrary chunk boundaries.
 */
export function makeRowTransform(): Transform {
  const incompleteChunks: Buffer[] = []
  return new Transform({
    autoDestroy: true,
    objectMode: true,
    transform(chunk: Buffer, _enc, callback) {
      const rows: Row[] = []
      let lastIdx = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const idx = chunk.indexOf(NEWLINE, lastIdx)
        if (idx === -1) {
          // No row terminator left in this chunk — stash the remainder.
          if (lastIdx < chunk.length) incompleteChunks.push(chunk.subarray(lastIdx))
          if (rows.length > 0) this.push(rows)
          break
        }
        let part: Buffer
        if (incompleteChunks.length > 0) {
          incompleteChunks.push(chunk.subarray(lastIdx, idx))
          part = Buffer.concat(incompleteChunks)
          incompleteChunks.length = 0
        } else {
          part = chunk.subarray(lastIdx, idx)
        }
        const text = part.toString('utf8')
        rows.push({
          text,
          json<T = unknown>(): T {
            return JSON.parse(text) as T
          },
        })
        lastIdx = idx + 1
      }
      callback()
    },
    // The final row may not be newline-terminated; emit any buffered remainder
    // at stream end so a last unterminated row is never silently dropped.
    flush(callback) {
      if (incompleteChunks.length > 0) {
        const text = Buffer.concat(incompleteChunks).toString('utf8')
        incompleteChunks.length = 0
        if (text.length > 0) {
          this.push([
            {
              text,
              json<T = unknown>(): T {
                return JSON.parse(text) as T
              },
            },
          ])
        }
      }
      callback()
    },
  })
}

export class ChdbResultSet<Format = unknown> {
  readonly query_id: string
  readonly response_headers: Record<string, string | string[] | undefined>

  #bytes: Uint8Array
  #format: string
  #consumed = false
  #closed = false

  constructor(
    bytes: Uint8Array,
    format: string,
    query_id: string,
    response_headers: Record<string, string | string[] | undefined> = {},
  ) {
    this.#bytes = bytes
    this.#format = format
    this.query_id = query_id
    // Frozen, like upstream (synthesized empty headers in embedded mode).
    this.response_headers = Object.freeze({ ...response_headers })
  }

  #consume(): void {
    if (this.#closed) throw new Error(CLOSED_MESSAGE)
    if (this.#consumed) throw new Error(CONSUMED_MESSAGE)
    this.#consumed = true
  }

  /** Full output decoded as a UTF-8 string (valid for every format). */
  async text(): Promise<string> {
    this.#consume()
    return decoder.decode(this.#bytes)
  }

  /**
   * Format-dispatched JSON decode (byte-compat with upstream `ResultJSONType`):
   *  - streamable JSON family → `T[]`
   *  - single-document JSON   → `ResponseJSON<T>`
   *  - records JSON           → `Record<string, T>`
   *  - raw (CSV/TSV/Parquet)  → throws `Cannot decode <format> as JSON`
   */
  async json<T = unknown>(): Promise<unknown> {
    if (isStreamableJSONFamily(this.#format)) {
      // Consume via the same row pipeline used by stream(), so the two paths
      // share one decoder and behave identically.
      const out: T[] = []
      for await (const rows of this.stream() as AsyncIterable<Row[]>) {
        for (const row of rows) out.push(row.json<T>())
      }
      return out
    }
    if (isSingleDocumentJSONFamily(this.#format) || isRecordsJSONFamily(this.#format)) {
      this.#consume()
      return JSON.parse(decoder.decode(this.#bytes))
    }
    // raw formats — never decodable as JSON (upstream returns `never`).
    throw new Error(`Cannot decode ${this.#format} as JSON`)
  }

  /**
   * A Node Readable (object mode) yielding `Row[]` chunks. Only valid for
   * streamable formats; throws otherwise (upstream returns `never`). Replays the
   * materialized buffer through the canonical newline Transform.
   */
  stream(): Readable {
    if (!isStreamableFormat(this.#format)) {
      throw new Error(`${this.#format} format is not streamable`)
    }
    this.#consume()
    const source = Readable.from(
      // single source chunk; the Transform handles row framing + carry-over
      (function* (b: Uint8Array) {
        yield Buffer.from(b)
      })(this.#bytes),
    )
    const toRows = makeRowTransform()
    return pipeline(source, toRows, () => {
      /* errors propagate via the returned stream's 'error' event */
    }) as unknown as Readable
  }

  /** Mark the result set closed; subsequent terminal calls throw. Idempotent. */
  close(): void {
    this.#closed = true
  }

  [Symbol.dispose](): void {
    this.close()
  }
}
