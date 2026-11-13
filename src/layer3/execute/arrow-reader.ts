/** Bounded async Arrow reader -> core C Stream source. */
import { randomUUID } from 'node:crypto'
import { ChdbAbortError, ChdbCompileError } from '../../errors'
import { runtime, type Runtime } from '../runtime'
import { encodeArrowBatch, emptyArrowBatch, type ArrowRecordBatchInput } from './arrow-input'

export type ArrowReaderSource = (AsyncIterable<ArrowRecordBatchInput> | Iterable<ArrowRecordBatchInput>) & {
  /** Required only when the reader yields no batches. */
  readonly schema?: ArrowRecordBatchInput['schema']
}

export interface ArrowReaderHandle {
  readonly name: string
  readonly fields: ReadonlyArray<string>
  /** Batches accepted by the bounded native queue; not a storage write ledger. */
  readonly rowsSubmitted: number
  /** Settles when the JS producer has finished or failed, not when SQL finishes. */
  readonly producerDone: Promise<void>
  /** Cancel production and unregister; one-shot readers cannot be refreshed. */
  close(): Promise<void>
}

const readerFinalizers = new FinalizationRegistry<{
  rt: Runtime; native: unknown; conn: unknown; name: string; token: unknown
}>(({ rt, native, conn, name, token }) => {
  try {
    rt._arrowCancelReader(native)
    rt._arrowUnregister(conn, name, token)
  } catch { /* best effort on a connection already closed */ }
})

/**
 * Register a one-shot synchronous or asynchronous RecordBatch reader. The
 * native queue holds at most two not-yet-delivered batches; JS produces on its
 * own event loop and awaits queue capacity. Core may retain delivered batches
 * beyond the queue, so this is not a total-query memory bound.
 * Core get_next only waits on native descriptors and never invokes JS on its
 * query worker. Pass the returned name to arrowstream(name) on this Session.
 */
export async function registerArrowReader(
  source: ArrowReaderSource,
  opts: { session: { readonly connection: unknown }; signal?: AbortSignal },
): Promise<ArrowReaderHandle> {
  if (!opts?.session?.connection) throw new ChdbCompileError('registerArrowReader requires an active Session')
  if (opts.signal?.aborted) throw new ChdbAbortError('Arrow reader registration aborted')
  runtime()._assertArrowCore()
  const conn = opts.session.connection
  const asyncMethod = (source as AsyncIterable<ArrowRecordBatchInput>)[Symbol.asyncIterator]
  const syncMethod = (source as Iterable<ArrowRecordBatchInput>)[Symbol.iterator]
  if (typeof asyncMethod !== 'function' && typeof syncMethod !== 'function') {
    throw new ChdbCompileError('registerArrowReader requires a RecordBatch iterable')
  }
  const iterator: AsyncIterator<ArrowRecordBatchInput> | Iterator<ArrowRecordBatchInput> =
    typeof asyncMethod === 'function' ? asyncMethod.call(source) : syncMethod.call(source)
  // Registration must not hold the caller hostage when a network-backed
  // iterator has not produced its first batch. An uncooperative next() cannot
  // be forcibly stopped; return() is requested without awaiting it.
  const first = opts.signal ? await new Promise<IteratorResult<ArrowRecordBatchInput>>((resolve, reject) => {
    const onAbort = () => {
      try { void Promise.resolve(iterator.return?.()).catch(() => {}) } catch { /* best effort */ }
      reject(new ChdbAbortError('Arrow reader registration aborted'))
    }
    if (opts.signal!.aborted) { onAbort(); return }
    opts.signal!.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => iterator.next()).then(
      (value) => { opts.signal!.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { opts.signal!.removeEventListener('abort', onAbort); reject(error) },
    )
  }) : await iterator.next()
  if (opts.signal?.aborted) {
    try { void Promise.resolve(iterator.return?.()).catch(() => {}) } catch { /* best effort */ }
    throw new ChdbAbortError('Arrow reader registration aborted')
  }
  if (opts.session.connection !== conn) {
    try { await iterator.return?.() } catch { /* source cleanup is best effort */ }
    throw new ChdbCompileError('registerArrowReader: Session closed while awaiting the first batch')
  }
  let firstBatch: ArrowRecordBatchInput
  if (first.done) {
    const schema = (source as { schema?: ArrowRecordBatchInput['schema'] }).schema
    // Apache Arrow has separate ESM/CJS constructors; use its public schema shape.
    firstBatch = emptyArrowBatch(schema)
  } else firstBatch = first.value

  const rt = runtime()
  const name = `__chdb_arrow_reader_${randomUUID().replaceAll('-', '')}`
  const fields = firstBatch.schema.fields.map((field) => field.name)
  let native: unknown
  let token: unknown
  try {
    ({ handle: native, token } = rt._arrowRegisterReader(conn, name, encodeArrowBatch(firstBatch)))
  } catch (e) {
    try { await iterator.return?.() } catch { /* preserve registration error */ }
    throw e
  }
  let closing = false
  let onAbort: (() => void) | undefined
  let rowsSubmitted = first.done ? 0 : firstBatch.numRows
  const producerDone = (async () => {
    try {
      if (first.done) { rt._arrowFinishReader(native); return }
      while (!closing) {
        const next = await iterator.next()
        if (closing) return
        if (next.done) { rt._arrowFinishReader(native); return }
        await rt._arrowPushReaderBatch(native, encodeArrowBatch(next.value))
        rowsSubmitted += next.value.numRows
      }
    } catch (e) {
      if (!closing) {
        rt._arrowFinishReader(native, (e instanceof Error ? e.message : String(e)) || 'Arrow reader producer failed')
        throw e
      }
    }
  })()
  // SQL sees the producer error through get_next; an unobserved auxiliary
  // producerDone promise must not become an unhandled rejection.
  void producerDone.catch(() => {})

  const result: ArrowReaderHandle = {
    name, fields, producerDone,
    get rowsSubmitted() { return rowsSubmitted },
    async close() {
      if (!closing) {
        closing = true
        if (onAbort) opts.signal!.removeEventListener('abort', onAbort)
        rt._arrowCancelReader(native)
        rt._arrowUnregister(conn, name, token)
        readerFinalizers.unregister(result)
        // An arbitrary async iterator may be stuck inside next() and queue
        // return() behind it forever. Native cancellation must settle without
        // waiting for a non-cooperative producer; observe its eventual cleanup.
        try { void Promise.resolve(iterator.return?.()).catch(() => {}) }
        catch { /* cancellation is best effort */ }
      }
    },
  }
  readerFinalizers.register(result, { rt, native, conn, name, token }, result)
  if (opts.signal) {
    onAbort = () => { void result.close() }
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  return result
}
