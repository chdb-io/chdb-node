/**
 * `connect(config)` — the federation entry point. It opens a logical connection
 * to an external data source (a ClickHouse server, Postgres, MySQL, MongoDB,
 * object storage, a URL, or a local file) and lets you read from it through the
 * local chDB engine. The engine runs in-process; the data can live anywhere a
 * ClickHouse table function can reach.
 *
 * A `Connection` is a thin handle over a resolved source plan:
 *
 *   const pg = chdb.connect({ url: 'postgres://h/db', username, password })
 *   await chdb.selectFrom(pg.table('users').as('u'))
 *     .innerJoin(chTable.s3({ url, format: 'Parquet' }).as('e'), 'u.id', 'e.user_id')
 *     .selectAll().execute()
 *
 * Every host, credential, path, and option is bound server-side, so a
 * connection string never reaches the SQL text. The build phase is pure; only
 * the async methods touch the engine, where the typed Layer 1 errors surface.
 */

import type { ChdbResult } from '../../result'
import { runtime } from '../runtime'
import type { ExecContext } from '../execute/terminal'
import { executeStatement } from '../execute/terminal'
import { parseRows } from '../execute/format'
import { compileExpr, compileQuery, renderSettings, type CompiledQuery } from '../compiler/compile'
import type { Expr, SelectQueryNode } from '../compiler/nodes'
import { ChExpression } from '../builder/expression'
import { buildSource, type CatalogQuery, type ConnectConfig, type SourcePlan } from './url-scheme'
import { buildSnapshotNode } from './snapshot'

/** A column of `DESCRIBE TABLE`. */
export interface ColumnInfo {
  name: string
  type: string
  [key: string]: unknown
}

/** Engine settings applied to the queries a connection issues itself. */
export type EngineSettings = Readonly<Record<string, string | number | boolean>>

function hasSettings(settings?: EngineSettings): settings is EngineSettings {
  return settings !== undefined && Object.keys(settings).length > 0
}

/** Build the `DESCRIBE TABLE <source>` statement for a table / location. */
export function compileDescribe(plan: SourcePlan, table?: string, settings?: EngineSettings): CompiledQuery {
  const source = compileExpr(plan.table(table))
  const tail = hasSettings(settings) ? ` SETTINGS ${renderSettings(settings)}` : ''
  return { sql: `DESCRIBE TABLE ${source.sql}${tail}`, parameters: source.parameters }
}

/**
 * Build a catalog SELECT that returns one column, always aliased `name`, so the
 * caller reads the same shape regardless of the source's native column naming.
 */
function catalogSelect(cat: CatalogQuery, database?: string, settings?: EngineSettings): SelectQueryNode {
  const where: Expr | undefined =
    database !== undefined && cat.databaseColumn !== undefined
      ? {
          kind: 'Binary',
          left: { kind: 'Reference', name: cat.databaseColumn },
          op: '=',
          right: { kind: 'Value', value: database, chType: 'String' },
        }
      : undefined
  return {
    kind: 'SelectQuery',
    from: cat.source,
    selections: [{ kind: 'Alias', node: { kind: 'Reference', name: cat.nameColumn }, alias: 'name' }],
    where,
    orderBy: [{ expr: { kind: 'Reference', name: 'name' }, direction: 'asc' }],
    settings: hasSettings(settings) ? settings : undefined,
  }
}

/** Build the database-listing query (ClickHouse / Postgres / MySQL sources). */
export function compileDatabases(plan: SourcePlan, settings?: EngineSettings): CompiledQuery {
  return compileQuery(catalogSelect(plan.catalog('databases'), undefined, settings))
}

/** Build the table-listing query, optionally scoped to one database / schema. */
export function compileTables(plan: SourcePlan, database?: string, settings?: EngineSettings): CompiledQuery {
  return compileQuery(catalogSelect(plan.catalog('tables'), database, settings))
}

/** A logical connection to one external data source. */
export class Connection {
  private readonly plan: SourcePlan
  // ClickHouse engine settings applied to the queries this connection issues
  // (describe / databases / tables / snapshot). Data queries built with
  // selectFrom(conn.table()) carry settings through the builder's .settings().
  private readonly settings?: EngineSettings

  constructor(
    private readonly ctx: ExecContext,
    config: ConnectConfig,
  ) {
    this.plan = buildSource(config)
    this.settings = config.clickhouseSettings
  }

  /** The source family, e.g. `'postgres'`, `'s3'`, `'clickhouse'`. */
  get sourceType(): string {
    return this.plan.sourceType
  }

  /**
   * An aliasable source expression for a table/collection on this connection
   * (server sources), or for the configured location (object-storage / URL /
   * file sources, where the name is unused). Pass it to `selectFrom`/joins:
   *
   *   chdb.selectFrom(conn.table('schema.users').as('u'))
   */
  table(name?: string): ChExpression {
    return new ChExpression(this.plan.table(name))
  }

  /** Column names and types of a table/location (`DESCRIBE TABLE`). */
  async describe(table?: string): Promise<ColumnInfo[]> {
    return (await this.runRows(compileDescribe(this.plan, table, this.settings))) as ColumnInfo[]
  }

  /**
   * List the source's databases (ClickHouse / Postgres / MySQL). Postgres
   * groups tables by schema, so this returns its schema names — the same values
   * `tables()` filters on. Throws for sources without a SQL catalog (MongoDB,
   * object storage, URL, file); use `describe()` there instead.
   */
  async databases(): Promise<string[]> {
    const rows = await this.runRows(compileDatabases(this.plan, this.settings))
    return rows.map((r) => String(r.name))
  }

  /** List table names, optionally scoped to one database / schema. */
  async tables(database?: string): Promise<string[]> {
    const rows = await this.runRows(compileTables(this.plan, database, this.settings))
    return rows.map((r) => String(r.name))
  }

  /**
   * Copy a remote table into a local table once (`INSERT … SELECT`). There is
   * no ongoing sync — it reads the source a single time.
   */
  async snapshot(table: string, opts: { destination: string }): Promise<ChdbResult> {
    return executeStatement(this.ctx, buildSnapshotNode(this.plan, table, opts.destination, this.settings))
  }

  private async runRows(compiled: CompiledQuery): Promise<Record<string, unknown>[]> {
    const runOpts = { format: 'JSONEachRow' }
    const result = this.ctx.session
      ? await this.ctx.session.queryBindAsync(compiled.sql, compiled.parameters, runOpts)
      : await runtime().queryBindAsync(compiled.sql, compiled.parameters, runOpts)
    return parseRows(result.text())
  }
}
