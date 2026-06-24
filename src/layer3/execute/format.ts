/**
 * Maps the `.execute({ format })` OUTPUT-VIEW selector to the ClickHouse engine
 * format plus how to read the result back. This is deliberately distinct from
 * the `.format()` SQL clause: `.format()` changes what ClickHouse serializes,
 * while `execute({format})` only chooses which view of the bytes you get back
 * (`Row[]` / Arrow `Table` / raw `ChdbResult`).
 */

import { ChdbCompileError } from '../../errors'

export type OutputView = 'rows' | 'arrow' | 'raw'

export interface FormatPlan {
  /** The format string handed to Layer 1's queryBindAsync. */
  readonly chFormat: string
  /** How the terminal reads the ChdbResult back. */
  readonly view: OutputView
  /** Settings the view needs injected (e.g. quote 64-bit ints for precision). */
  readonly settings?: Record<string, string | number | boolean>
}

// The default row view: JSONEachRow with 64-bit integers quoted so UInt64/Int64
// survive as strings instead of losing precision through JS numbers (the
// precision-safe type policy). The bytes are parsed line-by-line, not as one
// JSON document.
const ROWS_PLAN: FormatPlan = {
  chFormat: 'JSONEachRow',
  view: 'rows',
  settings: { output_format_json_quote_64bit_integers: 1 },
}

// Common shorthands → canonical ClickHouse format names. An unknown name is
// passed through verbatim (the engine validates it) so any ClickHouse format
// stays reachable without a new mapping.
const RAW_FORMATS: Readonly<Record<string, string>> = {
  csv: 'CSV',
  csvwithnames: 'CSVWithNames',
  tsv: 'TSV',
  tabseparated: 'TabSeparated',
  parquet: 'Parquet',
  jsoneachrow: 'JSONEachRow',
  json: 'JSON',
  pretty: 'Pretty',
}

/**
 * Resolve a Layer 3 output format. `'json'` (or omitted) → parsed `Row[]`;
 * `'arrow'` → an apache-arrow `Table`; any other name → a raw `ChdbResult` the
 * caller reads via `.text()` / `.bytes()`.
 */
export function planFormat(format?: string): FormatPlan {
  if (format === undefined || format.toLowerCase() === 'json') return ROWS_PLAN
  // Pass the lowercase 'arrow' alias through verbatim: Layer 1 maps it to
  // ClickHouse's ArrowStream and disables Arrow output compression (which
  // apache-arrow JS cannot decode), so toArrow() works.
  if (format.toLowerCase() === 'arrow') return { chFormat: 'arrow', view: 'arrow' }
  const key = format.toLowerCase()
  const chFormat = RAW_FORMATS[key] ?? format
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(chFormat)) {
    throw new ChdbCompileError(`Invalid output format ${JSON.stringify(format)}`)
  }
  return { chFormat, view: 'raw' }
}

/** Parse a JSONEachRow payload (newline-delimited JSON objects) into rows. */
export function parseRows<T>(text: string): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (line.length > 0) out.push(JSON.parse(line) as T)
  }
  return out
}
