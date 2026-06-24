/**
 * SelectQueryBuilder — the immutable SELECT chain. Every method returns a NEW
 * builder over a NEW frozen node, so `const q2 = q1.where(...)` derives from `q1`
 * without mutating it and an unexecuted query can be passed around and composed.
 *
 * Verb names and clause order copy the Kysely v0.29.x shape (subject-first:
 * `selectFrom().where().groupBy().orderBy().limit()`); the runtime is
 * chDB's own, not Kysely's.
 */

import { ChdbCompileError } from '../../errors'
import { compileQuery, type CompiledQuery } from '../compiler/compile'
import type {
  Expr,
  JoinKind,
  OrderByItem,
  SelectQueryNode,
  SetOperator,
} from '../compiler/nodes'
import { ChExpression, toExpr, toValue, type ExprInput } from './expression'
import {
  executeSelect,
  type ExecContext,
  type ExecuteOptions,
} from '../execute/terminal'

/** Combine an existing predicate with a new one under AND / OR, flattening. */
function combine(existing: Expr | undefined, next: Expr, kind: 'And' | 'Or'): Expr {
  if (existing === undefined) return next
  if (existing.kind === kind) return { kind, items: [...existing.items, next] }
  return { kind, items: [existing, next] }
}

/** One element of a where/having call: either `(lhs, op, rhs)` or a single expression. */
type ColumnInput = ExprInput

export class SelectQueryBuilder<O = Record<string, unknown>> {
  constructor(
    private readonly ctx: ExecContext,
    private readonly node: SelectQueryNode,
  ) {
    Object.freeze(node)
  }

  private derive(patch: Partial<SelectQueryNode>): SelectQueryBuilder<O> {
    return new SelectQueryBuilder<O>(this.ctx, { ...this.node, ...patch })
  }

  // ---- projection -----------------------------------------------------------

  /** Add selections (accumulates across calls). Each is a column / expression. */
  select(selection: ColumnInput | ReadonlyArray<ColumnInput>): SelectQueryBuilder<O> {
    const incoming = (Array.isArray(selection) ? selection : [selection]).map(toExpr)
    return this.derive({ selections: [...(this.node.selections ?? []), ...incoming] })
  }

  /** Select everything (`SELECT *`). */
  selectAll(): SelectQueryBuilder<O> {
    return this.derive({ selections: [{ kind: 'Star' }] })
  }

  distinct(): SelectQueryBuilder<O> {
    return this.derive({ distinct: true })
  }

  // ---- filtering ------------------------------------------------------------

  private predicate(args: [ColumnInput] | [ColumnInput, string, unknown]): Expr {
    if (args.length === 1) return toExpr(args[0])
    const [lhs, op, rhs] = args
    return { kind: 'Binary', left: toExpr(lhs), op, right: toValue(rhs) }
  }

  /** AND a predicate. `(col, op, value)` or a single expression. */
  where(lhs: ColumnInput): SelectQueryBuilder<O>
  where(lhs: ColumnInput, op: string, rhs: unknown): SelectQueryBuilder<O>
  where(...args: [ColumnInput] | [ColumnInput, string, unknown]): SelectQueryBuilder<O> {
    return this.derive({ where: combine(this.node.where, this.predicate(args), 'And') })
  }

  /** Alias for {@link where} (explicit AND). */
  andWhere(lhs: ColumnInput): SelectQueryBuilder<O>
  andWhere(lhs: ColumnInput, op: string, rhs: unknown): SelectQueryBuilder<O>
  andWhere(...args: [ColumnInput] | [ColumnInput, string, unknown]): SelectQueryBuilder<O> {
    return this.derive({ where: combine(this.node.where, this.predicate(args), 'And') })
  }

  /** OR a predicate into the WHERE clause. */
  orWhere(lhs: ColumnInput): SelectQueryBuilder<O>
  orWhere(lhs: ColumnInput, op: string, rhs: unknown): SelectQueryBuilder<O>
  orWhere(...args: [ColumnInput] | [ColumnInput, string, unknown]): SelectQueryBuilder<O> {
    return this.derive({ where: combine(this.node.where, this.predicate(args), 'Or') })
  }

  having(lhs: ColumnInput): SelectQueryBuilder<O>
  having(lhs: ColumnInput, op: string, rhs: unknown): SelectQueryBuilder<O>
  having(...args: [ColumnInput] | [ColumnInput, string, unknown]): SelectQueryBuilder<O> {
    return this.derive({ having: combine(this.node.having, this.predicate(args), 'And') })
  }

  // ---- grouping / ordering / paging ----------------------------------------

  groupBy(columns: ColumnInput | ReadonlyArray<ColumnInput>): SelectQueryBuilder<O> {
    const incoming = (Array.isArray(columns) ? columns : [columns]).map(toExpr)
    return this.derive({ groupBy: [...(this.node.groupBy ?? []), ...incoming] })
  }

  orderBy(column: ColumnInput, direction: 'asc' | 'desc' = 'asc'): SelectQueryBuilder<O> {
    const item: OrderByItem = { expr: toExpr(column), direction }
    return this.derive({ orderBy: [...(this.node.orderBy ?? []), item] })
  }

  limit(count: number): SelectQueryBuilder<O> {
    return this.derive({ limit: count })
  }

  offset(count: number): SelectQueryBuilder<O> {
    return this.derive({ offset: count })
  }

  // ---- joins ----------------------------------------------------------------

  private join(
    joinType: JoinKind,
    source: ExprInput,
    leftKey?: string,
    rightKey?: string,
  ): SelectQueryBuilder<O> {
    const on =
      leftKey !== undefined && rightKey !== undefined
        ? ({
            kind: 'Binary',
            left: { kind: 'Reference', name: leftKey },
            op: '=',
            right: { kind: 'Reference', name: rightKey },
          } as Expr)
        : undefined
    return this.derive({
      joins: [...(this.node.joins ?? []), { kind: 'Join', joinType, source: toExpr(source), on }],
    })
  }

  innerJoin(source: ExprInput, leftKey: string, rightKey: string): SelectQueryBuilder<O> {
    return this.join('Inner', source, leftKey, rightKey)
  }

  leftJoin(source: ExprInput, leftKey: string, rightKey: string): SelectQueryBuilder<O> {
    return this.join('Left', source, leftKey, rightKey)
  }

  fullJoin(source: ExprInput, leftKey: string, rightKey: string): SelectQueryBuilder<O> {
    return this.join('Full', source, leftKey, rightKey)
  }

  crossJoin(source: ExprInput): SelectQueryBuilder<O> {
    return this.join('Cross', source)
  }

  // ---- ClickHouse dialect sugar --------------------------------------------

  /** `FROM t FINAL` — merge parts on read (ReplacingMergeTree, etc.). */
  final(): SelectQueryBuilder<O> {
    return this.derive({ final: true })
  }

  /** `SAMPLE rate` — approximate query over a fraction (or absolute count) of rows. */
  sample(rate: number): SelectQueryBuilder<O> {
    return this.derive({ sample: rate })
  }

  /**
   * `PREWHERE` — ClickHouse reads these columns first and filters before the
   * rest of the row is read. Same argument shapes as {@link where}; multiple
   * calls are AND-combined.
   */
  prewhere(lhs: ColumnInput): SelectQueryBuilder<O>
  prewhere(lhs: ColumnInput, op: string, rhs: unknown): SelectQueryBuilder<O>
  prewhere(...args: [ColumnInput] | [ColumnInput, string, unknown]): SelectQueryBuilder<O> {
    return this.derive({ prewhere: combine(this.node.prewhere, this.predicate(args), 'And') })
  }

  /** Append a trailing `SETTINGS k = v, …` clause (merges across calls). */
  settings(settings: Record<string, string | number | boolean>): SelectQueryBuilder<O> {
    return this.derive({ settings: { ...this.node.settings, ...settings } })
  }

  /**
   * `FORMAT x` — the SQL-level output format (changes how ClickHouse serializes
   * the result). This is distinct from `.execute({ format })`, which picks the
   * view over the bytes (`Row[]` / Arrow `Table` / raw). Use this only when you
   * read the raw result yourself.
   */
  format(name: string): SelectQueryBuilder<O> {
    return this.derive({ format: name })
  }

  /**
   * `LIMIT n BY (cols)` — keep the first n rows per distinct value of the
   * columns. Independent of (and combinable with) the trailing `LIMIT`.
   */
  limitBy(count: number, columns: ColumnInput | ReadonlyArray<ColumnInput>): SelectQueryBuilder<O> {
    const cols = (Array.isArray(columns) ? columns : [columns]).map(toExpr)
    return this.derive({ limitBy: { count, columns: cols } })
  }

  // ---- set operations -------------------------------------------------------

  private setOp(operator: SetOperator, other: SelectQueryBuilder<O>): SelectQueryBuilder<O> {
    return this.derive({
      setOps: [...(this.node.setOps ?? []), { operator, query: other.toNode() }],
    })
  }

  union(other: SelectQueryBuilder<O>): SelectQueryBuilder<O> {
    return this.setOp('union', other)
  }

  unionAll(other: SelectQueryBuilder<O>): SelectQueryBuilder<O> {
    return this.setOp('unionAll', other)
  }

  intersect(other: SelectQueryBuilder<O>): SelectQueryBuilder<O> {
    return this.setOp('intersect', other)
  }

  except(other: SelectQueryBuilder<O>): SelectQueryBuilder<O> {
    return this.setOp('except', other)
  }

  // ---- composition ----------------------------------------------------------

  /** The underlying node (for use as a subquery / set-operation operand). */
  toNode(): SelectQueryNode {
    return this.node
  }

  /** Wrap this query as an aliased subquery usable as a source or in a join. */
  as(alias: string): ChExpression {
    return new ChExpression({
      kind: 'Alias',
      node: { kind: 'Subquery', query: this.node },
      alias,
    })
  }

  // ---- terminals ------------------------------------------------------------

  /** Emit `{ sql, parameters }` without running anything (debug / audit / tools). */
  compile(): CompiledQuery {
    return compileQuery(this.node)
  }

  /** Run and return rows (default), an Arrow Table (`{format:'arrow'}`), or a raw result. */
  execute(opts?: ExecuteOptions & { format?: undefined | 'json' }): Promise<O[]>
  execute(opts: ExecuteOptions & { format: 'arrow' }): Promise<unknown>
  execute(opts: ExecuteOptions & { format: string }): Promise<unknown>
  execute(opts?: ExecuteOptions): Promise<unknown> {
    return executeSelect<O>(this.ctx, this.node, opts)
  }

  /** Run and return the first row, or `undefined` when there are none. */
  async executeTakeFirst(opts?: ExecuteOptions): Promise<O | undefined> {
    const rows = (await executeSelect<O>(this.ctx, this.node, opts)) as O[]
    return rows[0]
  }

  /** Run and return the first row, throwing if there are none. */
  async executeTakeFirstOrThrow(opts?: ExecuteOptions): Promise<O> {
    const first = await this.executeTakeFirst(opts)
    if (first === undefined) {
      throw new ChdbCompileError('executeTakeFirstOrThrow: the query returned no rows')
    }
    return first
  }
}
