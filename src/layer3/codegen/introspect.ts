/**
 * Runtime introspection: ask the chDB engine to describe a table / file /
 * remote source and return its columns as a `column → CH-type-string` map.
 * Whatever source you can read with `selectFrom(...)` you can introspect here,
 * which keeps the gen-types CLI source-agnostic (file, table, federated url —
 * all the same code path).
 */

import { runtime, type RuntimeSession } from '../runtime'
import { ChdbCompileError } from '../../errors'
import { compileExpr, compileQuery } from '../compiler/compile'
import { parseRows } from '../execute/format'
import { ChExpression } from '../builder/expression'
import { chTable } from '../builder/table-functions'
import { buildSource, type ConnectConfig } from '../connect/url-scheme'
import type { Expr } from '../compiler/nodes'
import type { ColumnSchema } from '../types/infer'

/** One column as DESCRIBE TABLE returns it. */
export interface IntrospectedColumn {
  name: string
  type: string
}

/** A `{ table → column → CH-type }` schema, the input to `emitDatabase`. */
export type IntrospectedDatabase = Record<string, ColumnSchema>

/** Anything you can describe: a SQL identifier, a `chTable.*()` expression, or a federated source. */
export type IntrospectSource =
  | { kind: 'table'; name: string }
  | { kind: 'file'; path: string; format?: string; structure?: string }
  | { kind: 'expr'; expr: ChExpression }
  | { kind: 'url'; config: ConnectConfig; table?: string }

/** Where to run the DESCRIBE (default connection, or a bound Session). */
export interface IntrospectContext {
  session?: RuntimeSession
}

function sourceExpr(source: IntrospectSource): Expr {
  switch (source.kind) {
    case 'table':
      return { kind: 'Reference', name: source.name }
    case 'file':
      return chTable.file({ path: source.path, format: source.format, structure: source.structure }).node
    case 'expr':
      return source.expr.node
    case 'url': {
      const plan = buildSource(source.config)
      if (plan.kind === 'server' && source.table === undefined) {
        throw new ChdbCompileError(`Introspecting a ${plan.sourceType} source needs --table <name>`)
      }
      return plan.table(source.table)
    }
  }
}

/** Run `DESCRIBE TABLE <source>` and return its raw `(name, type)` rows. */
export async function describeSource(
  source: IntrospectSource,
  ctx: IntrospectContext = {},
): Promise<IntrospectedColumn[]> {
  const expr = sourceExpr(source)
  // `DESCRIBE TABLE ident` requires the source to be a SQL reference; table
  // functions and file/url expressions get wrapped in `(SELECT * FROM ...)`.
  const compiled =
    expr.kind === 'Reference'
      ? { sql: `DESCRIBE TABLE ${compileExpr(expr).sql}`, parameters: {} }
      : (() => {
          const inner = compileQuery({
            kind: 'SelectQuery',
            from: expr,
            selections: [{ kind: 'Star' }],
            limit: 0,
          })
          return { sql: `DESCRIBE TABLE (${inner.sql})`, parameters: inner.parameters }
        })()
  const runOpts = { format: 'JSONEachRow' }
  const result = ctx.session
    ? await ctx.session.queryBindAsync(compiled.sql, compiled.parameters, runOpts)
    : await runtime().queryBindAsync(compiled.sql, compiled.parameters, runOpts)
  return parseRows<IntrospectedColumn>(result.text())
}

/**
 * Run DESCRIBE on a source and flatten the result to a `{ column: CH-type }`
 * map — the exact shape `Database<DB>` and the gen-types CLI consume.
 */
export async function introspectTable(
  source: IntrospectSource,
  ctx?: IntrospectContext,
): Promise<ColumnSchema> {
  const rows = await describeSource(source, ctx)
  const out: ColumnSchema = {}
  for (const r of rows) out[r.name] = r.type
  return out
}

/** Introspect several tables in one shot, keyed by the label you want in the emitted interface. */
export async function introspectDatabase(
  sources: Record<string, IntrospectSource>,
  ctx?: IntrospectContext,
): Promise<IntrospectedDatabase> {
  const entries = await Promise.all(
    Object.entries(sources).map(async ([label, source]) => [label, await introspectTable(source, ctx)] as const),
  )
  return Object.fromEntries(entries)
}
