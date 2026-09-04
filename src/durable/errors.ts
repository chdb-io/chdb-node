/**
 * Durable V1 error model.
 *
 * The V1 contract freezes a set of error *categories* (contract §6) and
 * requires them to be programmatically distinguishable. It deliberately does
 * not freeze class names, so the categories live on `category` — a stable
 * string discriminator every binding shares — while the class hierarchy is
 * shaped the way the rest of this package shapes errors.
 *
 * Two rules the contract states explicitly and this file encodes:
 *
 *  1. A provider precondition failure (HTTP 412 and friends) is a CAS race
 *     first. It is resolved against lease/manifest state into `lease_held`,
 *     `lease_fenced` or a retry — never reported as a plain `backend` error.
 *     `DurableBackendError` is for the failures that are genuinely the
 *     provider's: network, auth, quota.
 *  2. Messages must not carry secret-bearing SQL, provider credentials or
 *     unredacted connection parameters. `secret_refused` in particular
 *     describes the refusal without echoing the statement that caused it.
 */

import { ChdbError, type ChdbErrorOptions } from '../errors'

/**
 * The frozen category set (contract §6). Cross-binding conformance asserts on
 * these strings, so they are the wire names, not prose.
 */
export type DurableErrorCategory =
  | 'not_found'
  | 'lease_held'
  | 'lease_fenced'
  | 'engine_incompatible'
  | 'protocol_unsupported'
  | 'corrupt'
  | 'classification_refused'
  | 'secret_refused'
  | 'engine'
  | 'backend'
  | 'timeout'
  | 'commit_ambiguous'
  | 'limit_exceeded'
  | 'closed'

export abstract class DurableError extends ChdbError {
  /** Frozen V1 category (contract §6). */
  abstract readonly category: DurableErrorCategory
  readonly code: string = 'CHDB_DURABLE'
}

/** Read-only open of an object that does not exist, or existing-only was required. */
export class DurableNotFoundError extends DurableError {
  readonly category = 'not_found'
  override readonly code = 'CHDB_DURABLE_NOT_FOUND'
}

/** Another writer holds an unexpired lease. */
export class DurableLeaseHeldError extends DurableError {
  readonly category = 'lease_held'
  override readonly code = 'CHDB_DURABLE_LEASE_HELD'

  /** Owner recorded on the live lease — observability only, never authority. */
  readonly owner?: string
  /** Seconds until the observed lease expires; negative once inside skew allowance. */
  readonly expiresInSeconds?: number

  constructor(
    message: string,
    options?: ChdbErrorOptions & { owner?: string; expiresInSeconds?: number },
  ) {
    super(message, options)
    if (options?.owner !== undefined) this.owner = options.owner
    if (options?.expiresInSeconds !== undefined) this.expiresInSeconds = options.expiresInSeconds
  }
}

/**
 * This instance no longer owns the generation/ETag it was writing under —
 * either a takeover happened, or heartbeat could not be confirmed inside the
 * locally believed validity window and the writer fenced itself (contract
 * §5.7). Both are unrecoverable for the object handle: it never writes again.
 */
export class DurableLeaseFencedError extends DurableError {
  readonly category = 'lease_fenced'
  override readonly code = 'CHDB_DURABLE_LEASE_FENCED'
}

/** The object records an engine version that is not exactly the running one. */
export class DurableEngineIncompatibleError extends DurableError {
  readonly category = 'engine_incompatible'
  override readonly code = 'CHDB_DURABLE_ENGINE_INCOMPATIBLE'

  readonly expected?: string
  readonly actual?: string

  constructor(message: string, options?: ChdbErrorOptions & { expected?: string; actual?: string }) {
    super(message, options)
    if (options?.expected !== undefined) this.expected = options.expected
    if (options?.actual !== undefined) this.actual = options.actual
  }
}

/** Protocol version above this baseline, or a feature name this build does not know. */
export class DurableProtocolUnsupportedError extends DurableError {
  readonly category = 'protocol_unsupported'
  override readonly code = 'CHDB_DURABLE_PROTOCOL_UNSUPPORTED'

  /** The unrecognised feature names, so the caller learns which ones blocked it. */
  readonly features?: readonly string[]
  readonly version?: number

  constructor(
    message: string,
    options?: ChdbErrorOptions & { features?: readonly string[]; version?: number },
  ) {
    super(message, options)
    if (options?.features !== undefined) this.features = options.features
    if (options?.version !== undefined) this.version = options.version
  }
}

/**
 * Head failed schema validation, a referenced immutable object is missing, or
 * its length/SHA-256 did not match. Never downgraded into "open an older
 * state": a corrupt object stays closed (contract §4.5).
 */
export class DurableCorruptError extends DurableError {
  readonly category = 'corrupt'
  override readonly code = 'CHDB_DURABLE_CORRUPT'
}

/**
 * Core query analysis refused the statement at a public entry point: wrong
 * statement count, wrong class, or a write outside the object's database
 * (contract §3.4). The message states which fact failed, never the SQL.
 */
export class DurableClassificationRefusedError extends DurableError {
  readonly category = 'classification_refused'
  override readonly code = 'CHDB_DURABLE_CLASSIFICATION_REFUSED'
}

/**
 * A mutation carries a credential. It cannot be logged, and V1 has nowhere
 * else to put it, so it is refused outright. Kept apart from
 * `classification_refused` because the reason a caller must act on is
 * different: rewrite the statement to not embed a secret.
 */
export class DurableSecretRefusedError extends DurableError {
  readonly category = 'secret_refused'
  override readonly code = 'CHDB_DURABLE_SECRET_REFUSED'
}

/** A core query, backup or restore failed. */
export class DurableEngineError extends DurableError {
  readonly category = 'engine'
  override readonly code = 'CHDB_DURABLE_ENGINE'
}

/** Provider network, auth or non-conditional failure. Never a CAS conflict. */
export class DurableBackendError extends DurableError {
  readonly category = 'backend'
  override readonly code = 'CHDB_DURABLE_BACKEND'
}

/** Deadline passed while the operation was provably still uncommitted. */
export class DurableTimeoutError extends DurableError {
  readonly category = 'timeout'
  override readonly code = 'CHDB_DURABLE_TIMEOUT'
}

/**
 * Reconcile could not prove whether the remote committed (contract §5.8).
 * The one thing this must never do is report success: a caller that treats
 * ambiguity as failure and retries is safe, one told "committed" is not.
 */
export class DurableCommitAmbiguousError extends DurableError {
  readonly category = 'commit_ambiguous'
  override readonly code = 'CHDB_DURABLE_COMMIT_AMBIGUOUS'

  /** The unique key whose commit state could not be settled, for operator triage. */
  readonly key?: string

  constructor(message: string, options?: ChdbErrorOptions & { key?: string }) {
    super(message, options)
    if (options?.key !== undefined) this.key = options.key
  }
}

/** SQL, WAL segment, head or provider object exceeded a declared V1 limit. */
export class DurableLimitExceededError extends DurableError {
  readonly category = 'limit_exceeded'
  override readonly code = 'CHDB_DURABLE_LIMIT_EXCEEDED'

  readonly limit?: number
  readonly actual?: number

  constructor(message: string, options?: ChdbErrorOptions & { limit?: number; actual?: number }) {
    super(message, options)
    if (options?.limit !== undefined) this.limit = options.limit
    if (options?.actual !== undefined) this.actual = options.actual
  }
}

/** Operation on an object whose close already completed. */
export class DurableClosedError extends DurableError {
  readonly category = 'closed'
  override readonly code = 'CHDB_DURABLE_CLOSED'
}

/** Type guard for the whole durable hierarchy. */
export function isDurableError(value: unknown): value is DurableError {
  return value instanceof DurableError
}

/**
 * Narrow by frozen category. Conformance suites and callers that branch on the
 * contract's categories use this rather than `instanceof`, so an implementation
 * is free to add subclasses without breaking them.
 */
export function isDurableErrorOf(value: unknown, category: DurableErrorCategory): boolean {
  return isDurableError(value) && value.category === category
}
