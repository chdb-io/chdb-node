/**
 * Raw-format passthrough insert. The payload arrives as bytes
 * (Buffer / Uint8Array / string), is handed to the native side zero-copy, and
 * the engine's multithreaded C++ parser does all the parsing — JS never builds
 * an object tree from the payload. This module owns the SQL-prefix
 * construction and the dispatch predicates; the native entry is
 * InsertRawAsync(prefix, dataBuffer, countLines).
 *
 * Two row ledgers, by design:
 *  - rowsSent  (payload view): non-empty payload lines, counted off-thread by
 *    the native worker. Exact for line-delimited formats (they escape raw
 *    '\n' inside values); undefined for the CSV family (RFC 4180 allows raw
 *    newlines inside quoted fields — we refuse to fake a count).
 *  - rowsWritten (engine view): chdb_result_rows_written (chdb-io/chdb-core#88).
 *    Includes cascaded materialized-view writes — same semantics as the HTTP
 *    interface's X-ClickHouse-Summary.
 */

import { serializeValue, validateIdentifier } from './serialize'
import { ChdbInsertError } from './errors'

export interface RawFormatInfo {
  /** Canonical ClickHouse format name interpolated into the SQL prefix. */
  canonical: string
  /** Line-delimited formats escape raw '\n' in values => newline === row boundary. */
  lineDelimited: boolean
  /** Header lines included in the payload (WithNames variants). */
  headerLines: 0 | 1
}

/**
 * v1 whitelist: text formats only (the format name is interpolated into SQL,
 * so it must never be passed through unvalidated). Binary formats wait on the
 * upstream inline-data feasibility check.
 */
const RAW_FORMATS: Record<string, RawFormatInfo> = {
  JSONEachRow: { canonical: 'JSONEachRow', lineDelimited: true, headerLines: 0 },
  JSONCompactEachRow: { canonical: 'JSONCompactEachRow', lineDelimited: true, headerLines: 0 },
  TSV: { canonical: 'TabSeparated', lineDelimited: true, headerLines: 0 },
  TabSeparated: { canonical: 'TabSeparated', lineDelimited: true, headerLines: 0 },
  TSVWithNames: { canonical: 'TabSeparatedWithNames', lineDelimited: true, headerLines: 1 },
  TabSeparatedWithNames: { canonical: 'TabSeparatedWithNames', lineDelimited: true, headerLines: 1 },
  CSV: { canonical: 'CSV', lineDelimited: false, headerLines: 0 },
  CSVWithNames: { canonical: 'CSVWithNames', lineDelimited: false, headerLines: 1 },
}

export function rawFormatInfo(format: unknown): RawFormatInfo {
  if (typeof format !== 'string' || !(format in RAW_FORMATS)) {
    throw new ChdbInsertError(
      `Unsupported raw insert format ${JSON.stringify(format)}; ` +
        `supported: ${Object.keys(RAW_FORMATS).join(', ')}`,
    )
  }
  return RAW_FORMATS[format] as RawFormatInfo
}

/** Raw payload predicate: bytes (or a string for small-payload convenience). */
export function isRawValues(v: unknown): v is Buffer | Uint8Array | string {
  return typeof v === 'string' || Buffer.isBuffer(v) || v instanceof Uint8Array
}

/** Streaming payload predicate: any async-iterable that is not an array/raw value. */
export function isStreamValues(v: unknown): v is AsyncIterable<Buffer | Uint8Array | string> {
  return (
    v != null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !isRawValues(v) &&
    typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  )
}

export interface RawInsertPrefixParams {
  table: string
  columns?: ReadonlyArray<string>
  settings?: Record<string, string | number | boolean>
  format: string
}

/**
 * Build the SQL prefix `INSERT INTO <t>[ (c1, c2)][ SETTINGS k=v] FORMAT <fmt>`.
 * Injection safety: table/columns/setting keys go through the identifier
 * whitelist; setting values through serializeValue (quoted/escaped literals);
 * the format through the RAW_FORMATS whitelist. The payload itself is never
 * inspected here.
 *
 * @throws ChdbInsertError on any invalid identifier, setting, or format.
 */
export function buildRawInsertPrefix(params: RawInsertPrefixParams): {
  prefix: string
  fmt: RawFormatInfo
} {
  let table: string
  try {
    table = validateIdentifier(params.table)
  } catch (e) {
    throw new ChdbInsertError(`Invalid insert target table: ${(e as Error).message}`, { cause: e })
  }

  let colsClause = ''
  if (params.columns !== undefined) {
    if (!Array.isArray(params.columns) || params.columns.length === 0) {
      throw new ChdbInsertError('columns must be a non-empty array of column names')
    }
    try {
      colsClause = ` (${params.columns.map(validateIdentifier).join(', ')})`
    } catch (e) {
      throw new ChdbInsertError(`Invalid insert column: ${(e as Error).message}`, { cause: e })
    }
  }

  let settingsClause = ''
  if (params.settings !== undefined) {
    const entries = Object.entries(params.settings)
    if (entries.length > 0) {
      const parts = entries.map(([k, v]) => {
        let key: string
        try {
          key = validateIdentifier(k)
        } catch (e) {
          throw new ChdbInsertError(`Invalid setting name: ${(e as Error).message}`, { cause: e })
        }
        const t = typeof v
        if (t !== 'string' && t !== 'number' && t !== 'boolean') {
          throw new ChdbInsertError(`Setting '${k}' must be a string, number or boolean (got ${t})`)
        }
        return `${key}=${serializeValue(v)}`
      })
      settingsClause = ` SETTINGS ${parts.join(', ')}`
    }
  }

  const fmt = rawFormatInfo(params.format)
  return { prefix: `INSERT INTO ${table}${colsClause}${settingsClause} FORMAT ${fmt.canonical}`, fmt }
}
