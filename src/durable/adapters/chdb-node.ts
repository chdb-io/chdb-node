/**
 * The default {@link EngineAdapter} for Node: the durable control plane driven
 * by this package's own native addon.
 *
 * `chdb/durable` loads no native code, on purpose — the engine arrives
 * injected, so a Bun `dlopen` or a test fake can drive the same state machine.
 * This module is the injection Node callers should not have to write
 * themselves. It lives behind its own subpath (`chdb/durable/node`) rather
 * than in the barrel, because importing it *does* load the addon and that
 * would make the no-native-load guarantee of `chdb/durable` vacuous.
 *
 * ```ts
 * import { DurableNamespace } from 'chdb/durable'
 * import { nodeEngineFactory } from 'chdb/durable/node'
 *
 * const ns = new DurableNamespace('s3://bucket/durable?region=us-east-2', {
 *   engineFactory: nodeEngineFactory(),
 * })
 * ```
 *
 * The four ABI calls behind it — `chdb_version`, `chdb_backup_database_n`,
 * `chdb_restore_database_n`, `chdb_classify_query_n` — are bound in
 * `lib/chdb_node.cpp`, and the three that take a connection run on the libuv
 * pool, so a checkpoint of a large database does not freeze the event loop and
 * heartbeat keeps landing while it runs.
 *
 * One process, one engine, one object. chdb-core binds a single data path per
 * process, and each durable object needs a private one, so a process holds one
 * open durable object at a time and cannot hold an ordinary `Session`
 * alongside it. Fan-out goes across worker processes.
 */

import { loadNative } from '../../loader'
import type {
  EngineAdapter,
  EngineFactory,
  EngineStartOptions,
  QueryAnalysis,
} from '../engine-adapter'
import { QueryClass } from '../engine-adapter'
import { DurableEngineError } from '../errors'

/**
 * The addon surface this adapter uses. Declared structurally rather than
 * imported, because the addon is a `.node` file with no type information and
 * this list is exactly the contract between the two halves.
 */
export interface ChdbDurableNative {
  EngineVersion(): string
  CreateConnection(path: string, settings?: readonly string[]): unknown
  CloseConnection(connection: unknown): void
  QueryAsyncConnection(
    connection: unknown,
    sql: string,
    format: string,
  ): Promise<{ bytes: Buffer }>
  DurableBackupAsync(connection: unknown, database: string, filePath: string): Promise<void>
  DurableRestoreAsync(connection: unknown, database: string, filePath: string): Promise<void>
  DurableClassifyAsync(
    connection: unknown,
    sql: string,
    targetDatabase: string | null,
  ): Promise<{
    statementCount: number
    queryClass: number
    hasSecrets: boolean
    writesOnlyTargetDatabase: boolean
    changesDatabaseLifecycle: boolean
  }>
}

/** Everything the durable seam needs; an addon missing any of it is refused. */
const REQUIRED_EXPORTS = [
  'EngineVersion',
  'CreateConnection',
  'CloseConnection',
  'QueryAsyncConnection',
  'DurableBackupAsync',
  'DurableRestoreAsync',
  'DurableClassifyAsync',
] as const

/**
 * Settings a durable writer cannot leave to chance, applied at connect.
 *
 * Asynchronous inserts and non-synchronous mutations both mean "the statement
 * returned before its effect landed", which would put a statement in the WAL
 * whose local effect is not yet in the database the next checkpoint archives.
 * They have to be connect arguments rather than `SET`s: the control plane
 * classifies `SET` as CONTROL and refuses it, so nothing can undo them through
 * the public surface later.
 */
const DURABILITY_SETTINGS = [
  '--async_insert=0',
  '--wait_for_async_insert=1',
  '--mutations_sync=2',
  '--alter_sync=2',
] as const

export interface ChdbNodeEngineOptions {
  /**
   * Extra `--setting=value` argv entries appended to the connection. `--path`
   * is refused by the addon: the data directory is the connection registry's
   * key, and a setting that moved it would leave the registry describing a
   * path the engine is not on.
   */
  extraArgs?: readonly string[]
  /** Use this addon instead of loading one. For tests. */
  native?: ChdbDurableNative
}

/**
 * ClickHouse identifier quoting for the one identifier this adapter has to
 * emit itself.
 *
 * `BACKUP`/`RESTORE` take a name and a path and core does the quoting, but
 * there is no C entry point for `CREATE DATABASE` or `USE`, so these two
 * statements are built here. Both escapes matter: a backtick would end the
 * quoted name, and a backslash introduces an escape sequence — leave it alone
 * and a database called `a\b` is created as `a<backspace>`, under a name the
 * backup call would then not find.
 */
function quoteDatabase(name: string): string {
  return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'
}

/**
 * Refuse an addon that does not carry the durable ABI, naming what is missing.
 *
 * Separate from loading so it can be checked against an addon this process did
 * not load, which is also what the suite does.
 */
export function assertDurableAbi(addon: unknown): ChdbDurableNative {
  const native = (addon ?? {}) as Record<string, unknown>
  const missing = REQUIRED_EXPORTS.filter((name) => typeof native[name] !== 'function')
  if (missing.length > 0) {
    // Far and away the most likely cause is an addon built before the durable
    // ABI was bound, and the loader prefers a published @chdb/lib-* package
    // over a local build — so this is the failure a developer working in a
    // checkout meets first. The message should say what to do about it rather
    // than what was missing.
    throw new DurableEngineError(
      `durable: the loaded chdb addon does not export ${missing.join(', ')}, so it predates the ` +
        `durable ABI (chdb_version, chdb_backup_database_n, chdb_restore_database_n, ` +
        `chdb_classify_query_n). Rebuild it with \`npm run build\` in a working copy, or install ` +
        `a @chdb/lib-* platform package that carries it — note the platform package is resolved ` +
        `before a local build, so \`rm -rf node_modules/@chdb/lib-*\` is how you override it`,
    )
  }
  return native as unknown as ChdbDurableNative
}

function loadDurableNative(): ChdbDurableNative {
  try {
    return assertDurableAbi(loadNative())
  } catch (e) {
    if (e instanceof DurableEngineError) throw e
    throw new DurableEngineError(
      `durable: could not load the chdb native addon: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    )
  }
}

/**
 * An {@link EngineAdapter} over the chdb-node addon.
 *
 * One instance owns one native connection. The control plane serializes its
 * operations, and this class holds the same line one level down: it will not
 * release the connection while a native call is still on a libuv thread, since
 * that thread holds the handle and closing under it would be a use-after-free.
 */
export class ChdbNodeEngine implements EngineAdapter {
  private readonly native: ChdbDurableNative
  private readonly extraArgs: readonly string[]
  private connection: unknown = null
  private closed = false
  /** Native calls still on a libuv thread, so close can wait them out. */
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(options: ChdbNodeEngineOptions = {}) {
    this.native = options.native ?? loadDurableNative()
    this.extraArgs = options.extraArgs ?? []
  }

  /**
   * `chdb_version()` of the loaded library. Answerable before {@link start},
   * which the compatibility gate depends on — an incompatible engine is
   * refused before a lease is taken or a scratch directory made.
   */
  async version(): Promise<string> {
    return this.native.EngineVersion()
  }

  async start(options: EngineStartOptions): Promise<void> {
    if (this.connection) throw new DurableEngineError('durable: engine is already started')
    if (this.closed) throw new DurableEngineError('durable: engine is closed')
    const settings = [
      `--backups.allowed_path=${options.backupsAllowedPath}`,
      ...DURABILITY_SETTINGS,
      ...this.extraArgs,
    ]
    try {
      this.connection = this.native.CreateConnection(options.dataPath, settings)
    } catch (e) {
      // The likeliest failure is not a broken engine but an ordinary
      // constraint: this process already has a data directory bound, by an
      // open Session or another durable object.
      throw new DurableEngineError(
        `durable: could not start an engine on ${options.dataPath}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      )
    }
    if (!this.connection) {
      throw new DurableEngineError(`durable: could not start an engine on ${options.dataPath}`)
    }
  }

  private handle(): unknown {
    if (this.closed) throw new DurableEngineError('durable: engine is closed')
    if (!this.connection) throw new DurableEngineError('durable: engine is not started')
    return this.connection
  }

  /** Run a native call, keeping it visible to {@link close} until it settles. */
  private async track<T>(start: () => Promise<T>): Promise<T> {
    const promise = start()
    this.inFlight.add(promise)
    try {
      return await promise
    } catch (e) {
      // Native rejections arrive as plain Errors carrying the engine's own
      // message. Categorising them as `engine` is what lets a caller tell a
      // statement that failed from a lease that was lost.
      throw e instanceof DurableEngineError
        ? e
        : new DurableEngineError(`durable: ${e instanceof Error ? e.message : String(e)}`, {
            cause: e,
          })
    } finally {
      this.inFlight.delete(promise)
    }
  }

  async createDatabase(database: string): Promise<void> {
    await this.run(`CREATE DATABASE IF NOT EXISTS ${quoteDatabase(database)}`)
  }

  async useDatabase(database: string): Promise<void> {
    await this.run(`USE ${quoteDatabase(database)}`)
  }

  async query(sql: string, format: string): Promise<string> {
    const conn = this.handle()
    const result = await this.track(() => this.native.QueryAsyncConnection(conn, sql, format))
    return result.bytes.toString('utf8')
  }

  async run(sql: string): Promise<void> {
    const conn = this.handle()
    await this.track(() => this.native.QueryAsyncConnection(conn, sql, 'CSV'))
  }

  async analyze(sql: string, targetDatabase: string): Promise<QueryAnalysis> {
    const conn = this.handle()
    const out = await this.track(() =>
      this.native.DurableClassifyAsync(conn, sql, targetDatabase),
    )
    return {
      statementCount: out.statementCount,
      // A class this build has no name for is not coerced into one: every gate
      // requires an exact class, so an unrecognised value fails closed.
      queryClass: out.queryClass as QueryClass,
      hasSecrets: out.hasSecrets,
      writesOnlyTargetDatabase: out.writesOnlyTargetDatabase,
      changesDatabaseLifecycle: out.changesDatabaseLifecycle,
    }
  }

  async backupDatabase(database: string, filePath: string): Promise<void> {
    const conn = this.handle()
    await this.track(() => this.native.DurableBackupAsync(conn, database, filePath))
  }

  async restoreDatabase(database: string, filePath: string): Promise<void> {
    const conn = this.handle()
    await this.track(() => this.native.DurableRestoreAsync(conn, database, filePath))
  }

  /**
   * Release the connection. Safe after a failed {@link start}, safe twice, and
   * it waits out any native call still running — a libuv thread holds this
   * handle, so closing under one would be a use-after-free rather than a
   * cancelled operation. There is no interrupt for a running query, so this
   * waits rather than aborts.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
    const conn = this.connection
    this.connection = null
    if (conn) this.native.CloseConnection(conn)
  }
}

/**
 * An {@link EngineFactory} building {@link ChdbNodeEngine}s — the shape
 * `DurableNamespace` wants.
 *
 * The addon is loaded when the factory is *called*, not when it is built, so
 * constructing a namespace stays free of native code and a missing or stale
 * addon is reported at the open that needed it.
 */
export function nodeEngineFactory(options: ChdbNodeEngineOptions = {}): EngineFactory {
  return () => new ChdbNodeEngine(options)
}
