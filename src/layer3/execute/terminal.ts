/**
 * The execution boundary. The build phase is pure (it only assembles nodes and
 * throws ChdbCompileError); IO happens only here, where a compiled
 * `{ sql, parameters }` is forwarded to Layer 1 `queryBindAsync`. Layer 1 owns
 * value serialization and the typed runtime-error hierarchy, so this layer adds
 * no new runtime error types.
 */

import type { ChdbResult } from '../../result'
import { ChdbStreamError } from '../../errors'
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

/**
 * Compile a SELECT and stream its rows lazily, one at a time, instead of
 * buffering the whole result (the large-result path: a forgotten `.limit()` on a
 * big scan stays O(chunk) in memory rather than materializing 3–4×N).
 *
 * Fixed to the JSONEachRow row view so streamed rows equal executed rows. Caller
 * settings ride in the statement's SETTINGS clause; the 64-bit-int precision
 * setting instead rides on a session-level SET before the stream opens (see
 * {@link streamSelectRows} for why). Values are still bound server-side (via
 * queryStreamBind), so streaming is as injection-safe as `.execute()`. Requires a
 * bound session: the default connection has no streaming cursor.
 *
 * `timeout` is intentionally absent from the options: Layer 1 streaming has no
 * deadline knob (only `signal`), so accepting it would imply unsupported behavior.
 */
export function executeSelectStream<O>(
  ctx: ExecContext,
  node: SelectQueryNode,
  opts: Omit<ExecuteOptions, 'format' | 'timeout'> = {},
): AsyncIterableIterator<O> {
  if (ctx.session === undefined) {
    throw new ChdbStreamError(
      'stream() requires a bound session; use chdb.session().selectFrom(...).stream() ' +
        '(pass chdb.session(path) for a persistent database)',
    )
  }
  const compiled = compileQuery(mergeSettings(node, opts.settings))
  // The generator takes `session` as a non-optional parameter (rather than closing
  // over the narrowed ctx.session) so the non-undefined type holds inside the
  // closure across TypeScript versions.
  return streamSelectRows<O>(ctx.session, compiled, opts.signal)
}

async function* streamSelectRows<O>(
  session: RuntimeSession,
  compiled: CompiledQuery,
  signal: AbortSignal | undefined,
): AsyncIterableIterator<O> {
  // chDB builds the streaming output format from the connection's session settings
  // at OPEN time, not from a query's trailing SETTINGS clause (which executeSelect
  // rides in SQL). So the row view's 64-bit-int precision setting must be SET on the
  // session first, otherwise UInt64/Int64 come back as lossy JS numbers and streamed
  // rows would differ from executed rows. The setting persists on the session by design.
  await session.queryAsync('SET output_format_json_quote_64bit_integers = 1', { format: 'CSV' })
  const stream = session.queryStreamBind(compiled.sql, compiled.parameters, {
    format: 'JSONEachRow',
    signal,
  })
  yield* stream.rows() as AsyncIterableIterator<O>
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
