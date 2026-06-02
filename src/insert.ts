/**
 * Insert support (Item 6 / §9). Builds a single multi-row `INSERT ... VALUES`
 * with the data serialized inline (via serializeValue). This NEVER triggers the
 * stdin-read fallback that hung complex-type inserts (#26, root cause chdb#152),
 * and it handles every CH type the serializer does (Array/Map/Date/bigint/…).
 *
 * v1 scope: in-memory row arrays (objects or positional arrays). Stream.Readable
 * input and chunking of very large inputs are a documented follow-up.
 */

import { serializeValue, validateIdentifier } from './serialize'
import { ChdbInsertError } from './errors'

export type InsertRow = Record<string, unknown> | ReadonlyArray<unknown>

export interface InsertParams {
  /** Target table (optionally db-qualified). */
  table: string
  /** Rows: array of objects, or array of positional value arrays. */
  values: ReadonlyArray<InsertRow>
  /** Explicit column list, or `{ except }` to exclude columns (positional rows). */
  columns?: ReadonlyArray<string> | { except: ReadonlyArray<string> }
}

export interface InsertSummary {
  rowsWritten: number
  bytesRead: number
  elapsed: number
}

function columnClause(cols: ReadonlyArray<string>): string {
  return ` (${cols.map(validateIdentifier).join(', ')})`
}

/**
 * Build the inline INSERT SQL and the row count. Returns an empty sql for an
 * empty input (caller short-circuits to a zero summary).
 *
 * @throws ChdbInsertError on a malformed table/column or unserializable value.
 */
export function buildInsertSQL(params: InsertParams): { sql: string; rowsWritten: number } {
  let table: string
  try {
    table = validateIdentifier(params.table)
  } catch (e) {
    throw new ChdbInsertError(`Invalid insert target table: ${(e as Error).message}`, { cause: e })
  }

  const rows = params.values
  if (!Array.isArray(rows) || rows.length === 0) {
    return { sql: '', rowsWritten: 0 }
  }

  const objectRows = !Array.isArray(rows[0])
  let colsClause = ''
  let tuples: string[]

  try {
    if (objectRows) {
      const cols = Array.isArray(params.columns)
        ? (params.columns as ReadonlyArray<string>)
        : Object.keys(rows[0] as Record<string, unknown>)
      colsClause = columnClause(cols)
      tuples = (rows as ReadonlyArray<Record<string, unknown>>).map(
        (r) => `(${cols.map((c) => serializeValue(r[c])).join(', ')})`,
      )
    } else {
      if (Array.isArray(params.columns)) {
        colsClause = columnClause(params.columns as ReadonlyArray<string>)
      } else if (params.columns && 'except' in params.columns) {
        colsClause = ` (* EXCEPT (${params.columns.except.map(validateIdentifier).join(', ')}))`
      }
      tuples = (rows as ReadonlyArray<ReadonlyArray<unknown>>).map(
        (arr) => `(${arr.map((v) => serializeValue(v)).join(', ')})`,
      )
    }
  } catch (e) {
    // serializeValue / validateIdentifier failures (e.g. unsafe int, bad column)
    if (e && typeof (e as { code?: string }).code === 'string') throw e
    throw new ChdbInsertError(`Failed to serialize insert values: ${(e as Error).message}`, { cause: e })
  }

  const sql = `INSERT INTO ${table}${colsClause} VALUES ${tuples.join(', ')}`
  return { sql, rowsWritten: rows.length }
}
