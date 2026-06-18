/**
 * DataFormat classification, copied 1:1 from `@clickhouse/client-common`'s
 * `data_formatter` (byte-compat — these literal lists must match upstream, and
 * the CI drift test asserts it). They drive `ResultSet.json()` dispatch and
 * `stream()` validation exactly as clickhouse-js does.
 */

/** Newline-delimited JSON families: `json()` yields `T[]`, and they stream. */
export const StreamableJSONFormats = [
  'JSONEachRow',
  'JSONStringsEachRow',
  'JSONCompactEachRow',
  'JSONCompactStringsEachRow',
  'JSONCompactEachRowWithNames',
  'JSONCompactEachRowWithNamesAndTypes',
  'JSONCompactStringsEachRowWithNames',
  'JSONCompactStringsEachRowWithNamesAndTypes',
  'JSONEachRowWithProgress',
] as const

/** `JSONObjectEachRow`: `json()` yields `Record<string, T>`; not streamable. */
export const RecordsJSONFormats = ['JSONObjectEachRow'] as const

/** Single-document JSON: `json()` yields `ResponseJSON<T>`; not streamable. */
export const SingleDocumentJSONFormats = [
  'JSON',
  'JSONStrings',
  'JSONCompact',
  'JSONCompactStrings',
  'JSONColumnsWithMetadata',
] as const

/** CSV / TSV / Parquet etc.: stream as raw lines; `json()` throws. */
export const SupportedRawFormats = [
  'CSV',
  'CSVWithNames',
  'CSVWithNamesAndTypes',
  'TabSeparated',
  'TabSeparatedRaw',
  'TabSeparatedWithNames',
  'TabSeparatedWithNamesAndTypes',
  'CustomSeparated',
  'CustomSeparatedWithNames',
  'CustomSeparatedWithNamesAndTypes',
  'Parquet',
] as const

const streamableJSON = new Set<string>(StreamableJSONFormats)
const recordsJSON = new Set<string>(RecordsJSONFormats)
const singleDocJSON = new Set<string>(SingleDocumentJSONFormats)
const rawFormats = new Set<string>(SupportedRawFormats)

/** A newline-delimited JSON family (`json()` → `T[]`, streamable). */
export function isStreamableJSONFamily(format: string): boolean {
  return streamableJSON.has(format)
}

/** `JSONObjectEachRow` (`json()` → `Record<string, T>`). */
export function isRecordsJSONFamily(format: string): boolean {
  return recordsJSON.has(format)
}

/** A single-document JSON family (`json()` → `ResponseJSON<T>`). */
export function isSingleDocumentJSONFamily(format: string): boolean {
  return singleDocJSON.has(format)
}

/** A raw text/binary format — can stream, cannot be decoded as JSON. */
export function isRawFormat(format: string): boolean {
  return rawFormats.has(format)
}

/** Can be streamed (streamable JSON families ∪ raw formats), per upstream. */
export function isStreamableFormat(format: string): boolean {
  return streamableJSON.has(format) || rawFormats.has(format)
}

/** Decodable by `json()` at all (any JSON family). */
export function isJSONFamily(format: string): boolean {
  return streamableJSON.has(format) || recordsJSON.has(format) || singleDocJSON.has(format)
}
