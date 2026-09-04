/**
 * `head.json` parsing, strict validation and unknown-field-preserving
 * write-back (contract §4.2, §4.3, §4.5).
 *
 * The single most important thing this file does is *not* rebuild the head
 * from scratch on every write. A writer that constructs a fresh object each
 * time silently deletes every field it does not know about, which turns the
 * whole named-feature mechanism into a lie: a future revision's state would
 * survive exactly until an older writer touched the object. So the parsed raw
 * JSON is carried alongside the typed view, and {@link serializeHead} patches
 * the known fields onto a clone of it.
 *
 * The second thing is that "preserve unknown fields" is not "be lenient".
 * Known fields are validated strictly — wrong types are `corrupt`, not
 * best-effort coercions — because a head that does not mean what it says is
 * more dangerous than one that fails to load.
 */

import { DurableCorruptError, DurableLimitExceededError } from './errors'
import { assertObjectKey } from './keys'
import {
  BACKUP_FORMAT_BASELINE,
  ENGINE_NAME,
  LIMITS,
  PROTOCOL_VERSION,
  type DurableEngineIdentity,
  type DurableHead,
  type DurableLease,
  type DurableManifest,
  type DurableObjectRef,
  type DurableProtocol,
} from './types'

const SHA256_HEX = /^[0-9a-f]{64}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function corrupt(what: string): never {
  throw new DurableCorruptError(`durable: head.json ${what}`)
}

function safeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    corrupt(`${where} must be a non-negative safe integer`)
  }
  return value
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupt(`${where} must be a non-empty string`)
  return value
}

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    corrupt(`${where} must be an array of strings`)
  }
  return value as string[]
}

function parseRef(value: unknown, where: string): DurableObjectRef {
  if (!isPlainObject(value)) corrupt(`${where} must be an object`)
  return {
    key: assertObjectKey(value['key'], `head.json ${where}.key`),
    size: safeInt(value['size'], `${where}.size`),
    sha256: (() => {
      const s = value['sha256']
      if (typeof s !== 'string' || !SHA256_HEX.test(s)) {
        corrupt(`${where}.sha256 must be 64 lowercase hex characters`)
      }
      return s
    })(),
  }
}

/**
 * A missing `protocol` block reads as the V1 baseline with no features. That
 * is the documented default rather than a rejection so that objects written
 * before the block existed stay readable; every other shape of `protocol` is
 * validated strictly.
 */
function parseProtocol(value: unknown): DurableProtocol {
  if (value === undefined) {
    return { version: PROTOCOL_VERSION, reader_features: [], writer_features: [] }
  }
  if (!isPlainObject(value)) corrupt('protocol must be an object')
  return {
    version: safeInt(value['version'] ?? PROTOCOL_VERSION, 'protocol.version'),
    reader_features: stringArray(value['reader_features'] ?? [], 'protocol.reader_features'),
    writer_features: stringArray(value['writer_features'] ?? [], 'protocol.writer_features'),
  }
}

/**
 * `engine` itself has no default — a head that records no engine cannot
 * establish compatibility at all, so an absent block is a refusal rather than
 * a wildcard.
 *
 * The two compatibility fields do have defaults, and both are chosen to be the
 * conservative reading of an object written before they existed:
 *
 *  - `backup_format` defaults to the V1 baseline, which is what such an object
 *    necessarily used.
 *  - `min_reader` defaults to `version`. That reproduces the old exact-match
 *    behaviour's lower bound: only a reader at or above the producer may open
 *    it. Defaulting it to something older would retroactively widen an object's
 *    audience on the strength of a field its writer never wrote.
 */
function parseEngine(value: unknown): DurableEngineIdentity {
  if (!isPlainObject(value)) corrupt('engine must be an object')
  const version = nonEmptyString(value['version'], 'engine.version')
  return {
    name: nonEmptyString(value['name'], 'engine.name'),
    version,
    backup_format: safeInt(value['backup_format'] ?? BACKUP_FORMAT_BASELINE, 'engine.backup_format'),
    min_reader: nonEmptyString(value['min_reader'] ?? version, 'engine.min_reader'),
  }
}

/**
 * The lease is either fully held or fully released. A partial form — an owner
 * with no expiry, an expiry with no instance — is rejected rather than
 * normalised, because each half implies a different answer to "may I take
 * this over", and guessing is how two writers end up believing they are the
 * one writer.
 */
function parseLease(value: unknown): DurableLease {
  if (!isPlainObject(value)) corrupt('lease must be an object')
  const generation = safeInt(value['generation'], 'lease.generation')
  const owner = value['owner'] ?? null
  const instance = value['instance'] ?? null
  const expiresAt = value['expires_at'] ?? null

  const released = owner === null && instance === null && expiresAt === null
  if (released) return { generation, owner: null, instance: null, expires_at: null }

  if (typeof owner !== 'string' || typeof instance !== 'string' || typeof expiresAt !== 'number') {
    corrupt(
      'lease must be either fully released (owner, instance and expires_at all null) ' +
        'or fully held (owner and instance strings, expires_at a number)',
    )
  }
  if (!Number.isFinite(expiresAt)) corrupt('lease.expires_at must be finite')
  return { generation, owner, instance, expires_at: expiresAt }
}

function parseManifest(value: unknown): DurableManifest {
  if (!isPlainObject(value)) corrupt('manifest must be an object')
  const base = value['base'] ?? null
  const wal = value['wal'] ?? []
  if (!Array.isArray(wal)) corrupt('manifest.wal must be an array')
  return {
    db: nonEmptyString(value['db'], 'manifest.db'),
    base: base === null ? null : parseRef(base, 'manifest.base'),
    wal: wal.map((ref, i) => parseRef(ref, `manifest.wal[${i}]`)),
    seq: safeInt(value['seq'], 'manifest.seq'),
  }
}

/** Parse and strictly validate head bytes, keeping the raw JSON for round-trip. */
export function parseHead(bytes: Uint8Array): { head: DurableHead; raw: Record<string, unknown> } {
  if (bytes.byteLength > LIMITS.MAX_HEAD_BYTES) {
    throw new DurableLimitExceededError(
      `durable: head.json is ${bytes.byteLength} bytes, over the V1 limit of ${LIMITS.MAX_HEAD_BYTES}`,
      { limit: LIMITS.MAX_HEAD_BYTES, actual: bytes.byteLength },
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (e) {
    throw new DurableCorruptError(`durable: head.json is not valid UTF-8 JSON`, { cause: e })
  }
  if (!isPlainObject(raw)) corrupt('must be a JSON object')
  return {
    head: {
      protocol: parseProtocol(raw['protocol']),
      engine: parseEngine(raw['engine']),
      lease: parseLease(raw['lease']),
      manifest: parseManifest(raw['manifest']),
    },
    raw,
  }
}

/**
 * Patch the known fields of `head` onto a clone of `raw`, so anything this
 * build does not recognise — at the top level or inside protocol, engine,
 * lease and manifest — is written back untouched.
 *
 * `manifest.base` and `manifest.wal` are replaced wholesale rather than
 * merged: they are this build's own state, and a stale unknown key inside a
 * reference we are rewriting would describe bytes that are no longer there.
 */
export function serializeHead(head: DurableHead, raw?: Record<string, unknown>): Uint8Array {
  const base: Record<string, unknown> = raw ? structuredClone(raw) : {}

  const mergeInto = (key: string, known: Record<string, unknown>): void => {
    const existing = base[key]
    base[key] = isPlainObject(existing) ? { ...existing, ...known } : known
  }

  mergeInto('protocol', {
    version: head.protocol.version,
    reader_features: [...head.protocol.reader_features],
    writer_features: [...head.protocol.writer_features],
  })
  mergeInto('engine', {
    name: head.engine.name,
    version: head.engine.version,
    backup_format: head.engine.backup_format,
    min_reader: head.engine.min_reader,
  })
  mergeInto('lease', {
    generation: head.lease.generation,
    owner: head.lease.owner,
    instance: head.lease.instance,
    expires_at: head.lease.expires_at,
  })
  mergeInto('manifest', {
    db: head.manifest.db,
    base: head.manifest.base === null ? null : { ...head.manifest.base },
    wal: head.manifest.wal.map((r) => ({ ...r })),
    seq: head.manifest.seq,
  })

  const bytes = Buffer.from(JSON.stringify(base), 'utf8')
  if (bytes.byteLength > LIMITS.MAX_HEAD_BYTES) {
    throw new DurableLimitExceededError(
      `durable: head.json would be ${bytes.byteLength} bytes, over the V1 limit of ` +
        `${LIMITS.MAX_HEAD_BYTES}; checkpoint to truncate the WAL list`,
      { limit: LIMITS.MAX_HEAD_BYTES, actual: bytes.byteLength },
    )
  }
  return bytes
}

/**
 * The head a cold object starts from: no base, no WAL, generation 1. The
 * creating writer fills the lease in before publishing, because cold create and
 * lease acquisition are one conditional write (contract §5.2) — publishing an
 * unheld head first would leave a window where a second process could take a
 * lease on a manifest nobody has restored into yet.
 */
export function coldHead(
  db: string,
  engineVersion: string,
  backupFormat: number = BACKUP_FORMAT_BASELINE,
): DurableHead {
  return {
    protocol: { version: PROTOCOL_VERSION, reader_features: [], writer_features: [] },
    engine: {
      name: ENGINE_NAME,
      version: engineVersion,
      backup_format: backupFormat,
      // A fresh object can only be read by this engine or later: its base will
      // be produced by this engine.
      min_reader: engineVersion,
    },
    lease: { generation: 1, owner: null, instance: null, expires_at: null },
    manifest: { db, base: null, wal: [], seq: 0 },
  }
}
