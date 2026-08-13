#!/usr/bin/env node
// The @chdb/lib-<platform> version has to say which engine is inside it, and the
// main package has to pin exactly that. Both are edited by hand, in two files, and
// getting them out of step fails in the worst possible way: optionalDependencies
// that cannot resolve are skipped without an error, so the install succeeds and the
// user meets it later as ERR_DLOPEN_FAILED with no native binding.
//
// The scheme, keyed off CHDB_ENGINE_PIN:
//
//   engine v26.7.2        ->  26.7.2-stable.N     N counts repackagings of the
//   engine v26.7.3-rc.1   ->  26.7.3-rc.1.N       same engine (addon-only changes)
//
// N starts at 1 and goes up whenever the subpackage is rebuilt for an engine it has
// already shipped — npm forbids republishing a version, so an addon fix with no
// engine change still needs a new number.
//
// Everything here is derived from the engine pin rather than checked for internal
// consistency, so bumping the engine and forgetting the npm version is caught too.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const PLATFORMS = [
  '@chdb/lib-darwin-arm64',
  '@chdb/lib-darwin-x64',
  '@chdb/lib-linux-arm64-gnu',
  '@chdb/lib-linux-x64-gnu',
]

const shell = readFileSync(join(root, 'update_libchdb.sh'), 'utf8')
const readVar = (name) => {
  const m = shell.match(new RegExp(`^${name}=(.+)$`, 'm'))
  if (!m) fail(`update_libchdb.sh has no ${name}= line`)
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const problems = []
function fail(msg) { problems.push(msg) }

const pin = readVar('CHDB_ENGINE_PIN')
const npmVersion = readVar('LIBCHDB_NPM_VERSION')

// v26.7.2 -> "26.7.2-stable."   |   v26.7.3-rc.1 -> "26.7.3-rc.1."
let prefix = null
const stable = /^v(\d+\.\d+\.\d+)$/.exec(pin)
const rc = /^v(\d+\.\d+\.\d+-rc\.\d+)$/.exec(pin)
if (stable) prefix = `${stable[1]}-stable.`
else if (rc) prefix = `${rc[1]}.`
else fail(`CHDB_ENGINE_PIN is ${pin}, which is neither vX.Y.Z nor vX.Y.Z-rc.N — ` +
          `if chdb-core has started tagging some other way, this script needs to learn it`)

if (prefix) {
  if (!npmVersion.startsWith(prefix)) {
    fail(`LIBCHDB_NPM_VERSION is ${npmVersion}, and engine ${pin} calls for ` +
         `${prefix}N. Bumping the engine means bumping this too.`)
  } else {
    const counter = npmVersion.slice(prefix.length)
    if (!/^[1-9]\d*$/.test(counter)) {
      fail(`LIBCHDB_NPM_VERSION is ${npmVersion}; the part after ${prefix} should be ` +
           `a counter starting at 1, and it is ${JSON.stringify(counter)}`)
    }
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const optional = pkg.optionalDependencies || {}

for (const name of PLATFORMS) {
  if (!(name in optional)) {
    fail(`package.json optionalDependencies is missing ${name}`)
    continue
  }
  if (optional[name] !== npmVersion) {
    fail(`package.json pins ${name} at ${optional[name]}, LIBCHDB_NPM_VERSION is ` +
         `${npmVersion}. These must be identical and exact: a range would not match ` +
         `at all, because a version with a -suffix is a semver prerelease.`)
  }
}
for (const name of Object.keys(optional)) {
  if (name.startsWith('@chdb/lib-') && !PLATFORMS.includes(name)) {
    fail(`package.json pins ${name}, which is not one of the four platforms this ` +
         `script knows about — add it here if it is real`)
  }
}

if (problems.length) {
  console.error('Version scheme check failed:\n')
  for (const p of problems) console.error(`  - ${p}\n`)
  console.error(`  engine pin           ${pin}`)
  console.error(`  LIBCHDB_NPM_VERSION  ${npmVersion}`)
  console.error(`  optionalDependencies ${JSON.stringify(optional, null, 2).replace(/\n/g, '\n  ')}`)
  process.exit(1)
}

console.log(`engine ${pin} -> @chdb/lib-* ${npmVersion}, pinned identically in package.json`)
