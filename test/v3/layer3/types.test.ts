import { describe, it, expectTypeOf } from 'vitest'
import { database } from '../../../index.js'
import type { CHTypeOf, InferRow, RowOf } from '../../../index.js'

// Type-layer tests: these run as no-op assertions at runtime but assert the
// compile-time mapping from ClickHouse type literals to TypeScript types. A
// failure here surfaces as a `tsc` error (caught by `npm run typecheck`).

describe('CHTypeOf — leaf types', () => {
  it('small ints / floats map to `number`', () => {
    expectTypeOf<CHTypeOf<'Int8'>>().toEqualTypeOf<number>()
    expectTypeOf<CHTypeOf<'UInt16'>>().toEqualTypeOf<number>()
    expectTypeOf<CHTypeOf<'Int32'>>().toEqualTypeOf<number>()
    expectTypeOf<CHTypeOf<'UInt32'>>().toEqualTypeOf<number>()
    expectTypeOf<CHTypeOf<'Float32'>>().toEqualTypeOf<number>()
    expectTypeOf<CHTypeOf<'Float64'>>().toEqualTypeOf<number>()
  })

  it('64+ bit ints map to `string` for JS precision safety', () => {
    expectTypeOf<CHTypeOf<'Int64'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'UInt64'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'Int128'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'UInt256'>>().toEqualTypeOf<string>()
  })

  it('strings, UUID, IP, Bool', () => {
    expectTypeOf<CHTypeOf<'String'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'UUID'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'IPv4'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'IPv6'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'Bool'>>().toEqualTypeOf<boolean>()
  })

  it('parameterized leaves (FixedString / Decimal / Date / DateTime / Enum) map to `string`', () => {
    expectTypeOf<CHTypeOf<'FixedString(16)'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'Decimal(18, 4)'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'Decimal64(3)'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'Date'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'Date32'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'DateTime'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<"DateTime('UTC')">>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<'DateTime64(3)'>>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<"DateTime64(3, 'UTC')">>().toEqualTypeOf<string>()
    expectTypeOf<CHTypeOf<"Enum8('a' = 1, 'b' = 2)">>().toEqualTypeOf<string>()
  })

  it('unknown literals degrade to `unknown` rather than lie', () => {
    expectTypeOf<CHTypeOf<'NotAType'>>().toEqualTypeOf<unknown>()
  })
})

describe('CHTypeOf — wrappers', () => {
  it('Nullable(T) is `CHTypeOf<T> | null`', () => {
    expectTypeOf<CHTypeOf<'Nullable(UInt32)'>>().toEqualTypeOf<number | null>()
    expectTypeOf<CHTypeOf<'Nullable(String)'>>().toEqualTypeOf<string | null>()
    expectTypeOf<CHTypeOf<'Nullable(UInt64)'>>().toEqualTypeOf<string | null>()
  })

  it('LowCardinality(T) is transparent (storage hint, not a JS type)', () => {
    expectTypeOf<CHTypeOf<'LowCardinality(String)'>>().toEqualTypeOf<string>()
  })

  it('Array(T) is `CHTypeOf<T>[]`', () => {
    expectTypeOf<CHTypeOf<'Array(Int32)'>>().toEqualTypeOf<number[]>()
    expectTypeOf<CHTypeOf<'Array(String)'>>().toEqualTypeOf<string[]>()
  })

  it('Map(K, V) is `Record<K-key, V>` (string|number keys)', () => {
    expectTypeOf<CHTypeOf<'Map(String, UInt32)'>>().toEqualTypeOf<Record<string, number>>()
    expectTypeOf<CHTypeOf<'Map(UInt32, String)'>>().toEqualTypeOf<Record<number, string>>()
  })

  it('Tuple(...) is `unknown[]` (positional shape; precise tuple typing is a follow-up)', () => {
    expectTypeOf<CHTypeOf<'Tuple(String, Int32)'>>().toEqualTypeOf<unknown[]>()
  })

  it('nested wrappers recurse', () => {
    expectTypeOf<CHTypeOf<'Nullable(Array(Int32))'>>().toEqualTypeOf<number[] | null>()
    expectTypeOf<CHTypeOf<'Array(Nullable(String))'>>().toEqualTypeOf<(string | null)[]>()
    expectTypeOf<CHTypeOf<'LowCardinality(Nullable(String))'>>().toEqualTypeOf<string | null>()
  })
})

describe('InferRow — schema → row mapping', () => {
  it('maps each column through CHTypeOf', () => {
    type Events = {
      id: 'UInt64'
      country: 'String'
      ts: "DateTime('UTC')"
      cnt: 'Nullable(UInt32)'
      tags: 'Array(String)'
    }
    expectTypeOf<InferRow<Events>>().toEqualTypeOf<{
      id: string
      country: string
      ts: string
      cnt: number | null
      tags: string[]
    }>()
  })
})

describe('Database<DB>.selectFrom — row inference end to end', () => {
  interface Db {
    events: {
      id: 'UInt64'
      country: 'String'
      ts: "DateTime('UTC')"
      cnt: 'Nullable(UInt32)'
    }
    users: { uid: 'UInt64'; name: 'String' }
  }

  it('a known table key infers `InferRow<DB[table]>` through to .execute()', () => {
    const db = database<Db>()
    const q = db.selectFrom('events').selectAll()
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
      id: string
      country: string
      ts: string
      cnt: number | null
    }>()
  })

  it('a non-string source still works and stays generic', () => {
    const db = database<Db>()
    const q = db.selectFrom<{ x: number }>(db.selectFrom('users').selectAll())
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ x: number }>()
  })
})
