/**
 * Lifecycle, lease and fault-matrix conformance (contract §5, §7.4).
 *
 * The happy path here is short. Most of the file is about what happens when a
 * step does not cleanly succeed, because that is where a durable object either
 * keeps its promise or quietly stops keeping it: a commit whose response was
 * lost, a checkpoint that uploaded but did not publish, a writer that was
 * taken over while it thought it was still the writer.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import { DurableNamespace } from '../../src/durable/namespace'
import { LocalDurableBackend } from '../../src/durable/backends/local'
import { DurableObject } from '../../src/durable/object'
import { isDurableErrorOf } from '../../src/durable/errors'
import { FakeEngine, FaultBackend } from './fakes'

const FAST = {
  leaseTtlMs: 1_500,
  heartbeatIntervalMs: 400,
  clockSkewAllowanceMs: 100,
  commitDeadlineMs: 1_500,
  maxCommitAttempts: 3,
}

const roots: string[] = []
const open: DurableObject[] = []

afterEach(async () => {
  for (const o of open.splice(0)) await o.close().catch(() => {})
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

interface Harness {
  root: string
  objectDir: string
  ns: DurableNamespace
  engines: FakeEngine[]
  faults: FaultBackend[]
}

async function harness(options: { fault?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'durable-sm-'))
  roots.push(root)
  const engines: FakeEngine[] = []
  const faults: FaultBackend[] = []
  const ns = new DurableNamespace(pathToFileURL(root).href, {
    engineFactory: () => {
      const e = new FakeEngine()
      engines.push(e)
      return e
    },
    backendFactory: (id) => {
      const inner = new LocalDurableBackend({ root: join(root, id) })
      if (!options.fault) return inner
      const wrapped = new FaultBackend(inner)
      faults.push(wrapped)
      return wrapped
    },
    tuning: FAST,
    scratchRoot: root,
  })
  return { root, objectDir: join(root, 'obj'), ns, engines, faults }
}

async function track(p: Promise<DurableObject>): Promise<DurableObject> {
  const o = await p
  open.push(o)
  return o
}

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return undefined
  } catch (e) {
    return e
  }
}

/** Names of every immutable object published under a subdirectory. */
async function listed(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

describe('cold create and reopen', () => {
  it('creates the object, commits a WAL segment, and replays it on reopen', async () => {
    const h = await harness()
    const a = await track(h.ns.open('obj', { database: 'mem' }))
    expect(a.generation).toBe(1)
    expect(a.manifest.base).toBeNull()

    await a.execute('INSERT INTO t VALUES (1)')
    await a.execute('INSERT INTO t VALUES (2)')
    expect(a.pendingStatements).toBe(2)

    const ref = await a.flush()
    expect(ref?.key).toMatch(/^wal\/1-1-[0-9a-f]{8}\.jsonl$/)
    expect(a.pendingStatements).toBe(0)
    expect(a.manifest.seq).toBe(1)
    await a.close()
    open.length = 0

    const b = await track(h.ns.open('obj'))
    expect(h.engines[1]!.statements).toEqual(['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)'])
    // Reopening from a released lease takes the next generation.
    expect(b.generation).toBe(2)
    expect(b.database).toBe('mem')
  })

  it('never records a statement whose local execution failed', async () => {
    const h = await harness()
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    h.engines[0]!.failNextRun = new Error('engine said no')
    await expect(o.execute('INSERT INTO t VALUES (1)')).rejects.toThrow('engine said no')
    expect(o.pendingStatements).toBe(0)
    expect(await o.flush()).toBeUndefined()
  })

  it('refuses to create when existingOnly is set', async () => {
    const h = await harness()
    expect(isDurableErrorOf(await catchError(() => h.ns.open('obj', { existingOnly: true })), 'not_found')).toBe(true)
  })
})

describe('checkpoint', () => {
  it('replaces the base, clears the WAL list, and keeps the data', async () => {
    const h = await harness()
    const a = await track(h.ns.open('obj', { database: 'mem' }))
    await a.execute('INSERT INTO t VALUES (1)')
    await a.flush()
    await a.execute('INSERT INTO t VALUES (2)')

    // The unflushed statement is in the local database, so the backup carries
    // it and the commit may clear it from the buffer.
    const base = await a.checkpoint()
    expect(base.key).toMatch(/^checkpoints\//)
    expect(a.manifest.base?.key).toBe(base.key)
    expect(a.manifest.wal).toEqual([])
    expect(a.pendingStatements).toBe(0)
    await a.close()
    open.length = 0

    const b = await track(h.ns.open('obj'))
    expect(h.engines[1]!.statements).toEqual(['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)'])
    expect(b.manifest.base?.key).toBe(base.key)
  })

  it('leaves no archive behind in the scratch tree', async () => {
    const h = await harness()
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')
    await o.checkpoint()
    const backups = await listed(join(o.scratchPath, 'backups'))
    expect(backups).toEqual([])
  })
})

describe('read-only opens', () => {
  it('reports not_found for an object that does not exist', async () => {
    const h = await harness()
    expect(isDurableErrorOf(await catchError(() => h.ns.open('obj', { readOnly: true })), 'not_found')).toBe(true)
  })

  it('takes no lease and refuses writes', async () => {
    const h = await harness()
    const w = await track(h.ns.open('obj', { database: 'mem' }))
    await w.execute('INSERT INTO t VALUES (1)')
    await w.flush()
    await w.close()
    open.length = 0

    const r = await track(h.ns.open('obj', { readOnly: true }))
    expect(h.engines[1]!.statements).toEqual(['INSERT INTO t VALUES (1)'])
    expect(isDurableErrorOf(await catchError(() => r.execute('INSERT INTO t VALUES (2)')), 'classification_refused')).toBe(true)

    // The lease is untouched, so a writer can still take it while this reads.
    const w2 = await track(h.ns.open('obj'))
    expect(w2.generation).toBe(2)
  })
})

describe('lease, takeover and fencing', () => {
  it('refuses a second writer while the lease is live', async () => {
    const h = await harness()
    await track(h.ns.open('obj', { database: 'mem' }))
    const e = await catchError(() => h.ns.open('obj'))
    expect(isDurableErrorOf(e, 'lease_held')).toBe(true)
  })

  it('releases the lease on a clean close so the next writer finds it free', async () => {
    const h = await harness()
    const a = await track(h.ns.open('obj', { database: 'mem' }))
    expect(a.generation).toBe(1)
    await a.close()
    open.length = 0

    const stored = JSON.parse(await readFile(join(h.objectDir, 'head.json'), 'utf8'))
    expect(stored.lease).toEqual({ generation: 1, owner: null, instance: null, expires_at: null })

    const b = await track(h.ns.open('obj'))
    expect(b.generation).toBe(2)
  })

  it('takes over a lease whose recorded expiry is past the skew allowance', async () => {
    const h = await harness()
    const be = new LocalDurableBackend({ root: h.objectDir })
    // A writer that died holding the lease: still named, expiry long gone.
    await be.putBytesIfAbsent(
      'head.json',
      Buffer.from(
        JSON.stringify({
          protocol: { version: 1, reader_features: [], writer_features: [] },
          engine: { name: 'chdb', version: '26.7.0' },
          lease: { generation: 6, owner: 'dead-worker', instance: 'gone', expires_at: (Date.now() - 60_000) / 1000 },
          manifest: { db: 'mem', base: null, wal: [], seq: 0 },
        }),
      ),
    )
    const o = await track(h.ns.open('obj'))
    expect(o.generation).toBe(7)
  })

  it('refuses to take over a lease that has expired by less than the skew allowance', async () => {
    const h = await harness()
    const be = new LocalDurableBackend({ root: h.objectDir })
    await be.putBytesIfAbsent(
      'head.json',
      Buffer.from(
        JSON.stringify({
          protocol: { version: 1, reader_features: [], writer_features: [] },
          engine: { name: 'chdb', version: '26.7.0' },
          lease: { generation: 6, owner: 'maybe-alive', instance: 'x', expires_at: Date.now() / 1000 },
          manifest: { db: 'mem', base: null, wal: [], seq: 0 },
        }),
      ),
    )
    // Expired by ~0ms, allowance is 100ms: the clocks may simply disagree.
    expect(isDurableErrorOf(await catchError(() => h.ns.open('obj')), 'lease_held')).toBe(true)
    // Forcing is the documented escape hatch, and it is explicit.
    const o = await track(h.ns.open('obj', { force: true }))
    expect(o.generation).toBe(7)
  })

  it('fences the previous writer after a forced takeover', async () => {
    const h = await harness()
    const a = await track(h.ns.open('obj', { database: 'mem' }))
    await a.execute('INSERT INTO t VALUES (1)')

    const b = await track(h.ns.open('obj', { force: true }))
    expect(b.generation).toBe(2)

    // The old writer only learns on its next commit — which is exactly the
    // point of fencing, and why force carries a data-loss warning.
    const e = await catchError(() => a.flush())
    expect(isDurableErrorOf(e, 'lease_fenced')).toBe(true)
    expect(a.isFenced).toBe(true)
  })

  it('self-fences when it cannot confirm its lease before the window lapses', async () => {
    const h = await harness({ fault: true })
    const o = await track(
      h.ns.open('obj', { database: 'mem', tuning: { ...FAST, leaseTtlMs: 300, heartbeatIntervalMs: 100 } }),
    )
    // Every head write from now on fails, so no heartbeat can land.
    for (let i = 0; i < 40; i++) h.faults[0]!.inject({ on: 'replace', result: 'throw' })
    await new Promise((r) => setTimeout(r, 500))

    const e = await catchError(() => o.execute('INSERT INTO t VALUES (1)'))
    expect(isDurableErrorOf(e, 'lease_fenced')).toBe(true)
  })

  it('keeps the lease alive across an idle period through heartbeat', async () => {
    const h = await harness()
    const o = await track(
      h.ns.open('obj', { database: 'mem', tuning: { ...FAST, leaseTtlMs: 600, heartbeatIntervalMs: 150 } }),
    )
    await new Promise((r) => setTimeout(r, 900))
    // Still ours: no generation bump, and writes are accepted.
    await o.execute('INSERT INTO t VALUES (1)')
    expect(o.generation).toBe(1)
    expect(o.isFenced).toBe(false)
  })
})

describe('fault matrix', () => {
  it('keeps the old manifest and the local buffer when a WAL commit fails', async () => {
    const h = await harness({ fault: true })
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')

    // The segment uploads; every attempt to publish the reference is refused.
    for (let i = 0; i < 5; i++) h.faults[0]!.inject({ on: 'replace', result: 'not-replaced' })
    const e = await catchError(() => o.flush())
    expect(isDurableErrorOf(e, 'commit_ambiguous')).toBe(true)

    expect(o.manifest.wal).toEqual([])
    // The statement is still buffered, so a later flush can still commit it.
    expect(o.pendingStatements).toBe(1)
    // And the orphaned segment is on disk, collectable but unreferenced.
    expect((await listed(join(h.objectDir, 'wal'))).length).toBe(1)
  })

  it('reconciles a head commit whose response was lost into a success', async () => {
    const h = await harness({ fault: true })
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')

    h.faults[0]!.inject({ on: 'replace', result: 'commit-then-ambiguous' })
    const ref = await o.flush()

    expect(ref).toBeDefined()
    expect(o.manifest.wal.map((w) => w.key)).toEqual([ref!.key])
    expect(o.pendingStatements).toBe(0)
  })

  it('reports commit_ambiguous rather than success when nothing can be proven', async () => {
    const h = await harness({ fault: true })
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')

    // Every head write answers "maybe", and re-reading never shows the
    // intent. There is no honest answer except that we do not know.
    for (let i = 0; i < 6; i++) h.faults[0]!.inject({ on: 'replace', result: 'ambiguous' })
    const e = await catchError(() => o.flush())
    expect(isDurableErrorOf(e, 'commit_ambiguous')).toBe(true)
    expect(o.pendingStatements).toBe(1)
  })

  it('treats a WAL upload that landed but lost its response as published', async () => {
    const h = await harness({ fault: true })
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')

    // The segment really is written; only the answer went missing. Re-reading
    // the unique key and matching its digest turns that back into a fact.
    h.faults[0]!.inject({ on: 'putBytes', key: /^wal\//, result: 'write-then-ambiguous' })
    const ref = await o.flush()
    expect(ref).toBeDefined()
    expect(o.manifest.wal.map((w) => w.key)).toEqual([ref!.key])
    expect(o.pendingStatements).toBe(0)
  })

  it('treats a checkpoint upload that landed but lost its response as published', async () => {
    const h = await harness({ fault: true })
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')

    h.faults[0]!.inject({ on: 'putFile', key: /^checkpoints\//, result: 'write-then-ambiguous' })
    const base = await o.checkpoint()
    expect(o.manifest.base?.key).toBe(base.key)
  })

  it('reports an upload it cannot find as ambiguous rather than as published', async () => {
    const h = await harness({ fault: true })
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')

    // Nothing was written and the answer was lost: there is no proof either
    // way, and inventing one would be the only unrecoverable mistake here.
    h.faults[0]!.inject({ on: 'putBytes', key: /^wal\//, result: 'ambiguous' })
    expect(isDurableErrorOf(await catchError(() => o.flush()), 'commit_ambiguous')).toBe(true)
    expect(o.pendingStatements).toBe(1)
  })

  it('refuses a published object whose bytes are not the bytes it meant to publish', async () => {
    const h = await harness({ fault: true })
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')

    // The key exists, holding content that is not ours. A key match is not
    // proof of a commit; a digest match is.
    h.faults[0]!.inject({ on: 'putBytes', key: /^wal\//, result: 'divergent-then-exists' })
    const e = await catchError(() => o.flush())
    expect(isDurableErrorOf(e, 'corrupt')).toBe(true)
    expect((e as Error).message).toMatch(/sha256|size/)
    expect(o.pendingStatements).toBe(1)
  })

  it('keeps the old base recoverable when a checkpoint uploads but does not publish', async () => {
    const h = await harness({ fault: true })
    const a = await track(h.ns.open('obj', { database: 'mem' }))
    await a.execute('INSERT INTO t VALUES (1)')
    await a.flush()
    const walBefore = a.manifest.wal.map((w) => w.key)

    await a.execute('INSERT INTO t VALUES (2)')
    for (let i = 0; i < 5; i++) h.faults[0]!.inject({ on: 'replace', result: 'not-replaced' })
    expect(isDurableErrorOf(await catchError(() => a.checkpoint()), 'commit_ambiguous')).toBe(true)

    // Old manifest intact, unflushed statement still buffered.
    expect(a.manifest.base).toBeNull()
    expect(a.manifest.wal.map((w) => w.key)).toEqual(walBefore)
    expect(a.pendingStatements).toBe(1)
    // The uploaded checkpoint is an orphan, not a new base.
    expect((await listed(join(h.objectDir, 'checkpoints'))).length).toBe(1)
  })

  it('closes the partial engine and releases the lease when replay fails', async () => {
    const h = await harness()
    const a = await track(h.ns.open('obj', { database: 'mem' }))
    await a.execute('INSERT INTO t VALUES (1)')
    await a.flush()
    await a.close()
    open.length = 0

    const before = await readdir(h.root)
    // The next engine refuses to replay.
    const failing = new FakeEngine()
    failing.failNextRun = new Error('replay exploded')
    const ns = new DurableNamespace(pathToFileURL(h.root).href, {
      engineFactory: () => failing,
      backendFactory: (id) => new LocalDurableBackend({ root: join(h.root, id) }),
      tuning: FAST,
      scratchRoot: h.root,
    })
    await expect(ns.open('obj')).rejects.toThrow('replay exploded')

    expect(failing.closed).toBe(true)
    // The lease was released, so a healthy writer can still take the object.
    const recovered = await track(h.ns.open('obj'))
    expect(recovered.manifest.wal).toHaveLength(1)
    // And no scratch tree was left behind.
    const after = await readdir(h.root)
    expect(after.filter((d) => d.startsWith('chdb-durable-')).length).toBeLessThanOrEqual(
      before.filter((d) => d.startsWith('chdb-durable-')).length + 1,
    )
  })

  it('surfaces a failed close flush and still releases local resources', async () => {
    const h = await harness({ fault: true })
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')
    for (let i = 0; i < 6; i++) h.faults[0]!.inject({ on: 'replace', result: 'not-replaced' })

    const e = await catchError(() => o.close())
    expect(isDurableErrorOf(e, 'commit_ambiguous')).toBe(true)
    expect(h.engines[0]!.closed).toBe(true)
    expect(existsSync(o.scratchPath)).toBe(false)
    open.length = 0

    expect(isDurableErrorOf(await catchError(() => o.execute('INSERT INTO t VALUES (2)')), 'closed')).toBe(true)
  })
})

describe('corruption', () => {
  async function objectWithWal(): Promise<Harness> {
    const h = await harness()
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')
    await o.flush()
    await o.close()
    open.length = 0
    return h
  }

  it('refuses to open when a referenced WAL segment is gone', async () => {
    const h = await objectWithWal()
    const dir = join(h.objectDir, 'wal')
    for (const f of await readdir(dir)) await unlink(join(dir, f))
    expect(isDurableErrorOf(await catchError(() => h.ns.open('obj')), 'corrupt')).toBe(true)
  })

  it('refuses to open when a WAL segment does not match its digest', async () => {
    const h = await objectWithWal()
    const dir = join(h.objectDir, 'wal')
    const [name] = await readdir(dir)
    const path = join(dir, name as string)
    const size = (await stat(path)).size
    // Same length, different bytes: only the checksum can catch this.
    await unlink(path)
    await writeFile(path, 'x'.repeat(size))
    const e = await catchError(() => h.ns.open('obj'))
    expect(isDurableErrorOf(e, 'corrupt')).toBe(true)
    expect((e as Error).message).toMatch(/sha256/)
  })

  it('refuses to open when a WAL segment is the wrong length', async () => {
    const h = await objectWithWal()
    const dir = join(h.objectDir, 'wal')
    const [name] = await readdir(dir)
    const path = join(dir, name as string)
    const body = await readFile(path)
    await unlink(path)
    await writeFile(path, Buffer.concat([body, Buffer.from('\n')]))
    const e = await catchError(() => h.ns.open('obj'))
    expect(isDurableErrorOf(e, 'corrupt')).toBe(true)
    expect((e as Error).message).toMatch(/size/)
  })

  it('refuses to open when the base checkpoint is gone', async () => {
    const h = await harness()
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    await o.execute('INSERT INTO t VALUES (1)')
    await o.checkpoint()
    await o.close()
    open.length = 0

    const dir = join(h.objectDir, 'checkpoints')
    for (const f of await readdir(dir)) await unlink(join(dir, f))
    expect(isDurableErrorOf(await catchError(() => h.ns.open('obj')), 'corrupt')).toBe(true)
  })
})

describe('foreign heads', () => {
  /** A head as another binding would have written it: plain file, unknown fields. */
  async function writeForeignHead(objectDir: string, extra: Record<string, unknown>): Promise<void> {
    const be = new LocalDurableBackend({ root: objectDir })
    await be.putBytesIfAbsent(
      'head.json',
      Buffer.from(
        JSON.stringify({
          protocol: { version: 1, reader_features: [], writer_features: [], vendor_flag: 7 },
          engine: { name: 'chdb', version: '26.7.0', built_by: 'python' },
          lease: { generation: 4, owner: null, instance: null, expires_at: null },
          manifest: { db: 'mem', base: null, wal: [], seq: 2, vendor_note: 'keep' },
          top_level_extension: ['a', 'b'],
          ...extra,
        }),
      ),
    )
  }

  it('preserves unknown fields across open, execute, flush, checkpoint and close', async () => {
    const h = await harness()
    await writeForeignHead(h.objectDir, {})

    const o = await track(h.ns.open('obj'))
    expect(o.generation).toBe(5)
    await o.execute('INSERT INTO t VALUES (1)')
    await o.flush()
    await o.checkpoint()
    await o.close()
    open.length = 0

    const stored = JSON.parse(await readFile(join(h.objectDir, 'head.json'), 'utf8'))
    expect(stored.top_level_extension).toEqual(['a', 'b'])
    expect(stored.protocol.vendor_flag).toBe(7)
    expect(stored.engine.built_by).toBe('python')
    expect(stored.manifest.vendor_note).toBe('keep')
    // And this build's own fields moved on.
    expect(stored.manifest.base).not.toBeNull()
    expect(stored.manifest.wal).toEqual([])
    expect(stored.lease.owner).toBeNull()
  })

  it('refuses an object whose engine version is not exactly ours', async () => {
    const h = await harness()
    const be = new LocalDurableBackend({ root: h.objectDir })
    await be.putBytesIfAbsent(
      'head.json',
      Buffer.from(
        JSON.stringify({
          protocol: { version: 1, reader_features: [], writer_features: [] },
          engine: { name: 'chdb', version: '26.6.0' },
          lease: { generation: 1, owner: null, instance: null, expires_at: null },
          manifest: { db: 'mem', base: null, wal: [], seq: 0 },
        }),
      ),
    )
    expect(isDurableErrorOf(await catchError(() => h.ns.open('obj')), 'engine_incompatible')).toBe(true)
  })

  it('allows a read-only open but refuses the lease on an unknown writer feature', async () => {
    const h = await harness()
    await writeForeignHead(h.objectDir, {
      protocol: { version: 1, reader_features: [], writer_features: ['data-wal'] },
    })
    expect(isDurableErrorOf(await catchError(() => h.ns.open('obj')), 'protocol_unsupported')).toBe(true)
    const r = await track(h.ns.open('obj', { readOnly: true }))
    expect(r.readOnly).toBe(true)
  })

  it('refuses any open on an unknown reader feature', async () => {
    const h = await harness()
    await writeForeignHead(h.objectDir, {
      protocol: { version: 1, reader_features: ['preamble'], writer_features: [] },
    })
    expect(isDurableErrorOf(await catchError(() => h.ns.open('obj', { readOnly: true })), 'protocol_unsupported')).toBe(true)
    expect(isDurableErrorOf(await catchError(() => h.ns.open('obj')), 'protocol_unsupported')).toBe(true)
  })
})

describe('write barriers', () => {
  it('coalesces concurrent waiters onto a single head commit', async () => {
    const h = await harness()
    const o = await track(h.ns.open('obj', { database: 'mem' }))

    const tickets = []
    for (let i = 0; i < 5; i++) tickets.push(await o.execute(`INSERT INTO t VALUES (${i})`))
    await Promise.all(tickets.map((t) => o.flushThrough(t)))

    // One segment, not five: the first waiter through the queue published a
    // segment covering all of them and the rest found their watermark met.
    expect(o.manifest.wal).toHaveLength(1)
    expect(o.manifest.seq).toBe(1)
    expect((await listed(join(h.objectDir, 'wal'))).length).toBe(1)
  })

  it('is a no-op for a ticket already covered', async () => {
    const h = await harness()
    const o = await track(h.ns.open('obj', { database: 'mem' }))
    const t = await o.execute('INSERT INTO t VALUES (1)')
    await o.flushThrough(t)
    const seq = o.manifest.seq
    await o.flushThrough(t)
    expect(o.manifest.seq).toBe(seq)
  })
})
