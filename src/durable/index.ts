/**
 * `chdb/durable` — the pure-TypeScript Durable V1 control plane.
 *
 * Importing this module loads no native code. Not the chdb-node addon, not
 * `libchdb`, nothing that a second copy of an engine in the same process could
 * collide with. That is a hard requirement rather than a nicety: the first
 * downstream user of this package reaches `libchdb` through its own Bun FFI
 * bindings, and a control plane that quietly pulled in a second native runtime
 * would be unusable there.
 *
 * What arrives instead is an {@link EngineAdapter}: the caller supplies
 * something that can analyse, run, back up and restore, and this package
 * supplies everything above it — object layout, `head.json`, manifest, lease,
 * CAS, fencing, WAL, checkpoint orchestration and the frozen error categories.
 *
 * The protocol these implement is specified in `CHDB_DURABLE_V1_CONTRACT.md`
 * in the chdb repository, and that document — not this implementation — is the
 * source of truth. Semantics change there first.
 *
 * ```js
 * import { DurableNamespace } from 'chdb/durable'
 *
 * const ns = new DurableNamespace('file:///var/lib/chdb-durable', { engineFactory })
 * const obj = await ns.open('orders')
 *
 * const ticket = await obj.execute("INSERT INTO events VALUES (1, 'a')")
 * await obj.flushThrough(ticket)      // now it survives losing this machine
 * const rows = await obj.query('SELECT count() FROM events')
 * await obj.checkpoint()
 * await obj.close()                   // rejects if the final flush failed
 * ```
 */

export {
  DurableNamespace,
  registerBackendScheme,
  type BackendSchemeFactory,
  type DurableNamespaceOptions,
} from './namespace'

export {
  DurableObject,
  DEFAULT_TUNING,
  type DurableObjectDeps,
  type DurableOpenOptions,
  type DurableStats,
  type DurableTuning,
  type RestoreProgress,
  type QueryOptions,
  type WriteTicket,
} from './object'

export {
  QueryClass,
  assertExecuteAllowed,
  assertQueryAllowed,
  queryClassName,
  type EngineAdapter,
  type EngineFactory,
  type EngineStartOptions,
  type QueryAnalysis,
} from './engine-adapter'

export type {
  BackendFactory,
  DurableBackend,
  GetWithEtag,
  PutOutcome,
  ReplaceOutcome,
} from './backend'

export { LocalDurableBackend, type LocalBackendOptions } from './backends/local'

export {
  DurableError,
  DurableBackendError,
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
  DurableProtocolUnsupportedError,
  DurableSecretRefusedError,
  DurableTimeoutError,
  isDurableError,
  isDurableErrorOf,
  type DurableErrorCategory,
} from './errors'

export {
  BACKUP_FORMAT_BASELINE,
  ENGINE_NAME,
  KNOWN_READER_FEATURES,
  KNOWN_WRITER_FEATURES,
  LIMITS,
  PROTOCOL_VERSION,
  type DurableEngineIdentity,
  type DurableHead,
  type DurableLease,
  type DurableManifest,
  type DurableObjectRef,
  type DurableProtocol,
  type HeadSnapshot,
} from './types'

export { coldHead, parseHead, serializeHead } from './head'
export {
  assertEngineCompatible,
  assertReadable,
  assertWritable,
  type RunningEngine,
} from './negotiate'
export {
  compareEngineVersions,
  comparePrecedence,
  maxEngineVersion,
  parseEngineVersion,
  type ParsedEngineVersion,
} from './version'
export { decodeWalSegment, encodeWalSegment } from './wal'
export { HEAD_KEY, checkpointKey, isValidObjectKey, walKey } from './keys'
export { digestOf, sha256Hex } from './digest'
