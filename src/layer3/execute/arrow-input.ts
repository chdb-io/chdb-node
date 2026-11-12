/**
 * Arrow C Data Interface input: register JavaScript-side columnar data with
 * the engine so it shows up as a table function (`arrowstream('<name>')`) that
 * SELECTs read with zero IPC copy.
 *
 *   const t = registerArrowTable('events', [
 *     { name: 'id',      type: 'Int32',   data: new Int32Array([1, 2, 3]) },
 *     { name: 'country', type: 'String',  data: ['US', 'FR', 'US'] },
 *   ])
 *   const rows = await chdb.selectFrom(chTable.arrowstream('events').as('e'))
 *     .select('country').execute()
 *   t.close()
 *
 * Single-pass semantics: the engine consumes the underlying Arrow array on
 * each query, so a second query reads zero rows. Call `t.refresh()` between
 * queries when you want to read the same data more than once, or build a new
 * handle for each query.
 */

import { runtime, type Runtime } from '../runtime'
import { ChdbCompileError } from '../../errors'
import { randomUUID } from 'node:crypto'

/**
 * Best-effort safety net: if a handle is garbage-collected without an explicit
 * `close()`, unregister the table so native stops pinning its JS buffers
 * (`Napi::Reference`). This is non-deterministic — the JS spec gives no timing
 * guarantee that finalizers run at all — so an explicit `close()` (ideally in a
 * `try/finally`) is still required. This only catches the leak when a caller
 * forgets.
 *
 * The held value must NOT reference the handle itself or the encoded buffers:
 * a finalization registry keeps its held value alive, so closing over the
 * handle would pin it forever (it could never be collected, defeating the
 * registry), and holding `encoded` would keep the very buffers we want freed.
 * `rt`/`conn`/`name`/`state` are small or shared; native owns the buffer pins
 * and releases them on unregister.
 */
const arrowFinalizers = new FinalizationRegistry<{
  rt: Runtime
  conn: unknown
  session?: { readonly connection: unknown }
  name: string
  state: { live: boolean; token: unknown }
}>(({ rt, conn, session, name, state }) => {
  if (!state.live) return
  state.live = false
  // Session.close() releases the native connection and its Arrow registrations
  // after outstanding scans drain. Its old External must not be used again.
  if (session !== undefined && session.connection !== conn) return
  try {
    rt._arrowUnregister(conn, name, state.token)
  } catch {
    // best effort: connection may already be closed, table already erased, etc.
  }
})

/** A column the caller asks to register. The shape mirrors apache-arrow naming. */
export type ArrowColumnInput =
  | { name: string; type: 'Int32'; data: Int32Array | ReadonlyArray<number>; nulls?: ReadonlyArray<boolean> | null }
  | { name: string; type: 'Int64'; data: BigInt64Array | ReadonlyArray<bigint>; nulls?: ReadonlyArray<boolean> | null }
  | { name: string; type: 'Float64'; data: Float64Array | ReadonlyArray<number>; nulls?: ReadonlyArray<boolean> | null }
  | { name: string; type: 'Bool'; data: ReadonlyArray<boolean>; nulls?: ReadonlyArray<boolean> | null }
  | { name: string; type: 'String'; data: ReadonlyArray<string>; nulls?: ReadonlyArray<boolean> | null }

interface NativeArrowColumn {
  name: string
  /** Arrow C Data Interface format string ('i' Int32, 'l' Int64, 'g' Float64, 'b' Bool, 'u' Utf8). */
  format: string
  length: number
  nullCount: number
  /** [validity bitmap or null, data buffer, optional offsets buffer]. */
  buffers: (Buffer | null)[]
  dictionary?: { format: string; length: number; nullCount: number; buffers: (Buffer | null)[] }
}

// Structural rather than an apache-arrow type import: it is an optional peer,
// and clients that only use SQL must still be able to typecheck without it.
export interface ArrowRecordBatchInput {
  readonly schema: { readonly fields: ReadonlyArray<{ readonly name: string; readonly type: { toString(): string } }> }
  readonly data: { readonly children: ReadonlyArray<unknown> }
  readonly numRows: number
  readonly numCols: number
}
export interface ArrowTableInput { readonly batches: ReadonlyArray<ArrowRecordBatchInput> }

interface ArrowDataInput {
  readonly offset?: number
  readonly length: number
  readonly nullCount: number
  readonly nullBitmap?: Uint8Array
  readonly values?: ArrayBufferView
  readonly valueOffsets?: Int32Array
}

function rebaseBits(bits: Uint8Array, offset: number, length: number): Buffer {
  const output = Buffer.alloc(Math.ceil(length / 8))
  for (let i = 0; i < length; i++) {
    if (bits[(offset + i) >> 3]! & (1 << ((offset + i) & 7))) output[i >> 3]! |= 1 << (i & 7)
  }
  return output
}

/**
 * A deliberately narrow bridge from apache-arrow JS buffers to the C Data
 * descriptor supported by the current addon. Materialized multi-batch tables
 * use the native C Stream adapter; sliced bitmaps are rebased and one-chunk
 * dictionary buffers stay columnar without flattening their rows.
 */
export function encodeArrowBatch(input: unknown): NativeArrowColumn[] {
  // apache-arrow publishes separate CJS and ESM constructors. A Table made by
  // one entry point need not pass instanceof against the other (notably under
  // Vitest), so inspect the public batch/schema shape instead.
  const source = input as ArrowTableInput & ArrowRecordBatchInput
  const batch = source?.batches
    ? source.batches.length === 1 ? source.batches[0]! : null
    : source?.data?.children && source?.schema ? source : null
  if (!batch) {
    throw new ChdbCompileError('registerArrowTable: expected a RecordBatch or an apache-arrow Table with a batch')
  }
  if (batch.numCols === 0) throw new ChdbCompileError('registerArrowTable: at least one column required')
  if (!Number.isSafeInteger(batch.numRows) || batch.numRows < 0 ||
      batch.schema.fields.length !== batch.numCols || batch.data.children.length !== batch.numCols) {
    throw new ChdbCompileError('registerArrowTable: invalid Arrow batch shape')
  }

  return batch.schema.fields.map((field, i) => {
    const data = batch.data.children[i] as ArrowDataInput | undefined
    const offset = data?.offset ?? 0
    if (!data || !Number.isSafeInteger(offset) || offset < 0 || data.length !== batch.numRows ||
        !Number.isSafeInteger(data.nullCount) || data.nullCount < 0 || data.nullCount > data.length) {
      throw new ChdbCompileError(`registerArrowTable: column "${field.name}" has an invalid offset or length`)
    }
    let format: string
    let views: ArrayBufferView[]
    const kind = field.type.toString()
    if (kind.startsWith('Dictionary<')) {
      const dictionaryType = field.type as { indices: { toString(): string }; dictionary: { toString(): string } }
      if (dictionaryType.dictionary.toString().startsWith('Dictionary<')) {
        throw new ChdbCompileError('nested Arrow dictionaries are unsupported')
      }
      const vector = (data as ArrowDataInput & { dictionary?: { data?: ReadonlyArray<unknown> } }).dictionary
      if (vector?.data?.length !== 1) {
        throw new ChdbCompileError(`registerArrowTable: dictionary for "${field.name}" needs one unsliced value chunk`)
      }
      const dictionaryData = vector.data[0] as ArrowDataInput
      const index = encodeArrowBatch({ schema: { fields: [{ name: field.name, type: dictionaryType.indices }] },
        data: { children: [data] }, numCols: 1, numRows: batch.numRows })[0]!
      const values = encodeArrowBatch({ schema: { fields: [{ name: '', type: dictionaryType.dictionary }] },
        data: { children: [dictionaryData] }, numCols: 1, numRows: dictionaryData.length })[0]!
      if (!['i', 'I'].includes(index.format) || !['u', 'z'].includes(values.format)) {
        throw new ChdbCompileError(`registerArrowTable: unsupported dictionary layout for "${field.name}"`)
      }
      return { ...index, dictionary: { format: values.format, length: values.length,
        nullCount: values.nullCount, buffers: values.buffers } }
    }
    const fixedFormats: Record<string, string> = {
      Int8: 'c', Uint8: 'C', Int16: 's', Uint16: 'S',
      Int32: 'i', Uint32: 'I', Int64: 'l', Uint64: 'L',
      Float32: 'f', Float64: 'g',
    }
    if (fixedFormats[kind]) {
      format = fixedFormats[kind]!
      views = [data.values ?? new Uint8Array(0)]
    } else if (kind.startsWith('Timestamp<')) {
      const timestamp = field.type as { unit?: number; timezone?: string | null }
      const unit = timestamp.unit == null ? undefined : 'smun'[timestamp.unit]
      if (!unit) throw new ChdbCompileError(`registerArrowTable: unsupported timestamp unit for "${field.name}"`)
      format = `ts${unit}:${timestamp.timezone ?? ''}`
      views = [data.values ?? new BigInt64Array(0)]
    } else if (kind.startsWith('Decimal[')) {
      const decimal = field.type as { precision?: number; scale?: number; bitWidth?: number }
      if (!decimal.precision || ![128, 256].includes(decimal.bitWidth ?? 128)) {
        throw new ChdbCompileError(`registerArrowTable: unsupported decimal for "${field.name}"`)
      }
      format = `d:${decimal.precision},${decimal.scale ?? 0}${decimal.bitWidth === 256 ? ',256' : ''}`
      views = [data.values ?? new Uint32Array(0)]
    } else if (kind === 'Bool') {
      format = 'b'
      const bits = data.values as Uint8Array | undefined
      if (offset && (!bits || bits.byteLength < Math.ceil((offset + data.length) / 8))) {
        throw new ChdbCompileError(`registerArrowTable: truncated Bool values for "${field.name}"`)
      }
      views = [offset ? rebaseBits(bits!, offset, data.length) : bits ?? new Uint8Array(0)]
    } else if (kind === 'Utf8' || kind === 'Binary') {
      format = kind === 'Utf8' ? 'u' : 'z'
      views = [data.valueOffsets ?? new Int32Array([0]), data.values ?? new Uint8Array(0)]
    } else {
      throw new ChdbCompileError(`registerArrowTable: unsupported Arrow type ${field.type} for "${field.name}"`)
    }
    const validity = data.nullCount > 0 ? data.nullBitmap : null
    if (data.nullCount > 0 && (!validity || !ArrayBuffer.isView(validity) ||
        validity.byteLength < Math.ceil((offset + data.length) / 8))) {
      throw new ChdbCompileError(`registerArrowTable: missing validity bitmap for "${field.name}"`)
    }
    const variable = format === 'u' || format === 'z'
    const width = format.startsWith('d:') ? (format.endsWith(',256') ? 32 : 16)
      : 'cC'.includes(format) ? 1 : 'sS'.includes(format) ? 2
      : 'iIf'.includes(format) ? 4 : 8
    const expected = variable ? (data.length + 1) * 4
      : format === 'b' ? Math.ceil(data.length / 8) : data.length * width
    if (!views.every((v) => v && ArrayBuffer.isView(v) && !(v.buffer instanceof SharedArrayBuffer)) ||
        (validity && validity.buffer instanceof SharedArrayBuffer) || views[0]!.byteLength < expected) {
      throw new ChdbCompileError(`registerArrowTable: invalid or shared buffer for "${field.name}"`)
    }
    if (variable) {
      const offsets = views[0] as Int32Array
      let valid = offsets[0]! >= 0 && offsets[data.length]! <= views[1]!.byteLength
      for (let j = 1; j <= data.length; j++) valid &&= offsets[j]! >= offsets[j - 1]!
      if (!valid) {
        throw new ChdbCompileError(`registerArrowTable: invalid UTF-8 offsets for "${field.name}"`)
      }
    }
    const buffer = (view: ArrayBufferView): Buffer => Buffer.from(view.buffer, view.byteOffset, view.byteLength)
    const bitmapView = validity && offset ? rebaseBits(validity, offset, data.length) : validity
    return {
      name: field.name, format, length: data.length, nullCount: data.nullCount,
      buffers: [bitmapView ? buffer(bitmapView) : null, ...views.map(buffer)],
    }
  })
}

/** A handle returned by `registerArrowTable`. */
export interface ArrowTableHandle {
  /** Close the handle; native unregister waits for active queries/streams. */
  close(): void
  /**
   * Re-register the same data so a follow-up query can read it again.
   * The engine consumes the underlying array on each scan, so use this
   * between completed queries against the same table. Throws while a query
   * or stream is active, since re-registering would invalidate that scan.
   */
  refresh(): void
}

export interface ArrowSourceHandle extends ArrowTableHandle {
  /** Unique process-wide name to use in `arrowstream(name)` SQL. */
  readonly name: string
}

/** Validate name + same row count + at least one column. */
function validate(name: string, columns: ReadonlyArray<ArrowColumnInput>): void {
  if (typeof name !== 'string' || name === '') {
    throw new ChdbCompileError('registerArrowTable: name must be a non-empty string')
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new ChdbCompileError('registerArrowTable: at least one column required')
  }
  let len = -1
  for (const c of columns) {
    const n = Array.isArray(c.data) ? c.data.length : (c.data as { length: number }).length
    if (len === -1) len = n
    else if (n !== len) throw new ChdbCompileError(`registerArrowTable: column "${c.name}" has ${n} rows, expected ${len}`)
    // A nulls mask must cover exactly the rows it annotates. A shorter/longer
    // mask would otherwise be silently dropped from the validity bitmap while
    // still feeding nullCount, producing an inconsistent ArrowArray descriptor.
    if (c.nulls != null && c.nulls.length !== n) {
      throw new ChdbCompileError(
        `registerArrowTable: column "${c.name}" nulls mask has ${c.nulls.length} entries, expected ${n}`,
      )
    }
  }
}

/** Bit-pack a JS boolean validity mask into an Arrow-spec validity bitmap. */
function bitmap(mask: ReadonlyArray<boolean>): Buffer {
  const out = Buffer.alloc(Math.ceil(mask.length / 8))
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) out[i >> 3]! |= 1 << (i & 7)
  }
  return out
}

/** Encode one column into the native descriptor the addon understands. */
function encodeColumn(col: ArrowColumnInput): NativeArrowColumn {
  const length = Array.isArray(col.data) ? col.data.length : (col.data as { length: number }).length
  // Validity bitmap: one bit per row, 1 = valid; null when there's no mask.
  // `validate()` has already guaranteed col.nulls (when present) covers exactly
  // `length` rows, so the bitmap and nullCount always agree.
  const validity = col.nulls ? bitmap(col.nulls) : null
  const nullCount = col.nulls ? col.nulls.reduce((n, v) => (v ? n : n + 1), 0) : 0

  switch (col.type) {
    case 'Int32': {
      const data = col.data instanceof Int32Array ? col.data : Int32Array.from(col.data as number[])
      return { name: col.name, format: 'i', length, nullCount, buffers: [validity, Buffer.from(data.buffer, data.byteOffset, data.byteLength)] }
    }
    case 'Int64': {
      const data = col.data instanceof BigInt64Array ? col.data : BigInt64Array.from(col.data as bigint[])
      return { name: col.name, format: 'l', length, nullCount, buffers: [validity, Buffer.from(data.buffer, data.byteOffset, data.byteLength)] }
    }
    case 'Float64': {
      const data = col.data instanceof Float64Array ? col.data : Float64Array.from(col.data as number[])
      return { name: col.name, format: 'g', length, nullCount, buffers: [validity, Buffer.from(data.buffer, data.byteOffset, data.byteLength)] }
    }
    case 'Bool': {
      return { name: col.name, format: 'b', length, nullCount, buffers: [validity, bitmap(col.data)] }
    }
    case 'String': {
      // Arrow Utf8: int32 offsets[N+1] + concatenated bytes. Offsets are
      // byte offsets into the data buffer.
      const offsets = new Int32Array(length + 1)
      const parts: Buffer[] = []
      let cursor = 0
      for (let i = 0; i < length; i++) {
        const s = col.data[i]!
        const bytes = Buffer.from(s, 'utf-8')
        parts.push(bytes)
        offsets[i] = cursor
        cursor += bytes.byteLength
      }
      offsets[length] = cursor
      const data = Buffer.concat(parts)
      const offsetsBuf = Buffer.from(offsets.buffer, offsets.byteOffset, offsets.byteLength)
      return { name: col.name, format: 'u', length, nullCount, buffers: [validity, offsetsBuf, data] }
    }
  }
}

/**
 * Pin JS columns, one apache-arrow RecordBatch, or a single-batch Table as an
 * `arrowstream('<name>')` source. Arrow objects support primitive numeric,
 * Bool, Utf8, Binary, Timestamp, Decimal and one-chunk Dictionary buffers;
 * sliced bitmaps are rebased. Multi-batch tables use a C Stream. This avoids Arrow IPC, but the engine may
 * still copy buffers while mapping them to ClickHouse columns.
 *
 * Returns a handle owning JS-side buffer references. close() is idempotent;
 * native unregister and buffer release are deferred while a query or lazy
 * stream is active. Exhaust or cancel streams so deferred cleanup can finish.
 */
export function registerArrowTable(
  name: string,
  columns: ReadonlyArray<ArrowColumnInput> | ArrowTableInput | ArrowRecordBatchInput,
  opts: { session?: { readonly connection: unknown } } = {},
): ArrowTableHandle {
  if (typeof name !== 'string' || name === '') {
    throw new ChdbCompileError('registerArrowTable: name must be a non-empty string')
  }
  let encoded: NativeArrowColumn[]
  let encodedBatches: NativeArrowColumn[][] | undefined
  if (Array.isArray(columns)) {
    validate(name, columns)
    encoded = columns.map(encodeColumn)
  } else if ('batches' in columns && columns.batches.length > 1) {
    encodedBatches = columns.batches.map(encodeArrowBatch)
    encoded = encodedBatches[0]!
  } else {
    encoded = encodeArrowBatch(columns)
  }
  const session = opts.session
  const conn = session !== undefined ? session.connection : null
  if (session !== undefined && conn == null) {
    throw new ChdbCompileError('registerArrowTable: session has no active connection')
  }
  const rt = runtime()
  if (!Array.isArray(columns)) rt._assertArrowCore()
  const sessionStillOwnsConnection = (): boolean => session === undefined || session.connection === conn
  // Shared between close/refresh and the GC finalizer so all three agree on
  // whether the table is currently registered.
  const state: { live: boolean; closed: boolean; token: unknown } = {
    live: false, closed: false, token: undefined,
  }
  const register = (): void => {
    if (!sessionStillOwnsConnection()) {
      throw new ChdbCompileError('registerArrowTable: session has no active connection')
    }
    state.token = encodedBatches
      ? rt._arrowRegisterBatches(conn, name, encodedBatches)
      : rt._arrowRegisterColumns(conn, name, encoded)
    state.live = true
  }
  const unregister = (defer = true): void => {
    if (!state.live) return
    if (!sessionStillOwnsConnection()) {
      // Closing the Session has already dropped its native Arrow registrations.
      state.live = false
      return
    }
    rt._arrowUnregister(conn, name, state.token, defer)
    state.live = false
  }
  register()
  const handle: ArrowTableHandle = {
    close(): void {
      if (state.closed) return
      unregister()
      state.closed = true
      // Explicitly closed: drop the GC safety net so the finalizer can't fire
      // a redundant unregister later.
      arrowFinalizers.unregister(handle)
    },
    refresh(): void {
      if (state.closed) throw new ChdbCompileError('registerArrowTable: handle is closed')
      unregister(false)
      register()
    },
  }
  // Register the GC fallback. The handle is also the unregister token so
  // `close()` can cancel it.
  arrowFinalizers.register(handle, { rt, conn, session, name, state }, handle)
  return handle
}

/** Register a materialized Arrow source under a generated opaque SQL name. */
export function registerArrowSource(
  input: ReadonlyArray<ArrowColumnInput> | ArrowTableInput | ArrowRecordBatchInput,
  opts: { session?: { readonly connection: unknown } } = {},
): ArrowSourceHandle {
  runtime()._assertArrowCore()
  const name = `__chdb_arrow_${randomUUID().replaceAll('-', '')}`
  const handle = registerArrowTable(name, input, opts)
  return Object.assign(handle, { name })
}
