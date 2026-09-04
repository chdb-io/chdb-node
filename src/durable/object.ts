/**
 * The Durable V1 object state machine (contract §5).
 *
 * Everything the protocol calls hard lives here: lease acquisition and
 * fencing, the operation queue, WAL publication, checkpoint, and the
 * reconcile that decides whether a request whose response vanished actually
 * committed. None of it touches a native library — the engine arrives as an
 * {@link EngineAdapter}, the object store as a {@link DurableBackend}.
 *
 * A few invariants are worth stating up front, because most of the code below
 * exists to hold one of them:
 *
 *  - **`execute()` succeeding does not mean the write is durable.** It means
 *    the statement ran locally and joined the buffer. Durability is `flush()`.
 *    A product that answers a client before flushing is choosing to lose that
 *    write on a crash, and it should choose that knowingly.
 *  - **Nothing is ever reported as committed without proof.** Every commit
 *    path can end in `commit_ambiguous`, which is an honest answer. Reporting
 *    a lost response as success would be the one failure mode a caller cannot
 *    defend against.
 *  - **A writer that cannot confirm its lease stops writing.** Not on the next
 *    error — at the moment its locally believed validity window lapses. The
 *    alternative is two processes each convinced they are the only writer.
 *  - **Local resources are always released.** A close that fails to flush
 *    still closes the connection and removes the scratch directory, and still
 *    reports the failure.
 */

import { mkdir, mkdtemp, rm, unlink } from 'fs/promises'
import { createReadStream } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { pipeline } from 'stream/promises'

import type { DurableBackend } from './backend'
import { assertDigest, digestOf, digestingStream, streamToVerifiedFile, type Digest } from './digest'
import {
  assertExecuteAllowed,
  assertQueryAllowed,
  type EngineAdapter,
  type EngineFactory,
} from './engine-adapter'
import {
  DurableClassificationRefusedError,
  DurableClosedError,
  DurableCommitAmbiguousError,
  DurableCorruptError,
  DurableEngineError,
  DurableEngineIncompatibleError,
  DurableLeaseFencedError,
  DurableLeaseHeldError,
  DurableLimitExceededError,
  DurableNotFoundError,
  DurableTimeoutError,
} from './errors'
import { coldHead, parseHead, serializeHead } from './head'
import { HEAD_KEY, checkpointKey, uuid8, walKey } from './keys'
import { Mutex } from './mutex'
import {
  assertEngineCompatible,
  assertReadable,
  assertWritable,
  type RunningEngine,
} from './negotiate'
import { maxEngineVersion } from './version'
import {
  assertStatementWithinLimit,
  decodeWalSegment,
  encodeWalSegment,
  walLineBytes,
} from './wal'
import {
  BACKUP_FORMAT_BASELINE,
  LIMITS,
  type DurableHead,
  type DurableManifest,
  type DurableObjectRef,
} from './types'

/**
 * Lease and commit tuning. The contract lets a binding choose these but
 * requires the defaults, their units and their rules to be documented — so
 * they are, here, and the same values drive the conformance scenarios.
 */
export interface DurableTuning {
  /** How long a lease is valid after a successful head write. Default 30s. */
  leaseTtlMs: number
  /**
   * How often the writer renews. Must be at most a third of the TTL, so two
   * consecutive heartbeat failures still leave a window to notice and fence.
   * Default 10s.
   */
  heartbeatIntervalMs: number
  /**
   * How far past a recorded expiry another writer waits before treating a
   * lease as abandoned. This is a bound on disagreement between two machines'
   * clocks, not a grace period for a slow writer. Default 5s.
   */
  clockSkewAllowanceMs: number
  /** How long a single commit may spend retrying and reconciling. Default 30s. */
  commitDeadlineMs: number
  /** Attempts inside that deadline before giving up. Default 5. */
  maxCommitAttempts: number
}

export const DEFAULT_TUNING: DurableTuning = {
  leaseTtlMs: 30_000,
  heartbeatIntervalMs: 10_000,
  clockSkewAllowanceMs: 5_000,
  commitDeadlineMs: 30_000,
  maxCommitAttempts: 5,
}

export interface DurableOpenOptions {
  /** Open without a writer lease. Read-only opens see the manifest as of open. */
  readOnly?: boolean
  /**
   * Take an unexpired lease from its current holder. An administrator action:
   * the previous writer's unflushed local work is lost, and it learns this
   * only when its next commit is fenced.
   */
  force?: boolean
  /** Refuse to create the object if it does not exist. */
  existingOnly?: boolean
  /** Visible writer name recorded in the lease. Observability only. */
  owner?: string
  /** Database this object holds. Only used when creating a cold object. */
  database?: string
  /** Parent directory for the scratch tree. Defaults to the system temp dir. */
  scratchRoot?: string
  /**
   * Called as the open restores base and replays WAL. Synchronous and
   * best-effort: a throw from it is swallowed, because a reporting callback
   * must not be able to fail an otherwise good recovery.
   */
  onRestoreProgress?: (progress: RestoreProgress) => void
  tuning?: Partial<DurableTuning>
}

/**
 * Progress through the restore an open performs, for a caller that has to show
 * one. Recovering a large object is not instantaneous, and "starting" with no
 * further detail is indistinguishable from "stuck" — which is the state an
 * operator most needs to tell apart.
 */
export type RestoreProgress =
  | { phase: 'creating-database'; database: string }
  | { phase: 'restoring-base'; key: string; size: number }
  | {
      phase: 'replaying-wal'
      /** 1-based index of the segment being replayed. */
      segment: number
      segments: number
      /** Statements replayed so far, across all segments. */
      statements: number
      key: string
    }
  | { phase: 'ready'; statementsReplayed: number }

/**
 * A consistent snapshot of an object's runtime state. Contains no credentials
 * and no SQL, so it is safe to log verbatim.
 */
export interface DurableStats {
  objectId: string
  database: string
  readOnly: boolean
  state: 'open' | 'closing' | 'closed'
  /** True once this writer has lost, or given up on, its lease. */
  fenced: boolean
  generation: number
  owner: string
  instance: string
  /** When this writer stops believing its lease. Absent for a read-only open. */
  leaseExpiresAt: Date | undefined
  /** `manifest.seq` as last committed. */
  committedSeq: number
  baseKey: string | undefined
  walSegments: number
  /** Statements executed through this handle since it opened. */
  executedStatements: number
  /** Of those, how many are in a committed WAL segment. */
  committedStatements: number
  pendingStatements: number
  pendingBytes: number
  lastFlushAt: Date | undefined
  lastCheckpointAt: Date | undefined
}

export interface DurableObjectDeps {
  id: string
  backend: DurableBackend
  engineFactory: EngineFactory
}

/**
 * A watermark for one executed statement. `flushThrough` turns it into a
 * durability barrier, which is what lets a caller that expands one request
 * into several statements answer the request as a whole (roadmap §10.1)
 * without the protocol having to know about requests.
 */
export interface WriteTicket {
  /** Ordinal of the statement within this open session, starting at 1. */
  readonly statement: number
}

export interface QueryOptions {
  /** ClickHouse output format. Defaults to `JSONEachRow`. */
  format?: string
}

interface Scratch {
  root: string
  data: string
  backups: string
  staging: string
}

function nowMs(): number {
  return Date.now()
}

/** Stream a local file through SHA-256 without holding it in memory. */
async function digestFile(path: string): Promise<Digest> {
  const counter = digestingStream()
  await pipeline(createReadStream(path), counter, async function* (source) {
    // Drain without collecting: the digest is the only thing wanted here.
    for await (const _chunk of source) void _chunk
  })
  return counter.digest()
}

export class DurableObject {
  readonly id: string
  readonly readOnly: boolean

  private readonly backend: DurableBackend
  private readonly engine: EngineAdapter
  private readonly scratch: Scratch
  private readonly tuning: DurableTuning
  private readonly instance: string
  private readonly ownerName: string
  private readonly running: RunningEngine

  /** Serializes whole logical operations. See {@link Mutex} for why there are two. */
  private readonly ops = new Mutex()
  /** Serializes single head compare-and-swaps, including heartbeat. */
  private readonly headLock = new Mutex()

  private head: DurableHead
  private etag: string
  private raw: Record<string, unknown>

  private walBuffer: string[] = []
  /** Encoded size of `walBuffer`, kept in step so execute() can budget in O(1). */
  private walBufferBytes = 0
  private statementCounter = 0
  private committedStatementCount = 0
  private lastFlushAtMs: number | undefined
  private lastCheckpointAtMs: number | undefined

  private status: 'open' | 'closing' | 'closed' = 'open'
  private fenced = false
  /** Local wall-clock time at which this writer stops believing its lease. */
  private leaseDeadlineMs = 0
  private heartbeatTimer: NodeJS.Timeout | undefined
  private closing: Promise<void> | undefined

  private constructor(init: {
    id: string
    backend: DurableBackend
    engine: EngineAdapter
    scratch: Scratch
    tuning: DurableTuning
    readOnly: boolean
    instance: string
    owner: string
    running: RunningEngine
    head: DurableHead
    etag: string
    raw: Record<string, unknown>
  }) {
    this.id = init.id
    this.backend = init.backend
    this.engine = init.engine
    this.scratch = init.scratch
    this.tuning = init.tuning
    this.readOnly = init.readOnly
    this.instance = init.instance
    this.ownerName = init.owner
    this.running = init.running
    this.head = init.head
    this.etag = init.etag
    this.raw = init.raw
  }

  // ---------------------------------------------------------------- accessors

  /** The database this object holds. Fixed for the object's lifetime. */
  get database(): string {
    return this.head.manifest.db
  }

  /** Lease generation currently recorded in the head. */
  get generation(): number {
    return this.head.lease.generation
  }

  /** A copy of the committed manifest. Observability; never authority. */
  get manifest(): DurableManifest {
    return {
      db: this.head.manifest.db,
      base: this.head.manifest.base ? { ...this.head.manifest.base } : null,
      wal: this.head.manifest.wal.map((r) => ({ ...r })),
      seq: this.head.manifest.seq,
    }
  }

  /** Statements executed locally but not yet published in a WAL segment. */
  get pendingStatements(): number {
    return this.walBuffer.length
  }

  /**
   * Encoded size of those statements. Exposed so a caller can apply its own
   * backpressure — flush on a size threshold rather than discovering the
   * segment ceiling by hitting it.
   */
  get pendingBytes(): number {
    return this.walBufferBytes
  }

  /** Statements this session has published in a committed WAL segment. */
  get committedStatements(): number {
    return this.committedStatementCount
  }

  /**
   * A point-in-time snapshot for a status endpoint or a log line.
   *
   * Taken together rather than field by field, so what it reports is internally
   * consistent: reading a generation and a sequence number through separate
   * getters can straddle a commit and describe a state that never existed.
   *
   * Carries no credentials and no SQL. Object ids and keys are safe; the
   * statements that produced them are not, and are deliberately absent.
   */
  get stats(): DurableStats {
    return {
      objectId: this.id,
      database: this.database,
      readOnly: this.readOnly,
      state: this.status,
      fenced: this.fenced,
      generation: this.head.lease.generation,
      owner: this.ownerName,
      instance: this.instance,
      leaseExpiresAt:
        this.readOnly || this.leaseDeadlineMs === 0 ? undefined : new Date(this.leaseDeadlineMs),
      committedSeq: this.head.manifest.seq,
      baseKey: this.head.manifest.base?.key,
      walSegments: this.head.manifest.wal.length,
      executedStatements: this.statementCounter,
      committedStatements: this.committedStatementCount,
      pendingStatements: this.walBuffer.length,
      pendingBytes: this.walBufferBytes,
      lastFlushAt: this.lastFlushAtMs === undefined ? undefined : new Date(this.lastFlushAtMs),
      lastCheckpointAt:
        this.lastCheckpointAtMs === undefined ? undefined : new Date(this.lastCheckpointAtMs),
    }
  }

  /** True once this writer has lost, or given up on, its lease. */
  get isFenced(): boolean {
    return this.fenced
  }

  /** Absolute path of this object's private scratch tree. */
  get scratchPath(): string {
    return this.scratch.root
  }

  // --------------------------------------------------------------- public API

  /**
   * Run a read-only statement. Refused unless core proves it is exactly one
   * READ_ONLY statement — the method name is not the gate, the analysis is.
   */
  async query(sql: string, options?: QueryOptions): Promise<string> {
    return this.ops.run(async () => {
      this.assertUsable()
      const analysis = await this.engine.analyze(sql, this.database)
      assertQueryAllowed(analysis)
      return this.engine.query(sql, options?.format ?? 'JSONEachRow')
    })
  }

  /**
   * Run one mutating statement and buffer it for the WAL.
   *
   * The statement is executed first and buffered only on success, so a
   * statement that failed is never replayed. The returned ticket is the
   * watermark to pass to {@link flushThrough} when the caller needs the write
   * to be durable before it answers someone.
   */
  async execute(sql: string): Promise<WriteTicket> {
    return this.ops.run(async () => {
      this.assertWriter()
      const analysis = await this.engine.analyze(sql, this.database)
      assertExecuteAllowed(analysis, this.database)

      // Both limits are checked here rather than at flush, and before the
      // statement runs rather than after.
      //
      // The ordering is the point. A statement that has executed cannot be
      // un-executed, so a buffer that has grown past what a segment can hold
      // can no longer be flushed at all — every flush would fail encoding
      // while the local database has already moved on. `checkpoint()` can
      // still rescue it, since it archives the database rather than the
      // buffer, but a caller has to know that, and nothing would have warned
      // it. Worse, that state is reachable from a single transient failure: a
      // flush that fails leaves the buffer intact by design, and a caller that
      // keeps writing walks straight into it.
      //
      // Refusing here instead turns an unrecoverable flush into a recoverable
      // execute. Nothing has run, so the refusal costs only the statement.
      assertStatementWithinLimit(sql)
      const lineBytes = walLineBytes(sql)
      if (this.walBufferBytes + lineBytes > LIMITS.MAX_WAL_SEGMENT_BYTES) {
        throw new DurableLimitExceededError(
          `durable: this statement would take the unflushed buffer to ` +
            `${this.walBufferBytes + lineBytes} bytes, over the ${LIMITS.MAX_WAL_SEGMENT_BYTES}-byte ` +
            `WAL segment limit; flush() or checkpoint() first`,
          { limit: LIMITS.MAX_WAL_SEGMENT_BYTES, actual: this.walBufferBytes + lineBytes },
        )
      }

      await this.engine.run(sql)
      this.walBuffer.push(sql)
      this.walBufferBytes += lineBytes
      this.statementCounter++
      return { statement: this.statementCounter }
    })
  }

  /**
   * Publish the buffered statements as one immutable WAL segment and commit
   * the reference. Returns the published reference, or `undefined` when there
   * was nothing buffered.
   */
  async flush(): Promise<DurableObjectRef | undefined> {
    return this.ops.run(() => this.flushLocked())
  }

  /**
   * Durability barrier for one ticket. Returns immediately if that statement
   * is already committed, which is what makes concurrent callers coalesce onto
   * a single head write: the first through the queue publishes the segment
   * covering all of them, and the rest find their watermark already met.
   */
  async flushThrough(ticket: WriteTicket): Promise<void> {
    if (ticket.statement <= this.committedStatementCount) return
    await this.ops.run(async () => {
      if (ticket.statement <= this.committedStatementCount) return
      await this.flushLocked()
    })
  }

  /**
   * Replace the base with a full backup of the current local database and
   * clear the WAL list.
   *
   * Holds the operation queue for its whole duration, so nothing new is
   * executed into a database that is being archived. Heartbeat is unaffected —
   * it contends only for the head lock, which this takes just for the final
   * commit.
   */
  async checkpoint(): Promise<DurableObjectRef> {
    return this.ops.run(() => this.checkpointLocked())
  }

  /**
   * Drain, flush, release the lease, then release local resources.
   *
   * Local cleanup happens whether or not the remote steps worked, and a remote
   * failure is still thrown. A close that swallowed a failed flush would be
   * reporting a durability barrier it did not reach.
   */
  async close(): Promise<void> {
    if (!this.closing) this.closing = this.closeInner()
    return this.closing
  }

  // ------------------------------------------------------------ open sequence

  static async open(deps: DurableObjectDeps, options: DurableOpenOptions = {}): Promise<DurableObject> {
    const tuning: DurableTuning = { ...DEFAULT_TUNING, ...options.tuning }
    // Every one of these ends up in arithmetic that decides whether this
    // process still owns the object. A NaN TTL propagates to `expires_at`,
    // which JSON renders as null, producing a lease with an owner and no
    // expiry: nobody can take it over and this writer never self-fences,
    // because every comparison against NaN is false.
    for (const [name, value] of Object.entries(tuning)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(
          `durable: tuning.${name} must be a finite positive number, got ${String(value)}`,
        )
      }
    }
    if (tuning.heartbeatIntervalMs > tuning.leaseTtlMs / 3) {
      throw new RangeError(
        `durable: heartbeatIntervalMs (${tuning.heartbeatIntervalMs}) must be at most a third of ` +
          `leaseTtlMs (${tuning.leaseTtlMs}); the contract requires room for a retry before expiry`,
      )
    }
    const readOnly = options.readOnly === true
    const owner = options.owner ?? `chdb-node-${process.pid}`
    const instance = randomUUID()

    const engine = await deps.engineFactory()
    let scratch: Scratch | undefined
    let leaseTaken: { head: DurableHead; etag: string; raw: Record<string, unknown> } | undefined
    let started = false

    try {
      // Compatibility is settled before anything is created or claimed: an
      // object this engine cannot read should cost nothing but two strings.
      const running: RunningEngine = {
        version: await engine.version(),
        // Optional until chdb-core exposes the generation itself; every
        // release so far is the V1 baseline.
        backupFormat: (await engine.backupFormat?.()) ?? BACKUP_FORMAT_BASELINE,
      }
      const existing = await readHead(deps.backend)

      if (existing) {
        assertReadable(existing.head)
        assertEngineCompatible(existing.head, running)
        if (!readOnly) assertWritable(existing.head)
      } else if (readOnly || options.existingOnly) {
        throw new DurableNotFoundError(
          `durable: object ${deps.id} does not exist at ${deps.backend.describe}`,
        )
      }

      if (readOnly) {
        // No lease, no heartbeat: the manifest read here is the snapshot this
        // handle serves for its whole life. Immutable references make that
        // safe even while a writer keeps committing.
        const snap = existing as NonNullable<typeof existing>
        scratch = await makeScratch(options.scratchRoot)
        await engine.start({ dataPath: scratch.data, backupsAllowedPath: scratch.backups })
        started = true
        await restoreInto(engine, deps.backend, snap.head, scratch, running, options.onRestoreProgress)
        return new DurableObject({
          id: deps.id,
          backend: deps.backend,
          engine,
          scratch,
          tuning,
          readOnly: true,
          instance,
          owner,
          running,
          head: snap.head,
          etag: snap.etag,
          raw: snap.raw,
        })
      }

      // Checked before anything is published: an empty name would produce a
      // head that fails to parse, created with a conditional create that V1
      // gives no way to undo. A bad argument should be a bad argument, not a
      // permanently corrupt object.
      const database = options.database ?? 'default'
      if (database.length === 0) {
        throw new RangeError('durable: options.database must be a non-empty string')
      }
      leaseTaken = existing
        ? await acquireLease(deps.backend, existing, { instance, owner, tuning, force: options.force === true })
        : await createCold(deps.backend, {
            database,
            running,
            instance,
            owner,
            tuning,
            id: deps.id,
          })

      scratch = await makeScratch(options.scratchRoot)
      await engine.start({ dataPath: scratch.data, backupsAllowedPath: scratch.backups })
      started = true

      await restoreInto(engine, deps.backend, leaseTaken.head, scratch, running, options.onRestoreProgress)

      const object = new DurableObject({
        id: deps.id,
        backend: deps.backend,
        engine,
        scratch,
        tuning,
        readOnly: false,
        instance,
        owner,
        running,
        head: leaseTaken.head,
        etag: leaseTaken.etag,
        raw: leaseTaken.raw,
      })
      object.leaseDeadlineMs = Math.min(
        (leaseTaken.head.lease.expires_at ?? 0) * 1000,
        nowMs() + tuning.leaseTtlMs,
      )

      // Restore can outlast a lease. Confirming ownership before the handle
      // escapes is what stops a writer from starting work on a database
      // someone else has already taken over (contract §5.2 step 7).
      await object.renewLease()
      object.startHeartbeat()
      leaseTaken = undefined
      return object
    } catch (e) {
      // Unwind in the reverse order of acquisition, and never let a cleanup
      // failure mask the error that caused it.
      // close() has to tolerate a failed start: the engine may hold a
      // connection, or nothing at all, and the caller cannot tell which.
      void started
      await engine.close().catch(() => {})
      if (leaseTaken) {
        await releaseLease(deps.backend, leaseTaken, instance).catch(() => {})
      }
      if (scratch) await rm(scratch.root, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  }

  // ------------------------------------------------------------ internal work

  private assertUsable(): void {
    if (this.status === 'closed') {
      throw new DurableClosedError(`durable: object ${this.id} is closed`)
    }
    if (this.fenced) {
      throw new DurableLeaseFencedError(
        `durable: object ${this.id} lost its lease (generation ${this.generation}); this handle cannot be used again`,
      )
    }
  }

  private assertWriter(): void {
    this.assertUsable()
    if (this.readOnly) {
      throw new DurableClassificationRefusedError(
        `durable: object ${this.id} is open read-only; only READ_ONLY statements are accepted`,
      )
    }
    if (nowMs() >= this.leaseDeadlineMs) {
      // Self-fence. The lease may in fact still be ours, but we cannot show
      // it, and "probably still the writer" is not a state to write from.
      this.fence()
      throw new DurableLeaseFencedError(
        `durable: object ${this.id} could not confirm its lease before it lapsed; the writer has fenced itself`,
      )
    }
  }

  private fence(): void {
    this.fenced = true
    this.stopHeartbeat()
  }

  private async flushLocked(): Promise<DurableObjectRef | undefined> {
    this.assertWriter()
    if (this.walBuffer.length === 0) return undefined

    const statements = [...this.walBuffer]
    const bytes = encodeWalSegment(statements)
    const digest = digestOf(bytes)
    const key = walKey(this.generation, this.head.manifest.seq + 1)
    const ref: DurableObjectRef = { key, size: digest.size, sha256: digest.sha256 }

    await this.publishBytes(ref, bytes)
    // The upload is network I/O and can outlast the lease. Checking only at
    // entry would let a writer that was required to self-fence mid-upload go
    // on to commit the manifest anyway.
    this.assertWriter()
    await this.commitHead({
      build: (current) => ({
        ...current,
        manifest: {
          ...current.manifest,
          wal: [...current.manifest.wal, ref],
          seq: current.manifest.seq + 1,
        },
      }),
      committed: (observed) => observed.manifest.wal.some((w) => w.key === key),
      key,
    })

    this.walBuffer.splice(0, statements.length)
    this.walBufferBytes = this.walBuffer.reduce((n, s) => n + walLineBytes(s), 0)
    this.committedStatementCount += statements.length
    this.lastFlushAtMs = nowMs()
    return ref
  }

  private async checkpointLocked(): Promise<DurableObjectRef> {
    this.assertWriter()

    const archive = join(this.scratch.backups, `checkpoint-${Date.now().toString(36)}-${uuid8()}.tar.gz`)
    try {
      await this.engine.backupDatabase(this.database, archive)
    } catch (e) {
      await unlink(archive).catch(() => {})
      throw e instanceof DurableEngineError
        ? e
        : new DurableEngineError(`durable: backup of ${JSON.stringify(this.database)} failed`, { cause: e })
    }

    try {
      const digest = await digestFile(archive)
      const key = checkpointKey(this.generation, this.head.manifest.seq + 1)
      const ref: DurableObjectRef = { key, size: digest.size, sha256: digest.sha256 }

      await this.publishFile(ref, archive)
      // A full backup plus its upload is the longest thing this object does,
      // easily longer than a lease TTL. Ownership was checked before it
      // started; it has to hold now, when the commit actually happens.
      this.assertWriter()
      const covered = this.walBuffer.length
      await this.commitHead({
        build: (current) => ({
          ...current,
          manifest: { ...current.manifest, base: ref, wal: [], seq: current.manifest.seq + 1 },
        }),
        committed: (observed) => observed.manifest.base?.key === key,
        key,
      })

      // Only now. Until the head names this base, the old base plus the old
      // WAL is still the authoritative state, and these statements are only
      // recoverable from the buffer.
      this.walBuffer.splice(0, covered)
      this.walBufferBytes = this.walBuffer.reduce((n, s) => n + walLineBytes(s), 0)
      this.committedStatementCount += covered
      this.lastCheckpointAtMs = nowMs()
      return ref
    } finally {
      await unlink(archive).catch(() => {})
    }
  }

  private async closeInner(): Promise<void> {
    this.status = 'closing'
    this.stopHeartbeat()
    await this.ops.sealAndDrain(() => new DurableClosedError(`durable: object ${this.id} is closing`))

    let failure: unknown
    try {
      if (!this.readOnly && !this.fenced) {
        await this.ops.runSealed(async () => {
          if (this.walBuffer.length > 0) await this.flushLocked()
          await this.releaseLeaseLocked()
        })
      }
    } catch (e) {
      failure = e
    }

    // Native connection and scratch go back whatever happened above: a remote
    // failure is a durability problem, not a reason to leak a connection or a
    // temp tree.
    try {
      await this.engine.close()
    } catch (e) {
      failure ??= e
    }
    try {
      await rm(this.scratch.root, { recursive: true, force: true })
    } catch (e) {
      failure ??= e
    }
    this.status = 'closed'
    if (failure) throw failure
  }

  private async releaseLeaseLocked(): Promise<void> {
    await this.commitHead({
      build: (current) => ({
        ...current,
        lease: { generation: current.lease.generation, owner: null, instance: null, expires_at: null },
      }),
      committed: (observed) => observed.lease.instance === null,
      key: HEAD_KEY,
      // Releasing is the last thing this instance does; after it succeeds the
      // ownership check would fail by construction.
      skipOwnershipAfter: true,
    })
    this.fenced = false
    this.leaseDeadlineMs = 0
  }

  // ----------------------------------------------------------------- lease

  private startHeartbeat(): void {
    if (this.readOnly) return
    this.heartbeatTimer = setInterval(() => {
      void this.renewLease().catch(() => {
        // Failure is not fatal on its own — the next attempt may succeed. What
        // is fatal is reaching the locally believed expiry without a
        // confirmation, and assertWriter() checks exactly that.
      })
    }, this.tuning.heartbeatIntervalMs)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  /** One heartbeat: extend the expiry, leaving generation and seq untouched. */
  private async renewLease(): Promise<void> {
    if (this.readOnly || this.fenced || this.status === 'closed') return

    // The expiry has to be computed inside the lock, not before waiting for
    // it. Computed early and then delayed behind a long checkpoint commit,
    // the value written could already be in the past — while the local
    // deadline below was refreshed from the current clock. The object would
    // then keep writing under a lease other writers are entitled to take.
    let written = 0
    await this.commitHead({
      build: (current) => {
        written = (nowMs() + this.tuning.leaseTtlMs) / 1000
        return { ...current, lease: { ...current.lease, expires_at: written } }
      },
      committed: (observed) =>
        observed.lease.instance === this.instance &&
        observed.lease.expires_at !== null &&
        observed.lease.expires_at >= written,
      key: HEAD_KEY,
    })

    // Believe what is actually stored, not what a fresh clock would allow.
    // Reconciliation can settle on a head written by an earlier attempt whose
    // expiry is older than this one's.
    const persisted = this.head.lease.expires_at
    this.leaseDeadlineMs =
      persisted === null ? 0 : Math.min(persisted * 1000, nowMs() + this.tuning.leaseTtlMs)
  }

  // ------------------------------------------------------- immutable publish

  private async publishBytes(ref: DurableObjectRef, bytes: Uint8Array): Promise<void> {
    const outcome = await this.backend.putBytesIfAbsent(ref.key, bytes)
    if (outcome === 'created') return
    await this.reconcileUpload(ref, outcome)
  }

  private async publishFile(ref: DurableObjectRef, localPath: string): Promise<void> {
    const outcome = await this.backend.putFileIfAbsent(ref.key, localPath)
    if (outcome === 'created') return
    await this.reconcileUpload(ref, outcome)
  }

  /**
   * Settle an upload that did not cleanly create (contract §5.8).
   *
   * The key is unique to this attempt, so "already exists" can only mean an
   * earlier try by this same writer landed. Re-reading and comparing the
   * digest is what turns a lost response into a fact: matching bytes are the
   * bytes we meant to publish, different bytes are corruption, and an absent
   * object means the write genuinely did not happen and can be retried
   * against the same conditional create.
   */
  private async reconcileUpload(ref: DurableObjectRef, outcome: 'already-exists' | 'ambiguous'): Promise<void> {
    const stream = await this.backend.openReadStream(ref.key)
    if (!stream) {
      if (outcome === 'already-exists') {
        throw new DurableCorruptError(
          `durable: ${ref.key} was reported as existing but cannot be read from ${this.backend.describe}`,
        )
      }
      throw new DurableCommitAmbiguousError(
        `durable: could not determine whether ${ref.key} was uploaded to ${this.backend.describe}`,
        { key: ref.key },
      )
    }
    const counter = digestingStream()
    await pipeline(stream, counter, async function* (source) {
      for await (const _chunk of source) void _chunk
    })
    assertDigest(ref, counter.digest(), 'published object')
  }

  // ------------------------------------------------------------- head commit

  /**
   * The single path through which this object writes `head.json`.
   *
   * Every caller supplies two things: how to build the next head from whatever
   * the current one turns out to be, and how to recognise its own intent in a
   * head it did not write. The second is what makes a lost response
   * recoverable — after re-reading, either the intent is visible and this
   * committed, or ownership is gone and this is fenced, or neither is true and
   * it can try again inside the deadline.
   */
  private async commitHead(params: {
    build: (current: DurableHead) => DurableHead
    committed: (observed: DurableHead) => boolean
    key: string
    skipOwnershipAfter?: boolean
  }): Promise<void> {
    await this.headLock.run(async () => {
      const deadline = nowMs() + this.tuning.commitDeadlineMs
      let attempts = 0

      let sawAmbiguous = false

      for (;;) {
        attempts++
        const candidate = this.raiseCompatibilityFloor(params.build(this.head))
        const outcome = await this.backend.replaceIfMatch(
          HEAD_KEY,
          serializeHead(candidate, this.raw),
          this.etag,
        )

        if (outcome.status === 'replaced') {
          this.adopt(candidate, outcome.etag)
          return
        }

        if (outcome.status === 'ambiguous') sawAmbiguous = true

        // Either someone else wrote (`not-replaced`) or the answer was lost
        // (`ambiguous`). Both are settled the same way: look at what is
        // actually there.
        const fresh = await readHead(this.backend)
        if (!fresh) {
          throw new DurableCorruptError(
            `durable: ${HEAD_KEY} disappeared from ${this.backend.describe} while committing`,
          )
        }

        const stillOurs =
          fresh.head.lease.instance === this.instance &&
          fresh.head.lease.generation === this.head.lease.generation

        if (params.committed(fresh.head) && (stillOurs || params.skipOwnershipAfter)) {
          this.adopt(fresh.head, fresh.etag, fresh.raw)
          return
        }

        if (!stillOurs) {
          this.fence()
          throw new DurableLeaseFencedError(
            `durable: object ${this.id} was taken over (generation ${fresh.head.lease.generation}); ` +
              `this writer can no longer commit`,
          )
        }

        // Ownership intact and the intent is not there: our ETag was stale.
        // Adopt the current one and retry within the deadline.
        this.adopt(fresh.head, fresh.etag, fresh.raw)

        if (attempts >= this.tuning.maxCommitAttempts || nowMs() >= deadline) {
          // Two different answers, and the caller acts on them differently.
          // If every attempt came back as a definite refusal, the commit
          // provably did not happen and retrying later is safe. If any attempt
          // was ambiguous, it may have landed, and a blind retry could publish
          // twice.
          if (sawAmbiguous) {
            throw new DurableCommitAmbiguousError(
              `durable: gave up committing ${params.key} after ${attempts} attempts without ` +
                `proving the outcome`,
              { key: params.key },
            )
          }
          throw new DurableTimeoutError(
            `durable: could not commit ${params.key} within ${this.tuning.commitDeadlineMs}ms ` +
              `(${attempts} attempts, each definitively refused); nothing was committed`,
          )
        }
      }
    })
  }

  /**
   * Record this engine's compatibility requirements on every head write,
   * without ever relaxing what is already stored.
   *
   * The protocol says a writer must not lower either requirement. Taking the
   * maximum rather than overwriting is what enforces that: an object whose
   * base was produced by a newer engine keeps demanding that engine even if an
   * older one somehow reaches a write, instead of quietly advertising itself
   * as readable by a build that cannot restore it.
   */
  private raiseCompatibilityFloor(head: DurableHead): DurableHead {
    return {
      ...head,
      engine: {
        ...head.engine,
        version: this.running.version,
        backup_format: Math.max(head.engine.backup_format, this.running.backupFormat),
        min_reader: maxEngineVersion(head.engine.min_reader, this.running.version),
      },
    }
  }

  private adopt(head: DurableHead, etag: string, raw?: Record<string, unknown>): void {
    this.head = head
    this.etag = etag
    if (raw) this.raw = raw
    else this.raw = JSON.parse(Buffer.from(serializeHead(head, this.raw)).toString('utf8'))
  }
}

// ------------------------------------------------------------------ helpers

async function makeScratch(root?: string): Promise<Scratch> {
  const base = await mkdtemp(join(root ?? tmpdir(), 'chdb-durable-'))
  const scratch: Scratch = {
    root: base,
    data: join(base, 'data'),
    backups: join(base, 'backups'),
    staging: join(base, 'staging'),
  }
  // The engine validates that a backup target's parent directory exists, and
  // its allowed-path guard resolves relative paths somewhere nobody wants, so
  // all three are created up front and always absolute.
  await mkdir(scratch.data, { recursive: true })
  await mkdir(scratch.backups, { recursive: true })
  await mkdir(scratch.staging, { recursive: true })
  return scratch
}

async function readHead(
  backend: DurableBackend,
): Promise<{ head: DurableHead; etag: string; raw: Record<string, unknown> } | undefined> {
  const got = await backend.getBytesWithEtag(HEAD_KEY)
  if (!got) return undefined
  const { head, raw } = parseHead(got.bytes)
  return { head, etag: got.etag, raw }
}

/**
 * Restore the manifest's state into the scratch engine: base, then WAL in
 * order. Both are verified against length and SHA-256 before use, and a
 * missing or mismatched object stops the open rather than yielding a
 * partially recovered database (contract §4.5).
 */
async function restoreInto(
  engine: EngineAdapter,
  backend: DurableBackend,
  head: DurableHead,
  scratch: Scratch,
  running: RunningEngine,
  onProgress?: (progress: RestoreProgress) => void,
): Promise<void> {
  const db = head.manifest.db
  const base = head.manifest.base
  // A reporting callback is never allowed to break the recovery it reports on.
  const report = (p: RestoreProgress): void => {
    try {
      onProgress?.(p)
    } catch {
      /* deliberately ignored */
    }
  }

  if (base === null) {
    report({ phase: 'creating-database', database: db })
    await engine.createDatabase(db)
  } else {
    report({ phase: 'restoring-base', key: base.key, size: base.size })
    const stream = await backend.openReadStream(base.key)
    if (!stream) {
      throw new DurableCorruptError(
        `durable: manifest names base ${base.key}, which is not present at ${backend.describe}`,
      )
    }
    const staged = join(scratch.staging, `base-${uuid8()}.part`)
    const archive = join(scratch.backups, `base-${uuid8()}.tar.gz`)
    await streamToVerifiedFile(stream, base, staged, archive, 'base checkpoint')
    try {
      await engine.restoreDatabase(db, archive)
    } catch (e) {
      // The gate already established that this engine is allowed to read the
      // object, so a RESTORE that fails anyway means the compatibility promise
      // was violated rather than that the engine hit an ordinary error. The
      // distinction is the caller's next move: upgrade the engine, or report a
      // core defect. Reporting it as a plain `engine` error hides both.
      throw new DurableEngineIncompatibleError(
        `durable: restoring base ${base.key} into ${JSON.stringify(db)} failed on chdb ` +
          `${running.version}. The archive was produced by ${head.engine.version} and the object ` +
          `declares min_reader ${head.engine.min_reader} at archive format ` +
          `${head.engine.backup_format}, so this restore was expected to be supported`,
        { cause: e, expected: head.engine.version, actual: running.version },
      )
    }
    await unlink(archive).catch(() => {})
  }

  await engine.useDatabase(db)

  let replayed = 0
  for (const [i, ref] of head.manifest.wal.entries()) {
    report({
      phase: 'replaying-wal',
      segment: i + 1,
      segments: head.manifest.wal.length,
      statements: replayed,
      key: ref.key,
    })
    const bytes = await backend.getBytes(ref.key)
    if (!bytes) {
      throw new DurableCorruptError(
        `durable: manifest names WAL segment ${ref.key}, which is not present at ${backend.describe}`,
      )
    }
    assertDigest(ref, digestOf(bytes), 'WAL segment')
    for (const sql of decodeWalSegment(bytes, ref.key)) {
      // Replay goes straight to the engine. Routing it back through the public
      // execute() would re-analyse statements core already accepted and, worse,
      // append every one of them to the WAL a second time.
      await engine.run(sql)
      replayed++
    }
  }
  report({ phase: 'ready', statementsReplayed: replayed })
}

/** Atomically create a cold object and take generation 1 in the same write. */
async function createCold(
  backend: DurableBackend,
  params: {
    database: string
    running: RunningEngine
    instance: string
    owner: string
    tuning: DurableTuning
    id: string
  },
): Promise<{ head: DurableHead; etag: string; raw: Record<string, unknown> }> {
  const head = coldHead(params.database, params.running.version, params.running.backupFormat)
  head.lease = {
    generation: 1,
    owner: params.owner,
    instance: params.instance,
    expires_at: (nowMs() + params.tuning.leaseTtlMs) / 1000,
  }
  const outcome = await backend.putBytesIfAbsent(HEAD_KEY, serializeHead(head))

  if (outcome === 'created') {
    const fresh = await readHead(backend)
    if (!fresh) {
      throw new DurableCorruptError(
        `durable: created ${HEAD_KEY} at ${backend.describe} but it cannot be read back`,
      )
    }
    return fresh
  }

  // Lost the race, or the response was lost. Either way the answer is in the
  // object: if the head that is there names this instance, the create landed.
  const fresh = await readHead(backend)
  if (!fresh) {
    throw new DurableCommitAmbiguousError(
      `durable: could not determine whether object ${params.id} was created at ${backend.describe}`,
      { key: HEAD_KEY },
    )
  }
  if (fresh.head.lease.instance === params.instance) return fresh

  assertReadable(fresh.head)
  assertEngineCompatible(fresh.head, params.running)
  assertWritable(fresh.head)
  return acquireLease(backend, fresh, {
    instance: params.instance,
    owner: params.owner,
    tuning: params.tuning,
    force: false,
  })
}

/**
 * Take the writer lease by compare-and-swap.
 *
 * An unheld lease is free. A held one is only takeable once its recorded
 * expiry is behind us by more than the clock-skew allowance — the allowance is
 * there because the two writers' clocks are not the same clock, and a lease
 * that looks expired by a second might not be. Taking a lease that has not
 * expired is possible, but only as an explicit `force`, never as a retry.
 */
async function acquireLease(
  backend: DurableBackend,
  start: { head: DurableHead; etag: string; raw: Record<string, unknown> },
  params: { instance: string; owner: string; tuning: DurableTuning; force: boolean },
): Promise<{ head: DurableHead; etag: string; raw: Record<string, unknown> }> {
  let current = start
  const deadline = nowMs() + params.tuning.commitDeadlineMs

  for (let attempt = 1; ; attempt++) {
    const lease = current.head.lease
    if (lease.owner !== null && !params.force) {
      const expiresAtMs = (lease.expires_at ?? 0) * 1000
      const takeableAtMs = expiresAtMs + params.tuning.clockSkewAllowanceMs
      if (nowMs() < takeableAtMs) {
        throw new DurableLeaseHeldError(
          `durable: ${JSON.stringify(lease.owner)} holds the writer lease (generation ${lease.generation})`,
          { owner: lease.owner, expiresInSeconds: (expiresAtMs - nowMs()) / 1000 },
        )
      }
    }

    const generation = lease.generation + 1
    const candidate: DurableHead = {
      ...current.head,
      lease: {
        generation,
        owner: params.owner,
        instance: params.instance,
        expires_at: (nowMs() + params.tuning.leaseTtlMs) / 1000,
      },
    }
    const outcome = await backend.replaceIfMatch(
      HEAD_KEY,
      serializeHead(candidate, current.raw),
      current.etag,
    )
    if (outcome.status === 'replaced') {
      return { head: candidate, etag: outcome.etag, raw: current.raw }
    }

    const fresh = await readHead(backend)
    if (!fresh) {
      throw new DurableCorruptError(
        `durable: ${HEAD_KEY} disappeared from ${backend.describe} while taking the lease`,
      )
    }
    if (fresh.head.lease.instance === params.instance) return fresh

    if (attempt >= params.tuning.maxCommitAttempts || nowMs() >= deadline) {
      throw new DurableLeaseHeldError(
        `durable: could not take the writer lease after ${attempt} attempts; ` +
          `generation is now ${fresh.head.lease.generation}`,
        fresh.head.lease.owner !== null ? { owner: fresh.head.lease.owner } : undefined,
      )
    }
    current = fresh
  }
}

/** Best-effort lease release used when an open fails part-way through. */
async function releaseLease(
  backend: DurableBackend,
  held: { head: DurableHead; etag: string; raw: Record<string, unknown> },
  instance: string,
): Promise<void> {
  const fresh = await readHead(backend)
  if (!fresh || fresh.head.lease.instance !== instance) return
  const candidate: DurableHead = {
    ...fresh.head,
    lease: { generation: fresh.head.lease.generation, owner: null, instance: null, expires_at: null },
  }
  await backend.replaceIfMatch(HEAD_KEY, serializeHead(candidate, fresh.raw), fresh.etag)
}
