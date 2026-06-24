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

import { runtime, type RuntimeSession } from '../runtime'
import { ChdbCompileError } from '../../errors'

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
}

/** A handle returned by `registerArrowTable`. */
export interface ArrowTableHandle {
  /** Drop the table from the engine and release JS-side buffer pins. */
  close(): void
  /**
   * Re-register the same data so a follow-up query can read it again.
   * The engine consumes the underlying array on each scan, so use this
   * between repeated queries against the same table.
   */
  refresh(): void
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
  // Validity bitmap: one bit per row, 1 = valid; null when all-valid.
  const validity = col.nulls && col.nulls.length === length ? bitmap(col.nulls) : null
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
 * Pin a JS columnar dataset as an `arrowstream('<name>')` table the engine can
 * read with zero IPC copy. Returns a handle owning the JS-side buffer
 * references; call `.close()` to release everything.
 */
export function registerArrowTable(
  name: string,
  columns: ReadonlyArray<ArrowColumnInput>,
  opts: { session?: RuntimeSession } = {},
): ArrowTableHandle {
  validate(name, columns)
  const encoded = columns.map(encodeColumn)
  const conn = opts.session !== undefined ? (opts.session as { _handle?: unknown })._handle : null
  const rt = runtime()
  let live = false
  const register = (): void => {
    rt._arrowRegisterColumns(conn, name, encoded)
    live = true
  }
  const unregister = (): void => {
    if (!live) return
    rt._arrowUnregister(conn, name)
    live = false
  }
  register()
  return {
    close(): void {
      unregister()
    },
    refresh(): void {
      unregister()
      register()
    },
  }
}
