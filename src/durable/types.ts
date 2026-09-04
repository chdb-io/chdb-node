/**
 * The frozen wire types of Durable V1 (contract §4).
 *
 * Everything here is `[FROZEN]`: another binding has to be able to read what
 * this one writes. The JSON is compared semantically, not byte for byte — key
 * order and whitespace are free — but field names, types and meanings are not.
 */

/** Protocol baseline this build implements. Higher in a head means "do not open". */
export const PROTOCOL_VERSION = 1

/**
 * V1 defines no non-empty feature names. Anything appearing in a head's
 * feature lists is therefore from a future revision, and the negotiation rules
 * (contract §4.3) apply: unknown reader feature refuses the open outright,
 * unknown writer feature still permits a read-only open.
 */
export const KNOWN_READER_FEATURES: readonly string[] = []
export const KNOWN_WRITER_FEATURES: readonly string[] = []

/** Engine name recorded in `head.engine.name`. */
export const ENGINE_NAME = 'chdb'

/**
 * Archive-format generation this build understands. V1's baseline is 1.
 *
 * It exists to be the one explicit signal that the backward-compatibility
 * promise has been withdrawn: core increments it when a later release can no
 * longer restore earlier full backups, and a reader refuses anything above its
 * own baseline. Without it, a reader compares version numbers, sees a larger
 * one, and walks into a RESTORE that fails halfway through recovery.
 *
 * The running engine's own value is not yet available — the C ABI exposes no
 * accessor — so an adapter may report it through the optional
 * `EngineAdapter.backupFormat()` and everything else falls back to this.
 */
export const BACKUP_FORMAT_BASELINE = 1

export interface DurableProtocol {
  version: number
  reader_features: string[]
  writer_features: string[]
}

export interface DurableEngineIdentity {
  name: string
  /**
   * `chdb_version()` of the writer that last touched the object. Recorded for
   * diagnosis and audit; it is explicitly **not** the compatibility gate.
   */
  version: string
  /** Archive-format generation. A reader refuses anything above its baseline. */
  backup_format: number
  /**
   * Oldest chdb release that may read the current state. A reader older than
   * this is refused; anything at or above it opens.
   */
  min_reader: string
}

/**
 * A reference to an immutable object. The size and digest are not decoration:
 * base and WAL are verified against both before anything is restored or
 * replayed, and they are what makes an ambiguous upload resolvable (§5.8).
 */
export interface DurableObjectRef {
  /** Key relative to `<namespace>/<object-id>/`, `/`-separated, no leading slash. */
  key: string
  size: number
  /** Lowercase full SHA-256 hex. */
  sha256: string
}

/**
 * Writer lease. A released lease is the all-null form — owner, instance and
 * expiry absent while the generation stays, so the next acquirer knows what to
 * increment past.
 */
export interface DurableLease {
  generation: number
  /** Human-visible name. Observability only; never an authority check. */
  owner: string | null
  /** Identifies one live instance. This, with the generation, is the fence. */
  instance: string | null
  /** Epoch seconds, fractional allowed. */
  expires_at: number | null
}

export interface DurableManifest {
  /** The one database this object holds. */
  db: string
  base: DurableObjectRef | null
  /** Ordered by replay order. */
  wal: DurableObjectRef[]
  seq: number
}

/**
 * The typed view of `head.json`. Unknown fields are not represented here —
 * they are preserved separately by {@link ParsedHead}, because dropping them
 * would silently strip a future revision's state (contract §4.2, §4.3).
 */
export interface DurableHead {
  protocol: DurableProtocol
  engine: DurableEngineIdentity
  lease: DurableLease
  manifest: DurableManifest
}

/** A head as read from the backend: the typed view plus its CAS token. */
export interface HeadSnapshot {
  head: DurableHead
  /** Opaque backend CAS token. Never parsed, never assumed to be an MD5. */
  etag: string
  /** The raw parsed JSON, kept so unknown fields survive a write-back. */
  raw: Record<string, unknown>
}

/** Frozen V1 limits (contract §4.4, §4.5). */
export const LIMITS = {
  /** One statement, UTF-8 bytes. */
  MAX_SQL_BYTES: 64 * 1024 * 1024,
  /** One uncompressed WAL segment, bytes. */
  MAX_WAL_SEGMENT_BYTES: 128 * 1024 * 1024,
  /** `head.json`, bytes. */
  MAX_HEAD_BYTES: 1024 * 1024,
} as const
