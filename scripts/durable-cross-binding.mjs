#!/usr/bin/env node
/**
 * Can another binding read what this one wrote, and the other way round?
 *
 * The V1 contract's cross-binding requirement is that a writer's object be
 * readable by the other implementations — the on-disk format is the interface,
 * not any one library's API. Python (`chdb` ≥ 4.4.0) and Go both reached V1,
 * so this pairs Node against Python; Go is not covered here.
 *
 * Four exchanges, because each proves something the others do not:
 *
 *  1. Python writes a base archive plus a WAL segment; Node opens it. Proves
 *     Node can RESTORE a foreign archive and replay a foreign WAL.
 *  2. Node appends to that same object; Python reads it back. Proves a
 *     foreign writer's head/CAS/lease round trip is accepted.
 *  3. Node creates its own object and checkpoints; Python restores purely
 *     from Node's base, with no WAL left. The strongest direction: Python's
 *     engine RESTOREs an archive Node's BACKUP produced.
 *  4. Both spellings of the local backend URL name the same object — Python
 *     writes `local:`, Node reads the identical string.
 *
 * ```sh
 * python3 -m venv /tmp/pyenv && /tmp/pyenv/bin/pip install 'chdb>=4.4.0'
 * npm run build            # the addon must carry the durable ABI
 * CHDB_PYTHON=/tmp/pyenv/bin/python node scripts/durable-cross-binding.mjs
 * ```
 *
 * Not in CI: it needs a second language runtime with its own engine build.
 * Run it when adopting an engine, and record the result in
 * docs/design/durable-control-plane.md.
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'

const require = createRequire(join(process.cwd(), 'package.json'))
const PYTHON = process.env.CHDB_PYTHON ?? 'python3'

function pythonHasDurable() {
  try {
    const v = execFileSync(PYTHON, ['-c', 'import chdb,chdb.durable;print(chdb.__version__)'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return v
  } catch {
    return null
  }
}

const pyVersion = pythonHasDurable()
if (!pyVersion) {
  console.error(
    `${PYTHON} has no chdb.durable. Install it:\n` +
      `  python3 -m venv /tmp/pyenv && /tmp/pyenv/bin/pip install 'chdb>=4.4.0'\n` +
      `  CHDB_PYTHON=/tmp/pyenv/bin/python node scripts/durable-cross-binding.mjs`,
  )
  process.exit(2)
}

const { DurableNamespace, nodeEngineFactory } = require('./dist/durable/node.js')

const root = mkdtempSync(join(tmpdir(), 'durable-xbind-'))
let failed = false

function report(claim, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

/** Run a Python snippet against the shared namespace; returns its stdout. */
function python(body) {
  const file = join(root, `py-${Math.random().toString(36).slice(2)}.py`)
  writeFileSync(file, body)
  return execFileSync(PYTHON, [file], { encoding: 'utf8', env: { ...process.env, XBIND_ROOT: root } })
}

/** A namespace on the shared directory, driven by this package's addon. */
function namespace(url, scratchName) {
  return new DurableNamespace(url, {
    engineFactory: nodeEngineFactory(),
    scratchRoot: mkdtempSync(join(tmpdir(), `${scratchName}-`)),
    tuning: { leaseTtlMs: 120_000, heartbeatIntervalMs: 30_000 },
  })
}

const NODE_ENGINE = await (async () => {
  const { ChdbNodeEngine } = require('./dist/durable/node.js')
  return new ChdbNodeEngine().version()
})()
console.log(`node addon engine ${NODE_ENGINE}   <->   python chdb ${pyVersion}\n`)

try {
  // 1. Python writes base + WAL.
  python(`
import os
from chdb.durable import Namespace
ns = Namespace('file://' + os.environ['XBIND_ROOT'] + '/ns', db='default')
o = ns.open('shared')
o.execute("CREATE TABLE events (id UInt64, note String) ENGINE = MergeTree ORDER BY id")
o.execute("INSERT INTO events VALUES (1, 'py-one'), (2, 'py-two')")
o.checkpoint()
o.execute("INSERT INTO events VALUES (3, 'py-three')")
o.flush()
o.close()
`)

  // 2. Node restores it, then appends.
  {
    const ns = namespace(`file://${root}/ns`, 'xbind-node')
    const phases = []
    const obj = await ns.open('shared', { onRestoreProgress: (p) => phases.push(p.phase) })
    const rows = await obj.query('SELECT id, note FROM events ORDER BY id', { format: 'CSV' })
    report('Node restores a Python base', phases.includes('restoring-base'))
    report('Node replays a Python WAL', phases.includes('replaying-wal'))
    report(
      'Python -> Node rows match',
      rows === '1,"py-one"\n2,"py-two"\n3,"py-three"\n',
      rows.trim().replace(/\n/g, ' | '),
    )
    await obj.execute("INSERT INTO events VALUES (4, 'node-four')")
    await obj.flush()
    await obj.close()
  }

  // 3. Python reads Node's append.
  {
    const out = python(`
import os
from chdb.durable import Namespace
ns = Namespace('file://' + os.environ['XBIND_ROOT'] + '/ns', db='default')
o = ns.open('shared')
print(o.query('SELECT id, note FROM events ORDER BY id','CSV').bytes().decode(), end='')
o.close()
`)
    report(
      'Node -> Python rows match',
      out === '1,"py-one"\n2,"py-two"\n3,"py-three"\n4,"node-four"\n',
      out.trim().replace(/\n/g, ' | '),
    )
  }

  // 4. Node creates its own object and checkpoints; Python restores from that
  //    base alone, with no WAL to fall back on.
  {
    const ns = namespace(`file://${root}/ns`, 'xbind-nw')
    const obj = await ns.open('nodeobj', { database: 'default' })
    await obj.execute('CREATE TABLE t (id UInt64, note String) ENGINE = MergeTree ORDER BY id')
    await obj.execute("INSERT INTO t VALUES (1, 'from-node')")
    await obj.checkpoint()
    report('Node checkpoint left no WAL', obj.manifest.wal.length === 0)
    await obj.close()

    const out = python(`
import os
from chdb.durable import Namespace
ns = Namespace('file://' + os.environ['XBIND_ROOT'] + '/ns', db='default')
o = ns.open('nodeobj')
assert len(o.wal) == 0, 'expected a checkpoint-only object'
print(o.query('SELECT id, note FROM t','CSV').bytes().decode(), end='')
o.close()
`)
    report("Python RESTOREs Node's archive", out === '1,"from-node"\n', out.trim())
  }

  // 5. One `local:` URL string, both bindings.
  {
    const url = `local:${root}/shared-url`
    python(`
import os
from chdb.durable import Namespace
ns = Namespace('local:' + os.environ['XBIND_ROOT'] + '/shared-url', db='default')
o = ns.open('o')
o.execute("CREATE TABLE u (who String) ENGINE = MergeTree ORDER BY who")
o.execute("INSERT INTO u VALUES ('python')")
o.flush()
o.close()
`)
    const ns = namespace(url, 'xbind-url')
    const obj = await ns.open('o')
    const rows = await obj.query('SELECT who FROM u', { format: 'CSV' })
    report('one local: URL serves both bindings', rows === '"python"\n', rows.trim())
    await obj.close()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failed ? '\nSOMETHING FAILED' : '\nall exchanges hold')
process.exit(failed ? 1 : 0)
