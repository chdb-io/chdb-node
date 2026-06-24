/**
 * Layer 3 public surface — the fluent, immutable query builder. It borrows the
 * verb names and clause order of the Kysely v0.29.x shape but vendors none of
 * its runtime: a chain accumulates a node tree, `.compile()` emits
 * `{ sql, parameters }`, and execution forwards to Layer 1. Every user value is
 * bound server-side via `{pN:Type}` placeholders — no value is ever spliced into
 * the SQL string.
 *
 * This is a sibling of the pluggable Connection surface (`chdb/connection`), not
 * built on top of it; both sit directly on Layer 1.
 */

export { ChdbCompileError } from '../errors'

// Root factory.
export {
  selectFrom,
  insertInto,
  updateTable,
  deleteFrom,
  connect,
  database,
  session,
  Database,
} from './database'
export type { FromInput } from './database'

// Federated connections (connect).
export { Connection } from './connect/connect'
export type { ColumnInfo } from './connect/connect'
export type { ConnectConfig, SourceKind, SourcePlan } from './connect/url-scheme'

// Builder + expression helpers.
export { SelectQueryBuilder } from './builder/select'
export {
  InsertQueryBuilder,
  InsertValuesExecutable,
  InsertSelectExecutable,
} from './builder/insert'
export type { InsertRow, InsertColumns } from './builder/insert'
export { UpdateQueryBuilder } from './builder/update'
export { DeleteQueryBuilder } from './builder/delete'
export { sql, eb, ref, val, fn, ChExpression } from './builder/expression'
export type { ExprInput } from './builder/expression'

// ClickHouse table-function and function helpers.
export { chTable } from './builder/table-functions'
export type {
  S3Options,
  FileOptions,
  UrlOptions,
  PgOptions,
  MySqlOptions,
  LakeOptions,
} from './builder/table-functions'
export { chFn } from './builder/functions'

// Compiler output (for `.compile()` consumers and tooling).
export { compileQuery } from './compiler/compile'
export type { CompiledQuery } from './compiler/compile'

// Execution options.
export type { ExecuteOptions, ExecContext } from './execute/terminal'

// AST node types.
export type * from './compiler/nodes'

// Type-system: CH type-string-literal → TS type, row inference.
export type { CHTypeOf } from './types/ch-types'
export type { AnyDatabase, ColumnSchema, ColumnType, DatabaseSchema, InferRow, RowOf } from './types/infer'

// Codegen — runtime introspection + the gen-types CLI entry points.
export {
  describeSource,
  introspectTable,
  introspectDatabase,
} from './codegen/introspect'
export type {
  IntrospectedColumn,
  IntrospectedDatabase,
  IntrospectSource,
  IntrospectContext,
} from './codegen/introspect'
export { emitDatabase } from './codegen/emit'
export type { EmitOptions } from './codegen/emit'
export { parsePrismaSchema } from './codegen/from-prisma'
export { parseDrizzleFile, parseDrizzleSource } from './codegen/from-drizzle'
