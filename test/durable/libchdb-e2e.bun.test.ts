/**
 * End-to-end conformance against a real `libchdb`.
 *
 * Everything above this file has been checked against a fake engine, which
 * proves the state machine and proves nothing about the seam. This suite runs
 * the same control plane over the actual library — the real backup format, the
 * real restore, and above all the real `chdb_classify_query_n`, because the
 * entry-point gates are only as good as the analysis behind them and a test
 * double cannot tell you that core agrees.
 *
 * It runs under Bun rather than vitest because it reaches the library through
 * `bun:ffi`, which is also the shape a downstream that owns its own `dlopen`
 * will use. Point it at a build with:
 *
 * ```sh
 * CHDB_LIBCHDB_PATH=/path/to/chdb-core/buildlib/libchdb.so \
 *   bun test test/durable/libchdb-e2e.bun.test.ts
 * ```
 *
 * The engine binds one data path per process, so every case opens and closes
 * its object; there is no parallelism to be had here.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import { DurableNamespace } from '../../src/durable/namespace'
import type { DurableObject } from '../../src/durable/object'
import { isDurableErrorOf } from '../../src/durable/errors'
import { tryResolveLibchdb } from '../../src/libchdb/index'
import { LibchdbFfiEngine } from './libchdb-ffi'

const located = tryResolveLibchdb()
if (!located) {
  throw new Error(
    'libchdb not found. Set CHDB_LIBCHDB_PATH to a chdb-core build, e.g. ' +
      'CHDB_LIBCHDB_PATH=/path/to/chdb-core/buildlib/libchdb.so',
  )
}
const LIBRARY = located.path

let engineVersion: string
const roots: string[] = []
const openObjects: DurableObject[] = []

beforeAll(async () => {
  engineVersion = await new LibchdbFfiEngine({ libraryPath: LIBRARY }).version()
})

afterEach(async () => {
  for (const o of openObjects.splice(0)) await o.close().catch(() => {})
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function namespace(): Promise<DurableNamespace> {
  const root = await mkdtemp(join(tmpdir(), 'durable-e2e-'))
  roots.push(root)
  return new DurableNamespace(pathToFileURL(join(root, 'ns')).href, {
    engineFactory: () => new LibchdbFfiEngine({ libraryPath: LIBRARY }),
    scratchRoot: root,
    tuning: { leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 },
  })
}

async function open(ns: DurableNamespace, id: string, options = {}): Promise<DurableObject> {
  const o = await ns.open(id, options)
  openObjects.push(o)
  return o
}

/** First CSV cell of a single-value result. */
function cell(csv: string): string {
  return csv.trim().replace(/^"|"$/g, '')
}

const CREATE = 'CREATE TABLE events (id UInt64, note String) ENGINE = MergeTree ORDER BY id'

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return undefined
  } catch (e) {
    return e
  }
}

describe('durable object over real libchdb', () => {
  it('records the exact engine version the library reports', async () => {
    const ns = await namespace()
    const o = await open(ns, 'obj', { database: 'default' })
    await o.close()
    openObjects.length = 0

    const head = JSON.parse(
      await Bun.file(join(new URL(ns.url).pathname, 'obj', 'head.json')).text(),
    )
    expect(head.engine).toEqual({ name: 'chdb', version: engineVersion })
    expect(head.protocol.version).toBe(1)
  })

  it('survives losing the machine: WAL replay reproduces the rows', async () => {
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'default' })
    await a.execute(CREATE)
    await a.execute("INSERT INTO events VALUES (1, 'one'), (2, 'two')")
    const ticket = await a.execute("INSERT INTO events VALUES (3, 'three')")
    await a.flushThrough(ticket)
    // Simulate the process dying with the writes committed but not closed.
    await a.close()
    openObjects.length = 0

    const b = await open(ns, 'obj')
    expect(cell(await b.query('SELECT count() FROM events', { format: 'CSV' }))).toBe('3')
    expect(await b.query('SELECT id, note FROM events ORDER BY id', { format: 'CSV' })).toBe(
      '1,"one"\n2,"two"\n3,"three"\n',
    )
  })

  it('checkpoints, truncates the WAL, and still restores everything', async () => {
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'default' })
    await a.execute(CREATE)
    await a.execute("INSERT INTO events VALUES (1, 'before')")
    await a.flush()
    const base = await a.checkpoint()
    expect(a.manifest.wal).toEqual([])
    expect(a.manifest.base?.key).toBe(base.key)

    await a.execute("INSERT INTO events VALUES (2, 'after')")
    await a.flush()
    await a.close()
    openObjects.length = 0

    const b = await open(ns, 'obj')
    expect(b.manifest.base?.key).toBe(base.key)
    expect(b.manifest.wal).toHaveLength(1)
    expect(await b.query('SELECT id, note FROM events ORDER BY id', { format: 'CSV' })).toBe(
      '1,"before"\n2,"after"\n',
    )
  })

  it('carries materialized view output through a checkpoint', async () => {
    // A checkpoint is a whole-database backup, so derived tables come back
    // without the WAL having to replay the derivation.
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'default' })
    await a.execute(CREATE)
    await a.execute('CREATE TABLE totals (note String, n UInt64) ENGINE = SummingMergeTree ORDER BY note')
    await a.execute('CREATE MATERIALIZED VIEW mv TO totals AS SELECT note, count() AS n FROM events GROUP BY note')
    await a.execute("INSERT INTO events VALUES (1, 'a'), (2, 'a'), (3, 'b')")
    await a.checkpoint()
    await a.close()
    openObjects.length = 0

    const b = await open(ns, 'obj')
    expect(await b.query('SELECT note, sum(n) FROM totals GROUP BY note ORDER BY note', { format: 'CSV' })).toBe(
      '"a",2\n"b",1\n',
    )
  })

  it('handles a database name that needs quoting', async () => {
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'my-db`weird' })
    await a.execute('CREATE TABLE q (id UInt64) ENGINE = MergeTree ORDER BY id')
    await a.execute('INSERT INTO q VALUES (7)')
    await a.checkpoint()
    await a.close()
    openObjects.length = 0

    const b = await open(ns, 'obj')
    expect(b.database).toBe('my-db`weird')
    expect(cell(await b.query('SELECT id FROM q', { format: 'CSV' }))).toBe('7')
  })

  it('serves a read-only snapshot without taking the lease', async () => {
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'default' })
    await a.execute(CREATE)
    await a.execute("INSERT INTO events VALUES (1, 'x')")
    await a.flush()
    await a.close()
    openObjects.length = 0

    const r = await open(ns, 'obj', { readOnly: true })
    expect(cell(await r.query('SELECT count() FROM events', { format: 'CSV' }))).toBe('1')
    expect(isDurableErrorOf(await caught(() => r.execute("INSERT INTO events VALUES (2, 'y')")), 'classification_refused')).toBe(true)
  })
})

describe('core analysis gates the public surface', () => {
  let ns: DurableNamespace
  let o: DurableObject

  async function withObject(): Promise<DurableObject> {
    ns = await namespace()
    o = await open(ns, 'obj', { database: 'default' })
    await o.execute(CREATE)
    return o
  }

  it('refuses a mutation submitted through query()', async () => {
    const obj = await withObject()
    expect(isDurableErrorOf(await caught(() => obj.query("INSERT INTO events VALUES (1, 'x')")), 'classification_refused')).toBe(true)
  })

  it('refuses a read submitted through execute()', async () => {
    const obj = await withObject()
    expect(isDurableErrorOf(await caught(() => obj.execute('SELECT 1')), 'classification_refused')).toBe(true)
  })

  it('refuses a batch at both entry points', async () => {
    const obj = await withObject()
    expect(isDurableErrorOf(await caught(() => obj.query('SELECT 1; SELECT 2')), 'classification_refused')).toBe(true)
    expect(
      isDurableErrorOf(
        await caught(() => obj.execute("INSERT INTO events VALUES (1,'a'); INSERT INTO events VALUES (2,'b')")),
        'classification_refused',
      ),
    ).toBe(true)
  })

  it('refuses a write to another database', async () => {
    const obj = await withObject()
    expect(isDurableErrorOf(await caught(() => obj.execute("INSERT INTO other.events VALUES (1, 'x')")), 'classification_refused')).toBe(true)
  })

  it('refuses a write that leaves the engine entirely', async () => {
    const obj = await withObject()
    expect(isDurableErrorOf(await caught(() => obj.execute("INSERT INTO FUNCTION file('/tmp/leak.csv') SELECT 1")), 'classification_refused')).toBe(true)
  })

  it('refuses a database lifecycle change', async () => {
    const obj = await withObject()
    expect(isDurableErrorOf(await caught(() => obj.execute('CREATE DATABASE sneaky')), 'classification_refused')).toBe(true)
    expect(isDurableErrorOf(await caught(() => obj.execute('DROP DATABASE default')), 'classification_refused')).toBe(true)
  })

  it('refuses global state a checkpoint could not carry', async () => {
    const obj = await withObject()
    expect(isDurableErrorOf(await caught(() => obj.execute('CREATE FUNCTION addone AS (x) -> x + 1')), 'classification_refused')).toBe(true)
  })

  it('refuses session control, so the current database cannot drift', async () => {
    const obj = await withObject()
    for (const sql of ['USE system', 'SET max_threads = 4', 'SYSTEM FLUSH LOGS']) {
      expect(isDurableErrorOf(await caught(() => obj.execute(sql)), 'classification_refused'), sql).toBe(true)
      expect(isDurableErrorOf(await caught(() => obj.query(sql)), 'classification_refused'), sql).toBe(true)
    }
    expect(cell(await obj.query('SELECT currentDatabase()', { format: 'CSV' }))).toBe('default')
  })

  it('refuses a mutation carrying a credential, without echoing it', async () => {
    const obj = await withObject()
    const e = await caught(() =>
      obj.execute("CREATE NAMED COLLECTION c AS access_key_id = 'AKIAEXAMPLE', secret_access_key = 'shhh'"),
    )
    // Core classifies this as MUTATING_GLOBAL, which V1 refuses outright; the
    // secret flag is the second reason it could never be logged.
    expect(isDurableErrorOf(e, 'classification_refused') || isDurableErrorOf(e, 'secret_refused')).toBe(true)
    expect((e as Error).message).not.toContain('AKIAEXAMPLE')
    expect((e as Error).message).not.toContain('shhh')
  })

  it('fails closed on SQL core cannot parse', async () => {
    const obj = await withObject()
    expect(isDurableErrorOf(await caught(() => obj.execute('this is not sql ((')), 'classification_refused')).toBe(true)
    expect(isDurableErrorOf(await caught(() => obj.query('this is not sql ((')), 'classification_refused')).toBe(true)
  })

  it('does not record a refused statement in the WAL', async () => {
    const obj = await withObject()
    await obj.flush()
    const before = obj.manifest.seq
    await caught(() => obj.execute('CREATE DATABASE sneaky'))
    expect(obj.pendingStatements).toBe(0)
    await obj.flush()
    expect(obj.manifest.seq).toBe(before)
  })

  it('lets a read-only statement carrying a secret run, since it never reaches the WAL', async () => {
    const obj = await withObject()
    // Parses, reads, and would carry a credential — allowed, but the caller is
    // responsible for not logging the text.
    const out = await obj.query("SELECT 'secret_access_key' AS s", { format: 'CSV' })
    expect(cell(out)).toBe('secret_access_key')
  })
})

describe('lease behaviour with a real engine', () => {
  it('refuses a second writer and permits an explicit takeover', async () => {
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'default' })
    await a.execute(CREATE)

    expect(isDurableErrorOf(await caught(() => ns.open('obj')), 'lease_held')).toBe(true)

    // A forced takeover needs the first writer's engine gone first: the engine
    // binds one data path per process, and the second object needs its own.
    await a.close()
    openObjects.length = 0
    const b = await open(ns, 'obj', { force: true })
    expect(b.generation).toBeGreaterThan(1)
  })
})
