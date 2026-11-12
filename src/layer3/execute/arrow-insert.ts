/** Bulk insert through one in-memory Arrow registration and an engine-side INSERT SELECT. */
import { ChdbCompileError } from '../../errors'
import { quoteIdentifier, quoteIdentifierSegment } from '../compiler/identifier'
import { registerArrowSource, type ArrowColumnInput, type ArrowRecordBatchInput, type ArrowTableInput } from './arrow-input'
import { registerArrowReader, type ArrowReaderSource } from './arrow-reader'

export type ArrowInsertInput = ReadonlyArray<ArrowColumnInput> | ArrowRecordBatchInput | ArrowTableInput

export interface ArrowInsertSession {
  readonly connection: unknown
  queryAsync(query: string, opts?: { format?: string }): Promise<{
    readonly rowsRead: number; readonly bytesRead: number; readonly elapsed: number
  }>
}

/** Number submitted is known from the Arrow source; it is not a storage-side write ledger. */
export interface ArrowInsertSummary {
  rowsSubmitted: number
  rowsRead: number
  bytesRead: number
  elapsed: number
}

/**
 * Insert a single RecordBatch/Table batch (or supported column descriptors)
 * without Arrow IPC or JS row materialization. Destination names are matched
 * to source fields, not positional table order. The registration is scoped to
 * this awaited query and always closed, including on errors.
 */
export async function insertArrow(
  table: string,
  input: ArrowInsertInput,
  opts: { session: ArrowInsertSession },
): Promise<ArrowInsertSummary> {
  if (!opts?.session?.connection || typeof opts.session.queryAsync !== 'function') {
    throw new ChdbCompileError('insertArrow: an active Session is required')
  }
  const batch = !Array.isArray(input) && 'batches' in input ? input.batches[0] : input
  const columns = Array.isArray(batch)
    ? batch.map((column) => column.name)
    : (batch as ArrowRecordBatchInput).schema?.fields.map((field) => field.name)
  if (!columns?.length || new Set(columns).size !== columns.length) {
    throw new ChdbCompileError('insertArrow: source needs unique column names')
  }
  const rowsSubmitted = !Array.isArray(input) && 'batches' in input
    ? input.batches.reduce((total, current) => total + current.numRows, 0)
    : Array.isArray(batch) ? batch[0]!.data.length : (batch as ArrowRecordBatchInput).numRows
  const destination = quoteIdentifier(table)
  const fieldList = columns.map(quoteIdentifierSegment).join(', ')
  const registration = registerArrowSource(input, { session: opts.session })
  try {
    // Generated name is ASCII hex only. Identifier paths/column names are
    // quoted by the shared compiler, never interpolated as untrusted SQL.
    const result = await opts.session.queryAsync(
      `INSERT INTO ${destination} (${fieldList}) SELECT ${fieldList} FROM arrowstream('${registration.name}')`,
    )
    return { rowsSubmitted, rowsRead: result.rowsRead, bytesRead: result.bytesRead, elapsed: result.elapsed }
  } finally {
    registration.close()
  }
}

/** Incrementally insert an async/sync RecordBatch reader with native backpressure. */
export async function insertArrowReader(
  table: string,
  source: ArrowReaderSource,
  opts: { session: ArrowInsertSession },
): Promise<ArrowInsertSummary> {
  const destination = quoteIdentifier(table)
  const reader = await registerArrowReader(source, opts)
  try {
    if (new Set(reader.fields).size !== reader.fields.length) {
      throw new ChdbCompileError('insertArrowReader: source needs unique column names')
    }
    const fieldList = reader.fields.map(quoteIdentifierSegment).join(', ')
    const result = await opts.session.queryAsync(
      `INSERT INTO ${destination} (${fieldList}) SELECT ${fieldList} FROM arrowstream('${reader.name}')`,
    )
    await reader.producerDone
    return { rowsSubmitted: reader.rowsSubmitted, rowsRead: result.rowsRead,
      bytesRead: result.bytesRead, elapsed: result.elapsed }
  } finally {
    await reader.close()
  }
}
