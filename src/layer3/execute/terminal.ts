/**
 * The execution boundary. The build phase is pure (it only assembles nodes and
 * throws ChdbCompileError); IO happens only here, where a compiled
 * `{ sql, parameters }` is forwarded to Layer 1 `queryBindAsync`. Layer 1 owns
 * value serialization and the typed runtime-error hierarchy, so this layer adds
 * no new runtime error types.
 */

import type { ChdbResult } from '../../result'
import { runtime, type RuntimeSession } from '../runtime'
import { compileQuery, type CompiledQuery } from '../compiler/compile'
import type { QueryNode, SelectQueryNode } from '../compiler/nodes'
import { planFormat, parseRows } from './format'

/** The connection a builder runs on: a bound Session, or the default connection. */
export interface ExecContext {
  readonly session?: RuntimeSession
}

/** Pass-through runtime options for a terminal call. */
export interface ExecuteOptions {
  /** Output view: 'json' (default) ⇒ Row[], 'arrow' ⇒ Table, else raw ChdbResult. */
  format?: string
  signal?: AbortSignal
  timeout?: number
  /** Extra ClickHouse settings merged into the statement's SETTINGS clause. */
  settings?: Record<string, string | number | boolean>
}

function mergeSettings(
  node: SelectQueryNode,
  extra?: Record<string, string | number | boolean>,
): SelectQueryNode {
  if (extra === undefined || Object.keys(extra).length === 0) return node
  return { ...node, settings: { ...node.settings, ...extra } }
}

async function run(
  ctx: ExecContext,
  compiled: CompiledQuery,
  chFormat: string,
  opts: ExecuteOptions,
): Promise<ChdbResult> {
  const runOpts = { format: chFormat, signal: opts.signal, timeout: opts.timeout }
  return ctx.session
    ? ctx.session.queryBindAsync(compiled.sql, compiled.parameters, runOpts)
    : runtime().queryBindAsync(compiled.sql, compiled.parameters, runOpts)
}

/** Compile a SELECT and run it, returning rows / an Arrow Table / a raw result. */
export async function executeSelect<O>(
  ctx: ExecContext,
  node: SelectQueryNode,
  opts: ExecuteOptions = {},
): Promise<unknown> {
  const plan = planFormat(opts.format)
  // The row view's precision setting and any caller-supplied settings ride in
  // the statement's SETTINGS clause (server-side), not the engine format flag.
  const effective = mergeSettings(node, { ...plan.settings, ...opts.settings })
  const compiled = compileQuery(effective)
  const result = await run(ctx, compiled, plan.chFormat, opts)
  if (plan.view === 'rows') return parseRows<O>(result.text())
  if (plan.view === 'arrow') return result.toArrow()
  return result
}

/** Compile and run any query node that returns no row view (UPDATE/DELETE/INSERT…SELECT). */
export async function executeStatement(
  ctx: ExecContext,
  node: QueryNode,
  opts: ExecuteOptions = {},
): Promise<ChdbResult> {
  const compiled = compileQuery(node)
  // Mutations and INSERT…SELECT have no row payload; CSV keeps the response tiny.
  return run(ctx, compiled, 'CSV', opts)
}
