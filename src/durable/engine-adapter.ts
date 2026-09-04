/**
 * The engine seam (contract §3, roadmap §7.1).
 *
 * The durable control plane never touches a native library. Everything it
 * needs from the engine goes through this interface, which is why the same
 * state machine can drive chdb-node's addon, a Bun `dlopen` of `libchdb`, or a
 * fake in a unit test without any of them knowing about the others.
 *
 * Two rules shape the interface, and both are contract requirements rather
 * than taste:
 *
 *  1. **The binding never builds management SQL.** `backupDatabase`,
 *     `restoreDatabase` and `createDatabase` take an identifier and a path;
 *     quoting and AST construction happen in core. A binding that concatenated
 *     `BACKUP DATABASE ` + name would be one clever database name away from
 *     injection, in four languages independently.
 *  2. **The binding never classifies SQL itself.** No prefix lists, no regular
 *     expressions. `analyze` is ClickHouse's own parser answering questions
 *     only it can answer — how many executable statements are in this text,
 *     and does every persistent write land in the database we own. A regex
 *     cannot see through `INSERT ... FORMAT` inline data, and it cannot
 *     resolve an unqualified table name against the session's current
 *     database.
 *
 * `backupDatabase` deliberately has no incremental-base parameter even though
 * the C ABI accepts one. V1 checkpoints are always full: an incremental
 * archive records the *path* of its base, and that path does not exist on the
 * machine that restores it (contract §3.2).
 */

import { DurableClassificationRefusedError, DurableSecretRefusedError } from './errors'

/**
 * Statement classes, ascending by how restricted they are — so a batch
 * classifies as the maximum over its members. Values match `chdb_query_class`
 * in the C ABI and must not be renumbered.
 */
export enum QueryClass {
  /** SELECT, SHOW, DESCRIBE, EXPLAIN: leaves no trace. */
  ReadOnly = 0,
  /** INSERT, CREATE, ALTER, DROP, …: changes a database, and a backup captures it. */
  Mutating = 1,
  /** Global UDFs, named collections, access entities, `system` writes: persistent
   *  and replayable, but outside any database a checkpoint could capture. */
  MutatingGlobal = 2,
  /** USE, SET, SYSTEM, BACKUP, RESTORE, writes outside the engine entirely. */
  Control = 3,
  /** Did not parse, or parsed into something this engine does not classify. */
  Unknown = 4,
}

/** What `chdb_classify_query_n` reports, as a JS value. */
export interface QueryAnalysis {
  /** Executable statements. `PARALLEL WITH` arms count separately. */
  statementCount: number
  queryClass: QueryClass
  /** The text carries a credential. Never set when the class is Unknown. */
  hasSecrets: boolean
  /** Proven: every persistent write lands in the database the caller named. */
  writesOnlyTargetDatabase: boolean
  /** The statement creates, drops or renames a database rather than acting inside one. */
  changesDatabaseLifecycle: boolean
}

export interface EngineStartOptions {
  /** Fresh, empty, private data directory for this object's engine. */
  dataPath: string
  /** Absolute, already-created directory the engine may read and write archives in. */
  backupsAllowedPath: string
}

/**
 * What the durable object needs from an engine. Implementations own their
 * native resources entirely; the control plane only calls these methods and
 * `close`.
 */
export interface EngineAdapter {
  /** Bring up a connection on a fresh scratch path. Called once, before anything else. */
  start(options: EngineStartOptions): Promise<void>

  /**
   * Exact `chdb_version()`. Recorded in the head and matched on every open.
   *
   * Must be answerable before {@link start}: the open sequence checks engine
   * compatibility before it takes a lease or creates a scratch directory, so
   * a mismatch costs nothing. The underlying C symbol takes no connection, so
   * this is a property of the loaded library rather than of a session.
   */
  version(): Promise<string>

  /**
   * Highest archive-format generation this engine can restore.
   *
   * Optional, and defaults to the V1 baseline of 1, because the C ABI has no
   * accessor for it yet — every release so far is generation 1. Once core
   * exposes one, an adapter reports it here and the reader gate starts
   * refusing archives from a future generation instead of assuming.
   */
  backupFormat?(): Promise<number>

  /** `CREATE DATABASE`, with core doing the quoting. */
  createDatabase(database: string): Promise<void>

  /**
   * Pin the connection's current database. Called once after restore; the
   * public surface can never change it, because `USE` classifies as Control.
   */
  useDatabase(database: string): Promise<void>

  /** Analyse without executing, judged against `targetDatabase`. */
  analyze(sql: string, targetDatabase: string): Promise<QueryAnalysis>

  /** Run a read query and return its formatted result. */
  query(sql: string, format: string): Promise<string>

  /**
   * Run a statement for effect. This is the *internal* path: it does no
   * analysis and appends nothing to a WAL. Replay uses it, which is exactly
   * why it must not be reachable from the public surface — a replayed
   * statement that re-entered `execute()` would be logged a second time.
   */
  run(sql: string): Promise<void>

  /** Full `BACKUP DATABASE` to a new absolute path that must not already exist. */
  backupDatabase(database: string, filePath: string): Promise<void>

  /** `RESTORE DATABASE` from an archive into a database that does not hold its tables. */
  restoreDatabase(database: string, filePath: string): Promise<void>

  /** Release the native connection. Must be safe to call after a failed start. */
  close(): Promise<void>
}

/** Builds the engine for one durable object. */
export type EngineFactory = () => EngineAdapter | Promise<EngineAdapter>

const CLASS_NAMES: Record<QueryClass, string> = {
  [QueryClass.ReadOnly]: 'READ_ONLY',
  [QueryClass.Mutating]: 'MUTATING',
  [QueryClass.MutatingGlobal]: 'MUTATING_GLOBAL',
  [QueryClass.Control]: 'CONTROL',
  [QueryClass.Unknown]: 'UNKNOWN',
}

export function queryClassName(c: QueryClass): string {
  return CLASS_NAMES[c] ?? `class ${c}`
}

/**
 * The frozen `query()` gate (contract §3.4).
 *
 * Note what is *not* here: a secret check. A read-only statement never reaches
 * the WAL, so a credential inside it is not a durability problem — it is only
 * a logging problem, which the binding handles by never echoing SQL.
 */
export function assertQueryAllowed(analysis: QueryAnalysis): void {
  if (analysis.statementCount !== 1) {
    throw new DurableClassificationRefusedError(
      `durable: query() takes exactly one statement, core counted ${analysis.statementCount}`,
    )
  }
  if (analysis.queryClass !== QueryClass.ReadOnly) {
    throw new DurableClassificationRefusedError(
      `durable: query() accepts only READ_ONLY statements, core classified this as ` +
        `${queryClassName(analysis.queryClass)}`,
    )
  }
}

/**
 * The frozen `execute()` gate (contract §3.4).
 *
 * The checks are ordered so the message names the most actionable fact first.
 * The secret check is last and separate because it is the one failure the
 * caller fixes by rewriting the statement rather than by using a different
 * API — and because its message must describe the refusal without quoting the
 * statement that triggered it.
 */
export function assertExecuteAllowed(analysis: QueryAnalysis, database: string): void {
  if (analysis.statementCount !== 1) {
    throw new DurableClassificationRefusedError(
      `durable: execute() takes exactly one statement, core counted ${analysis.statementCount}. ` +
        `A WAL record is one statement, so a batch has no replayable form in V1`,
    )
  }
  if (analysis.queryClass !== QueryClass.Mutating) {
    throw new DurableClassificationRefusedError(
      `durable: execute() accepts only MUTATING statements, core classified this as ` +
        `${queryClassName(analysis.queryClass)}` +
        (analysis.queryClass === QueryClass.MutatingGlobal
          ? '. Global state lives outside every database, so a checkpoint cannot carry it and V1 refuses it'
          : ''),
    )
  }
  if (analysis.changesDatabaseLifecycle) {
    throw new DurableClassificationRefusedError(
      `durable: execute() cannot create, drop or rename a database; the object owns ` +
        `${JSON.stringify(database)} and its lifecycle is not a logged mutation`,
    )
  }
  if (!analysis.writesOnlyTargetDatabase) {
    throw new DurableClassificationRefusedError(
      `durable: core could not prove every write lands in ${JSON.stringify(database)}. ` +
        `A write to another database, to system, to a table function or to a file is not ` +
        `captured by this object's checkpoint`,
    )
  }
  if (analysis.hasSecrets) {
    throw new DurableSecretRefusedError(
      'durable: refusing to log a mutation that embeds a credential; the WAL outlives the ' +
        'statement, so the credential would outlive it too',
    )
  }
}
