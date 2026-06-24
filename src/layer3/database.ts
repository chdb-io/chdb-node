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
import type { ExecContext } from './execute/terminal'

/** Anything accepted as a SELECT source: a table name, an expression, or a subquery builder. */
export type FromInput = ExprInput | SelectQueryBuilder<any>

function toFrom(source: FromInput): Expr {
  if (source instanceof SelectQueryBuilder) {
    return { kind: 'Subquery', query: source.toNode() }
  }
  return toExpr(source)
}

/** A builder root bound to a specific execution context (connection / session). */
export class Database<DB = Record<string, any>> {
  constructor(private readonly ctx: ExecContext) {}

  /** Start a SELECT from a table, expression, table function, or subquery. */
  selectFrom<O = Record<string, unknown>>(source: FromInput): SelectQueryBuilder<O> {
    const node: SelectQueryNode = { kind: 'SelectQuery', from: toFrom(source) }
    return new SelectQueryBuilder<O>(this.ctx, node)
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

/** Create a typed builder root. Pass `{ session }` to pin the connection. */
export function database<DB = Record<string, any>>(opts?: { session?: RuntimeSession }): Database<DB> {
  return new Database<DB>({ session: opts?.session })
}

/**
 * Open a Layer 1 Session and bind the builder to it. The returned root owns the
 * session — call `.close()` to release it (and remove the temp dir for an
 * unnamed session).
 */
export function session<DB = Record<string, any>>(path?: string): Database<DB> {
  const s = new (runtime().Session)(path) as unknown as RuntimeSession
  return new Database<DB>({ session: s })
}
