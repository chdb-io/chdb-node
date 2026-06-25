/**
 * INSERT chain: `insertInto(table).values(source).execute()`. The `source` is
 * polymorphic (a single verb extended by its argument type, not several verbs):
 *
 *  - an object/array-of-values row array → forwarded to Layer 1's `insert`
 *    (the multithreaded engine parser does the work; no SQL is built here);
 *  - a SelectQueryBuilder → compiled to `INSERT INTO … SELECT` and run.
 *
 * Arrow / TypedArray / stream sources are handled in a later step (the Arrow IPC
 * input path); this is the row-array and subquery foundation.
 */

import { ChdbCompileError } from '../../errors'
import type { ChdbResult } from '../../result'
import type { CompiledQuery } from '../compiler/compile'
import { compileQuery } from '../compiler/compile'
import type { InsertSelectNode } from '../compiler/nodes'
import { runtime, type RuntimeInsertParams, type RuntimeInsertSummary } from '../runtime'
import { executeStatement, type ExecContext, type ExecuteOptions } from '../execute/terminal'
import { SelectQueryBuilder } from './select'

export type InsertRow = Record<string, unknown> | ReadonlyArray<unknown>
export type InsertColumns = ReadonlyArray<string> | { except: ReadonlyArray<string> }

/** Terminal for a row-array insert (forwards to Layer 1 `insert`). */
export class InsertValuesExecutable {
  constructor(
    private readonly ctx: ExecContext,
    private readonly table: string,
    private readonly rows: ReadonlyArray<InsertRow>,
    private readonly cols?: InsertColumns,
  ) {}

  execute(): Promise<RuntimeInsertSummary> {
    const params: RuntimeInsertParams = { table: this.table, values: this.rows, columns: this.cols }
    return this.ctx.session ? this.ctx.session.insert(params) : runtime().insert(params)
  }
}

/** Terminal for `INSERT INTO … SELECT` (compiles to SQL like the SELECT path). */
export class InsertSelectExecutable {
  constructor(
    private readonly ctx: ExecContext,
    private readonly node: InsertSelectNode,
  ) {}

  /** Emit `{ sql, parameters }` without running anything. */
  compile(): CompiledQuery {
    return compileQuery(this.node)
  }

  execute(opts?: ExecuteOptions): Promise<ChdbResult> {
    return executeStatement(this.ctx, this.node, opts)
  }
}

export class InsertQueryBuilder {
  constructor(
    private readonly ctx: ExecContext,
    private readonly table: string,
    private readonly cols?: ReadonlyArray<string>,
  ) {}

  /** Restrict the target columns: `INSERT INTO t (a, b) …`. */
  columns(columns: ReadonlyArray<string>): InsertQueryBuilder {
    return new InsertQueryBuilder(this.ctx, this.table, columns)
  }

  /** Insert object/array rows (forwarded to Layer 1's engine-parsed insert). */
  values(rows: ReadonlyArray<InsertRow>): InsertValuesExecutable
  /** Insert the result of a SELECT (`INSERT INTO … SELECT`). */
  values(query: SelectQueryBuilder<any>): InsertSelectExecutable
  values(source: ReadonlyArray<InsertRow> | SelectQueryBuilder<any>): InsertValuesExecutable | InsertSelectExecutable {
    if (source instanceof SelectQueryBuilder) {
      return new InsertSelectExecutable(this.ctx, {
        kind: 'InsertSelect',
        table: this.table,
        columns: this.cols,
        select: source.toNode(),
      })
    }
    if (!Array.isArray(source)) {
      throw new ChdbCompileError('values() expects a row array or a SELECT query builder')
    }
    return new InsertValuesExecutable(this.ctx, this.table, source, this.cols)
  }
}
