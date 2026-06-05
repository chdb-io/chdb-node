/**
 * Insert support. Builds a single multi-row `INSERT ... VALUES` with the data
 * serialized inline (via serializeValue). Inlining the data NEVER triggers the
 * stdin-read fallback that previously hung complex-type inserts (see issue #26),
 * and it handles every type the serializer does (Array/Map/Date/bigint/…).
 *
 * Scope: in-memory row arrays (objects or positional arrays). Stream input and
 * chunking of very large inputs are a tracked follow-up.
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

  // All rows must share the shape of the first row (all objects, or all
  // positional arrays). A mixed batch would otherwise build wrong SQL or throw
  // a confusing "undefined value" — reject it up front with a clear error.
  for (let i = 1; i < rows.length; i++) {
    if (!Array.isArray(rows[i]) !== objectRows) {
      throw new ChdbInsertError(
        `Inconsistent row shape at row ${i}: all rows must be ${objectRows ? 'objects' : 'arrays'}`,
      )
    }
  }

  let colsClause = ''
  let tuples: string[]

  // `undefined` almost always means an accidentally-missing field; serializing
  // it as NULL would silently become a default (e.g. 0) in a non-nullable
  // column. Reject it with a clear error and require an explicit `null` for an
  // intentional NULL.
  const cell = (value: unknown, where: string): string => {
    if (value === undefined) {
      throw new ChdbInsertError(
        `undefined value for ${where}; pass null for an explicit NULL`,
      )
    }
    return serializeValue(value)
  }

  try {
    if (objectRows) {
      const explicitCols = Array.isArray(params.columns)
      const cols = explicitCols
        ? (params.columns as ReadonlyArray<string>)
        : Object.keys(rows[0] as Record<string, unknown>)
      colsClause = columnClause(cols)
      // When columns are inferred from row 0, a later row carrying a key absent
      // from row 0 would be silently dropped (data loss). Surface it instead.
      // An explicit `columns` list is an intentional projection, so it's exempt.
      const colSet = explicitCols ? null : new Set(cols)
      tuples = (rows as ReadonlyArray<Record<string, unknown>>).map((r, i) => {
        if (colSet) {
          for (const k of Object.keys(r)) {
            if (!colSet.has(k)) {
              throw new ChdbInsertError(
                `Row ${i} has column "${k}" not present in the first row; ` +
                  `pass an explicit \`columns\` list for a non-uniform batch`,
              )
            }
          }
        }
        return `(${cols.map((c) => cell(r[c], `column "${c}" (row ${i})`)).join(', ')})`
      })
    } else {
      if (Array.isArray(params.columns)) {
        colsClause = columnClause(params.columns as ReadonlyArray<string>)
      } else if (params.columns && 'except' in params.columns) {
        colsClause = ` (* EXCEPT (${params.columns.except.map(validateIdentifier).join(', ')}))`
      }
      tuples = (rows as ReadonlyArray<ReadonlyArray<unknown>>).map(
        (arr, i) => `(${arr.map((v, j) => cell(v, `index ${j} (row ${i})`)).join(', ')})`,
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
