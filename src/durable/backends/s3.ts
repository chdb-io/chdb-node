/**
 * S3-compatible durable backend — AWS S3, Cloudflare R2, MinIO.
 *
 * This is the backend that makes the whole thing mean something. A local
 * directory cannot be a remote authority: when the machine holding it is gone,
 * so is the object. Recovering a database on a *different* machine needs the
 * head, the checkpoints and the WAL to live somewhere neither machine owns.
 *
 * It lives behind its own subpath (`chdb/durable/s3`) and registers the `s3`
 * scheme as an import side effect, so `chdb/durable` on its own never pulls in
 * the AWS SDK. A caller that only uses the local backend should not have to
 * install several megabytes of it.
 *
 * ## Conditional writes are the whole contract
 *
 * The protocol needs a real atomic create and a real atomic compare-and-swap;
 * simulating either with a HEAD followed by a PUT is not a weaker version, it
 * is the bug the protocol exists to prevent. S3 provides both as preconditions
 * on `PutObject`:
 *
 * ```text
 *   putIfAbsent    ->  PUT with If-None-Match: *
 *   replaceIfMatch ->  PUT with If-Match: <etag>
 * ```
 *
 * A precondition failure is a CAS outcome, not a transport error, and it is
 * reported as one. Everything the state machine does with `already-exists` and
 * `not-replaced` depends on that distinction being made here rather than
 * upstream.
 *
 * ## Why the SDK's own retries are safe
 *
 * The SDK retries on its own, and a retry can turn a request that *did* land
 * into a precondition failure: the first `PutObject` succeeds, the response is
 * lost, the retry finds the object already there and gets a 412. So this
 * backend can report `already-exists` for an object it wrote itself, and
 * `not-replaced` for a CAS that actually committed.
 *
 * That is fine, and it is fine for a specific reason: nothing upstream decides
 * anything from the return code alone. An `already-exists` sends the object
 * layer to re-read that unique key and compare length and SHA-256; a
 * `not-replaced` sends it to re-read the head and look for its own intent with
 * its own lease still on it. Both resolve to the truth. A design that trusted
 * the status code would need retries disabled; this one does not.
 *
 * ## ETags stay opaque, and carry one assumption worth naming
 *
 * An S3 ETag is quoted, and it is only an MD5 for single-part uploads — not on
 * R2, not for multipart, not necessarily forever. It is stored and handed back
 * exactly as received and never parsed, which is what the contract requires.
 *
 * Being a content hash has a consequence that a version counter would not
 * have: writing *byte-identical* content does not advance the ETag, so the
 * token used for that write stays valid afterwards and a second racer holding
 * it can also win. Measured, not assumed — on both MinIO and AWS S3,
 * re-PUTting the same bytes under `If-Match` leaves the ETag unchanged.
 *
 * Durable is safe from this because every head write changes the bytes: a
 * lease acquisition moves the generation, a heartbeat moves `expires_at`, and
 * a flush or checkpoint moves `manifest.seq`. That is a real dependency rather
 * than a coincidence, so it is written down here: anything that makes a head
 * write idempotent at the byte level would break compare-and-swap on any
 * content-hash-ETag provider.
 *
 * ## V1 limits
 *
 * Single `PutObject` only, so an object caps at 5 GiB and a larger checkpoint
 * fails with `limit_exceeded` rather than silently truncating. Multipart upload
 * is the fix and is not here yet.
 */

import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import type { Readable } from 'stream'
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

import type { DurableBackend, GetWithEtag, PutOutcome, ReplaceOutcome } from '../backend'
import { DurableBackendError, DurableLimitExceededError } from '../errors'
import { isValidObjectKey } from '../keys'
import { registerBackendScheme } from '../namespace'

/** Ceiling for a single PutObject. Beyond this a checkpoint needs multipart. */
export const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024

export interface S3BackendOptions {
  bucket: string
  /** Key prefix for this object, without a leading slash. May be empty. */
  prefix?: string
  /** Pre-built client. Takes precedence over `clientConfig`. */
  client?: S3Client
  /** Passed to `new S3Client`. Credentials come from the default chain unless set. */
  clientConfig?: S3ClientConfig
}

interface AwsErrorish {
  name?: string
  Code?: string
  $metadata?: { httpStatusCode?: number }
  code?: string
  message?: string
}

function asAwsError(e: unknown): AwsErrorish {
  return (typeof e === 'object' && e !== null ? e : {}) as AwsErrorish
}

function statusOf(e: unknown): number | undefined {
  return asAwsError(e).$metadata?.httpStatusCode
}

/**
 * A precondition failed. S3 answers 412 for `If-Match` and for an
 * `If-None-Match: *` against an object that already exists; a race between two
 * conditional writes can also surface as 409 `ConditionalRequestConflict`.
 * Both mean the same thing to the protocol: someone else got there first.
 */
function isPreconditionFailure(e: unknown): boolean {
  const err = asAwsError(e)
  const status = statusOf(e)
  if (status === 412 || status === 409) return true
  return err.name === 'PreconditionFailed' || err.name === 'ConditionalRequestConflict'
}

function isNotFound(e: unknown): boolean {
  const err = asAwsError(e)
  const status = statusOf(e)
  return status === 404 || err.name === 'NoSuchKey' || err.name === 'NotFound'
}

/**
 * Could the request have been committed?
 *
 * The distinction is the difference between a retry and a `commit_ambiguous`.
 * A timeout or a reset connection may have reached the service; a refused
 * connection or an unresolvable host did not. Guessing "did not" when it did
 * is how a caller ends up publishing twice, so anything genuinely in doubt
 * counts as in doubt.
 */
function isAmbiguous(e: unknown): boolean {
  const err = asAwsError(e)
  const status = statusOf(e)
  if (status !== undefined && status >= 500) return true
  const code = err.code ?? err.name ?? ''
  return (
    code === 'TimeoutError' ||
    code === 'RequestTimeout' ||
    code === 'RequestTimeTooSkewed' ||
    code === 'AbortError' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED'
  )
}

/**
 * Wrap a provider failure without leaking anything sensitive. Only the error's
 * name and status are carried into the message; the original hangs off
 * `.cause` for a caller that wants it, and credentials never appear in either.
 */
function backendError(what: string, describe: string, e: unknown): DurableBackendError {
  const err = asAwsError(e)
  const status = statusOf(e)
  const detail = [err.name ?? err.code, status !== undefined ? `HTTP ${status}` : undefined]
    .filter(Boolean)
    .join(', ')
  return new DurableBackendError(
    `durable: ${what} failed against ${describe}${detail ? ` (${detail})` : ''}`,
    { cause: e },
  )
}

export class S3DurableBackend implements DurableBackend {
  readonly describe: string
  private readonly client: S3Client
  private readonly bucket: string
  private readonly prefix: string

  constructor(options: S3BackendOptions) {
    if (!options.bucket) throw new RangeError('durable: S3 backend requires a bucket')
    this.bucket = options.bucket
    this.prefix = options.prefix ? options.prefix.replace(/^\/+|\/+$/g, '') : ''
    this.client = options.client ?? new S3Client(options.clientConfig ?? {})
    // Never the endpoint's credentials, and never a presigned anything: this
    // string ends up in error messages and logs.
    this.describe = `s3://${this.bucket}/${this.prefix}`
  }

  private keyFor(key: string): string {
    if (!isValidObjectKey(key)) {
      throw new DurableBackendError(`durable: refusing to resolve invalid key ${JSON.stringify(key)}`)
    }
    return this.prefix ? `${this.prefix}/${key}` : key
  }

  async getBytes(key: string): Promise<Uint8Array | undefined> {
    const got = await this.getBytesWithEtag(key)
    return got?.bytes
  }

  async getBytesWithEtag(key: string): Promise<GetWithEtag | undefined> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }),
      )
      if (!out.Body) return undefined
      const bytes = await out.Body.transformToByteArray()
      // An absent ETag would leave nothing to compare-and-swap against, so it
      // is a hard failure rather than an empty token that silently never
      // matches.
      if (!out.ETag) {
        throw new DurableBackendError(
          `durable: ${key} came back from ${this.describe} without an ETag; ` +
            `this provider cannot support compare-and-swap`,
        )
      }
      return { bytes, etag: out.ETag }
    } catch (e) {
      if (isNotFound(e)) return undefined
      if (e instanceof DurableBackendError) throw e
      throw backendError(`reading ${key}`, this.describe, e)
    }
  }

  async openReadStream(key: string): Promise<Readable | undefined> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }),
      )
      if (!out.Body) return undefined
      // Under Node the SDK hands back a Readable; the union also covers the
      // web stream and Blob shapes that only appear in other runtimes.
      return out.Body as unknown as Readable
    } catch (e) {
      if (isNotFound(e)) return undefined
      throw backendError(`opening ${key}`, this.describe, e)
    }
  }

  async putBytesIfAbsent(key: string, bytes: Uint8Array): Promise<PutOutcome> {
    this.assertWithinSinglePut(key, bytes.byteLength)
    return this.conditionalPut(key, {
      Body: bytes,
      ContentLength: bytes.byteLength,
      IfNoneMatch: '*',
    })
  }

  async putFileIfAbsent(key: string, localPath: string): Promise<PutOutcome> {
    const size = (await stat(localPath)).size
    this.assertWithinSinglePut(key, size)
    // ContentLength is not optional here: with a stream body and no length the
    // SDK cannot produce the signature S3 wants, and the upload fails at the
    // edge rather than here.
    return this.conditionalPut(key, {
      Body: createReadStream(localPath),
      ContentLength: size,
      IfNoneMatch: '*',
    })
  }

  async replaceIfMatch(key: string, bytes: Uint8Array, etag: string): Promise<ReplaceOutcome> {
    this.assertWithinSinglePut(key, bytes.byteLength)
    try {
      const out = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.keyFor(key),
          Body: bytes,
          ContentLength: bytes.byteLength,
          IfMatch: etag,
        }),
      )
      if (!out.ETag) {
        // The write landed but the new token is unknown, so the next CAS has
        // nothing to present. Re-reading is the honest way out.
        return { status: 'ambiguous' }
      }
      return { status: 'replaced', etag: out.ETag }
    } catch (e) {
      if (isPreconditionFailure(e)) return { status: 'not-replaced' }
      if (isAmbiguous(e)) return { status: 'ambiguous' }
      throw backendError(`replacing ${key}`, this.describe, e)
    }
  }

  private async conditionalPut(
    key: string,
    input: Omit<ConstructorParameters<typeof PutObjectCommand>[0], 'Bucket' | 'Key'>,
  ): Promise<PutOutcome> {
    try {
      await this.client.send(
        new PutObjectCommand({ ...input, Bucket: this.bucket, Key: this.keyFor(key) }),
      )
      return 'created'
    } catch (e) {
      if (isPreconditionFailure(e)) return 'already-exists'
      if (isAmbiguous(e)) return 'ambiguous'
      throw backendError(`creating ${key}`, this.describe, e)
    }
  }

  private assertWithinSinglePut(key: string, size: number): void {
    if (size > MAX_SINGLE_PUT_BYTES) {
      throw new DurableLimitExceededError(
        `durable: ${key} is ${size} bytes, over the ${MAX_SINGLE_PUT_BYTES}-byte ceiling for a ` +
          `single PutObject; multipart upload is not implemented yet, so checkpoint more often ` +
          `or reduce the database`,
        { limit: MAX_SINGLE_PUT_BYTES, actual: size },
      )
    }
  }
}

/**
 * `s3://<bucket>/<prefix>?region=&endpoint=&forcePathStyle=`
 *
 * The query parameters are what make one implementation serve three providers:
 *
 * ```text
 *   AWS     s3://my-bucket/durable?region=eu-west-1
 *   R2      s3://my-bucket/durable?region=auto&endpoint=https://<id>.r2.cloudflarestorage.com
 *   MinIO   s3://my-bucket/durable?region=us-east-1&endpoint=http://127.0.0.1:9000&forcePathStyle=true
 * ```
 *
 * Credentials are deliberately not among them. They come from the environment
 * or the standard credential chain, because a namespace URL is the sort of
 * thing that gets logged, put in a config file and pasted into an issue.
 */
registerBackendScheme('s3', (url, objectId) => {
  const bucket = url.hostname
  if (!bucket) throw new RangeError(`durable: s3 namespace URL needs a bucket: ${url.href}`)

  const basePrefix = url.pathname.replace(/^\/+|\/+$/g, '')
  const prefix = basePrefix ? `${basePrefix}/${objectId}` : objectId

  const region = url.searchParams.get('region') ?? undefined
  const endpoint = url.searchParams.get('endpoint') ?? undefined
  const forcePathStyle = url.searchParams.get('forcePathStyle') === 'true'

  const clientConfig: S3ClientConfig = {}
  if (region) clientConfig.region = region
  if (endpoint) clientConfig.endpoint = endpoint
  if (forcePathStyle) clientConfig.forcePathStyle = true

  return new S3DurableBackend({ bucket, prefix, clientConfig })
})
