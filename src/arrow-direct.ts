/** Construct apache-arrow objects from the native C Data result (never IPC). */
import { ChdbArrowError } from './errors'
import type { Uint32, Dictionary } from 'apache-arrow'

interface NativeField { name: string; format: string; nullable: boolean; dictionaryFormat?: string }
interface NativeColumn {
  nullCount: number
  buffers: Buffer[]
  dictionary?: { length: number; nullCount: number; buffers: Buffer[] }
}
interface NativeBatch { length: number; columns: NativeColumn[] }
export interface NativeArrowResult { fields: NativeField[]; batches: NativeBatch[] }

export function arrowTableFromDirect(raw: NativeArrowResult): unknown {
  let arrow: typeof import('apache-arrow')
  try { arrow = require('apache-arrow') as typeof import('apache-arrow') }
  catch { throw new ChdbArrowError('apache-arrow is required for queryArrow(); run npm i apache-arrow') }

  const typeFor = (format: string) => {
    const decimal = /^d:(\d+),(-?\d+)(?:,(128|256))?$/.exec(format)
    if (decimal) return new arrow.Decimal(Number(decimal[2]), Number(decimal[1]), Number(decimal[3] || 128))
    if (/^ts[smun]:/.test(format)) {
      const timezone = format.slice(4) || undefined
      switch (format[2]) {
        case 's': return new arrow.TimestampSecond(timezone)
        case 'm': return new arrow.TimestampMillisecond(timezone)
        case 'u': return new arrow.TimestampMicrosecond(timezone)
        case 'n': return new arrow.TimestampNanosecond(timezone)
      }
    }
    switch (format) {
      case 'c': return new arrow.Int8()
      case 'C': return new arrow.Uint8()
      case 's': return new arrow.Int16()
      case 'S': return new arrow.Uint16()
      case 'i': return new arrow.Int32()
      case 'I': return new arrow.Uint32()
      case 'l': return new arrow.Int64()
      case 'L': return new arrow.Uint64()
      case 'f': return new arrow.Float32()
      case 'g': return new arrow.Float64()
      case 'b': return new arrow.Bool()
      case 'u': return new arrow.Utf8()
      case 'z': return new arrow.Binary()
      default: throw new ChdbArrowError(`Unsupported direct Arrow format: ${format}`)
    }
  }
  const fields = raw.fields.map((field) => new arrow.Field(field.name,
    field.dictionaryFormat
      ? new arrow.Dictionary(typeFor(field.dictionaryFormat), typeFor(field.format) as Uint32)
      : typeFor(field.format), field.nullable))
  const schema = new arrow.Schema(fields)
  const view = (buffer: Buffer): Uint8Array => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  // The Buffer backing store may start at an unaligned byteOffset. Copy into
  // a fresh aligned ArrayBuffer before constructing numeric typed views.
  const aligned = (buffer: Buffer): ArrayBuffer => Uint8Array.from(buffer).buffer
  const batches = raw.batches.map((batch) => {
    if (batch.columns.length !== fields.length) throw new ChdbArrowError('Direct Arrow column count mismatch')
    const children = batch.columns.map((column, i) => {
      const format = raw.fields[i]!.format
      const validity = column.nullCount ? view(column.buffers[0]!) : undefined
      const values = column.buffers[1]!
      const common = { type: fields[i]!.type, length: batch.length, nullCount: column.nullCount, nullBitmap: validity }
      if (column.dictionary) {
        const dictionaryFormat = raw.fields[i]!.dictionaryFormat
        if (dictionaryFormat !== 'u' && dictionaryFormat !== 'z') {
          throw new ChdbArrowError(`Unsupported direct Arrow dictionary: ${dictionaryFormat}`)
        }
        const source = column.dictionary
        const dictionaryProps = { length: source.length, nullCount: source.nullCount,
          nullBitmap: source.nullCount ? view(source.buffers[0]!) : undefined,
          valueOffsets: new Int32Array(aligned(source.buffers[1]!)), data: view(source.buffers[2]!) }
        const dictionaryData = dictionaryFormat === 'u'
          ? arrow.makeData({ ...dictionaryProps, type: new arrow.Utf8() })
          : arrow.makeData({ ...dictionaryProps, type: new arrow.Binary() })
        const dictionary = new arrow.Vector([dictionaryData as any])
        const indices = format === 'i' ? new Int32Array(aligned(values)) : new Uint32Array(aligned(values))
        return arrow.makeData({ ...common, type: fields[i]!.type as Dictionary,
          data: indices, dictionary })
      }
      if (/^ts[smun]:/.test(format)) {
        return arrow.makeData({ ...common,
          type: fields[i]!.type as import('apache-arrow').TimestampMillisecond,
          data: new BigInt64Array(aligned(values)) })
      }
      if (/^d:\d+,-?\d+(?:,(?:128|256))?$/.test(format)) {
        return arrow.makeData({ ...common, type: fields[i]!.type as import('apache-arrow').Decimal,
          data: new Uint32Array(aligned(values)) })
      }
      switch (format) {
        case 'c': return arrow.makeData({ ...common, type: new arrow.Int8(), data: new Int8Array(aligned(values)) })
        case 'C': return arrow.makeData({ ...common, type: new arrow.Uint8(), data: new Uint8Array(aligned(values)) })
        case 's': return arrow.makeData({ ...common, type: new arrow.Int16(), data: new Int16Array(aligned(values)) })
        case 'S': return arrow.makeData({ ...common, type: new arrow.Uint16(), data: new Uint16Array(aligned(values)) })
        case 'i': return arrow.makeData({ ...common, type: new arrow.Int32(), data: new Int32Array(aligned(values)) })
        case 'I': return arrow.makeData({ ...common, type: new arrow.Uint32(), data: new Uint32Array(aligned(values)) })
        case 'l': return arrow.makeData({ ...common, type: new arrow.Int64(), data: new BigInt64Array(aligned(values)) })
        case 'L': return arrow.makeData({ ...common, type: new arrow.Uint64(), data: new BigUint64Array(aligned(values)) })
        case 'f': return arrow.makeData({ ...common, type: new arrow.Float32(), data: new Float32Array(aligned(values)) })
        case 'g': return arrow.makeData({ ...common, type: new arrow.Float64(), data: new Float64Array(aligned(values)) })
        case 'b': return arrow.makeData({ ...common, type: new arrow.Bool(), data: view(values) })
        case 'u': return arrow.makeData({ ...common, type: new arrow.Utf8(),
          valueOffsets: new Int32Array(aligned(values)), data: view(column.buffers[2]!) })
        case 'z': return arrow.makeData({ ...common, type: new arrow.Binary(),
          valueOffsets: new Int32Array(aligned(values)), data: view(column.buffers[2]!) })
        default: throw new ChdbArrowError(`Unsupported direct Arrow format: ${format}`)
      }
    })
    const data = arrow.makeData({ type: new arrow.Struct(fields), length: batch.length, children })
    return new arrow.RecordBatch(schema, data)
  })
  return new arrow.Table(schema, batches)
}
