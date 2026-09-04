/**
 * S3-compatible provider conformance.
 *
 * The contract is explicit that a provider is not supported because it claims
 * S3 compatibility — it is supported because this suite passed against it
 * (contract §7.5). So the whole file is parameterised: point it at MinIO, at
 * real S3, or at R2, and it runs the same checks.
 *
 * ```sh
 * CHDB_DURABLE_S3_BUCKET=my-bucket \
 * CHDB_DURABLE_S3_ENDPOINT=http://127.0.0.1:9000 \
 * CHDB_DURABLE_S3_REGION=us-east-1 \
 * CHDB_DURABLE_S3_FORCE_PATH_STYLE=true \
 * AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *   npm run test:durable:s3
 * ```
 *
 * Without a bucket configured the file skips rather than fails, because the
 * rest of the durable suite has to stay runnable with no network.
 *
 * Two things are being checked, and the second matters more. The first is that
 * the six backend methods behave; the second is that a durable object written
 * through this provider on one "machine" comes back on another — a fresh
 * engine, a fresh scratch directory, nothing shared but the bucket. That is
 * the claim the whole feature makes, and it is only true if it is true here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID, createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

import { S3DurableBackend } from '../../src/durable/backends/s3'
import { DurableNamespace } from '../../src/durable/namespace'
import type { DurableObject } from '../../src/durable/object'
import { digestOf } from '../../src/durable/digest'
import { isDurableErrorOf } from '../../src/durable/errors'
import { FakeEngine } from './fakes'

const BUCKET = process.env['CHDB_DURABLE_S3_BUCKET']
const ENDPOINT = process.env['CHDB_DURABLE_S3_ENDPOINT']
const REGION = process.env['CHDB_DURABLE_S3_REGION'] ?? 'us-east-1'
const PATH_STYLE = process.env['CHDB_DURABLE_S3_FORCE_PATH_STYLE'] === 'true'

/** Everything this run writes goes under one prefix, so cleanup is exact. */
const RUN_PREFIX = `chdb-durable-test/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`

function clientConfig(): S3ClientConfig {
  const cfg: S3ClientConfig = { region: REGION }
  if (ENDPOINT) cfg.endpoint = ENDPOINT
  if (PATH_STYLE) cfg.forcePathStyle = true
  return cfg
}

const roots: string[] = []
const openObjects: DurableObject[] = []
let client: S3Client | undefined

describe.skipIf(!BUCKET)(`S3-compatible backend (${ENDPOINT ?? 'aws'})`, () => {
  beforeAll(() => {
    client = new S3Client(clientConfig())
  })

  afterAll(async () => {
    for (const o of openObjects.splice(0)) await o.close().catch(() => {})
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
    // The protocol has no destroy, but a test that leaves objects in someone's
    // bucket is a test that costs money. Cleanup is the suite's own business.
    if (!client) return
    let token: string | undefined
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: RUN_PREFIX, ContinuationToken: token }),
      )
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key as string }))
      if (keys.length > 0) {
        await client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }))
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    client.destroy()
  })

  function backend(name: string): S3DurableBackend {
    return new S3DurableBackend({
      bucket: BUCKET as string,
      prefix: `${RUN_PREFIX}/${name}-${randomUUID().slice(0, 8)}`,
      clientConfig: clientConfig(),
    })
  }

  describe('conditional operations', () => {
    it('creates once and refuses to overwrite', async () => {
      const be = backend('create')
      expect(await be.putBytesIfAbsent('wal/1-1-aaaaaaaa.jsonl', Buffer.from('first'))).toBe('created')
      expect(await be.putBytesIfAbsent('wal/1-1-aaaaaaaa.jsonl', Buffer.from('second'))).toBe(
        'already-exists',
      )
      expect(Buffer.from((await be.getBytes('wal/1-1-aaaaaaaa.jsonl'))!).toString()).toBe('first')
    })

    it('replaces only against the current token', async () => {
      const be = backend('replace')
      await be.putBytesIfAbsent('head.json', Buffer.from('{"v":0}'))
      const first = (await be.getBytesWithEtag('head.json'))!

      const ok = await be.replaceIfMatch('head.json', Buffer.from('{"v":1}'), first.etag)
      expect(ok.status).toBe('replaced')

      const stale = await be.replaceIfMatch('head.json', Buffer.from('{"v":2}'), first.etag)
      expect(stale.status).toBe('not-replaced')

      const now = (await be.getBytesWithEtag('head.json'))!
      expect(Buffer.from(now.bytes).toString()).toBe('{"v":1}')
      // The token moved, which is what makes the previous one stale.
      expect(now.etag).not.toBe(first.etag)
    })

    it('lets exactly one of many concurrent replacers win', async () => {
      const be = backend('race')
      await be.putBytesIfAbsent('head.json', Buffer.from('{"v":0}'))
      const { etag } = (await be.getBytesWithEtag('head.json'))!

      // Every racer writes content distinct from the current object and from
      // each other. That matters on a content-hash ETag: a racer that happened
      // to write the bytes already there would leave the token unmoved, and a
      // second racer holding it would also win — which is a property of the
      // ETag, not a compare-and-swap failure. See the ETag test below.
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          be.replaceIfMatch('head.json', Buffer.from(`{"v":${i + 1}}`), etag),
        ),
      )
      // A provider without real compare-and-swap fails here, and only here.
      expect(results.filter((r) => r.status === 'replaced')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'not-replaced')).toHaveLength(7)
    })

    it('does not advance the token when the bytes do not change', async () => {
      // Not a defect, and not something to work around — a consequence of the
      // ETag being a content hash. It is asserted so that the assumption
      // durable relies on stays visible: every head write must change the
      // bytes, or the token it was written under remains usable.
      const be = backend('idempotent')
      await be.putBytesIfAbsent('head.json', Buffer.from('{"v":0}'))
      const first = (await be.getBytesWithEtag('head.json'))!

      const same = await be.replaceIfMatch('head.json', Buffer.from('{"v":0}'), first.etag)
      expect(same.status).toBe('replaced')
      const after = (await be.getBytesWithEtag('head.json'))!
      expect(after.etag).toBe(first.etag)

      // The original token still matches, because nothing about the object moved.
      const again = await be.replaceIfMatch('head.json', Buffer.from('{"v":1}'), first.etag)
      expect(again.status).toBe('replaced')
      // Different bytes, so now it does move.
      expect((await be.getBytesWithEtag('head.json'))!.etag).not.toBe(first.etag)
    })

    it('reports a missing key rather than throwing', async () => {
      const be = backend('missing')
      expect(await be.getBytes('wal/nope.jsonl')).toBeUndefined()
      expect(await be.getBytesWithEtag('head.json')).toBeUndefined()
      expect(await be.openReadStream('checkpoints/nope.tar.gz')).toBeUndefined()
    })

    it('refuses a key that would escape the object prefix', async () => {
      const be = backend('escape')
      await expect(be.getBytes('../escape')).rejects.toThrow(/invalid key/)
    })
  })

  describe('large objects', () => {
    it('streams a file up and back down with its digest intact', async () => {
      const be = backend('stream')
      const dir = await mkdtemp(join(tmpdir(), 'durable-s3-'))
      roots.push(dir)

      // Big enough that buffering it would be visible, small enough to be
      // polite to a real bucket.
      const payload = Buffer.alloc(12 * 1024 * 1024)
      for (let i = 0; i < payload.length; i += 4096) payload.writeUInt32BE(i, i)
      const path = join(dir, 'checkpoint.tar.gz')
      await writeFile(path, payload)
      const expected = digestOf(payload)

      expect(await be.putFileIfAbsent('checkpoints/1-1-aaaaaaaa.tar.gz', path)).toBe('created')

      const stream = await be.openReadStream('checkpoints/1-1-aaaaaaaa.tar.gz')
      expect(stream).toBeDefined()
      const hash = createHash('sha256')
      let size = 0
      await pipeline(stream!, async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk as Buffer)
          size += (chunk as Buffer).length
        }
      })
      expect(size).toBe(expected.size)
      expect(hash.digest('hex')).toBe(expected.sha256)
    })
  })

  describe('recovery on another machine', () => {
    /** A namespace whose objects live in the bucket, with a private scratch tree. */
    async function machine(): Promise<{ ns: DurableNamespace; engines: FakeEngine[] }> {
      const scratch = await mkdtemp(join(tmpdir(), 'durable-s3-machine-'))
      roots.push(scratch)
      const engines: FakeEngine[] = []
      const suffix = ENDPOINT
        ? `?region=${REGION}&endpoint=${encodeURIComponent(ENDPOINT)}${PATH_STYLE ? '&forcePathStyle=true' : ''}`
        : `?region=${REGION}`
      const ns = new DurableNamespace(`s3://${BUCKET}/${RUN_PREFIX}/recovery${suffix}`, {
        engineFactory: () => {
          const e = new FakeEngine()
          engines.push(e)
          return e
        },
        scratchRoot: scratch,
        tuning: { leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 },
      })
      return { ns, engines }
    }

    it('recovers a WAL-only object on a machine that shares nothing but the bucket', async () => {
      const objectId = `obj-${randomUUID().slice(0, 8)}`

      const a = await machine()
      const w = await a.ns.open(objectId, { database: 'mem' })
      openObjects.push(w)
      await w.execute('INSERT INTO t VALUES (1)')
      await w.execute('INSERT INTO t VALUES (2)')
      await w.flush()
      await w.close()
      openObjects.length = 0

      // Different namespace instance, different engine, different scratch.
      const b = await machine()
      const r = await b.ns.open(objectId)
      openObjects.push(r)
      expect(b.engines[0]!.statements).toEqual(['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)'])
      expect(r.generation).toBe(2)
      await r.close()
      openObjects.length = 0
    })

    it('recovers a checkpointed object, base and trailing WAL both', async () => {
      const objectId = `obj-${randomUUID().slice(0, 8)}`

      const a = await machine()
      const w = await a.ns.open(objectId, { database: 'mem' })
      openObjects.push(w)
      await w.execute('INSERT INTO t VALUES (1)')
      const base = await w.checkpoint()
      await w.execute('INSERT INTO t VALUES (2)')
      await w.flush()
      await w.close()
      openObjects.length = 0

      const b = await machine()
      const r = await b.ns.open(objectId)
      openObjects.push(r)
      expect(r.manifest.base?.key).toBe(base.key)
      expect(r.manifest.wal).toHaveLength(1)
      expect(b.engines[0]!.statements).toEqual(['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)'])
      await r.close()
      openObjects.length = 0
    })

    it('refuses a second writer while the first holds the lease', async () => {
      const objectId = `obj-${randomUUID().slice(0, 8)}`
      const a = await machine()
      const w = await a.ns.open(objectId, { database: 'mem' })
      openObjects.push(w)

      const b = await machine()
      let caught: unknown
      try {
        await b.ns.open(objectId)
      } catch (e) {
        caught = e
      }
      expect(isDurableErrorOf(caught, 'lease_held')).toBe(true)
    })

    it('serves a read-only snapshot without disturbing the writer', async () => {
      const objectId = `obj-${randomUUID().slice(0, 8)}`
      const a = await machine()
      const w = await a.ns.open(objectId, { database: 'mem' })
      openObjects.push(w)
      await w.execute('INSERT INTO t VALUES (1)')
      await w.flush()

      const b = await machine()
      const r = await b.ns.open(objectId, { readOnly: true })
      openObjects.push(r)
      expect(b.engines[0]!.statements).toEqual(['INSERT INTO t VALUES (1)'])
      // The writer still owns the lease and can still commit.
      await w.execute('INSERT INTO t VALUES (2)')
      await w.flush()
      expect(w.manifest.wal).toHaveLength(2)
    })
  })
})
