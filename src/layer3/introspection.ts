/**
 * Kysely-style database introspection for the local engine.
 *
 * `database<DB>()` anchors `new Kysely<DB>()`, and Kysely instances expose
 * `db.introspection.getTables()/getSchemas()/getMetadata()` (the
 * `DatabaseIntrospector` interface). This module mirrors that surface 1:1 (R1,
 * frozen at the Kysely v0.29.x shape) so a reader coming from Kysely finds the
 * same call. It is a thin convenience over the chDB engine's `system.*` tables;
 * the source-agnostic reflection used by `gen-types` (DESCRIBE / federated
 * sources) lives in `codegen/introspect.ts`, and cross-source federation
 * discovery lives on `connect()` (`Connection.databases()/tables()/describe()`).
 *
 * The introspector runs on the bound Session if the root has one, else the
 * default connection — i.e. it always reflects the local embedded engine, never
 * a remote/federated source (use `connect()` for those).
 */

import { runtime, type RuntimeSession } from './runtime'
import { parseRows } from './execute/format'

/** A schema (in ClickHouse terms, a database). Matches Kysely's `SchemaMetadata`. */
export interface SchemaMetadata {
  readonly name: string
}

/** One column's metadata. Matches Kysely's `ColumnMetadata`. */
export interface ColumnMetadata {
  readonly name: string
  /** The raw ClickHouse type string, e.g. `Nullable(String)` or `DateTime('UTC')`. */
  readonly dataType: string
  readonly isNullable: boolean
  /** Always false — ClickHouse has no auto-increment columns. Kept for Kysely shape. */
  readonly isAutoIncrementing: boolean
  /** True when the column carries a DEFAULT / MATERIALIZED / ALIAS expression. */
  readonly hasDefaultValue: boolean
  readonly comment?: string
}

/** One table's metadata. Matches Kysely's `TableMetadata`. */
export interface TableMetadata {
  readonly name: string
  readonly isView: boolean
  readonly columns: ColumnMetadata[]
  /** The owning database (Kysely calls a database a "schema"). */
  readonly schema?: string
}

/** Matches Kysely's `DatabaseMetadata`. */
export interface DatabaseMetadata {
  readonly tables: TableMetadata[]
}

/**
 * Matches Kysely's `DatabaseMetadataOptions`. `withInternalKyselyTables` is
 * accepted for shape parity but has no effect (chDB keeps no Kysely migration
 * tables); set `withSystemTables` to include ClickHouse's own `system` /
 * `INFORMATION_SCHEMA` databases, which are excluded by default.
 */
export interface DatabaseMetadataOptions {
  readonly withInternalKyselyTables?: boolean
  readonly withSystemTables?: boolean
}

/** Matches Kysely's `DatabaseIntrospector`. */
export interface DatabaseIntrospector {
  getSchemas(): Promise<SchemaMetadata[]>
  getTables(options?: DatabaseMetadataOptions): Promise<TableMetadata[]>
  getMetadata(options?: DatabaseMetadataOptions): Promise<DatabaseMetadata>
}

/** ClickHouse databases that are engine internals, hidden unless asked for. */
const SYSTEM_DATABASES = ['system', 'INFORMATION_SCHEMA', 'information_schema']

interface RawTable {
  database: string
  name: string
  engine: string
}

interface RawColumn {
  database: string
  table: string
  name: string
  type: string
  default_kind: string
  comment: string
}

/** A ClickHouse table engine whose name ends in `View` is a view. */
function isViewEngine(engine: string): boolean {
  return /View$/.test(engine)
}

/**
 * The local-engine introspector returned by `db.introspection`. Reads the
 * engine's `system.databases` / `system.tables` / `system.columns` rather than
 * issuing a DESCRIBE per table, so `getMetadata()` is a single pair of queries.
 */
export class ChdbIntrospector implements DatabaseIntrospector {
  constructor(private readonly session?: RuntimeSession) {}

  private async query<T>(sql: string): Promise<T[]> {
    const opts = { format: 'JSONEachRow' }
    const result = this.session
      ? await this.session.queryBindAsync(sql, {}, opts)
      : await runtime().queryBindAsync(sql, {}, opts)
    return parseRows<T>(result.text())
  }

  async getSchemas(): Promise<SchemaMetadata[]> {
    const rows = await this.query<{ name: string }>(
      'SELECT name FROM system.databases ORDER BY name',
    )
    return rows.map((r) => ({ name: r.name }))
  }

  async getTables(options: DatabaseMetadataOptions = {}): Promise<TableMetadata[]> {
    // The system-database predicate is a literal list (no user input), so it is
    // inlined rather than parameter-bound.
    const filter = options.withSystemTables
      ? ''
      : ` WHERE database NOT IN (${SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ')})`
    const [tables, columns] = await Promise.all([
      this.query<RawTable>(
        `SELECT database, name, engine FROM system.tables${filter} ORDER BY database, name`,
      ),
      this.query<RawColumn>(
        `SELECT database, table, name, type, default_kind, comment ` +
          `FROM system.columns${filter} ORDER BY database, table, position`,
      ),
    ])

    // Bucket columns by `database.table` so each table gets its columns in
    // ClickHouse storage order (the `position` sort above).
    const byTable = new Map<string, ColumnMetadata[]>()
    for (const c of columns) {
      const key = `${c.database}.${c.table}`
      let bucket = byTable.get(key)
      if (bucket === undefined) {
        bucket = []
        byTable.set(key, bucket)
      }
      bucket.push({
        name: c.name,
        dataType: c.type,
        isNullable: c.type.startsWith('Nullable('),
        isAutoIncrementing: false,
        hasDefaultValue: c.default_kind !== '',
        comment: c.comment === '' ? undefined : c.comment,
      })
    }

    return tables.map((t) => ({
      name: t.name,
      isView: isViewEngine(t.engine),
      schema: t.database,
      columns: byTable.get(`${t.database}.${t.name}`) ?? [],
    }))
  }

  async getMetadata(options?: DatabaseMetadataOptions): Promise<DatabaseMetadata> {
    return { tables: await this.getTables(options) }
  }
}
