#!/usr/bin/env node
/**
 * Run clickhouse-js's OWN integration suite against embedded chDB (design §6①).
 *
 * clickhouse-js (>= the vitest migration) runs its tests on vitest, exercising a
 * client built from `globalThis.environmentSpecificCreateClient`. We clone it at
 * the version matching the installed `@clickhouse/client`, point that single
 * factory at embedded `chdb://memory` (so the suite's own specs run unmodified
 * against chDB), drop the server-only suites via `skip-list.json`, apply
 * `expectations.patch` to mark the documented embedded-vs-server divergences as
 * expected, and run vitest serially (one active connection per process).
 *
 * This is GATING: with the skip-list + expectations patch applied, the remaining
 * suite must be green, proving the byte-compat surface against clickhouse-js's
 * own assertions. New, unexpected failures are real regressions.
 *
 * Usage: node scripts/upstream-suite/rewrite-and-run.mjs [--keep] [--list]
 * Env:   CHDB_PACKAGE_ROOT  built chdb package root (default: repo root)
 *        UPSTREAM_REF       git ref to clone (default: installed client version)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const workDir = join(__dirname, 'clickhouse-js-tmp') // matches repo .gitignore `*-tmp/`
const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const LIST = args.includes('--list')
const banner = (m) => console.log(`\n── [upstream-suite] ${m}`)
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: 'inherit', ...opts })

// 1) Resolve the clickhouse-js version we claim compatibility with.
const installed = JSON.parse(
  readFileSync(join(repoRoot, 'node_modules/@clickhouse/client/package.json'), 'utf8'),
)
const version = process.env.UPSTREAM_REF || installed.version
banner(`target clickhouse-js ref: ${version}`)

// 2) Fresh clone at the matching tag (try bare and v-prefixed).
if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })
const repo = 'https://github.com/ClickHouse/clickhouse-js.git'
let cloned = false
for (const ref of [version, `v${version}`]) {
  try {
    banner(`git clone --depth 1 --branch ${ref}`)
    sh('git', ['clone', '--depth', '1', '--branch', ref, repo, workDir])
    cloned = true
    break
  } catch {
    rmSync(workDir, { recursive: true, force: true })
    mkdirSync(workDir, { recursive: true })
  }
}
if (!cloned) {
  console.error(`[upstream-suite] could not clone clickhouse-js at ${version}. Failing.`)
  process.exit(1)
}

// 3) Discover integration specs; apply the file-level skip-list.
const skip = JSON.parse(readFileSync(join(__dirname, 'skip-list.json'), 'utf8')).skip
function findSpecs(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) findSpecs(p, acc)
    // client-web uses a fetch transport out of Layer 2's scope; node + common only.
    else if (/\.test\.ts$/.test(entry.name) && /integration/.test(p) && !/client-web/.test(p))
      acc.push(p)
  }
  return acc
}
const allSpecs = findSpecs(workDir)
const skipped = []
const selected = allSpecs.filter((p) => {
  // Match the spec's basename (not the full path) — skip-list entries are
  // documented as basename substrings, so a match value must not accidentally
  // hit an intermediate directory name.
  const name = basename(p).toLowerCase()
  const hit = skip.find((s) => name.includes(s.match.toLowerCase()))
  if (hit) {
    skipped.push({ p, why: hit.why })
    return false
  }
  return true
})
banner(
  `found ${allSpecs.length} integration specs; ${selected.length} selected, ${skipped.length} skipped`,
)
for (const s of skipped) console.log(`   skip ${s.p.replace(workDir + '/', '')} — ${s.why}`)
if (LIST) {
  for (const p of selected) console.log(`   run  ${p.replace(workDir + '/', '')}`)
  process.exit(0)
}
if (selected.length === 0) {
  console.error('[upstream-suite] no specs selected; clickhouse-js layout may have changed. Failing.')
  process.exit(1)
}

// 4) Install the clone's deps (provides vitest + the client sources).
try {
  banner('npm ci (clickhouse-js clone)')
  sh('npm', ['ci'], { cwd: workDir })
} catch {
  banner('npm ci failed; trying npm install')
  sh('npm', ['install'], { cwd: workDir })
}

// 5) Apply the per-case expectations patch (documented embedded-vs-server
//    divergences marked it.fails / it.skip with a reason). Decoupled from the
//    baseline specs so the clickhouse-js source stays pristine.
const patch = join(__dirname, 'expectations.patch')
if (existsSync(patch)) {
  banner('git apply expectations.patch')
  try {
    sh('git', ['apply', '--whitespace=nowarn', patch], { cwd: workDir })
  } catch {
    console.error('[upstream-suite] expectations.patch did not apply cleanly — clickhouse-js specs')
    console.error('  likely drifted from the patched version. Regenerate it (see README.md).')
    process.exit(1)
  }
}

// 6) Redirect the suite's client factory to embedded chDB, and run vitest
//    serially (libchdb allows one active connection per process).
writeFileSync(
  join(workDir, 'chdb-setup.mjs'),
  `import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const chdb = require(${JSON.stringify(process.env.CHDB_PACKAGE_ROOT || repoRoot)} + '/index.js')
// Force every test client onto embedded chDB; keep the suite's clickhouse_settings
// (e.g. output_format_json_quote_64bit_integers), drop url/host/database/auth.
globalThis.environmentSpecificCreateClient = (config = {}) =>
  chdb.createClient({ url: 'chdb://memory', clickhouse_settings: config.clickhouse_settings })
`,
)
const cfg = join(workDir, 'vitest.chdb.config.mts')
writeFileSync(
  cfg,
  `import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ${JSON.stringify(selected.map((p) => p.replace(workDir + '/', '')))},
    setupFiles: ['vitest.node.setup.ts', './chdb-setup.mjs'],
    hookTimeout: 60_000, testTimeout: 60_000,
    pool: 'forks', poolOptions: { forks: { singleFork: true } },
    fileParallelism: false, retry: 0,
  },
  resolve: { alias: {
    '@clickhouse/client-common': 'packages/client-common/src',
    '@clickhouse/client-node': 'packages/client-node/src',
    '@test': 'packages/client-common/__tests__',
  } },
})
`,
)

banner('running clickhouse-js integration specs against embedded chdb')
let code = 0
try {
  sh('npx', ['vitest', 'run', '-c', cfg], {
    cwd: workDir,
    env: { ...process.env, CHDB_PACKAGE_ROOT: process.env.CHDB_PACKAGE_ROOT || repoRoot },
  })
} catch (e) {
  code = e.status ?? 1
  banner(`vitest exited ${code} — unexpected failures (see skip-list.json / expectations.patch)`)
}

if (!KEEP) rmSync(workDir, { recursive: true, force: true })
process.exit(code)
