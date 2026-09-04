/**
 * Object key construction and validation (contract §4.1).
 *
 * Two separate jobs live here, and they are separate on purpose:
 *
 *  - *Minting* a key for something this writer is about to publish. Every
 *    attempt gets a fresh key, including a retry of an attempt that may have
 *    already landed. That is what makes an ambiguous upload resolvable rather
 *    than destructive — a retry can never overwrite the bytes the first try
 *    published (§5.8).
 *  - *Validating* a key read out of someone else's head. A reference is a
 *    relative key inside the object prefix, and nothing else. Rejecting `..`,
 *    absolute paths and empty segments here is what stops a hostile or broken
 *    head from steering a download outside the object — the local backend
 *    resolves keys against a directory, so a traversal would be a real escape.
 */

import { randomUUID } from 'crypto'
import { DurableCorruptError } from './errors'

/** First 8 hex digits of a UUID4, per the frozen key shape. */
export function uuid8(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

function decimal(n: number, what: string): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`durable: ${what} must be a non-negative safe integer, got ${n}`)
  }
  // No leading zeros: `String` on a safe integer never produces one.
  return String(n)
}

/** `checkpoints/<generation>-<seq>-<uuid8>.tar.gz` */
export function checkpointKey(generation: number, seq: number): string {
  return `checkpoints/${decimal(generation, 'generation')}-${decimal(seq, 'seq')}-${uuid8()}.tar.gz`
}

/** `wal/<generation>-<seq>-<uuid8>.jsonl` */
export function walKey(generation: number, seq: number): string {
  return `wal/${decimal(generation, 'generation')}-${decimal(seq, 'seq')}-${uuid8()}.jsonl`
}

/** The one mutable key in an object. */
export const HEAD_KEY = 'head.json'

/**
 * Accept only a relative, `/`-separated key with no empty, `.` or `..`
 * segments. Backslashes are rejected too: on a POSIX filesystem a backslash is
 * an ordinary character, so a key containing one would name a different file
 * here than it does on a provider that normalises it.
 */
export function isValidObjectKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0) return false
  if (key.startsWith('/') || key.includes('\\')) return false
  if (key.includes('\0')) return false
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

/** Validate a key that came out of a head, or refuse the object as corrupt. */
export function assertObjectKey(key: unknown, where: string): string {
  if (!isValidObjectKey(key)) {
    throw new DurableCorruptError(
      `durable: ${where} is not a valid relative object key: ${JSON.stringify(key)}`,
    )
  }
  return key
}

/**
 * Join a namespace prefix and an object id into the object prefix. Both are
 * validated as single path segments so an id cannot climb out of its
 * namespace.
 */
export function objectPrefix(objectId: string): string {
  if (
    typeof objectId !== 'string' ||
    objectId.length === 0 ||
    objectId.includes('/') ||
    objectId.includes('\\') ||
    objectId.includes('\0') ||
    objectId === '.' ||
    objectId === '..'
  ) {
    throw new RangeError(
      `durable: object id must be a single non-empty path segment, got ${JSON.stringify(objectId)}`,
    )
  }
  return objectId
}
