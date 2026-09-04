/**
 * Version and feature negotiation (contract §4.3) and engine identity
 * (§4.2).
 *
 * V1 uses named features rather than a monotonic minimum-version number. The
 * reason is that a monotonic number requires features to be linearly ordered,
 * and with several bindings developed in parallel they are not: a client can
 * implement B without A, and under a version floor it would be locked out of
 * an object that only ever used B. Delta Lake moved off version numbers onto
 * table features for exactly this.
 *
 * The asymmetry between the two lists is the whole point. An unknown
 * *reader* feature means bytes in this object cannot be interpreted, so the
 * object does not open at all. An unknown *writer* feature means only that
 * writing correctly requires something this build cannot do — reading is
 * still sound, so a read-only open is allowed and only the lease is refused.
 */

import { DurableEngineIncompatibleError, DurableProtocolUnsupportedError } from './errors'
import { compareEngineVersions } from './version'
import {
  ENGINE_NAME,
  KNOWN_READER_FEATURES,
  KNOWN_WRITER_FEATURES,
  PROTOCOL_VERSION,
  type DurableHead,
} from './types'

function unknown(features: readonly string[], known: readonly string[]): string[] {
  return features.filter((f) => !known.includes(f))
}

/**
 * Gate a read. Refuses a protocol version above this baseline, or any
 * unrecognised reader feature, naming the offenders so the operator knows
 * which build they need.
 */
export function assertReadable(head: DurableHead): void {
  if (head.protocol.version > PROTOCOL_VERSION) {
    throw new DurableProtocolUnsupportedError(
      `durable: object uses protocol version ${head.protocol.version}, this build implements ${PROTOCOL_VERSION}`,
      { version: head.protocol.version },
    )
  }
  const missing = unknown(head.protocol.reader_features, KNOWN_READER_FEATURES)
  if (missing.length > 0) {
    throw new DurableProtocolUnsupportedError(
      `durable: object requires reader features this build does not implement: ${missing.join(', ')}`,
      { features: missing },
    )
  }
}

/**
 * Gate taking the writer lease. Assumes {@link assertReadable} already passed;
 * this only adds the writer-side feature check.
 */
export function assertWritable(head: DurableHead): void {
  const missing = unknown(head.protocol.writer_features, KNOWN_WRITER_FEATURES)
  if (missing.length > 0) {
    throw new DurableProtocolUnsupportedError(
      `durable: object requires writer features this build does not implement: ${missing.join(', ')}; ` +
        `it can still be opened read-only`,
      { features: missing },
    )
  }
}

/** What the running engine can offer, for the compatibility gate. */
export interface RunningEngine {
  /** `chdb_version()` of the engine in this process. */
  version: string
  /** Highest archive-format generation this engine can restore. */
  backupFormat: number
}

/**
 * The frozen engine gate:
 *
 * ```text
 *   backup_format > reader baseline   -> engine_incompatible
 *   running_version < min_reader      -> engine_incompatible
 *   otherwise                         -> open
 * ```
 *
 * Note what is deliberately absent: a comparison against `engine.version`.
 * That field records which build produced the object, for diagnosis, and is
 * explicitly not a gate. An exact match would refuse every later release,
 * which is the opposite of what the compatibility promise says — a newer
 * chdb-core restores full backups made by an earlier one.
 *
 * The two checks guard different failures and neither subsumes the other.
 * `min_reader` catches a reader that is simply too old. `backup_format` is the
 * escape hatch for the day the promise itself is withdrawn: version numbers
 * keep increasing whether or not the format still works, so a broken format
 * needs its own signal, or a reader would compare a larger version, conclude
 * it is fine, and discover otherwise partway through RESTORE.
 */
export function assertEngineCompatible(head: DurableHead, running: RunningEngine): void {
  if (head.engine.name !== ENGINE_NAME) {
    throw new DurableEngineIncompatibleError(
      `durable: object was written by engine ${JSON.stringify(head.engine.name)}, not ${ENGINE_NAME}`,
      { expected: head.engine.name, actual: ENGINE_NAME },
    )
  }

  if (head.engine.backup_format > running.backupFormat) {
    throw new DurableEngineIncompatibleError(
      `durable: object uses archive format generation ${head.engine.backup_format}, and this ` +
        `engine restores up to ${running.backupFormat}. A newer chdb-core is required; the ` +
        `format generation only moves when older archives can no longer be restored`,
      { expected: String(head.engine.backup_format), actual: String(running.backupFormat) },
    )
  }

  if (compareEngineVersions(running.version, head.engine.min_reader) < 0) {
    throw new DurableEngineIncompatibleError(
      `durable: object requires chdb ${head.engine.min_reader} or later to read, and this ` +
        `process runs ${running.version} (written by ${head.engine.version})`,
      { expected: head.engine.min_reader, actual: running.version },
    )
  }
}
