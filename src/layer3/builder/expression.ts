/**
 * Expression builders: the small set of helpers that turn user input into the
 * node tree the compiler walks.
 *
 *  - `sql` — a tagged template for any SQL the verbs don't cover. Interpolated
 *    values are BOUND (`{pN:Type}`), never spliced; use `sql.ref()` for an
 *    identifier and `sql.raw()` for trusted, author-controlled SQL text.
 *  - `ref(name)` — a column/table reference (quote-escaped).
 *  - `val(value, type?)` — an explicitly bound value (optionally typed).
 *  - `fn(name, args)` — a function call; string args are column references,
 *    `ChExpression` args are nested expressions, anything else is a bound value.
 *
 * `eb` bundles the same helpers for an ergonomic single import.
 */

import { ChdbCompileError } from '../../errors'
import type { Expr } from '../compiler/nodes'

/** A wrapped expression node, carrying `.as()` for aliasing. */
export class ChExpression {
  constructor(readonly node: Expr) {}

  /** `expr AS alias`. */
  as(alias: string): ChExpression {
    return new ChExpression({ kind: 'Alias', node: this.node, alias })
  }
}

/** Anything the builder verbs accept where an expression is expected. */
export type ExprInput = string | ChExpression

/** A column / table reference. */
export function ref(name: string): ChExpression {
  return new ChExpression({ kind: 'Reference', name })
}

/** An explicitly bound value, with an optional ClickHouse placeholder type. */
export function val(value: unknown, chType?: string): ChExpression {
  return new ChExpression({ kind: 'Value', value, chType })
}

/** A function call. String args are references; other primitives are bound. */
export function fn(name: string, args: ReadonlyArray<ExprInput | unknown> = []): ChExpression {
  return new ChExpression({
    kind: 'Function',
    name,
    args: args.map((a) => {
      if (a instanceof ChExpression) return a.node
      if (typeof a === 'string') return { kind: 'Reference', name: a }
      return { kind: 'Value', value: a }
    }),
  })
}

interface SqlTag {
  (strings: TemplateStringsArray, ...values: unknown[]): ChExpression
  /** A raw, author-controlled SQL fragment (NOT bound — never pass user input). */
  raw(text: string): ChExpression
  /** A quote-escaped identifier. */
  ref(name: string): ChExpression
  /** A bound value (optionally typed). */
  val(value: unknown, chType?: string): ChExpression
}

const sqlTag = ((strings: TemplateStringsArray, ...values: unknown[]): ChExpression => {
  const exprs: Expr[] = values.map((v) =>
    v instanceof ChExpression ? v.node : { kind: 'Value', value: v },
  )
  return new ChExpression({ kind: 'Raw', fragments: [...strings], values: exprs })
}) as SqlTag

sqlTag.raw = (text: string) => new ChExpression({ kind: 'Raw', fragments: [text], values: [] })
sqlTag.ref = ref
sqlTag.val = val

/** Tagged-template SQL escape hatch (see module docs). */
export const sql: SqlTag = sqlTag

/** Bundled expression helpers for a single import. */
export const eb = { ref, val, fn, sql }

/** Convert an expression-position input (string ⇒ reference, `*` ⇒ star). */
export function toExpr(input: ExprInput): Expr {
  if (input instanceof ChExpression) return input.node
  if (typeof input !== 'string') {
    throw new ChdbCompileError(`Expected a column name or expression, got ${typeof input}`)
  }
  if (input === '*') return { kind: 'Star' }
  if (input.endsWith('.*')) return { kind: 'Star', table: input.slice(0, -2) }
  const aliasMatch = /^(.+?)\s+as\s+(.+)$/i.exec(input)
  if (aliasMatch) {
    return { kind: 'Alias', node: { kind: 'Reference', name: aliasMatch[1]!.trim() }, alias: aliasMatch[2]!.trim() }
  }
  return { kind: 'Reference', name: input }
}

/** Convert a value-position input: an expression wrapper stays an expression,
 * anything else becomes a bound value. */
export function toValue(input: unknown): Expr {
  if (input instanceof ChExpression) return input.node
  return { kind: 'Value', value: input }
}

/** A where/having argument list: `(lhs, op, rhs)` or a single expression. */
export type PredicateArgs = [ExprInput] | [ExprInput, string, unknown]

/** Turn a predicate argument list into one expression node. */
export function buildPredicate(args: PredicateArgs): Expr {
  if (args.length === 1) return toExpr(args[0])
  return { kind: 'Binary', left: toExpr(args[0]), op: args[1], right: toValue(args[2]) }
}

/** Combine an existing predicate with a new one under AND / OR, flattening. */
export function combinePredicate(
  existing: Expr | undefined,
  next: Expr,
  kind: 'And' | 'Or',
): Expr {
  if (existing === undefined) return next
  if (existing.kind === kind) return { kind, items: [...existing.items, next] }
  return { kind, items: [existing, next] }
}
