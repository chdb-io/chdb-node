/**
 * The whole stack, end to end.
 *
 * Every other suite tests one half. The engine end-to-end suite runs a real
 * `libchdb` over a local directory; the S3 suite runs a real bucket under a
 * fake engine. Neither is the arrangement a downstream actually ships, which
 * is a real engine reached through Bun's FFI writing to real object storage —
 * and the two halves meeting is exactly where a wrong assumption would hide.
 *
 * So this runs the whole stack in one process:
 *
 * ```text
 *   Bun
 *     -> chdb/durable          state machine
 *     -> chdb/durable/s3       AWS SDK, conditional writes
 *     -> LibchdbFfiEngine      bun:ffi dlopen(libchdb)
 *     -> chdb-core             backup / restore / classify
 * ```
 *
 * The claim it checks is the product one: rows acknowledged on one machine
 * come back on another that shares nothing but the bucket. "Another machine"
 * here means a second namespace, a second engine and a second scratch tree,
 * with the first fully closed first — the engine binds one data path per
 * process, so the two cannot overlap.
 *
 * ```sh
 * CHDB_LIBCHDB_PATH=/path/to/chdb-core/buildlib/libchdb.so \
 * CHDB_DURABLE_S3_BUCKET=... CHDB_DURABLE_S3_ENDPOINT=... \
 *   bun test test/durable/full-stack.bun.test.ts
 * ```
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'

import { DurableNamespace } from '../../src/durable/namespace'
import type { DurableObject } from '../../src/durable/object'
import { tryResolveLibchdb } from '../../src/libchdb/index'
import { LibchdbFfiEngine } from './libchdb-ffi'
import '../../src/durable/backends/s3'

const BUCKET = process.env['CHDB_DURABLE_S3_BUCKET']
const ENDPOINT = process.env['CHDB_DURABLE_S3_ENDPOINT']
const REGION = process.env['CHDB_DURABLE_S3_REGION'] ?? 'us-east-1'
const PATH_STYLE = process.env['CHDB_DURABLE_S3_FORCE_PATH_STYLE'] === 'true'

if (!BUCKET) throw new Error('set CHDB_DURABLE_S3_BUCKET (and CHDB_DURABLE_S3_ENDPOINT for MinIO)')
const located = tryResolveLibchdb()
if (!located) throw new Error('set CHDB_LIBCHDB_PATH to a chdb-core build carrying the durable ABI')
const LIBRARY = located.path

const RUN_PREFIX = `chdb-durable-stack/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
const scratchDirs: string[] = []

function urlFor(): string {
  const q = ENDPOINT
    ? `?region=${REGION}&endpoint=${encodeURIComponent(ENDPOINT)}${PATH_STYLE ? '&forcePathStyle=true' : ''}`
    : `?region=${REGION}`
  return `s3://${BUCKET}/${RUN_PREFIX}${q}`
}

function clientConfig(): S3ClientConfig {
  const cfg: S3ClientConfig = { region: REGION }
  if (ENDPOINT) cfg.endpoint = ENDPOINT
  if (PATH_STYLE) cfg.forcePathStyle = true
  return cfg
}

/** One "machine": its own namespace, its own engine, its own scratch tree. */
async function machine(): Promise<DurableNamespace> {
  const scratch = await mkdtemp(join(tmpdir(), 'maple-shape-'))
  scratchDirs.push(scratch)
  return new DurableNamespace(urlFor(), {
    engineFactory: () => new LibchdbFfiEngine({ libraryPath: LIBRARY }),
    scratchRoot: scratch,
    tuning: { leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 },
  })
}

function cell(csv: string): string {
  return csv.trim().replace(/^"|"$/g, '')
}

afterAll(async () => {
  for (const d of scratchDirs.splice(0)) await rm(d, { recursive: true, force: true })
  const c = new S3Client(clientConfig())
  let token: string | undefined
  do {
    const page = await c.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: RUN_PREFIX, ContinuationToken: token }),
    )
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key as string }))
    if (keys.length > 0) {
      await c.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }))
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  c.destroy()
})

const SCHEMA = 'CREATE TABLE events (id UInt64, note String) ENGINE = MergeTree ORDER BY id'

describe(`full stack: Bun + libchdb + ${ENDPOINT ?? 'aws s3'}`, () => {
  it('recovers acknowledged rows on a machine that shares only the bucket', async () => {
    const objectId = `poc-${randomUUID().slice(0, 8)}`

    const a = await machine()
    const w = await a.open(objectId, { database: 'default' })
    await w.execute(SCHEMA)
    await w.execute("INSERT INTO events VALUES (1, 'one'), (2, 'two')")
    const ticket = await w.execute("INSERT INTO events VALUES (3, 'three')")
    // The barrier a product would await before answering a client.
    await w.flushThrough(ticket)
    await w.close()

    const b = await machine()
    const r = await b.open(objectId)
    expect(await r.query('SELECT id, note FROM events ORDER BY id', { format: 'CSV' })).toBe(
      '1,"one"\n2,"two"\n3,"three"\n',
    )
    await r.close()
  })

  it('carries a checkpoint and its trailing WAL across machines', async () => {
    const objectId = `poc-${randomUUID().slice(0, 8)}`

    const a = await machine()
    const w = await a.open(objectId, { database: 'default' })
    await w.execute(SCHEMA)
    await w.execute("INSERT INTO events VALUES (1, 'before')")
    const base = await w.checkpoint()
    expect(w.manifest.wal).toEqual([])
    await w.execute("INSERT INTO events VALUES (2, 'after')")
    await w.flush()
    await w.close()

    const b = await machine()
    const r = await b.open(objectId)
    expect(r.manifest.base?.key).toBe(base.key)
    expect(r.manifest.wal).toHaveLength(1)
    expect(await r.query('SELECT id, note FROM events ORDER BY id', { format: 'CSV' })).toBe(
      '1,"before"\n2,"after"\n',
    )
    await r.close()
  })

  it('brings materialized view output back through the checkpoint', async () => {
    // A schema that leans on materialized views is the common case, and a
    // checkpoint is a whole database backup — so derived tables return without the WAL replaying
    // the derivation.
    const objectId = `poc-${randomUUID().slice(0, 8)}`

    const a = await machine()
    const w = await a.open(objectId, { database: 'default' })
    await w.execute(SCHEMA)
    await w.execute('CREATE TABLE totals (note String, n UInt64) ENGINE = SummingMergeTree ORDER BY note')
    await w.execute('CREATE MATERIALIZED VIEW mv TO totals AS SELECT note, count() AS n FROM events GROUP BY note')
    await w.execute("INSERT INTO events VALUES (1, 'a'), (2, 'a'), (3, 'b')")
    await w.checkpoint()
    await w.close()

    const b = await machine()
    const r = await b.open(objectId)
    expect(await r.query('SELECT note, sum(n) FROM totals GROUP BY note ORDER BY note', { format: 'CSV' })).toBe(
      '"a",2\n"b",1\n',
    )
    await r.close()
  })

  it('refuses raw mutations while serving reads, as a durable product must', async () => {
    const objectId = `poc-${randomUUID().slice(0, 8)}`
    const a = await machine()
    const w = await a.open(objectId, { database: 'default' })
    await w.execute(SCHEMA)
    await w.execute("INSERT INTO events VALUES (1, 'x')")

    // The /local/query contract: one read-only statement, nothing else.
    expect(cell(await w.query('SELECT count() FROM events', { format: 'CSV' }))).toBe('1')
    for (const sql of [
      "INSERT INTO events VALUES (2, 'y')",
      'CREATE DATABASE other',
      'SELECT 1; SELECT 2',
      "INSERT INTO FUNCTION file('/tmp/leak.csv') SELECT 1",
    ]) {
      let threw = false
      try {
        await w.query(sql)
      } catch {
        threw = true
      }
      expect(threw, sql).toBe(true)
    }
    await w.close()
  })
})
