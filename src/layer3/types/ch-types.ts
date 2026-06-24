/**
 * Maps a ClickHouse type written as a string literal to its TypeScript shape.
 *
 *   CHTypeOf<'UInt32'>                  // number
 *   CHTypeOf<'UInt64'>                  // string (precision-safe — JS number can't hold 64 bits)
 *   CHTypeOf<'String'>                  // string
 *   CHTypeOf<'Bool'>                    // boolean
 *   CHTypeOf<'Nullable(UInt32)'>        // number | null
 *   CHTypeOf<'Array(String)'>           // string[]
 *   CHTypeOf<"DateTime('UTC')">         // string
 *   CHTypeOf<'Decimal(18, 4)'>          // string
 *
 * Conversion policy (declared explicitly — same as hypequery / chdb-python):
 *  - small ints (8/16/32, signed or unsigned)  -> `number`
 *  - large ints (64/128/256)                   -> `string`  (round-trips losslessly)
 *  - floats                                    -> `number`
 *  - dates / datetimes / decimals              -> `string`  (matches ClickHouse text)
 *  - UUID / IPv4 / IPv6 / FixedString          -> `string`
 *  - Bool                                      -> `boolean`
 *  - Nullable(T)         -> CHTypeOf<T> | null
 *  - LowCardinality(T)   -> CHTypeOf<T>        (storage hint, not visible to JS)
 *  - Array(T)            -> CHTypeOf<T>[]
 *  - Map(K, V)           -> Record<string|number, CHTypeOf<V>>  (key flattens to a JS object key)
 *  - Tuple(...)          -> unknown[]          (positional shape; precise tuple typing is a follow-up)
 *  - any unknown literal -> unknown            (degrades gracefully; never lies about the type)
 *
 * Nested types parse top-down via template-literal `infer` and recurse on the
 * inner type, so `Nullable(Array(Int32))` -> `(number[]) | null`.
 */

// Numeric type sets, expressed once so the conditional below stays readable.
type SmallInt =
  | 'Int8' | 'Int16' | 'Int32'
  | 'UInt8' | 'UInt16' | 'UInt32'

type BigInt_ =
  | 'Int64' | 'Int128' | 'Int256'
  | 'UInt64' | 'UInt128' | 'UInt256'

type FloatLike = 'Float32' | 'Float64'

type StringLike =
  | 'String'
  | 'UUID'
  | 'IPv4' | 'IPv6'

type BoolLike = 'Bool' | 'Boolean'

// The leaf-type map. Anything that doesn't match a wrapper or a leaf falls
// through to `unknown`, which is the honest answer.
type CHLeaf<T extends string> =
  T extends StringLike ? string :
  T extends BoolLike ? boolean :
  T extends FloatLike ? number :
  T extends SmallInt ? number :
  T extends BigInt_ ? string :
  // Family prefixes (cover all parameterizations: `FixedString(N)`,
  // `Decimal(P,S)` / `Decimal32(S)` / …, `Date`, `Date32`, `DateTime`,
  // `DateTime('UTC')`, `DateTime64(3)`, `DateTime64(3, 'UTC')`, enums).
  T extends `FixedString${string}` ? string :
  T extends `Decimal${string}` ? string :
  T extends `DateTime${string}` ? string :
  T extends `Date${string}` ? string :
  T extends `Enum${string}` ? string :
  unknown

/** Strip the outermost wrapper (Nullable / LowCardinality / Array / Map) and recurse. */
export type CHTypeOf<T extends string> =
  T extends `Nullable(${infer Inner})` ? CHTypeOf<Inner> | null :
  T extends `LowCardinality(${infer Inner})` ? CHTypeOf<Inner> :
  T extends `Array(${infer Inner})` ? CHTypeOf<Inner>[] :
  T extends `Map(${infer K}, ${infer V})` ? MapOf<K, V> :
  T extends `Tuple(${string})` ? unknown[] :
  CHLeaf<T>

// A CH Map key flattens to a JS object key — string or number, depending on
// what the inner CH type maps to. Anything else widens to `string`, since JS
// object keys are stringified anyway.
type MapOf<K extends string, V extends string> =
  CHTypeOf<K> extends infer KK
    ? KK extends string | number
      ? Record<KK, CHTypeOf<V>>
      : Record<string, CHTypeOf<V>>
    : Record<string, CHTypeOf<V>>
