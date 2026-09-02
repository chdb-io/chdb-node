/**
 * The object-storage contract every durable backend must satisfy
 * (contract §5.1).
 *
 * The shape is small on purpose. Only two properties are load-bearing, and
 * both are properties a provider either has or does not:
 *
 *  1. **Real conditional operations.** `putIfAbsent` must be an atomic
 *     create and `replaceIfMatch` an atomic compare-and-swap. Simulating
 *     either with a read followed by a write is not a weaker implementation,
 *     it is a broken one: the window between the two is exactly where two
 *     writers both conclude they are the only writer.
 *  2. **Streaming.** A checkpoint is a full database archive. Requiring it to
 *     pass through a JavaScript `Buffer` puts a ceiling on database size that
 *     has nothing to do with the database. So checkpoints move as files and
 *     streams; only the head and WAL segments — both bounded by the protocol —
 *     move as bytes.
 *
 * A third property is expressed in the return types rather than the methods:
 * every mutating call can answer `'ambiguous'`. A request whose response was
 * lost is not a failure, and reporting it as one would make a caller retry a
 * commit that already happened. The state machine resolves ambiguity by
 * re-reading (§5.8), which is only possible if the backend admits it.
 *
 * `delete_prefix` is absent by design: V1 has no destroy and no GC, so nothing
 * in the protocol has the authority to remove an object (contract §8.1 item 4).
 */

import type { Readable } from 'stream'

/** Outcome of a conditional create. */
export type PutOutcome =
  | 'created'
  /** The key already exists. For a unique key this means *we* created it earlier. */
  | 'already-exists'
  /** The request may or may not have landed; the caller must re-read to find out. */
  | 'ambiguous'

/** Outcome of a conditional replace. */
export type ReplaceOutcome =
  | { status: 'replaced'; etag: string }
  /** The stored ETag no longer matches: someone else wrote first. */
  | { status: 'not-replaced' }
  | { status: 'ambiguous' }

export interface GetWithEtag {
  bytes: Uint8Array
  /** Opaque CAS token. Never parsed; never assumed to be a content digest. */
  etag: string
}

export interface DurableBackend {
  /**
   * Human-readable location of the object prefix, for logs and errors. Must
   * never contain credentials.
   */
  readonly describe: string

  /** Read a whole object. `undefined` when the key does not exist. */
  getBytes(key: string): Promise<Uint8Array | undefined>

  /** Read a whole object with its CAS token. */
  getBytesWithEtag(key: string): Promise<GetWithEtag | undefined>

  /**
   * Open a byte stream for a potentially large object. `undefined` when the
   * key does not exist. Used for checkpoint download so the archive never has
   * to be resident.
   */
  openReadStream(key: string): Promise<Readable | undefined>

  /** Atomically create from bytes. Never overwrites. */
  putBytesIfAbsent(key: string, bytes: Uint8Array): Promise<PutOutcome>

  /** Atomically create by uploading a local file. Never overwrites. */
  putFileIfAbsent(key: string, localPath: string): Promise<PutOutcome>

  /** Atomically replace only if the stored token still equals `etag`. */
  replaceIfMatch(key: string, bytes: Uint8Array, etag: string): Promise<ReplaceOutcome>
}

/**
 * Creates a backend bound to one object prefix. A namespace owns the factory
 * and hands each object its own scoped backend, so no code below the namespace
 * can address a key outside its object.
 */
export type BackendFactory = (objectPrefix: string) => Promise<DurableBackend> | DurableBackend
