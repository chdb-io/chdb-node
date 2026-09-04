/**
 * chDB release precedence.
 *
 * The V1 engine gate compares versions, and the protocol is explicit that they
 * are compared "by chDB release precedence, never as lexicographic strings".
 * The difference is not academic: as strings, `"26.10.0" < "26.7.0"` and
 * `"26.7.2-rc.2" > "26.7.2"`, both of which are backwards, and both of which
 * would let a reader open an object it cannot actually restore.
 *
 * The ordering is semver's:
 *
 * ```text
 *   26.7.2-rc.1  <  26.7.2-rc.2  <  26.7.2  <  26.7.3  <  26.8.1  <  27.0.0
 * ```
 *
 * A pre-release sorts *below* the release it leads to, which is what makes an
 * object written by `26.7.2-rc.2` readable by `26.7.2` and everything after it.
 *
 * chDB itself ships only two shapes, `X.Y.Z` and `X.Y.Z-rc.N`, and a patch
 * number that has had a release candidate never gets a final release of the
 * same number — after `26.7.2-rc.2` the next stable is `26.7.3`. So the
 * `26.7.2-rc.2 < 26.7.2` case does not arise in practice. It is still ordered
 * correctly, deliberately: an implementation that is more permissive than the
 * convention costs nothing, while one that assumed the convention would be
 * wrong the day it changed.
 *
 * That is also why the parser is semver-shaped rather than a two-branch match
 * on those exact shapes. A future `26.7.2-beta.1` sorts correctly here; a
 * tighter pattern would reject an object it could have opened safely, which is
 * the wrong place to fail closed.
 *
 * Failing closed belongs where nothing can be concluded: a string that does not
 * parse at all is refused rather than guessed at, because an unrecognised
 * version is not evidence of compatibility, and treating it as one is how a
 * reader restores an archive from a release nothing has tested it against.
 */

import { DurableEngineIncompatibleError } from './errors'

export interface ParsedEngineVersion {
  /** Numeric release components, e.g. `[26, 7, 2]`. At least one. */
  release: number[]
  /**
   * Dot-separated pre-release identifiers, e.g. `['rc', 2]`. Absent for a final
   * release, which sorts above every pre-release of the same numbers.
   */
  prerelease: (string | number)[] | undefined
}

// Numeric release, optional -prerelease, optional +build (parsed and ignored,
// as semver requires: build metadata takes no part in precedence).
const VERSION = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a chDB version string, or `undefined` if it is not one. */
export function parseEngineVersion(value: string): ParsedEngineVersion | undefined {
  const m = VERSION.exec(value.trim())
  if (!m) return undefined
  const release = (m[1] as string).split('.').map(Number)
  if (release.some((n) => !Number.isSafeInteger(n) || n < 0)) return undefined
  const raw = m[2]
  return {
    release,
    prerelease:
      raw === undefined
        ? undefined
        : raw.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
  }
}

function comparePrerelease(a: (string | number)[], b: (string | number)[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    // A shorter identifier list sorts lower when all shared parts are equal:
    // rc.1 comes before rc.1.1.
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    const x = a[i] as string | number
    const y = b[i] as string | number
    if (x === y) continue
    const xNum = typeof x === 'number'
    const yNum = typeof y === 'number'
    // Numeric identifiers always sort below alphanumeric ones.
    if (xNum && !yNum) return -1
    if (!xNum && yNum) return 1
    if (xNum && yNum) return (x as number) < (y as number) ? -1 : 1
    return (x as string) < (y as string) ? -1 : 1
  }
  return 0
}

/**
 * Compare two parsed versions: negative if `a` precedes `b`, zero if they are
 * the same release, positive otherwise.
 */
export function comparePrecedence(a: ParsedEngineVersion, b: ParsedEngineVersion): number {
  const n = Math.max(a.release.length, b.release.length)
  for (let i = 0; i < n; i++) {
    // A missing component is zero, so 26.7 and 26.7.0 are the same release.
    const x = a.release[i] ?? 0
    const y = b.release[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (a.prerelease === undefined && b.prerelease === undefined) return 0
  // No pre-release outranks any pre-release of the same numbers.
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * Compare two version strings, refusing either one this code cannot parse.
 * `what` names the comparison so the error says which value was the problem.
 */
export function compareEngineVersions(a: string, b: string): number {
  const pa = parseEngineVersion(a)
  const pb = parseEngineVersion(b)
  if (!pa || !pb) {
    const bad = !pa ? a : b
    throw new DurableEngineIncompatibleError(
      `durable: cannot order chdb version ${JSON.stringify(bad)} by release precedence, ` +
        `so compatibility cannot be established; refusing rather than guessing`,
    )
  }
  return comparePrecedence(pa, pb)
}

/** The later of two version strings, by precedence. */
export function maxEngineVersion(a: string, b: string): string {
  return compareEngineVersions(a, b) >= 0 ? a : b
}
