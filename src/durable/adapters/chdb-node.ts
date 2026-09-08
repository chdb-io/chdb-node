/**
 * The default {@link EngineAdapter} for Node: the durable control plane driven
 * by this package's own native addon.
 *
 * `chdb/durable` takes an injected engine, on purpose — so a Bun `dlopen` or a
 * test fake can drive the same state machine. This module is the injection
 * Node callers should not have to write themselves; import it through the
 * `chdb/durable/node` barrel, which also re-exports the control plane.
 *
 * Importing this module loads no native code. The addon is loaded when an
 * engine is first *constructed*, inside `namespace.open()` —
 * {@link nodeEngineFactory} only closes over its options. Deferring it that
 * far is what lets the load double as the compatibility check: the ABI is
 * verified and the engine version read at the point a caller is actually
 * asking for an engine, so a stale addon fails at `open()` naming what is
 * missing, rather than at import time from a module the caller may not reach.
 *
 * The subpath is therefore about **layering, not load side effects**.
 *
 * ```ts
 * import { DurableNamespace, nodeEngineFactory } from 'chdb/durable/node'
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

/**
 * Argv entries `extraArgs` may not carry, because durable's own guarantees
 * rest on them.
 *
 * ClickHouse takes the *last* value for a repeated argument, so an `extraArgs`
 * appended after {@link DURABILITY_SETTINGS} could turn `async_insert` back
 * on — and then `execute()` returns while the rows are still in a buffer, the
 * statement joins the WAL, and the next checkpoint archives a database that
 * does not contain them. `BACKUP DATABASE` only captures what has landed, and
 * a successful checkpoint empties the WAL list, so those rows are gone from
 * both halves with nothing reported. That is the one failure class this
 * package exists to rule out, so it is refused rather than documented.
 *
 * This list lives here rather than in the addon on purpose. Only durable needs
 * these pinned; an ordinary `Session` legitimately tunes `mutations_sync` or
 * loads a config file, and the addon serves both. `path` is the exception —
 * the addon refuses it for every caller, since it is the connection registry's
 * key — and it is repeated here so the refusal names durable's own option.
 */
export const RESERVED_SETTINGS: readonly string[] = [
  'path',
  'backups.allowed_path',
  'async_insert',
  'wait_for_async_insert',
  'mutations_sync',
  'alter_sync',
]

/**
 * The setting name inside an argv entry: leading dashes stripped, cut at the
 * `=` or the space. Covers `--async_insert=1`, `--async_insert 1` and a bare
 * `--async_insert`, which ClickHouse reads as three spellings of one argument.
 */
function settingName(arg: string): string {
  const stripped = arg.replace(/^-+/, '')
  const cut = stripped.search(/[=\s]/)
  return (cut === -1 ? stripped : stripped.slice(0, cut)).trim()
}

/**
 * Refuse reserved settings before anything is connected. A `TypeError`
 * rather than a durable category, matching how `DurableNamespace` reports a
 * malformed option: this is a mistake in the calling code, not a state the
 * object can be in.
 */
export function assertExtraArgsAllowed(extraArgs: readonly string[]): void {
  for (const arg of extraArgs) {
    if (typeof arg !== 'string') {
      throw new TypeError(`durable: extraArgs must be strings, got ${typeof arg}`)
    }
    // Before the name check, because an embedded NUL is how an argument gets
    // past it: the engine sees only the bytes before the NUL, so
    // `'--path\0x'` reaches it as a bare `--path` and swallows the next entry
    // as its value. The addon refuses these too — this is the earlier, more
    // specific error, and it is what keeps the check below honest.
    if (arg.includes('\0')) {
      throw new TypeError(
        `durable: extraArgs cannot contain a NUL byte — it truncates the argument at the C ` +
          `boundary and lets the next one become its value`,
      )
    }
    const name = settingName(arg)
    if (RESERVED_SETTINGS.includes(name)) {
      throw new TypeError(
        `durable: extraArgs cannot set ${JSON.stringify(name)} — durable pins it, and ` +
          `ClickHouse takes the last value for a repeated argument, so this would silently ` +
          `override it. Reserved: ${RESERVED_SETTINGS.join(', ')}`,
      )
    }
  }
}

export interface ChdbNodeEngineOptions {
  /**
   * Extra `--setting=value` argv entries for the connection, e.g.
   * `['--max_threads=8', '--max_memory_usage=8000000000']`.
   *
   * Durable's own arguments are appended after these and win, and the settings
   * durable depends on are refused outright — see {@link RESERVED_SETTINGS}.
   * Everything else ClickHouse accepts on a command line is fair game.
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
  /** The one cleanup every concurrent {@link close} awaits. */
  private closing?: Promise<void>
  /** Native calls still on a libuv thread, so close can wait them out. */
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(options: ChdbNodeEngineOptions = {}) {
    assertExtraArgsAllowed(options.extraArgs ?? [])
    // An injected addon is checked like a loaded one. Skipping it would make
    // the injection path the only one that reports a missing export as
    // `TypeError: EngineVersion is not a function`, instead of the
    // `DurableEngineError` that names what is absent and how to get it.
    this.native = options.native ? assertDurableAbi(options.native) : loadDurableNative()
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
    // Durable's own arguments go LAST, so that even a reserved setting that
    // slipped past `assertExtraArgsAllowed` loses — ClickHouse takes the last
    // value for a repeated argument. The check is the door; this is the lock.
    const settings = [
      ...this.extraArgs,
      `--backups.allowed_path=${options.backupsAllowedPath}`,
      ...DURABILITY_SETTINGS,
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
   *
   * Concurrent and repeated calls share one cleanup and all resolve only once
   * the connection is actually gone. Returning early on a `closed` flag would
   * be a lie to every caller but the first: the first may still be waiting out
   * a backup, so the handle is still owned by a libuv thread while the others
   * have been told it is released. Waiting on `inFlight` instead of on the
   * shared promise would narrow that window without closing it — the count
   * reaches zero before `CloseConnection` is called.
   */
  async close(): Promise<void> {
    // Set synchronously, so an operation starting between this call and the
    // first `await` is refused rather than queued behind a closing engine.
    this.closed = true
    if (!this.closing) this.closing = this.releaseConnection()
    return this.closing
  }

  private async releaseConnection(): Promise<void> {
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
  // Checked here as well as in the constructor, so a bad `extraArgs` is
  // reported where it was written rather than at the first `open()`. It is a
  // string check, so it costs nothing and loads nothing.
  assertExtraArgsAllowed(options.extraArgs ?? [])
  return () => new ChdbNodeEngine(options)
}
