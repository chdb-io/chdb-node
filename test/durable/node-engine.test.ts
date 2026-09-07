/**
 * The durable control plane over this package's own native addon — the default
 * a Node caller gets, and the half of the seam the Bun end-to-end suite cannot
 * reach.
 *
 * `libchdb-e2e.bun.test.ts` already proves the control plane against real core
 * through `bun:ffi`. What is unproven by that is everything *this* path adds:
 * the four ABI calls bound in `lib/chdb_node.cpp`, the connect-time settings a
 * durable writer depends on, and the identifier quoting the adapter has to do
 * itself because the C ABI has no entry point for `CREATE DATABASE`. So this
 * suite re-runs the load-bearing scenarios over the addon rather than every
 * scenario twice, and adds the cases that only exist here.
 *
 * It needs a built addon and no shadowing prebuilt:
 *
 * ```sh
 * npm run build && rm -rf node_modules/@chdb/lib-*
 * npm run test:durable:node
 * ```
 *
 * The engine binds one data path per process, so every case opens and closes
 * its object and nothing here runs in parallel.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { DurableNamespace } from '../../src/durable/namespace'
import type { DurableObject } from '../../src/durable/object'
import { isDurableErrorOf } from '../../src/durable/errors'
import {
  ChdbNodeEngine,
  assertDurableAbi,
  nodeEngineFactory,
  type ChdbDurableNative,
} from '../../src/durable/adapters/chdb-node'
import { loadNative } from '../../src/loader'

const CREATE = 'CREATE TABLE events (id UInt64, note String) ENGINE = MergeTree ORDER BY id'

let engineVersion: string
const roots: string[] = []
const openObjects: DurableObject[] = []

beforeAll(async () => {
  engineVersion = await new ChdbNodeEngine().version()
})

afterEach(async () => {
  for (const o of openObjects.splice(0)) await o.close().catch(() => {})
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function namespace(): Promise<DurableNamespace> {
  const root = await mkdtemp(join(tmpdir(), 'durable-node-'))
  roots.push(root)
  return new DurableNamespace(pathToFileURL(join(root, 'ns')).href, {
    engineFactory: nodeEngineFactory(),
    scratchRoot: root,
    // Long enough that a checkpoint of a test-sized database never races the
    // lease, short enough that a hung heartbeat still shows up as a failure.
    tuning: { leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 },
  })
}

async function open(ns: DurableNamespace, id: string, options = {}): Promise<DurableObject> {
  const o = await ns.open(id, options)
  openObjects.push(o)
  return o
}

/** Close and forget, for a case that then reopens the object. */
async function release(o: DurableObject): Promise<void> {
  await o.close()
  openObjects.splice(openObjects.indexOf(o), 1)
}

/** First CSV cell of a single-value result. */
function cell(csv: string): string {
  return csv.trim().replace(/^"|"$/g, '')
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return undefined
  } catch (e) {
    return e
  }
}

describe('durable object over the native addon', () => {
  it('records the version the addon reports, without a connection to ask on', async () => {
    // The compatibility gate runs before a lease is taken or a scratch
    // directory is made, so `chdb_version` has to be answerable with no
    // connection at all — which is why it is bound as its own export.
    expect(engineVersion).toMatch(/^\d+\.\d+\.\d+/)

    const ns = await namespace()
    const o = await open(ns, 'obj', { database: 'default' })
    await release(o)

    const head = JSON.parse(
      await readFile(join(fileURLToPath(ns.url), 'obj', 'head.json'), 'utf8'),
    )
    expect(head.engine).toEqual({
      name: 'chdb',
      version: engineVersion,
      backup_format: 1,
      min_reader: engineVersion,
    })
  })

  it('survives losing the machine: WAL replay reproduces the rows', async () => {
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'default' })
    await a.execute(CREATE)
    await a.execute("INSERT INTO events VALUES (1, 'one'), (2, 'two')")
    const ticket = await a.execute("INSERT INTO events VALUES (3, 'three')")
    await a.flushThrough(ticket)
    await release(a)

    const b = await open(ns, 'obj')
    expect(await b.query('SELECT id, note FROM events ORDER BY id', { format: 'CSV' })).toBe(
      '1,"one"\n2,"two"\n3,"three"\n',
    )
  })

  it('checkpoints through chdb_backup_database_n and restores from it', async () => {
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'default' })
    await a.execute(CREATE)
    await a.execute("INSERT INTO events VALUES (1, 'before')")
    const base = await a.checkpoint()
    expect(a.manifest.wal).toEqual([])
    await a.execute("INSERT INTO events VALUES (2, 'after')")
    await a.flush()
    await release(a)

    const b = await open(ns, 'obj')
    expect(b.manifest.base?.key).toBe(base.key)
    expect(b.manifest.wal).toHaveLength(1)
    expect(await b.query('SELECT id, note FROM events ORDER BY id', { format: 'CSV' })).toBe(
      '1,"before"\n2,"after"\n',
    )
  })

  it('quotes a database name that needs both escapes', async () => {
    // The adapter builds exactly two statements itself — `CREATE DATABASE` and
    // `USE` — because the C ABI has no entry point for either, while BACKUP and
    // RESTORE take the name unquoted and core quotes it. So the two quotings
    // have to agree, and a backslash is where they can silently disagree:
    // doubling backticks alone leaves `\d` as an escape sequence, which creates
    // a database under a name the backup call would not find.
    const database = 'od\\d-db`weird'
    const ns = await namespace()
    const a = await open(ns, 'obj', { database })
    await a.execute('CREATE TABLE q (id UInt64) ENGINE = MergeTree ORDER BY id')
    await a.execute('INSERT INTO q VALUES (7)')
    expect(cell(await a.query('SELECT currentDatabase()', { format: 'CSV' }))).toBe(database)
    await a.checkpoint()
    await release(a)

    const b = await open(ns, 'obj')
    expect(b.database).toBe(database)
    expect(cell(await b.query('SELECT id FROM q', { format: 'CSV' }))).toBe('7')
  })

  it('serves a read-only snapshot without taking the lease', async () => {
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'default' })
    await a.execute(CREATE)
    await a.execute("INSERT INTO events VALUES (1, 'x')")
    await a.flush()
    await release(a)

    const r = await open(ns, 'obj', { readOnly: true })
    expect(cell(await r.query('SELECT count() FROM events', { format: 'CSV' }))).toBe('1')
  })

  it('reports a statement the engine rejected as an engine error, not a refusal', async () => {
    // The distinction is the caller's next move: a refusal means rewrite the
    // statement, an engine error means the statement was allowed and failed.
    const ns = await namespace()
    const a = await open(ns, 'obj', { database: 'default' })
    await a.execute(CREATE)
    await a.flush()
    const e = await caught(() => a.execute('INSERT INTO events VALUES (1)'))
    expect(isDurableErrorOf(e, 'engine')).toBe(true)
    // A failed statement is never buffered, so it is never replayed.
    expect(a.pendingStatements).toBe(0)
  })
})

describe('real chdb_classify_query_n gates the public surface', () => {
  it('refuses everything the contract says it must, in one object', async () => {
    // The gate matrix is checked exhaustively against core by the Bun suite;
    // what is under test here is that the addon's classify binding reports the
    // same analysis, so one pass over the representative cases is enough.
    const ns = await namespace()
    const o = await open(ns, 'obj', { database: 'default' })
    await o.execute(CREATE)
    await o.flush()

    const refusals: [string, () => Promise<unknown>][] = [
      ['a mutation through query()', () => o.query("INSERT INTO events VALUES (1, 'x')")],
      ['a read through execute()', () => o.execute('SELECT 1')],
      ['a batch', () => o.execute("INSERT INTO events VALUES (1,'a'); INSERT INTO events VALUES (2,'b')")],
      ['a write to another database', () => o.execute("INSERT INTO other.events VALUES (1, 'x')")],
      ['a write leaving the engine', () => o.execute("INSERT INTO FUNCTION file('/tmp/leak.csv') SELECT 1")],
      ['a database lifecycle change', () => o.execute('CREATE DATABASE sneaky')],
      ['global state a checkpoint cannot carry', () => o.execute('CREATE FUNCTION addone AS (x) -> x + 1')],
      ['session control', () => o.execute('USE system')],
      ['SQL core cannot parse', () => o.execute('this is not sql ((')],
    ]
    for (const [what, fn] of refusals) {
      expect(isDurableErrorOf(await caught(fn), 'classification_refused'), what).toBe(true)
    }

    // Nothing above reached the WAL, and the current database did not drift.
    expect(o.pendingStatements).toBe(0)
    expect(cell(await o.query('SELECT currentDatabase()', { format: 'CSV' }))).toBe('default')
  })

  it('refuses a mutation carrying a credential without echoing it', async () => {
    const ns = await namespace()
    const o = await open(ns, 'obj', { database: 'default' })
    const e = await caught(() =>
      o.execute(
        "CREATE NAMED COLLECTION c AS access_key_id = 'AKIAEXAMPLE', secret_access_key = 'shhh'",
      ),
    )
    expect(
      isDurableErrorOf(e, 'classification_refused') || isDurableErrorOf(e, 'secret_refused'),
    ).toBe(true)
    expect((e as Error).message).not.toContain('AKIAEXAMPLE')
    expect((e as Error).message).not.toContain('shhh')
  })
})

describe('the adapter around the addon', () => {
  /** A native double: no engine, and every call resolves the way the ABI would. */
  function fakeNative(overrides: Partial<ChdbDurableNative> = {}): ChdbDurableNative & {
    closed: number
  } {
    const fake = {
      closed: 0,
      EngineVersion: () => '26.7.2-rc.2',
      CreateConnection: () => ({ handle: true }),
      CloseConnection() {
        fake.closed++
      },
      QueryAsyncConnection: async () => ({ bytes: Buffer.from('') }),
      DurableBackupAsync: async () => {},
      DurableRestoreAsync: async () => {},
      DurableClassifyAsync: async () => ({
        statementCount: 1,
        queryClass: 0,
        hasSecrets: false,
        writesOnlyTargetDatabase: true,
        changesDatabaseLifecycle: false,
      }),
      ...overrides,
    }
    return fake as ChdbDurableNative & { closed: number }
  }

  it('names every missing export, and what to do about it', () => {
    // The loader prefers a published @chdb/lib-* prebuilt over a local build,
    // so an addon predating the durable ABI is the first failure a developer in
    // a checkout meets. "undefined is not a function" would not help.
    let message = ''
    try {
      assertDurableAbi({ Query: () => '' })
    } catch (e) {
      message = (e as Error).message
    }
    for (const name of [
      'EngineVersion',
      'DurableBackupAsync',
      'DurableRestoreAsync',
      'DurableClassifyAsync',
    ]) {
      expect(message).toContain(name)
    }
    expect(message).toContain('npm run build')
    expect(message).toContain('@chdb/lib-')
  })

  it('accepts the addon this process actually loaded', () => {
    expect(() => assertDurableAbi(loadNative())).not.toThrow()
  })

  it('refuses a setting that would move the data directory', () => {
    // The path is the connection registry's key, and the registry is what
    // enforces one bound directory per process. A setting that moved it would
    // leave the two describing different places.
    const native = loadNative() as { CreateConnection: (p: string, s: string[]) => unknown }
    expect(() => native.CreateConnection('/tmp/should-not-open', ['--path=/tmp/elsewhere'])).toThrow(
      /--path/,
    )
  })

  it('will not release the connection under a call still on a libuv thread', async () => {
    // The worker holds the handle for the duration, so closing under one is a
    // use-after-free rather than a cancelled operation.
    let finish: (() => void) | undefined
    const native = fakeNative({
      DurableBackupAsync: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const engine = new ChdbNodeEngine({ native })
    await engine.start({ dataPath: '/tmp/x', backupsAllowedPath: '/tmp/x/backups' })

    const backup = engine.backupDatabase('db', '/tmp/x/backups/a.tar.gz')
    const closing = engine.close()
    // Give close every chance to have run past the wait.
    await new Promise((r) => setTimeout(r, 20))
    expect(native.closed).toBe(0)

    finish?.()
    await backup
    await closing
    expect(native.closed).toBe(1)
  })

  it('is safe to close twice, and refuses use afterwards', async () => {
    const native = fakeNative()
    const engine = new ChdbNodeEngine({ native })
    await engine.start({ dataPath: '/tmp/x', backupsAllowedPath: '/tmp/x/backups' })
    await engine.close()
    await engine.close()
    expect(native.closed).toBe(1)
    expect(isDurableErrorOf(await caught(() => engine.query('SELECT 1', 'CSV')), 'engine')).toBe(
      true,
    )
  })

  it('is safe to close after a failed start', async () => {
    const native = fakeNative({
      CreateConnection: () => {
        throw new Error('only one active data directory per process')
      },
    })
    const engine = new ChdbNodeEngine({ native })
    const e = await caught(() =>
      engine.start({ dataPath: '/tmp/x', backupsAllowedPath: '/tmp/x/backups' }),
    )
    expect(isDurableErrorOf(e, 'engine')).toBe(true)
    expect((e as Error).message).toContain('one active data directory')
    await engine.close()
    expect(native.closed).toBe(0)
  })

  it('refuses a second start on the same instance', async () => {
    const engine = new ChdbNodeEngine({ native: fakeNative() })
    await engine.start({ dataPath: '/tmp/x', backupsAllowedPath: '/tmp/x/backups' })
    expect(
      isDurableErrorOf(
        await caught(() => engine.start({ dataPath: '/tmp/y', backupsAllowedPath: '/tmp/y/b' })),
        'engine',
      ),
    ).toBe(true)
    await engine.close()
  })

  it('applies the settings a durable writer cannot leave to chance', async () => {
    // Connect arguments rather than SETs, because the control plane classifies
    // SET as CONTROL: an async insert or an unsynchronised mutation would
    // return before its effect landed, putting a statement in the WAL whose
    // local effect is not yet in the database the next checkpoint archives.
    let settings: readonly string[] = []
    const native = fakeNative({
      CreateConnection: (_path: string, given?: readonly string[]) => {
        settings = given ?? []
        return { handle: true }
      },
    })
    const engine = new ChdbNodeEngine({ native, extraArgs: ['--max_threads=2'] })
    await engine.start({ dataPath: '/tmp/x', backupsAllowedPath: '/tmp/x/backups' })
    expect(settings).toEqual([
      '--backups.allowed_path=/tmp/x/backups',
      '--async_insert=0',
      '--wait_for_async_insert=1',
      '--mutations_sync=2',
      '--alter_sync=2',
      '--max_threads=2',
    ])
    await engine.close()
  })

  it('never passes an incremental base to backup', async () => {
    // V1 checkpoints are always full: an incremental archive records the
    // absolute path of its base, and that path does not exist on the machine
    // doing the restore. The adapter has no parameter for one, and the addon
    // passes NULL — so the only place this could regress is the arity here.
    const calls: unknown[][] = []
    const native = fakeNative({
      DurableBackupAsync: async (...args: unknown[]) => {
        calls.push(args)
      },
    })
    const engine = new ChdbNodeEngine({ native })
    await engine.start({ dataPath: '/tmp/x', backupsAllowedPath: '/tmp/x/backups' })
    await engine.backupDatabase('db', '/tmp/x/backups/a.tar.gz')
    expect(calls[0]).toHaveLength(3)
    await engine.close()
  })
})
