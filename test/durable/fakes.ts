/**
 * Test doubles for the durable conformance suites.
 *
 * The backend under test is the real {@link LocalDurableBackend} — mocking it
 * would mean the conditional-create and compare-and-swap paths, which are the
 * only parts of a backend that can be subtly wrong, were never exercised.
 * {@link FaultBackend} therefore *wraps* it rather than replacing it, so a
 * fault scenario runs the real code right up to the injected failure.
 *
 * The engine is a fake, because the durable state machine's correctness does
 * not depend on ClickHouse actually executing anything, and a real engine
 * binds one data path per process. The real engine is covered separately by
 * the Bun end-to-end suite.
 */

import { readFile, writeFile } from 'fs/promises'
import type { DurableBackend, GetWithEtag, PutOutcome, ReplaceOutcome } from '../../src/durable/backend'
import type { Readable } from 'stream'
import {
  QueryClass,
  type EngineAdapter,
  type EngineStartOptions,
  type QueryAnalysis,
} from '../../src/durable/engine-adapter'

/**
 * A stand-in for `chdb_classify_query_n`.
 *
 * Deliberately crude, and deliberately confined to test code: a prefix table
 * like this is exactly what the contract forbids a binding from shipping,
 * because it cannot see through inline `FORMAT` data or resolve an unqualified
 * name against the session database. Here it only has to produce the analyses
 * the scenarios need; the real classifier is exercised by the Bun suite.
 */
export function fakeAnalyze(sql: string, targetDatabase: string): QueryAnalysis {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  const upper = trimmed.toUpperCase()
  const statementCount = trimmed.length === 0 ? 0 : trimmed.split(';').filter((s) => s.trim()).length

  let queryClass: QueryClass
  if (/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|EXISTS|CHECK)\b/.test(upper)) {
    queryClass = QueryClass.ReadOnly
  } else if (/^(SET|USE|SYSTEM|BACKUP|RESTORE|ATTACH|DETACH|KILL)\b/.test(upper)) {
    queryClass = QueryClass.Control
  } else if (/^INSERT\s+INTO\s+FUNCTION\b/.test(upper) || /INTO OUTFILE/.test(upper)) {
    queryClass = QueryClass.Control
  } else if (/^CREATE\s+(FUNCTION|NAMED COLLECTION|USER|ROLE)\b/.test(upper) || /\bSYSTEM\./.test(upper)) {
    queryClass = QueryClass.MutatingGlobal
  } else if (/^(INSERT|CREATE|ALTER|DROP|TRUNCATE|RENAME|OPTIMIZE|UPDATE|DELETE|EXCHANGE)\b/.test(upper)) {
    queryClass = QueryClass.Mutating
  } else {
    queryClass = QueryClass.Unknown
  }

  const changesDatabaseLifecycle = /^(CREATE|DROP|RENAME)\s+DATABASE\b/.test(upper)
  const hasSecrets = /SECRET_ACCESS_KEY|IDENTIFIED WITH|PASSWORD/i.test(trimmed)
  const foreignTarget = /\b([A-Za-z_][A-Za-z0-9_]*)\./.exec(trimmed)
  const writesOnlyTargetDatabase =
    queryClass === QueryClass.Unknown
      ? false
      : queryClass === QueryClass.ReadOnly
        ? true
        : !changesDatabaseLifecycle &&
          queryClass === QueryClass.Mutating &&
          (!foreignTarget || foreignTarget[1] === targetDatabase)

  return {
    statementCount: queryClass === QueryClass.Unknown && statementCount === 1 ? 0 : statementCount,
    queryClass,
    hasSecrets: queryClass === QueryClass.Unknown ? false : hasSecrets,
    writesOnlyTargetDatabase,
    changesDatabaseLifecycle,
  }
}

/**
 * An engine whose whole database is the ordered list of statements it has been
 * given. A backup is that list on disk; a restore replaces it. That is enough
 * to tell whether the state machine restored the right base, replayed the
 * right WAL, and did it in the right order.
 */
export class FakeEngine implements EngineAdapter {
  statements: string[] = []
  versionString = '26.7.0'
  currentDatabase: string | undefined
  dataPath: string | undefined
  started = false
  closed = false

  /** Set to make the next `run` throw, simulating a statement that fails locally. */
  failNextRun: Error | undefined
  /** Set to make every backup throw. */
  backupFailure: Error | undefined
  /** Set to make every restore throw. */
  restoreFailure: Error | undefined
  /** Override the analysis for a specific statement. */
  analysisOverrides = new Map<string, QueryAnalysis>()

  async version(): Promise<string> {
    return this.versionString
  }

  async start(options: EngineStartOptions): Promise<void> {
    this.dataPath = options.dataPath
    this.started = true
  }

  async createDatabase(database: string): Promise<void> {
    this.currentDatabase ??= database
  }

  async useDatabase(database: string): Promise<void> {
    this.currentDatabase = database
  }

  async analyze(sql: string, targetDatabase: string): Promise<QueryAnalysis> {
    return this.analysisOverrides.get(sql) ?? fakeAnalyze(sql, targetDatabase)
  }

  async query(sql: string, _format: string): Promise<string> {
    return JSON.stringify({ sql, statements: this.statements.length })
  }

  async run(sql: string): Promise<void> {
    if (this.failNextRun) {
      const e = this.failNextRun
      this.failNextRun = undefined
      throw e
    }
    this.statements.push(sql)
  }

  async backupDatabase(_database: string, filePath: string): Promise<void> {
    if (this.backupFailure) throw this.backupFailure
    // Mirrors core: the target must not already exist.
    await writeFile(filePath, JSON.stringify(this.statements), { flag: 'wx' })
  }

  async restoreDatabase(_database: string, filePath: string): Promise<void> {
    if (this.restoreFailure) throw this.restoreFailure
    const raw = await readFile(filePath, 'utf8')
    this.statements = JSON.parse(raw) as string[]
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

export type FaultPoint =
  | { on: 'putBytes'; key?: RegExp; result: PutOutcome | 'throw' | 'write-then-ambiguous' | 'divergent-then-exists' }
  | { on: 'putFile'; key?: RegExp; result: PutOutcome | 'throw' | 'write-then-ambiguous' }
  | { on: 'replace'; result: 'not-replaced' | 'ambiguous' | 'throw' | 'commit-then-ambiguous' }

/**
 * Wraps a real backend and injects one scripted fault per queued entry.
 *
 * The `*-then-ambiguous` modes are the interesting ones and the reason this
 * exists: they perform the underlying write for real and *then* report the
 * response as lost. That is the failure the contract spends a whole section
 * on, and it cannot be reproduced by a backend that simply refuses.
 */
export class FaultBackend implements DurableBackend {
  readonly describe: string
  private readonly inner: DurableBackend
  private readonly queue: FaultPoint[] = []

  constructor(inner: DurableBackend) {
    this.inner = inner
    this.describe = inner.describe
  }

  /** Queue one fault. Faults fire in the order queued, one call each. */
  inject(fault: FaultPoint): this {
    this.queue.push(fault)
    return this
  }

  get pendingFaults(): number {
    return this.queue.length
  }

  /** Generic on the discriminant so each caller gets its own variant back. */
  private take<K extends FaultPoint['on']>(on: K, key?: string): Extract<FaultPoint, { on: K }> | undefined {
    const i = this.queue.findIndex(
      (f) => f.on === on && (!('key' in f) || !f.key || (key !== undefined && f.key.test(key))),
    )
    if (i === -1) return undefined
    return this.queue.splice(i, 1)[0] as Extract<FaultPoint, { on: K }>
  }

  getBytes(key: string): Promise<Uint8Array | undefined> {
    return this.inner.getBytes(key)
  }

  getBytesWithEtag(key: string): Promise<GetWithEtag | undefined> {
    return this.inner.getBytesWithEtag(key)
  }

  openReadStream(key: string): Promise<Readable | undefined> {
    return this.inner.openReadStream(key)
  }

  async putBytesIfAbsent(key: string, bytes: Uint8Array): Promise<PutOutcome> {
    const fault = this.take('putBytes', key)
    if (fault) {
      if (fault.result === 'throw') throw new Error('injected: putBytesIfAbsent failed')
      if (fault.result === 'write-then-ambiguous') {
        await this.inner.putBytesIfAbsent(key, bytes)
        return 'ambiguous'
      }
      if (fault.result === 'divergent-then-exists') {
        // Something else is already at this key. Only the digest can tell.
        await this.inner.putBytesIfAbsent(key, Buffer.from('{"sql":"not what we sent"}\n'))
        return 'already-exists'
      }
      return fault.result
    }
    return this.inner.putBytesIfAbsent(key, bytes)
  }

  async putFileIfAbsent(key: string, localPath: string): Promise<PutOutcome> {
    const fault = this.take('putFile', key)
    if (fault) {
      if (fault.result === 'throw') throw new Error('injected: putFileIfAbsent failed')
      if (fault.result === 'write-then-ambiguous') {
        await this.inner.putFileIfAbsent(key, localPath)
        return 'ambiguous'
      }
      return fault.result
    }
    return this.inner.putFileIfAbsent(key, localPath)
  }

  async replaceIfMatch(key: string, bytes: Uint8Array, etag: string): Promise<ReplaceOutcome> {
    const fault = this.take('replace')
    if (fault) {
      if (fault.result === 'throw') throw new Error('injected: replaceIfMatch failed')
      if (fault.result === 'commit-then-ambiguous') {
        await this.inner.replaceIfMatch(key, bytes, etag)
        return { status: 'ambiguous' }
      }
      return { status: fault.result }
    }
    return this.inner.replaceIfMatch(key, bytes, etag)
  }
}

