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
import { execFileSync } from 'child_process'
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { DurableNamespace } from '../../src/durable/namespace'
import type { DurableObject } from '../../src/durable/object'
import { isDurableErrorOf } from '../../src/durable/errors'
import {
  ChdbNodeEngine,
  assertDurableAbi,
  assertExtraArgsAllowed,
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

describe('cross-entry-point connection safety', () => {
  // Run in a child process: the scenario deliberately leaves a query running
  // on the shared default connection, and asserting on it from inside this
  // worker would leave that state behind for whatever runs next.
  function runNode(source: string): string {
    return execFileSync(process.execPath, ['-e', source], {
      encoding: 'utf8',
      cwd: resolve(__dirname, '..', '..'),
    }).trim()
  }

  const scenario = (awaitFirst: boolean): string => `
    const { queryAsync } = require('./index.js')
    const { ChdbNodeEngine } = require('./dist/durable/adapters/chdb-node.js')
    const { mkdtempSync } = require('fs')
    const { tmpdir } = require('os')
    const { join } = require('path')
    ;(async () => {
      const root = mkdtempSync(join(tmpdir(), 'durable-race-'))
      const pending = queryAsync('SELECT sum(number) FROM numbers(4000000000)')
      pending.catch(() => {})
      ${awaitFirst ? 'await pending' : 'await new Promise(r => setTimeout(r, 200))'}
      const engine = new ChdbNodeEngine()
      try {
        await engine.start({ dataPath: join(root, 'data'), backupsAllowedPath: join(root, 'b') })
        console.log('STARTED')
        await engine.close()
      } catch (e) {
        console.log('REFUSED: ' + e.message)
      }
      ${awaitFirst ? '' : 'await pending.catch(() => {})'}
      process.exit(0)
    })().catch(e => { console.error(e); process.exit(1) })
  `

  it('refuses to bind a data directory under a running standalone query', () => {
    // index.js guards this for `new Session()`, but that guard sits above the
    // addon, so every entry point had to remember it — and this one, reaching
    // CreateConnection directly, did not. Closing the default connection while
    // a libuv thread is inside libchdb on it aborts the engine for the rest of
    // the process, or leaves the worker blocked so its promise never settles.
    const out = runNode(scenario(false))
    expect(out).toContain('REFUSED')
    expect(out).toContain('still running on the default connection')
  })

  it('binds normally once that query has been awaited', () => {
    // The refusal has to be a wait, not a wall: a released count must let the
    // next binding through, or the process is stuck for good.
    expect(runNode(scenario(true))).toBe('STARTED')
  })
})

describe('the settings the engine actually ends up with', () => {
  // A fake native can only prove which strings were passed. What the engine
  // did with them is a different claim, and it is the one that matters — so it
  // is read back out of system.settings on a real connection.
  it('pins the durability settings and still honours a legitimate extraArg', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-node-set-'))
    roots.push(root)
    const engine = new ChdbNodeEngine({ extraArgs: ['--max_threads=7'] })
    try {
      const data = join(root, 'data')
      const backups = join(root, 'backups')
      await mkdir(data, { recursive: true })
      await mkdir(backups, { recursive: true })
      await engine.start({ dataPath: data, backupsAllowedPath: backups })
      const csv = await engine.query(
        `SELECT name, value FROM system.settings WHERE name IN ` +
          `('async_insert','wait_for_async_insert','mutations_sync','alter_sync','max_threads') ` +
          `ORDER BY name`,
        'CSV',
      )
      expect(csv).toBe(
        '"alter_sync","2"\n' +
          '"async_insert","0"\n' +
          '"max_threads","7"\n' +
          '"mutations_sync","2"\n' +
          '"wait_for_async_insert","1"\n',
      )
    } finally {
      await engine.close()
    }
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

  it('checks an injected addon the same way as a loaded one', () => {
    // Otherwise the injection path is the only one that reports a missing
    // export as `TypeError: EngineVersion is not a function`, which says
    // nothing about what to install.
    const partial = { CreateConnection: () => ({}), CloseConnection: () => {} }
    let thrown: unknown
    try {
      new ChdbNodeEngine({ native: partial as unknown as ChdbDurableNative })
    } catch (e) {
      thrown = e
    }
    expect(isDurableErrorOf(thrown, 'engine')).toBe(true)
    expect((thrown as Error).message).toContain('EngineVersion')
    expect((thrown as Error).message).toContain('DurableClassifyAsync')
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

  it('refuses an argument carrying a NUL byte, at both layers', () => {
    // Built rather than written literally, so this file holds no control
    // character. A JS string may carry a NUL and `c_str()` hands the engine
    // only what precedes it — so '--path<NUL>x' arrives as a bare '--path',
    // an option that takes the NEXT argv as its value, and the entry after it
    // becomes the data directory. Measured before the fix: ['--path<NUL>x',
    // '/other'] bound /other while the registry recorded the requested path.
    // That is the exact mismatch the registry exists to prevent, and it
    // walked straight through the '--path' check, which compares strings.
    const nul = String.fromCharCode(0)
    for (const arg of [`--path${nul}x`, `--async_insert${nul}x`, `--max_threads${nul}x`]) {
      expect(() => assertExtraArgsAllowed([arg]), arg).toThrow(/NUL/)
      expect(() => nodeEngineFactory({ extraArgs: [arg] }), arg).toThrow(/NUL/)
    }
    // And the addon refuses them independently, which is what protects the
    // callers that never pass through the adapter.
    const native = loadNative() as { CreateConnection: (p: string, s?: string[]) => unknown }
    expect(() => native.CreateConnection('/tmp/should-not-open', [`--path${nul}x`, '/tmp/other'])).toThrow(
      /NUL/,
    )
    expect(() => native.CreateConnection(`/tmp/should${nul}-not-open`)).toThrow(/NUL/)
  })

  it('makes every concurrent close wait for the connection to actually go', async () => {
    // Returning early on a `closed` flag would tell the second caller the
    // handle is released while the first is still waiting out a backup that
    // owns it.
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
    const first = engine.close()
    const second = engine.close()

    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(secondSettled).toBe(false)
    expect(native.closed).toBe(0)

    finish?.()
    await backup
    await Promise.all([first, second])
    expect(native.closed).toBe(1)
    // A third, long after the fact, still resolves and still closes once.
    await engine.close()
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

  it('puts durable\u2019s own arguments last, so nothing can outrank them', async () => {
    // ClickHouse takes the last value for a repeated argument, so order is the
    // lock behind the reserved-name check: even a caller that got a reserved
    // setting past the door loses to the copy appended afterwards.
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
      '--max_threads=2',
      '--backups.allowed_path=/tmp/x/backups',
      '--async_insert=0',
      '--wait_for_async_insert=1',
      '--mutations_sync=2',
      '--alter_sync=2',
    ])
    await engine.close()
  })

  it('refuses every spelling of a reserved setting', () => {
    // Connect arguments rather than SETs, because the control plane classifies
    // SET as CONTROL: an async insert or an unsynchronised mutation would
    // return before its effect landed, putting a statement in the WAL whose
    // local effect is not yet in the database the next checkpoint archives.
    // Which is exactly why extraArgs must not be able to hand them back.
    const reserved = [
      '--async_insert=1',
      '--async_insert',
      '--async_insert 1',
      '--wait_for_async_insert=0',
      '--mutations_sync=0',
      '--alter_sync=0',
      '--backups.allowed_path=/tmp/elsewhere',
      '--path=/tmp/elsewhere',
    ]
    for (const arg of reserved) {
      expect(() => assertExtraArgsAllowed([arg]), arg).toThrow(TypeError)
      // Reported where it was written, not at the first open().
      expect(() => nodeEngineFactory({ extraArgs: [arg] }), arg).toThrow(/cannot set/)
    }
    expect(() => assertExtraArgsAllowed(['--max_threads=8'])).not.toThrow()
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
