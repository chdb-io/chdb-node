/**
 * Length and SHA-256 verification (contract §4.5).
 *
 * The contract requires both to be checked before a base is restored or a WAL
 * segment is parsed, and it requires checkpoint transfer not to hold the whole
 * archive in memory. So the streaming helper here does the two jobs in one
 * pass: it hashes and counts while it writes, then publishes the file to its
 * final name only once both match. A caller therefore never sees a scratch
 * path that holds unverified bytes.
 */

import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { rename, unlink } from 'fs/promises'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'
import { Transform } from 'stream'
import { DurableCorruptError } from './errors'
import type { DurableObjectRef } from './types'

export interface Digest {
  size: number
  sha256: string
}

/** Lowercase full SHA-256 hex of a buffer. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function digestOf(bytes: Uint8Array): Digest {
  return { size: bytes.byteLength, sha256: sha256Hex(bytes) }
}

/**
 * Compare an observed digest against a reference. Returns the mismatch reason
 * rather than throwing, because callers use it for two different things:
 * refusing a corrupt object, and deciding whether an upload whose response was
 * lost actually landed (§5.8) — where a mismatch is an answer, not a failure.
 */
export function digestMatches(ref: DurableObjectRef, observed: Digest): boolean {
  return ref.size === observed.size && ref.sha256 === observed.sha256
}

export function assertDigest(ref: DurableObjectRef, observed: Digest, what: string): void {
  if (ref.size !== observed.size) {
    throw new DurableCorruptError(
      `durable: ${what} (${ref.key}) has size ${observed.size}, head says ${ref.size}`,
    )
  }
  if (ref.sha256 !== observed.sha256) {
    throw new DurableCorruptError(
      `durable: ${what} (${ref.key}) sha256 ${observed.sha256} does not match head ${ref.sha256}`,
    )
  }
}

/** A pass-through that accumulates length and SHA-256 as bytes flow past. */
export function digestingStream(): Transform & { digest(): Digest } {
  const hash = createHash('sha256')
  let size = 0
  const t = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      size += chunk.length
      cb(null, chunk)
    },
  }) as Transform & { digest(): Digest }
  t.digest = () => ({ size, sha256: hash.digest('hex') })
  return t
}

/**
 * Stream `source` into `tmpPath`, verify it against `ref`, then atomically
 * publish it as `finalPath`. On any mismatch the scratch file is removed and
 * `finalPath` is never created, so a failed verify cannot leave behind
 * something a later step mistakes for a good archive.
 */
export async function streamToVerifiedFile(
  source: Readable,
  ref: DurableObjectRef,
  tmpPath: string,
  finalPath: string,
  what: string,
): Promise<Digest> {
  const counter = digestingStream()
  try {
    await pipeline(source, counter, createWriteStream(tmpPath))
  } catch (e) {
    await unlink(tmpPath).catch(() => {})
    throw e
  }
  const observed = counter.digest()
  try {
    assertDigest(ref, observed, what)
  } catch (e) {
    await unlink(tmpPath).catch(() => {})
    throw e
  }
  await rename(tmpPath, finalPath)
  return observed
}
