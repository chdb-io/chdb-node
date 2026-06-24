// Fixture for the from-drizzle parser. We don't actually import drizzle-orm —
// the parser is static, so any TS file shaped like a Drizzle schema works. The
// chained `.notNull()` / `.primaryKey()` modifiers are what matter for the
// Nullable wrap; everything else (defaults / references) is ignored.
declare function pgTable(name: string, columns: Record<string, unknown>): unknown
declare const bigint: (name: string, opts?: { mode?: 'number' | 'bigint' }) => any
declare const integer: (name: string) => any
declare const smallint: (name: string) => any
declare const text: (name: string) => any
declare const varchar: (name: string, opts?: { length?: number }) => any
declare const boolean: (name: string) => any
declare const real: (name: string) => any
declare const doublePrecision: (name: string) => any
declare const numeric: (name: string, opts?: { precision?: number; scale?: number }) => any
declare const timestamp: (name: string, opts?: { withTimezone?: boolean }) => any
declare const date: (name: string) => any
declare const jsonb: (name: string) => any
declare const uuid: (name: string) => any

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  age: smallint('age'),
  height: real('height').notNull(),
  weight: doublePrecision('weight'),
  balance: numeric('balance', { precision: 18, scale: 4 }).notNull(),
  price: numeric('price'),
  active: boolean('active').notNull(),
  createdAtUtc: timestamp('created_at_utc').notNull(),
  createdAtNaive: timestamp('created_at_naive', { withTimezone: false }).notNull(),
  bornOn: date('born_on'),
  meta: jsonb('meta'),
  externalId: uuid('external_id').notNull(),
})

export const orders = pgTable('orders', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  total: numeric('total', { precision: 12, scale: 2 }).notNull(),
})
