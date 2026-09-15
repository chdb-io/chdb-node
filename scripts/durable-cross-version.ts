/**
 * Does a newer engine restore what an older one wrote?
 *
 * That is the compatibility promise `chdb/durable` rests on — the `min_reader`
 * and `backup_format` gates exist to admit exactly this case — and until
 * `26.7.3` shipped it could not be tested, because `26.7.2-rc.2` was the first
 * engine with the durable ABI and there was nothing earlier to restore.
 *
 * Three claims, in order:
 *
 *  1. an object written by the OLD engine (full checkpoint plus a WAL segment
 *     on top) opens on the NEW one and yields the same rows;
 *  2. the floor rises on that write — `min_reader` becomes the new version —
 *     and the OLD engine is then refused with `engine_incompatible` rather
 *     than left to fail partway through RESTORE;
 *  3. neither direction silently half-works.
 *
 * Runs under Bun because the addon links one engine at build time, while
 * `bun:ffi` can `dlopen` whichever it is handed.
 *
 * Each stage runs in its OWN process, and that is not tidiness. A libchdb is
 * `dlopen`ed once per process — `loadLibchdb` caches it, and it has to,
 * because the engine binds one data path per process and a second `dlopen`
 * would be a second EmbeddedServer. So a single-process version of this
 * script silently tests one engine twice: the first library loaded answers
 * every later request, both versions report the same number, and the floor
 * never rises. It passes while proving nothing. Hence the re-exec below.
 *
 * ```sh
 * CHDB_LIBCHDB_OLD=/path/to/26.7.2-rc.2/libchdb.so \
 * CHDB_LIBCHDB_NEW=/path/to/26.7.3/libchdb.so \
 *   bun scripts/durable-cross-version.ts
 * ```
 *
 * Not in CI: it needs two ~100 MB engine downloads, and what it checks moves
 * only when core releases. Run it when adopting an engine, and record the
 * result in docs/design/durable-control-plane.md.
 */

import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { DurableNamespace } from '../src/durable/namespace'
import { isDurableErrorOf } from '../src/durable/errors'
import { LibchdbFfiEngine } from '../test/durable/libchdb-ffi'

const OLD = process.env['CHDB_LIBCHDB_OLD']
const NEW = process.env['CHDB_LIBCHDB_NEW']
if (!OLD || !NEW) {
  console.error(
    'Set CHDB_LIBCHDB_OLD and CHDB_LIBCHDB_NEW to two libchdb builds.\n' +
      'Fetch one with: curl -L -o old.tar.gz \\\n' +
      '  https://github.com/chdb-io/chdb-core/releases/download/v26.7.2-rc.2/macos-arm64-libchdb.tar.gz',
  )
  process.exit(2)
}

const ROWS = '1,"before-checkpoint"\n2,"also-before"\n3,"after-checkpoint"\n'

/** One namespace over a shared object store, driven by the given engine. */
async function namespaceOn(library: string, root: string, scratch: string): Promise<DurableNamespace> {
  await mkdir(scratch, { recursive: true })
  return new DurableNamespace(`file://${root}/ns`, {
    engineFactory: () => new LibchdbFfiEngine({ libraryPath: library }),
    scratchRoot: scratch,
    // Long enough that a checkpoint never races the lease on a slow machine.
    tuning: { leaseTtlMs: 120_000, heartbeatIntervalMs: 30_000 },
  })
}

function report(claim: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const phase = process.env['XVER_PHASE']
const root = process.env['XVER_ROOT']

if (phase && root) {
  // ---- a single stage, in its own process with exactly one engine ----
  if (phase === 'write') {
    const ns = await namespaceOn(OLD, root, join(root, 'scratch-old'))
    const obj = await ns.open('xver', { database: 'default' })
    await obj.execute('CREATE TABLE events (id UInt64, note String) ENGINE = MergeTree ORDER BY id')
    await obj.execute("INSERT INTO events VALUES (1, 'before-checkpoint'), (2, 'also-before')")
    await obj.checkpoint()
    await obj.execute("INSERT INTO events VALUES (3, 'after-checkpoint')")
    await obj.flush()
    await obj.close()
    console.log(`WROTE ${await new LibchdbFfiEngine({ libraryPath: OLD }).version()}`)
  } else if (phase === 'restore') {
    const ns = await namespaceOn(NEW, root, join(root, 'scratch-new'))
    const phases: string[] = []
    const obj = await ns.open('xver', { onRestoreProgress: (p) => phases.push(p.phase) })
    const rows = await obj.query('SELECT id, note FROM events ORDER BY id', { format: 'CSV' })
    report('new engine restores the old base', phases.includes('restoring-base'))
    report('and replays the WAL on top', phases.includes('replaying-wal'))
    report('rows survive the version change', rows === ROWS, rows === ROWS ? '' : JSON.stringify(rows))
    await obj.close()
    console.log(`RESTORED ${await new LibchdbFfiEngine({ libraryPath: NEW }).version()}`)
  } else if (phase === 'refuse') {
    const ns = await namespaceOn(OLD, root, join(root, 'scratch-back'))
    const e = await ns.open('xver').then(
      (o) => o.close().then(() => undefined),
      (err: unknown) => err,
    )
    report(
      'old engine refused once the floor rose',
      isDurableErrorOf(e, 'engine_incompatible'),
      e instanceof Error ? e.message.slice(0, 110) : 'it opened',
    )
  } else {
    console.error(`unknown XVER_PHASE ${phase}`)
    process.exit(2)
  }
  process.exit(process.exitCode ?? 0)
}

// ---- orchestrator ----
const workdir = await mkdtemp(join(tmpdir(), 'durable-xver-'))
let failed = false
try {
  console.log(`old: ${OLD}\nnew: ${NEW}\n`)
  for (const stage of ['write', 'restore', 'refuse'] as const) {
    const proc = Bun.spawnSync({
      cmd: [process.execPath, import.meta.path],
      env: { ...process.env, XVER_PHASE: stage, XVER_ROOT: workdir },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (proc.exitCode !== 0) failed = true
  }
} finally {
  await rm(workdir, { recursive: true, force: true })
}

console.log(failed ? '\nSOMETHING FAILED' : '\nall claims hold')
process.exit(failed ? 1 : 0)
