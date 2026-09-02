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

/**
 * V1 pins the engine exactly. A full `BACKUP DATABASE` archive is an engine
 * artefact, and there is no negotiated compatibility matrix yet, so "close
 * enough" would mean restoring an archive into a build that has never been
 * tested against it. Cross-version restore is V2 work (contract §8.1).
 */
export function assertEngineMatches(head: DurableHead, runningVersion: string): void {
  if (head.engine.name !== ENGINE_NAME) {
    throw new DurableEngineIncompatibleError(
      `durable: object was written by engine ${JSON.stringify(head.engine.name)}, not ${ENGINE_NAME}`,
      { expected: head.engine.name, actual: ENGINE_NAME },
    )
  }
  if (head.engine.version !== runningVersion) {
    throw new DurableEngineIncompatibleError(
      `durable: object requires chdb ${head.engine.version}, this process runs ${runningVersion}`,
      { expected: head.engine.version, actual: runningVersion },
    )
  }
}
