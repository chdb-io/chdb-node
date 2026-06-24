/**
 * DELETE chain: `deleteFrom(t).where(...).execute()`. Like UPDATE, this compiles
 * to a ClickHouse mutation (`ALTER TABLE … DELETE WHERE …`), not an OLTP delete.
 * A WHERE is required.
 */

import type { ChdbResult } from '../../result'
import { compileQuery, type CompiledQuery } from '../compiler/compile'
import type { DeleteQueryNode } from '../compiler/nodes'
import {
  buildPredicate,
  combinePredicate,
  type ExprInput,
  type PredicateArgs,
} from './expression'
import { executeStatement, type ExecContext, type ExecuteOptions } from '../execute/terminal'

export class DeleteQueryBuilder {
  constructor(
    private readonly ctx: ExecContext,
    private readonly node: DeleteQueryNode,
  ) {
    Object.freeze(node)
  }

  private derive(patch: Partial<DeleteQueryNode>): DeleteQueryBuilder {
    return new DeleteQueryBuilder(this.ctx, { ...this.node, ...patch })
  }

  where(lhs: ExprInput): DeleteQueryBuilder
  where(lhs: ExprInput, op: string, rhs: unknown): DeleteQueryBuilder
  where(...args: PredicateArgs): DeleteQueryBuilder {
    return this.derive({ where: combinePredicate(this.node.where, buildPredicate(args), 'And') })
  }

  compile(): CompiledQuery {
    return compileQuery(this.node)
  }

  execute(opts?: ExecuteOptions): Promise<ChdbResult> {
    return executeStatement(this.ctx, this.node, opts)
  }
}
