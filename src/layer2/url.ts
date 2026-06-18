/**
 * `chdb://` URL parsing (design §4.1/§4.2 ①). Embedded-only: any non-`chdb`
 * scheme is rejected with {@link ChdbEmbeddedOnlyError}. We parse manually rather
 * than via `URL` because the WHATWG parser mangles the `host`/`path` split for
 * filesystem paths (and `:memory:` is not a valid host).
 */

import { ChdbEmbeddedOnlyError } from './errors'

export type ParsedUrl =
  | { kind: 'memory'; database?: string }
  | { kind: 'path'; path: string; database?: string }

const SCHEME = 'chdb://'
const MEMORY_ALIASES = new Set(['', 'memory', ':memory:', 'memory/'])

/**
 * Parse a Layer 2 connection URL.
 *
 *  - `undefined` / `'chdb://memory'` / `'chdb://:memory:'` → in-memory.
 *  - `'chdb:///abs/path'` / `'chdb://./rel'` / `'chdb://name'` → on-disk path
 *    (everything after the scheme is the filesystem path; a literal dir named
 *    `memory` must be written as `chdb://./memory`).
 *  - any other scheme (`http://`, `https://`, `tcp://`, a bare path) →
 *    {@link ChdbEmbeddedOnlyError}.
 *
 * A trailing `?key=value` is parsed for a `database` parameter; other query
 * params are ignored (honest boundary, documented).
 */
export function parseChdbUrl(input: string | URL | undefined): ParsedUrl {
  if (input === undefined) return { kind: 'memory' }
  const raw = String(input).trim()

  // bare shorthands without the scheme
  if (raw === 'memory' || raw === ':memory:') return { kind: 'memory' }

  if (raw.toLowerCase().startsWith(SCHEME)) {
    let rest = raw.slice(SCHEME.length)
    let database: string | undefined
    const q = rest.indexOf('?')
    if (q !== -1) {
      database = parseDatabaseParam(rest.slice(q + 1))
      rest = rest.slice(0, q)
    }
    if (MEMORY_ALIASES.has(rest)) return { kind: 'memory', database }
    return { kind: 'path', path: rest, database }
  }

  throw new ChdbEmbeddedOnlyError(raw)
}

function parseDatabaseParam(search: string): string | undefined {
  for (const pair of search.split('&')) {
    const eq = pair.indexOf('=')
    const key = eq === -1 ? pair : pair.slice(0, eq)
    if (key === 'database') {
      const val = eq === -1 ? '' : pair.slice(eq + 1)
      try {
        return decodeURIComponent(val)
      } catch {
        return val
      }
    }
  }
  return undefined
}
