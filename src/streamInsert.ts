/**
 * Streaming insert over the raw passthrough entry.
 * Consumes the source pull-based: at most one bounded chunk is
 * buffered, and each chunk's INSERT is awaited before the next pull — so a
 * fast producer is throttled to the chDB write rate (for an HTTP request
 * stream the pause propagates all the way to the TCP window).
 *
 * Backpressure is flow-control, never an error. What IS an error is every
 * backpressure-adjacent failure, surfaced as a typed error that always
 * settles the returned promise:
 *   source-error | stall | backpressure-overflow | write-failure |
 *   row-too-large | abort
 * Every error carries a progress snapshot. Semantics are at-least-once:
 * already-flushed chunks are not rolled back; `failedAtRow` / `rowsSent` are
 * observability fields, NOT a resume protocol.
 *
 * Chunking invariant: cuts happen only at raw '\n'. The v1 stream formats are
 * line-delimited (they escape newlines inside values), so a raw '\n' is
 * always a row boundary, every chunk is an independently valid INSERT
 * payload, and multi-byte UTF-8 can never be split (0x0A never occurs inside
 * a multi-byte sequence). Each ~8 MiB chunk is far below the engine's block
 * thresholds, so a failed chunk lands zero rows (clean retry unit).
 */

import { ChdbAbortError, ChdbInsertError, ChdbTimeoutError } from './errors'
import type { InsertProgress } from './errors'

/** Per-chunk result from the prefix-bound native inserter. */
export interface ChunkInsertResult {
  rowsWritten?: number
  bytesWritten?: number
  rowsSent?: number
  elapsed: number
}

export type ChunkInserter = (data: Buffer) => Promise<ChunkInsertResult>

export interface StreamInsertOptions {
  values: AsyncIterable<Buffer | Uint8Array | string>
  /** Target chunk size (default 8 MiB). */
  maxChunkBytes?: number
  /** Single-row ceiling: accumulating past this without a row boundary fails (default 64 MiB). */
  maxRowBytes?: number
  /** Bounded-buffer ceiling for un-pausable Readable sources (default 64 MiB). */
  maxBufferedBytes?: number
  /** Idle deadline for the producer; off by default (quiet periods are legal for long-lived ingestion). */
  stallTimeout?: number
  onProgress?: (p: InsertProgress) => void
  signal?: AbortSignal
}

export interface StreamInsertSummary {
  /** Engine-side ledger (chdb-io/chdb-core#88), accumulated across chunks; includes MV-cascade writes. */
  rowsWritten: number
  bytesWritten: number
  /** Payload-side ledger: non-empty lines / bytes flushed. */
  rowsSent: number
  bytesSent: number
  chunks: number
  elapsed: number
}

const DEFAULT_CHUNK = 8 * 1024 * 1024
const DEFAULT_MAX_ROW = 64 * 1024 * 1024
const DEFAULT_MAX_BUFFERED = 64 * 1024 * 1024

const STALL = Symbol('chdb-stall')

/** Race an iterator pull against the (re-armed per pull) stall timer. */
function raceStall<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(STALL), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

function toChunkBuffer(v: unknown): Buffer {
  if (typeof v === 'string') return Buffer.from(v, 'utf8')
  if (Buffer.isBuffer(v)) return v
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  throw new ChdbInsertError(
    `Stream insert sources must yield bytes (Buffer/Uint8Array/string), got ${typeof v}. ` +
      'For object streams map rows to NDJSON first: ' +
      `(async function* () { for await (const r of src) yield JSON.stringify(r) + '\\n' })()`,
  )
}

export async function streamInsert(
  insertChunk: ChunkInserter,
  opts: StreamInsertOptions,
): Promise<StreamInsertSummary> {
  const maxChunkBytes = opts.maxChunkBytes ?? DEFAULT_CHUNK
  const maxRowBytes = opts.maxRowBytes ?? DEFAULT_MAX_ROW
  const maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED
  const { stallTimeout, onProgress, signal } = opts
  const source = opts.values

  const progress: InsertProgress = { rowsSent: 0, bytesSent: 0, chunks: 0 }
  const summary: StreamInsertSummary = {
    rowsWritten: 0, bytesWritten: 0, rowsSent: 0, bytesSent: 0, chunks: 0, elapsed: 0,
  }
  const snap = (): InsertProgress => ({ ...progress })

  const abortError = () =>
    new ChdbAbortError(
      'Insert aborted mid-stream (already-flushed chunks are not rolled back)',
      { progress: snap() },
    )

  if (signal?.aborted) throw abortError() // pre-aborted: reject before pulling anything

  // Accumulator: list of pending buffers plus the global offset of the last
  // raw '\n' seen — tracked incrementally so no byte is scanned or copied
  // more than once (a no-newline source cannot trigger O(n²) re-concats).
  let acc: Buffer[] = []
  let accBytes = 0
  let lastNl = -1

  const flush = async (data: Buffer): Promise<void> => {
    let res: ChunkInsertResult
    try {
      res = await insertChunk(data)
    } catch (e) {
      if (e instanceof ChdbAbortError) {
        throw new ChdbAbortError(e.message, { cause: e.cause ?? e, progress: snap() })
      }
      if (e instanceof ChdbTimeoutError) {
        throw new ChdbTimeoutError(e.message, { cause: e.cause ?? e, progress: snap() })
      }
      const ie = e as ChdbInsertError
      throw new ChdbInsertError(ie.message ?? String(e), {
        cause: e,
        clickhouseCode: ie.clickhouseCode,
        reason: 'write-failure',
        // Absolute row number: rows already flushed + the engine's chunk-local "(at row N)".
        failedAtRow:
          typeof ie.failedAtRow === 'number' ? progress.rowsSent + ie.failedAtRow : undefined,
        progress: snap(),
      })
    }
    progress.chunks += 1
    progress.bytesSent += data.length
    if (typeof res.rowsSent === 'number') progress.rowsSent += res.rowsSent
    summary.rowsWritten += res.rowsWritten ?? 0
    summary.bytesWritten += res.bytesWritten ?? 0
    summary.elapsed += res.elapsed
    if (onProgress) onProgress(snap())
  }

  // Cut everything up to (and including) the last seen newline into one chunk.
  const cutChunk = (): Buffer => {
    const whole = acc.length === 1 ? (acc[0] as Buffer) : Buffer.concat(acc, accBytes)
    const head = whole.subarray(0, lastNl + 1)
    const tail = whole.subarray(lastNl + 1)
    acc = tail.length ? [tail] : []
    accBytes = tail.length
    lastNl = -1 // the tail is past the last newline by construction
    return head
  }

  const it = source[Symbol.asyncIterator]()
  let finishedCleanly = false
  try {
    while (true) {
      if (signal?.aborted) throw abortError()

      // Bounded-buffer gate for push-style Readables that ignore backpressure.
      const buffered = (source as { readableLength?: unknown }).readableLength
      if (typeof buffered === 'number' && buffered > maxBufferedBytes) {
        throw new ChdbInsertError(
          `Source outran the bounded buffer (${buffered} > maxBufferedBytes=${maxBufferedBytes}); ` +
            'refusing to buffer unboundedly. Use a pull-based source or raise maxBufferedBytes.',
          { reason: 'backpressure-overflow', progress: snap() },
        )
      }

      let step: IteratorResult<Buffer | Uint8Array | string>
      try {
        step = stallTimeout ? await raceStall(it.next(), stallTimeout) : await it.next()
      } catch (e) {
        if (e === STALL) {
          throw new ChdbTimeoutError(
            `Insert source stalled: no data and no end for ${stallTimeout}ms`,
            { reason: 'stall', progress: snap() },
          )
        }
        throw new ChdbInsertError(`Insert source stream failed: ${(e as Error)?.message ?? e}`, {
          reason: 'source-error', cause: e, progress: snap(),
        })
      }
      if (step.done) break

      const chunk = toChunkBuffer(step.value)
      if (chunk.length === 0) continue
      const idx = chunk.lastIndexOf(0x0a)
      if (idx >= 0) lastNl = accBytes + idx
      acc.push(chunk)
      accBytes += chunk.length

      while (accBytes >= maxChunkBytes) {
        if (lastNl < 0) {
          if (accBytes > maxRowBytes) {
            throw new ChdbInsertError(
              `A single row exceeds maxRowBytes=${maxRowBytes} (no row boundary in ${accBytes} buffered bytes); ` +
                'raise maxRowBytes or split the row upstream.',
              { reason: 'row-too-large', progress: snap() },
            )
          }
          break // keep accumulating until a row boundary arrives
        }
        await flush(cutChunk())
        if (signal?.aborted) throw abortError()
      }
    }

    // Final flush: whatever remains (the last line may lack a trailing newline).
    if (accBytes > 0) {
      const whole = acc.length === 1 ? (acc[0] as Buffer) : Buffer.concat(acc, accBytes)
      acc = []
      accBytes = 0
      await flush(whole)
    }

    finishedCleanly = true
    summary.rowsSent = progress.rowsSent
    summary.bytesSent = progress.bytesSent
    summary.chunks = progress.chunks
    return summary
  } finally {
    if (!finishedCleanly) {
      // Stop the producer: destroy a Readable, or close a generator.
      const src = source as { destroy?: (e?: Error) => void; destroyed?: boolean }
      try {
        if (typeof src.destroy === 'function' && !src.destroyed) src.destroy()
        else if (typeof it.return === 'function') void it.return(undefined as never)
      } catch {
        /* best effort */
      }
    }
  }
}
