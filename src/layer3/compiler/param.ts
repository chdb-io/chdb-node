/**
 * Server-side parameter binding: every user value the builder carries becomes a
 * ClickHouse named placeholder `{pN:Type}` in the SQL string, while the value
 * itself goes into a separate `parameters` map handed to Layer 1's
 * `queryBindAsync`. The engine binds each value by its declared type; no value
 * is ever spliced into the SQL text. This is the hard security boundary —
 * injection is impossible by construction, not by runtime filtering.
 *
 * Layer 1 owns the value→literal serialization (it applies the same TSV/Escaped
 * encoding its own queryBind path uses), so this module only has to (a) hand out
 * unique placeholder names and (b) pick the ClickHouse type for each placeholder.
 * The raw JS value is what ends up in the `parameters` map, which keeps
 * `.compile()` output readable and auditable.
 */

/**
 * Infer the ClickHouse type for a `{pN:Type}` placeholder from a JS value.
 *
 * Precision-safe mapping (widenings are deliberate and documented):
 *  - string                  → String
 *  - boolean                 → Bool
 *  - integer number          → Int64  (a non-integer number → Float64)
 *  - bigint                  → Int64  (pass an explicit type for Int128/256)
 *  - Date                    → DateTime  (sub-second is dropped; use an explicit
 *                              DateTime64 type to keep it)
 *  - Array / TypedArray      → Array(elem), elem inferred from the first
 *                              non-null item; Nullable(elem) if any item is null
 *  - Map / plain object      → Map(String, String)  (override for typed maps)
 *  - null / undefined        → Nullable(String)
 *
 * Callers can always override with an explicit type (see {@link ParamCollector.bind}).
 */
export function inferChType(value: unknown): string {
  if (value === null || value === undefined) return 'Nullable(String)'
  switch (typeof value) {
    case 'string':
      return 'String'
    case 'boolean':
      return 'Bool'
    case 'bigint':
      return 'Int64'
    case 'number':
      return Number.isInteger(value) ? 'Int64' : 'Float64'
  }
  if (value instanceof Date) return 'DateTime'
  if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
    const arr = Array.isArray(value)
      ? value
      : Array.from(value as unknown as ArrayLike<number | bigint>)
    const sample = arr.find((x) => x !== null && x !== undefined)
    const elem = sample === undefined ? 'String' : inferChType(sample)
    const hasNull = arr.some((x) => x === null || x === undefined)
    // Only scalar element types take a Nullable() wrapper — ClickHouse rejects a
    // Nullable over a composite (Array/Map) type.
    const wrap = hasNull && !elem.startsWith('Array(') && !elem.startsWith('Map(')
    return `Array(${wrap ? `Nullable(${elem})` : elem})`
  }
  // Map and plain objects map to Map(String, String) by default; a typed map
  // needs an explicit placeholder type.
  return 'Map(String, String)'
}

/**
 * Hands out unique `{pN:Type}` placeholders and accumulates the raw values into
 * a single `parameters` map for the whole statement (one collector per compile,
 * so names stay unique across subqueries and CTEs).
 */
export class ParamCollector {
  readonly parameters: Record<string, unknown> = {}
  #next = 0

  /**
   * Bind a value and return its placeholder text. `chType` overrides the
   * inferred ClickHouse type (e.g. a schema-known `UInt64` or `DateTime64(3)`).
   */
  bind(value: unknown, chType?: string): string {
    const name = `p${this.#next++}`
    this.parameters[name] = value
    const type = chType ?? inferChType(value)
    return `{${name}:${type}}`
  }
}
