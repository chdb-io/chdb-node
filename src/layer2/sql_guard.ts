/**
 * Lightweight, lexical SQL guard for cluster-topology constructs that embedded
 * chDB cannot honour (design §4.4).
 *
 * It is deliberately a *front-line* guard, not a parser: it strips string
 * literals and comments (so a table named `cluster` or the text `'ON CLUSTER'`
 * inside a string never trips it), then looks for the four topology markers. The
 * engine is the backstop — anything this misses still fails as a real engine
 * error and gets rewrapped (we never silently allow). We do not claim static
 * completeness.
 *
 * Federated table functions (`remote`/`remoteSecure`/`s3`/`postgresql`/`url`/…)
 * are intentionally NOT matched: they are native engine I/O and work embedded.
 */

import { ChdbEmbeddedNotSupportedError } from './errors'

/**
 * Replace every string-literal and comment span with equivalent-length runs of
 * spaces, so keyword matching cannot be fooled by, nor accidentally match
 * inside, quoted text / comments. Positions are preserved (helpful for any
 * future diagnostics); only the *content* is blanked.
 */
export function stripStringsAndComments(sql: string): string {
  let out = ''
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i] as string
    const next = i + 1 < n ? sql[i + 1] : ''

    // line comments: -- ... \n   and   # ... \n
    if ((c === '-' && next === '-') || c === '#') {
      while (i < n && sql[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    // block comment: /* ... */
    if (c === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += '  '
        i += 2
      }
      continue
    }
    // quoted spans: '...'  "..."  `...`  (backslash escapes the next char)
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += ' '
      i++
      while (i < n) {
        const q = sql[i] as string
        if (q === '\\') {
          // escaped char — blank both, skip the escaped one
          out += i + 1 < n ? '  ' : ' '
          i += 2
          continue
        }
        if (q === quote) {
          // doubled quote ('') is an escaped quote inside the string
          if (sql[i + 1] === quote) {
            out += '  '
            i += 2
            continue
          }
          out += ' '
          i++
          break
        }
        out += q === '\n' ? '\n' : ' '
        i++
      }
      continue
    }

    out += c
    i++
  }
  return out
}

interface TopologyMarker {
  re: RegExp
  feature: string
}

// Evaluated against the stripped SQL. Case-insensitive; word-boundaried.
const MARKERS: ReadonlyArray<TopologyMarker> = [
  { re: /\bON\s+CLUSTER\b/i, feature: 'ON CLUSTER' },
  { re: /\bclusterAllReplicas\s*\(/i, feature: 'clusterAllReplicas()' },
  // `cluster(` — the required `(` immediately after `cluster` keeps this from
  // matching the longer `clusterAllReplicas(` (already reported by the rule above).
  { re: /\bcluster\s*\(/i, feature: 'cluster()' },
  // Distributed table engine: `ENGINE = Distributed(...)` or a bare
  // `Distributed(` engine spec.
  { re: /\bENGINE\s*=\s*Distributed\b/i, feature: 'Distributed engine' },
  { re: /\bDistributed\s*\(/i, feature: 'Distributed engine' },
]

/**
 * Throw {@link ChdbEmbeddedNotSupportedError} if the statement uses cluster
 * topology. No-op otherwise. Safe on empty / whitespace / comment-only input.
 */
export function assertNoClusterTopology(sql: string): void {
  if (!sql) return
  const stripped = stripStringsAndComments(sql)
  for (const { re, feature } of MARKERS) {
    if (re.test(stripped)) {
      throw new ChdbEmbeddedNotSupportedError(feature)
    }
  }
}
