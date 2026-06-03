/**
 * Native binding loader (design §4 / Item 1). Resolves the prebuilt native
 * addon at runtime without any local compilation:
 *
 *   1. the matching per-platform subpackage @chdb/lib-<platform> (the published
 *      path — installed via optionalDependencies + os/cpu filtering), then
 *   2. a locally compiled build/Release/chdb_node.node (the dev path), then
 *   3. a diagnostic ChdbPlatformUnsupportedError.
 *
 * No postinstall download: binaries come only from versioned npm subpackages.
 */

import { join } from 'path'
import { ChdbPlatformUnsupportedError, ChdbBinaryVersionMismatchError } from './errors'

/** First-batch platforms (D7): no musl, no Windows. */
const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  'darwin-arm64': '@chdb/lib-darwin-arm64',
  'darwin-x64': '@chdb/lib-darwin-x64',
  'linux-x64': '@chdb/lib-linux-x64-gnu',
  'linux-arm64': '@chdb/lib-linux-arm64-gnu',
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

let cached: unknown

/**
 * Load the native addon (cached). Throws a typed, diagnostic error when no
 * binding is available.
 */
export function loadNative(): any {
  if (cached) return cached
  const key = platformKey()
  const pkg = PLATFORM_PACKAGES[key]
  const tried: string[] = []

  // 1) per-platform subpackage (prod)
  if (pkg) {
    try {
      cached = require(pkg)
      return cached
    } catch (e: any) {
      if (e && e.code !== 'MODULE_NOT_FOUND') {
        // Present but unloadable: ABI/version mismatch, missing libchdb, a
        // cross-arch copy, or a dirty lockfile.
        throw new ChdbBinaryVersionMismatchError(
          `failed to load native binding from ${pkg}: ${e.message}. ` +
            `Try: rm -rf node_modules && npm ci`,
          { cause: e },
        )
      }
      tried.push(`${pkg} (not installed)`)
    }
  }

  // 2) locally compiled addon (dev)
  try {
    cached = require(join(__dirname, '..', 'build', 'Release', 'chdb_node.node'))
    return cached
  } catch (e: any) {
    tried.push(`local build/Release/chdb_node.node (${e && (e.code || e.message)})`)
  }

  // 3) unsupported
  const hint =
    process.platform === 'win32'
      ? 'Windows is not supported; use WSL2.'
      : pkg
        ? `Expected optional dependency ${pkg}.`
        : `Platform ${key} is not supported.`
  throw new ChdbPlatformUnsupportedError(
    `chdb: no native binding for ${key}. ${hint} Tried: ${tried.join('; ')}`,
  )
}
