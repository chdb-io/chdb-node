#!/usr/bin/env node
/**
 * Can another binding read what this one wrote, and the other way round?
 *
 * The V1 contract's cross-binding requirement is that a writer's object be
 * readable by the other implementations — the on-disk format is the interface,
 * not any one library's API. Python (`chdb` >= 4.4.0) and Go have both reached
 * V1, and this pairs Node against each of them.
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
 * Each pairing is skipped, loudly, when its runtime is absent — so the script
 * is useful with either one installed.
 *
 * ```sh
 * python3 -m venv /tmp/pyenv && /tmp/pyenv/bin/pip install 'chdb>=4.4.0'
 * git clone https://github.com/chdb-io/chdb-go /tmp/chdb-go
 * npm run build            # the addon must carry the durable ABI
 *
 * CHDB_PYTHON=/tmp/pyenv/bin/python \
 * CHDB_GO_REPO=/tmp/chdb-go \
 *   node scripts/durable-cross-binding.mjs
 * ```
 *
 * Go loads its engine through `CHDB_LIB_PATH`, which this script points at
 * this repository's `libchdb.so` — so both sides run the same engine build
 * and a difference in results is a difference in bindings, not in versions.
 *
 * Not in CI: it needs other language runtimes with their own engine builds.
 * Run it when adopting an engine, and record the result in
 * docs/design/durable-control-plane.md.
 */

import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
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

const { DurableNamespace, nodeEngineFactory } = require('./dist/durable/node.js')

const GO_REPO = process.env.CHDB_GO_REPO
const LIBCHDB = join(process.cwd(), 'libchdb.so')

function goAvailable() {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The Go side, as a throwaway module that `replace`s chdb-go to the checkout.
 *
 * Built rather than `go run` so a compile error surfaces once, before any
 * object is written, instead of once per invocation.
 */
function buildGoHelper() {
  const dir = mkdtempSync(join(tmpdir(), 'xbind-go-src-'))
  writeFileSync(
    join(dir, 'go.mod'),
    `module xbindgo\n\ngo 1.24\n\nrequire github.com/chdb-io/chdb-go/v2 v2.0.0\n\n` +
      `replace github.com/chdb-io/chdb-go/v2 => ${GO_REPO}\n`,
  )
  writeFileSync(join(dir, 'main.go'), GO_MAIN)
  // The checkout's own go.sum covers these; tidy writes ours from it.
  execFileSync('go', ['mod', 'tidy'], { cwd: dir, stdio: 'ignore', env: goEnv() })
  const bin = join(dir, 'xbindgo')
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: dir, stdio: 'inherit', env: goEnv() })
  return bin
}

/** Go finds its engine through CHDB_LIB_PATH; point it at ours so both sides
 *  run one engine build and a difference is a binding difference. */
function goEnv() {
  return { ...process.env, CHDB_LIB_PATH: LIBCHDB }
}

function runGo(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', env: goEnv() })
}

const GO_MAIN = `package main

import (
	"context"
	"fmt"
	"os"

	"github.com/chdb-io/chdb-go/v2/chdb/durable"
)

func main() {
	phase, root := os.Args[1], os.Args[2]
	ctx := context.Background()

	ns, err := durable.NewNamespace("file://"+root+"/ns", durable.NamespaceOptions{
		ScratchRoot: root + "/scratch-go",
		Tuning:      durable.Tuning{LeaseTTL: 120e9, HeartbeatInterval: 30e9},
	})
	must(err)

	switch phase {
	case "write":
		obj, _, err := ns.Open(ctx, "goobj", durable.OpenOptions{Database: "default"})
		must(err)
		_, err = obj.Execute(ctx, "CREATE TABLE g (id UInt64, note String) ENGINE = MergeTree ORDER BY id")
		must(err)
		_, err = obj.Execute(ctx, "INSERT INTO g VALUES (1, 'go-one'), (2, 'go-two')")
		must(err)
		_, err = obj.Checkpoint(ctx)
		must(err)
		_, err = obj.Execute(ctx, "INSERT INTO g VALUES (3, 'go-three')")
		must(err)
		_, err = obj.Flush(ctx)
		must(err)
		must(obj.Close(ctx))
	case "read":
		obj, _, err := ns.Open(ctx, os.Args[3], durable.OpenOptions{})
		must(err)
		out, err := obj.Query(ctx, "SELECT id, note FROM "+os.Args[4]+" ORDER BY id", "CSV")
		must(err)
		fmt.Print(out)
		must(obj.Close(ctx))
	default:
		fmt.Fprintln(os.Stderr, "unknown phase "+phase)
		os.Exit(2)
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "ERR:", err)
		os.Exit(1)
	}
}
`

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

let ran = 0

if (!pyVersion) {
  console.log(
    `SKIP  Python — ${PYTHON} has no chdb.durable.\n` +
      `      python3 -m venv /tmp/pyenv && /tmp/pyenv/bin/pip install 'chdb>=4.4.0'\n`,
  )
}

try {
  if (pyVersion) {
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
  ran++
  }

  // ---- Go ----
  if (!GO_REPO) {
    console.log(
      '\nSKIP  Go — set CHDB_GO_REPO to a chdb-go checkout.\n' +
        '      git clone https://github.com/chdb-io/chdb-go /tmp/chdb-go\n',
    )
  } else if (!goAvailable()) {
    console.log('\nSKIP  Go — no `go` on PATH.\n')
  } else {
    console.log('')
    const bin = buildGoHelper()
    // Go does not create its ScratchRoot either.
    mkdirSync(join(root, 'scratch-go'), { recursive: true })

    // Go writes a base plus a WAL segment on top.
    runGo(bin, ['write', root])

    // Node restores the Go base and replays the Go WAL, then appends.
    {
      const ns = namespace(`file://${root}/ns`, 'xbind-go')
      const phases = []
      const obj = await ns.open('goobj', { onRestoreProgress: (p) => phases.push(p.phase) })
      const rows = await obj.query('SELECT id, note FROM g ORDER BY id', { format: 'CSV' })
      report('Node restores a Go base', phases.includes('restoring-base'))
      report('Node replays a Go WAL', phases.includes('replaying-wal'))
      report(
        'Go -> Node rows match',
        rows === '1,"go-one"\n2,"go-two"\n3,"go-three"\n',
        rows.trim().replace(/\n/g, ' | '),
      )
      await obj.execute("INSERT INTO g VALUES (4, 'node-four')")
      await obj.flush()
      await obj.close()
    }

    // Go reads Node's append back.
    {
      const out = runGo(bin, ['read', root, 'goobj', 'g'])
      report(
        'Node -> Go rows match',
        out === '1,"go-one"\n2,"go-two"\n3,"go-three"\n4,"node-four"\n',
        out.trim().replace(/\n/g, ' | '),
      )
    }

    // Node checkpoints; Go restores from that archive with no WAL left.
    {
      const ns = namespace(`file://${root}/ns`, 'xbind-go-nw')
      const obj = await ns.open('nodeobj-go', { database: 'default' })
      await obj.execute('CREATE TABLE n (id UInt64, note String) ENGINE = MergeTree ORDER BY id')
      await obj.execute("INSERT INTO n VALUES (1, 'from-node')")
      await obj.checkpoint()
      report('Node checkpoint left no WAL (for Go)', obj.manifest.wal.length === 0)
      await obj.close()

      const out = runGo(bin, ['read', root, 'nodeobj-go', 'n'])
      report("Go RESTOREs Node's archive", out === '1,"from-node"\n', out.trim())
    }
    ran++
  }

  if (ran === 0) {
    console.error('\nNo other binding was available, so nothing was verified.')
    failed = true
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failed ? '\nSOMETHING FAILED' : '\nall exchanges hold')
process.exit(failed ? 1 : 0)
