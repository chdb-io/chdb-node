/**
 * Value serialization primitives: dependency-free building blocks that turn JS
 * values into ClickHouse SQL literals, shared by the queryBind and insert code
 * paths.
 *
 * Security note: the previous binding escaped `'` but NOT `\`, so a value like
 * `a\' OR 1=1 --` could break out of a single-quoted string literal.
 * {@link escapeStringLiteral} escapes the backslash first to close that hole.
 *
 * Scope: this is the JS-type-directed serializer. The declared-type-aware
 * binder for `{name:Type}` placeholders is layered on top (see formatParamValue
 * and the native chdb_query_with_params path).
 */

import { ChdbBindError } from './errors'

// Characters that must be backslash-escaped inside a single-quoted ClickHouse
// string literal. SECURITY-CRITICAL: only `\` (the escape introducer) and `'`
// (the literal delimiter) can break out of the string — those two are what make
// this injection-safe. The C0 control chars below (\0 \b \f \n \r \t) are
// escaped only for clean round-tripping/readability; leaving them raw inside the
// quotes would still be safe and is unambiguous. Any other byte (including all
// UTF-8 multibyte sequences) is passed through verbatim, which is correct.
// Per-character escape table for a single-quoted ClickHouse string literal.
// Keyed by the literal character (e.g. '\b' is the backspace char U+0008, not a
// word boundary). Performance: escaping is a single O(n) pass that only
// allocates when an escapable char is hit (see escapeWith), rather than 8
// sequential whole-string regex replaces.
const SQL_ESCAPE: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  "'": "\\'",
  '\0': '\\0',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

// TSV/Escaped table for query-parameter transport: ClickHouse parses param
// values with TSV rules (backslash escapes; a raw TAB/newline terminates the
// field), so a String param must be escaped this way (NOT SQL-quoted). Same as
// SQL_ESCAPE minus the single-quote (not special in TSV).
const TSV_ESCAPE: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '\0': '\\0',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

// Single-pass escape: copy runs of safe chars and substitute escapes inline.
function escapeWith(s: string, table: Readonly<Record<string, string>>): string {
  let out = ''
  let last = 0
  for (let i = 0; i < s.length; i++) {
    const rep = table[s[i] as string]
    if (rep !== undefined) {
      out += s.slice(last, i) + rep
      last = i + 1
    }
  }
  return last === 0 ? s : out + s.slice(last)
}

/**
 * Escape a JS string into a single-quoted ClickHouse string literal.
 * Escapes `\`, `'`, NUL, and the C0 control chars `\b \f \n \r \t`.
 */
export function escapeStringLiteral(s: string): string {
  return `'${escapeWith(s, SQL_ESCAPE)}'`
}

/** Escape a string for ClickHouse TSV/Escaped query-parameter transport. */
export function tsvEscape(s: string): string {
  return escapeWith(s, TSV_ESCAPE)
}

// Dot-separated segments, each non-empty and limited to [A-Za-z0-9_]. The `.`
// is only a `db.table` separator: this rejects the empty string, a leading or
// trailing dot, and consecutive dots (`.`, `..`, `a..b`, `.tbl`, `tbl.`), all
// of which pass a flat [A-Za-z0-9_.] whitelist but produce malformed SQL.
const IDENTIFIER_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/

/**
 * Validate an identifier (table / column / database, possibly dotted) against a
 * strict whitelist and return it unchanged. Identifiers are guarded by the
 * whitelist, NOT by quote-escaping: `db.table` must pass through as `db.table`,
 * not be wrapped as a single backtick-quoted name.
 *
 * @throws ChdbBindError if the identifier is not non-empty `[A-Za-z0-9_]`
 *   segments separated by `.`.
 */
export function validateIdentifier(name: string): string {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new ChdbBindError(
      `Invalid identifier ${JSON.stringify(name)}: expected non-empty [A-Za-z0-9_] segments separated by '.'`,
    )
  }
  return name
}

function formatDateTimeUTC(d: Date): string {
  if (Number.isNaN(d.getTime())) {
    throw new ChdbBindError('Cannot serialize an invalid Date')
  }
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  )
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ChdbBindError(`Cannot serialize non-finite number ${value}`)
  }
  if (Number.isInteger(value)) {
    // Never silently lose precision: an integer-valued number beyond ±2^53 has
    // already lost exact bits, so refuse it and point at the lossless paths.
    if (!Number.isSafeInteger(value)) {
      throw new ChdbBindError(
        `Refusing to serialize unsafe integer ${value} (beyond ±2^53): ` +
          `pass a bigint or string to preserve precision`,
      )
    }
    // Safe integers (|v| < 2^53) never render in exponent notation.
    return value.toString()
  }
  return String(value)
}

/**
 * Serialize a JS value into a ClickHouse SQL literal (recursive).
 *
 * Mapping:
 *  - null / undefined        -> NULL
 *  - boolean                 -> true / false
 *  - number                  -> finite literal (NaN/Infinity rejected)
 *  - bigint                  -> exact decimal digits (no precision loss)
 *  - string                  -> escaped single-quoted literal
 *  - Date                    -> 'YYYY-MM-DD HH:MM:SS' (UTC)
 *  - Array / TypedArray      -> [a, b, c]
 *  - Map                     -> {k: v, ...}  (keys escaped as string literals)
 *  - plain object            -> {k: v, ...}  (keys escaped as string literals)
 *
 * @throws ChdbBindError on non-finite numbers, invalid Dates, or unsupported types.
 */
export function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return serializeNumber(value)
    case 'bigint':
      return value.toString()
    case 'string':
      return escapeStringLiteral(value)
    case 'function':
    case 'symbol':
      throw new ChdbBindError(`Cannot serialize a ${typeof value} value`)
  }

  if (value instanceof Date) return escapeStringLiteral(formatDateTimeUTC(value))

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // TypedArray (Int32Array, Float64Array, …) -> Array literal.
    return serializeArray(Array.from(value as unknown as ArrayLike<number | bigint>))
  }

  if (Array.isArray(value)) return serializeArray(value)

  if (value instanceof Map) {
    const parts: string[] = []
    for (const [k, v] of value) {
      parts.push(`${escapeStringLiteral(String(k))}:${serializeValue(v)}`)
    }
    return `{${parts.join(',')}}`
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const parts = Object.keys(obj).map(
      (k) => `${escapeStringLiteral(k)}:${serializeValue(obj[k])}`,
    )
    return `{${parts.join(',')}}`
  }

  throw new ChdbBindError(`Cannot serialize value of type ${typeof value}`)
}

// Recursion cost: serializeValue recurses once per element/entry, so cost is
// O(total cells) and is bounded by the input the caller already holds in
// memory. It runs once per query/insert at serialization time, not in a
// per-row hot loop, so for typical parameters (scalars, small arrays/maps) it
// is negligible. The place this can matter is bulk insert of large arrays
// (O(rows x cells) string building + one large VALUES string); that path is
// intended to move to the Arrow/binary insert route rather than be optimized
// here.
function serializeArray(arr: ReadonlyArray<unknown>): string {
  return `[${arr.map((x) => serializeValue(x)).join(',')}]`
}

/**
 * Format a JS value as a ClickHouse **parameter** string for server-side
 * binding via `chdb_query_with_params` ({name:Type} placeholders). This is NOT
 * a SQL literal: the engine binds the value (resolving its type from the
 * placeholder) using TSV/Escaped parsing. A top-level string is TSV-escaped
 * (backslash/TAB/newline escaped, but NOT SQL-quoted); a Date is its plain
 * 'YYYY-MM-DD HH:MM:SS' form. Nested values inside Array/Map keep SQL-literal
 * quoting (e.g. `['a','b']`) because that is how the engine parses composite
 * param values.
 *
 * Because the engine binds the value (never interpolates it into SQL), there is
 * no escaping/injection surface here at all.
 *
 * A top-level `null`/`undefined` becomes the TSV null marker `\N`, byte-for-byte
 * matching @clickhouse/client-common's `formatQueryParams` (which emits `\N`
 * when `printNullAsKeyword` is false — the default at the top level). The engine
 * binds `\N` as SQL NULL for a Nullable placeholder (verified against
 * Nullable(String) and Nullable(Int64)); binding it to a non-Nullable
 * placeholder is rejected by the ENGINE, exactly as the HTTP client + server
 * would. A `null` NESTED inside an Array/Map keeps the `NULL` keyword form (see
 * serializeValue) — again matching the reference client.
 *
 * @throws ChdbBindError on non-finite or unsafe-integer numbers, invalid Dates,
 *   or unsupported types.
 */
export function formatParamValue(value: unknown): string {
  if (value === null || value === undefined) return '\\N'
  if (typeof value === 'string') return tsvEscape(value) // TSV/Escaped — engine binds as declared type
  if (value instanceof Date) return formatDateTimeUTC(value) // 'YYYY-MM-DD HH:MM:SS' (no TSV-special chars)
  // numbers / bigint / boolean / Array / TypedArray / Map / object: the
  // SQL-literal form is exactly the param form (nested strings stay quoted).
  return serializeValue(value)
}
