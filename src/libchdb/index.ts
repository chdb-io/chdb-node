/**
 * `chdb/libchdb` — where the engine shared library is, and nothing else.
 *
 * This module resolves a filesystem path. It does not `require` the addon, it
 * does not `dlopen` anything, and it has no side effects beyond reading the
 * filesystem. That restraint is the whole point: the callers who need it are
 * the ones who load `libchdb` themselves — a Bun `dlopen`, a `koffi` binding,
 * a subprocess — and for them, pulling in `chdb_node.node` would mean two
 * copies of an engine that binds one data path per process.
 *
 * Resolution order, most specific first:
 *
 *   1. `CHDB_LIBCHDB_PATH` — an explicit file. Overrides everything, and is
 *      the intended way to point at a local `chdb-core` build.
 *   2. `CHDB_LIBCHDB_DIR` — a directory to look inside.
 *   3. The platform package `@chdb/lib-<platform>`, located through
 *      `require.resolve` of its `package.json` so the addon is never executed.
 *   4. The repository root, for a working copy that ran `npm run libchdb`.
 *
 * The library file is named `libchdb.so` on every platform this package
 * publishes, macOS included — the platform packages copy it under that name
 * rather than renaming per platform. `libchdb.dylib` is still accepted, since
 * a locally built or hand-placed copy may use the platform-conventional name.
 */

import { existsSync, statSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { createRequire } from 'module'
import { ChdbPlatformUnsupportedError } from '../errors'

/** Names to look for inside a candidate directory, in order. */
const LIBRARY_NAMES = ['libchdb.so', 'libchdb.dylib'] as const

/** Same table as the native loader; kept here so this module imports nothing from it. */
const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  'darwin-arm64': '@chdb/lib-darwin-arm64',
  'darwin-x64': '@chdb/lib-darwin-x64',
  'linux-x64': '@chdb/lib-linux-x64-gnu',
  'linux-arm64': '@chdb/lib-linux-arm64-gnu',
}

export interface ResolveLibchdbOptions {
  /** Search these directories before the built-in candidates. */
  extraDirs?: readonly string[]
  /** Read overrides from here instead of `process.env`. */
  env?: NodeJS.ProcessEnv
}

export interface LibchdbLocation {
  /** Absolute path to the shared library. */
  path: string
  /** Which rule produced it: useful in a startup log when a build looks wrong. */
  source: 'env-file' | 'env-dir' | 'platform-package' | 'repository' | 'extra-dir'
  /** The platform package it came from, when it came from one. */
  packageName?: string
}

function firstLibraryIn(dir: string): string | undefined {
  for (const name of LIBRARY_NAMES) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

/**
 * Locate the engine library, or throw a diagnostic listing everywhere that was
 * tried. Callers that would rather branch than catch can use
 * {@link tryResolveLibchdb}.
 */
export function resolveLibchdb(options: ResolveLibchdbOptions = {}): LibchdbLocation {
  const env = options.env ?? process.env
  const tried: string[] = []

  const explicit = env['CHDB_LIBCHDB_PATH']
  if (explicit) {
    const path = resolve(explicit)
    // An explicit override that is wrong is a configuration mistake, not a
    // reason to quietly fall through to a different library than the operator
    // asked for — that is how a process ends up running an engine nobody
    // intended.
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new ChdbPlatformUnsupportedError(
        `chdb: CHDB_LIBCHDB_PATH points at ${path}, which is not a file`,
      )
    }
    return { path, source: 'env-file' }
  }

  const envDir = env['CHDB_LIBCHDB_DIR']
  if (envDir) {
    const found = firstLibraryIn(resolve(envDir))
    if (found) return { path: found, source: 'env-dir' }
    throw new ChdbPlatformUnsupportedError(
      `chdb: CHDB_LIBCHDB_DIR is ${resolve(envDir)}, which contains none of ${LIBRARY_NAMES.join(', ')}`,
    )
  }

  for (const dir of options.extraDirs ?? []) {
    const abs = isAbsolute(dir) ? dir : resolve(dir)
    const found = firstLibraryIn(abs)
    if (found) return { path: found, source: 'extra-dir' }
    tried.push(abs)
  }

  const key = platformKey()
  const pkg = PLATFORM_PACKAGES[key]
  if (pkg) {
    try {
      // Resolving package.json rather than the package entry point is what
      // keeps this from executing `index.js`, which would load the addon.
      const require_ = createRequire(__filename)
      const manifest = require_.resolve(`${pkg}/package.json`)
      const found = firstLibraryIn(dirname(manifest))
      if (found) return { path: found, source: 'platform-package', packageName: pkg }
      tried.push(`${pkg} (installed, but holds none of ${LIBRARY_NAMES.join(', ')})`)
    } catch {
      tried.push(`${pkg} (not installed)`)
    }
  }

  // A working copy: `npm run libchdb` drops the library at the package root.
  const repoRoot = resolve(__dirname, '..', '..')
  const local = firstLibraryIn(repoRoot)
  if (local) return { path: local, source: 'repository' }
  tried.push(repoRoot)

  const hint =
    process.platform === 'win32'
      ? 'Windows is not supported; use WSL2.'
      : pkg
        ? `Expected optional dependency ${pkg}, or set CHDB_LIBCHDB_PATH.`
        : `Platform ${key} is not supported.`
  throw new ChdbPlatformUnsupportedError(
    `chdb: could not locate libchdb for ${key}. ${hint} Tried: ${tried.join('; ')}`,
  )
}

/** {@link resolveLibchdb} without the throw. */
export function tryResolveLibchdb(options: ResolveLibchdbOptions = {}): LibchdbLocation | undefined {
  try {
    return resolveLibchdb(options)
  } catch {
    return undefined
  }
}

/** Just the path, for callers that only want to hand it to `dlopen`. */
export function libchdbPath(options: ResolveLibchdbOptions = {}): string {
  return resolveLibchdb(options).path
}
