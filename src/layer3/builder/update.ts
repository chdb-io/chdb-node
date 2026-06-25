/**
 * UPDATE chain: `updateTable(t).set({...}).where(...).execute()`. ClickHouse has
 * no row-level UPDATE statement, so this compiles to an `ALTER TABLE … UPDATE …`
 * mutation — documented as mutation semantics (asynchronous, heavyweight), not
 * an OLTP point update. A WHERE is required (the compiler refuses an unguarded
 * whole-table mutation).
 */

import type { ChdbResult } from '../../result'
import { compileQuery, type CompiledQuery } from '../compiler/compile'
import type { Expr, UpdateQueryNode } from '../compiler/nodes'
import {
  buildPredicate,
  combinePredicate,
  toValue,
  type ExprInput,
  type PredicateArgs,
} from './expression'
import { executeStatement, type ExecContext, type ExecuteOptions } from '../execute/terminal'

export class UpdateQueryBuilder {
  constructor(
    private readonly ctx: ExecContext,
    private readonly node: UpdateQueryNode,
  ) {
    Object.freeze(node)
  }

  private derive(patch: Partial<UpdateQueryNode>): UpdateQueryBuilder {
    return new UpdateQueryBuilder(this.ctx, { ...this.node, ...patch })
  }

  /**
   * Column assignments. Values are bound (`{pN:Type}`) unless wrapped as an
   * expression (e.g. `sql\`col + 1\``). Accumulates across calls.
   */
  set(assignments: Record<string, unknown>): UpdateQueryBuilder {
    const incoming = Object.keys(assignments).map((column) => ({
      column,
      value: toValue(assignments[column]) as Expr,
    }))
    return this.derive({ assignments: [...this.node.assignments, ...incoming] })
  }

  where(lhs: ExprInput): UpdateQueryBuilder
  where(lhs: ExprInput, op: string, rhs: unknown): UpdateQueryBuilder
  where(...args: PredicateArgs): UpdateQueryBuilder {
    return this.derive({ where: combinePredicate(this.node.where, buildPredicate(args), 'And') })
  }

  compile(): CompiledQuery {
    return compileQuery(this.node)
  }

  execute(opts?: ExecuteOptions): Promise<ChdbResult> {
    return executeStatement(this.ctx, this.node, opts)
  }
}
