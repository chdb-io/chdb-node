/**
 * Value serialization primitives (design §3.4 / §8, path B).
 *
 * These are the dependency-free building blocks that both queryBind (Item 5)
 * and insert (Item 6) consume to turn JS values into ClickHouse SQL literals.
 *
 * Security note: this module closes the v2 `chEscape` injection hole — v2
 * escaped `'` but NOT `\`, so a value like `a\' OR 1=1 --` could break out of
 * the string literal. {@link escapeStringLiteral} escapes the backslash first.
 *
 * Scope: this is the JS-type-directed serializer (no declared `{name:Type}`).
 * The declared-type-aware binder (the 64-bit `number` rejection, Tuple vs
 * Array disambiguation, per-`:Type` coercion, @clickhouse/client 1:1 parity)
 * layers on top of these primitives in Item 5.
 */

import { ChdbBindError } from './errors'

const STRING_ESCAPES: ReadonlyArray<[RegExp, string]> = [
  // Backslash MUST be first so we don't double-escape the escapes we add below.
  [/\\/g, '\\\\'],
  [/'/g, "\\'"],
  [/\0/g, '\\0'],
  // NB: \x08 (backspace), NOT /\b/ which is a zero-width word-boundary assertion.
  [/\x08/g, '\\b'],
  [/\f/g, '\\f'],
  [/\n/g, '\\n'],
  [/\r/g, '\\r'],
  [/\t/g, '\\t'],
]

/**
 * Escape a JS string into a single-quoted ClickHouse string literal.
 * Escapes `\`, `'`, NUL, and the C0 control chars `\b \f \n \r \t`.
 */
export function escapeStringLiteral(s: string): string {
  let body = s
  for (const [re, rep] of STRING_ESCAPES) {
    body = body.replace(re, rep)
  }
  return `'${body}'`
}

const IDENTIFIER_RE = /^[A-Za-z0-9_.]+$/

/**
 * Validate an identifier (table / column / database, possibly dotted) against a
 * strict whitelist and return it unchanged. Identifiers are guarded by the
 * whitelist, NOT by quote-escaping (design §8): `db.table` must pass through as
 * `db.table`, not be wrapped as a single backtick-quoted name.
 *
 * @throws ChdbBindError if the identifier contains anything outside `[A-Za-z0-9_.]`.
 */
export function validateIdentifier(name: string): string {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new ChdbBindError(
      `Invalid identifier ${JSON.stringify(name)}: only [A-Za-z0-9_.] are allowed`,
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

function serializeArray(arr: ReadonlyArray<unknown>): string {
  return `[${arr.map((x) => serializeValue(x)).join(',')}]`
}
