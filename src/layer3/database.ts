/**
 * Root factory for the fluent builder.
 *
 *  - `selectFrom(table)` — the top-level shortcut on the default connection.
 *  - `database<DB>(opts?)` — a typed root; pass a Session to pin the connection.
 *  - `session(path?)` — open a Layer 1 Session and bind the builder to it (for
 *    persistent / multi-step pipelines); call `.close()` when done.
 *
 * A `Database` is just a thin holder of the execution context (which connection
 * to run on); the builders carry all the query state.
 */

import { runtime, type RuntimeSession } from './runtime'
import type { Expr, SelectQueryNode } from './compiler/nodes'
import { toExpr, type ExprInput } from './builder/expression'
import { SelectQueryBuilder } from './builder/select'
import { InsertQueryBuilder } from './builder/insert'
import { UpdateQueryBuilder } from './builder/update'
import { DeleteQueryBuilder } from './builder/delete'
import { Connection } from './connect/connect'
import type { ConnectConfig } from './connect/url-scheme'
import type { ExecContext } from './execute/terminal'
import type { AnyDatabase, InferRow } from './types/infer'

/** Anything accepted as a SELECT source: a table name, an expression, or a subquery builder. */
export type FromInput = ExprInput | SelectQueryBuilder<any>

function toFrom(source: FromInput): Expr {
  if (source instanceof SelectQueryBuilder) {
    return { kind: 'Subquery', query: source.toNode() }
  }
  return toExpr(source)
}

/**
 * A builder root bound to an execution context (connection / session). When the
 * `DB` type argument lists tables and column types (see `gen-types`), passing a
 * known table name to `selectFrom` infers the row shape at `.execute()`.
 */
export class Database<DB = AnyDatabase> {
  constructor(private readonly ctx: ExecContext) {}

  /** Typed: `selectFrom('events')` infers the row from `DB['events']`. */
  selectFrom<T extends Extract<keyof DB, string>>(table: T): SelectQueryBuilder<InferRow<DB[T]>>
  /** Untyped: any expression / subquery; the row is `Record<string, unknown>` unless `O` is set. */
  selectFrom<O = Record<string, unknown>>(source: FromInput): SelectQueryBuilder<O>
  selectFrom(source: FromInput): SelectQueryBuilder<any> {
    const node: SelectQueryNode = { kind: 'SelectQuery', from: toFrom(source) }
    return new SelectQueryBuilder(this.ctx, node)
  }

  /** Start an INSERT into a table (row arrays or `INSERT … SELECT`). */
  insertInto(table: string): InsertQueryBuilder {
    return new InsertQueryBuilder(this.ctx, table)
  }

  /** Start an UPDATE (compiles to a ClickHouse `ALTER TABLE … UPDATE` mutation). */
  updateTable(table: string): UpdateQueryBuilder {
    return new UpdateQueryBuilder(this.ctx, { kind: 'UpdateQuery', table, assignments: [] })
  }

  /** Start a DELETE (compiles to a ClickHouse `ALTER TABLE … DELETE` mutation). */
  deleteFrom(table: string): DeleteQueryBuilder {
    return new DeleteQueryBuilder(this.ctx, { kind: 'DeleteQuery', table })
  }

  /** Open a federated connection to an external data source (read through chDB). */
  connect(config: ConnectConfig): Connection {
    return new Connection(this.ctx, config)
  }

  /** The bound Session, if this root was created with one. */
  get session(): RuntimeSession | undefined {
    return this.ctx.session
  }

  /** Close the bound Session (no-op on the default connection). */
  close(): void {
    this.ctx.session?.close()
  }
}

const DEFAULT = new Database({})

/** Start a SELECT on the default connection (the README hero shortcut). */
export function selectFrom<O = Record<string, unknown>>(source: FromInput): SelectQueryBuilder<O> {
  return DEFAULT.selectFrom<O>(source)
}

/** Start an INSERT on the default connection. */
export function insertInto(table: string): InsertQueryBuilder {
  return DEFAULT.insertInto(table)
}

/** Start an UPDATE (ClickHouse mutation) on the default connection. */
export function updateTable(table: string): UpdateQueryBuilder {
  return DEFAULT.updateTable(table)
}

/** Start a DELETE (ClickHouse mutation) on the default connection. */
export function deleteFrom(table: string): DeleteQueryBuilder {
  return DEFAULT.deleteFrom(table)
}

/** Open a federated connection to an external data source on the default connection. */
export function connect(config: ConnectConfig): Connection {
  return DEFAULT.connect(config)
}

/** Create a typed builder root. Pass `{ session }` to pin the connection. */
export function database<DB = AnyDatabase>(opts?: { session?: RuntimeSession }): Database<DB> {
  return new Database<DB>({ session: opts?.session })
}

/**
 * Open a Layer 1 Session and bind the builder to it. The returned root owns the
 * session — call `.close()` to release it (and remove the temp dir for an
 * unnamed session).
 */
export function session<DB = AnyDatabase>(path?: string): Database<DB> {
  const s = new (runtime().Session)(path) as unknown as RuntimeSession
  return new Database<DB>({ session: s })
}
