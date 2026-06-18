/**
 * Query-parameter formatting for the `@clickhouse/client` byte-compat surface.
 *
 * clickhouse-js binds `{name:Type}` placeholders by serializing each JS value to
 * a ClickHouse text literal and handing the engine the `{name: literal}` map.
 * Layer 1 has its OWN parameter serializer (a different dialect, e.g. Date →
 * 'YYYY-MM-DD HH:MM:SS'); Layer 2 must instead reproduce clickhouse-js's exact
 * output so a client swapped from `@clickhouse/client` to chdb binds identically.
 *
 * This is a faithful port of clickhouse-js's `formatQueryParams`:
 *  - top level: strings are NOT quoted (the engine parses them per the declared
 *    type) and `null` is the TSV token `\N`;
 *  - inside an Array / Tuple / Map: strings ARE quoted and `null` is the keyword
 *    `NULL` (ClickHouse literal syntax);
 *  - booleans are `1`/`0` at top level but `TRUE`/`FALSE` inside a composite;
 *  - Date → a Unix timestamp (seconds, with a `.mmm` fraction when sub-second);
 *  - a Tuple must be wrapped in {@link TupleParam} (a plain array is an Array),
 *    mirroring clickhouse-js, since JS cannot distinguish the two.
 */

/**
 * Marks an array as a ClickHouse `Tuple(...)` query parameter (serialized as
 * `(a, b, …)`), as opposed to an `Array(...)` (`[a, b, …]`). JS has no native
 * tuple type, so — exactly like clickhouse-js — the value must be wrapped to
 * disambiguate. A clickhouse-js `TupleParam` is also accepted (see isTupleParam).
 */
export class TupleParam {
  constructor(public readonly values: readonly unknown[]) {}
}

// Accept this package's TupleParam AND a clickhouse-js TupleParam (a client
// migrating from @clickhouse/client may still import its wrapper). Both expose a
// readonly `values` array; match structurally rather than by identity so the two
// independent class instances are treated alike.
function isTupleParam(v: unknown): v is { values: readonly unknown[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { values?: unknown }).values) &&
    v.constructor != null &&
    v.constructor.name === 'TupleParam'
  )
}

interface FmtOptions {
  wrapStringInQuotes: boolean
  // Inside an Array/Tuple/Map, NULL must be the keyword, not the TSV token.
  printNullAsKeyword: boolean
  isInArrayOrTuple: boolean
}

const NESTED: FmtOptions = {
  wrapStringInQuotes: true,
  printNullAsKeyword: true,
  isInArrayOrTuple: true,
}

function escapeString(value: string, wrapInQuotes: boolean): string {
  let result = ''
  for (let i = 0; i < value.length; i++) {
    switch (value.charCodeAt(i)) {
      case 9: // \t
        result += '\\t'
        break
      case 10: // \n
        result += '\\n'
        break
      case 13: // \r
        result += '\\r'
        break
      case 39: // '
        result += "\\'"
        break
      case 92: // \
        result += '\\\\'
        break
      default:
        result += value[i]
    }
  }
  return wrapInQuotes ? `'${result}'` : result
}

function formatObjectLike(entries: Iterable<[unknown, unknown]>): string {
  const parts: string[] = []
  for (const [k, v] of entries) {
    parts.push(`${fmt(k, NESTED)}:${fmt(v, NESTED)}`)
  }
  return `{${parts.join(',')}}`
}

function fmt(value: unknown, opts: FmtOptions): string {
  if (value === null || value === undefined) {
    return opts.printNullAsKeyword ? 'NULL' : '\\N'
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan'
    if (value === Number.POSITIVE_INFINITY) return '+inf'
    if (value === Number.NEGATIVE_INFINITY) return '-inf'
    return String(value)
  }
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') {
    if (opts.isInArrayOrTuple) return value ? 'TRUE' : 'FALSE'
    return value ? '1' : '0'
  }
  if (typeof value === 'string') return escapeString(value, opts.wrapStringInQuotes)
  if (Array.isArray(value)) {
    return `[${value.map((v) => fmt(v, NESTED)).join(',')}]`
  }
  if (value instanceof Date) {
    // The engine reads a numeric DateTime parameter as a timezone-agnostic Unix
    // timestamp; keep the sub-second part so DateTime64 round-trips.
    const seconds = Math.floor(value.getTime() / 1000)
      .toString()
      .padStart(10, '0')
    const ms = value.getUTCMilliseconds()
    return ms === 0 ? seconds : `${seconds}.${ms.toString().padStart(3, '0')}`
  }
  if (isTupleParam(value)) {
    return `(${value.values.map((v) => fmt(v, NESTED)).join(',')})`
  }
  if (value instanceof Map) {
    return formatObjectLike(value.entries())
  }
  if (typeof value === 'object') {
    return formatObjectLike(Object.entries(value as Record<string, unknown>))
  }
  throw new Error(`Unsupported value in query parameters: [${String(value)}].`)
}

/** Format a single value as a top-level `{name:Type}` parameter literal. */
export function formatQueryParam(value: unknown): string {
  return fmt(value, { wrapStringInQuotes: false, printNullAsKeyword: false, isInArrayOrTuple: false })
}

/** Map a `query_params` object to the engine's `{name: literal}` bound map. */
export function formatQueryParams(params: Record<string, unknown>): Record<string, string> {
  const bound: Record<string, string> = {}
  for (const k of Object.keys(params)) bound[k] = formatQueryParam(params[k])
  return bound
}
