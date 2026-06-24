/**
 * A user-authored Database interface describes each table's columns as
 * ClickHouse type string literals; the builder turns that schema into a row
 * type at the `.execute()` boundary via a single mapped type. The `gen-types`
 * CLI emits exactly this shape.
 *
 *   interface Db {
 *     events: {
 *       id: 'UInt64'
 *       country: 'String'
 *       ts: "DateTime('UTC')"
 *       cnt: 'Nullable(UInt32)'
 *     }
 *   }
 *
 *   const rows = await chdb.database<Db>().selectFrom('events').selectAll().execute()
 *   // rows: { id: string; country: string; ts: string; cnt: number | null }[]
 */

import type { CHTypeOf } from './ch-types'

/** One column's CH type, written as a string literal. */
export type ColumnType = string

/** A table = column name → CH type literal. */
export type ColumnSchema = Record<string, ColumnType>

/** A database = table name → column schema. */
export type DatabaseSchema = Record<string, ColumnSchema>

/**
 * Compile a column schema into the JS row shape it produces. Accepts any shape
 * so a user-declared `interface Db { … }` (which does not auto-satisfy an index
 * signature) works as-is; columns whose value isn't a CH type literal degrade
 * to `unknown` rather than fail to compile.
 */
export type InferRow<S> = {
  [K in keyof S]: S[K] extends string ? CHTypeOf<S[K]> : unknown
}

/** The default (untyped) database — every table is `Record<string, unknown>`. */
export interface AnyDatabase {
  [table: string]: ColumnSchema
}

/**
 * Extract the row type from a typed builder for use in `expectTypeOf` and
 * mapped-type plumbing. Sidesteps TypeScript's `ReturnType` rule that picks the
 * last overload of `.execute()` (which the builder uses for non-JSON formats).
 */
export type RowOf<T> = T extends { readonly _row: infer R } ? R : never
