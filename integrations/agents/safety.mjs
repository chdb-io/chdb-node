// Shared safety primitives for the chDB agent tool.
//
// Values go through server-side parameter binding, never through here. The only
// exceptions are places where the engine cannot bind (identifiers, and string
// literals baked into a stored CREATE VIEW definition) — those use quoteIdent /
// quoteString. These helpers are deliberately tiny and dependency-free so the
// same rules match the Python reference (chdb.agents.safety) verbatim; the
// CONTRACT.md points every language here to stop each one hand-rolling its own
// (subtly different) quoting or path-allowlist logic.

/** Raised when an identifier cannot be safely quoted. */
export class InvalidIdentifier extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidIdentifier'
  }
}

/**
 * Backtick-quote a ClickHouse identifier (db / table / column). Identifiers
 * cannot be passed as bound parameters, so agent-supplied names are quoted here.
 * Embedded backticks are doubled (ClickHouse escaping); a NUL byte is rejected
 * outright since it cannot appear in a valid identifier and is a classic
 * truncation-smuggling vector.
 */
export function quoteIdent(name) {
  if (typeof name !== 'string' || name === '') {
    throw new InvalidIdentifier('identifier must be a non-empty string')
  }
  if (name.includes('\x00')) {
    throw new InvalidIdentifier('identifier must not contain a NUL byte')
  }
  return '`' + name.replace(/`/g, '``') + '`'
}

/**
 * Escape a value as a ClickHouse single-quoted string literal. Prefer bound
 * parameters ({name:Type}) for values — this is only for the few spots the
 * engine cannot bind, e.g. a path/format literal baked into a stored CREATE VIEW
 * definition. Backslashes and single quotes are escaped; a NUL byte is rejected.
 */
export function quoteString(value) {
  if (typeof value !== 'string') value = String(value)
  if (value.includes('\x00')) {
    throw new InvalidIdentifier('string literal must not contain a NUL byte')
  }
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

/**
 * True if `path` starts with one of the allowlist prefixes. An empty/null
 * allowlist means "no allowlist configured" and returns true.
 */
export function pathAllowed(path, allowlist) {
  if (!allowlist || allowlist.length === 0) return true
  return allowlist.some((p) => String(path).startsWith(String(p)))
}

// Literal first-argument of file()/s3()/url()/etc. table functions. Best-effort:
// it catches the common `file('<path>' ...)` literal form used by agents, not
// computed/concatenated arguments — the real write backstop is readonly=2.
const FILE_FN_RE = /\b(file|s3|url|hdfs|azureBlobStorage)\s*\(\s*(['"])([\s\S]*?)\2/gi

/**
 * Return the [fn, path] literals of file-like table functions in `sql`.
 * Heuristic — used only to enforce a configured allowlist as defense in depth;
 * documented as best-effort (won't see computed arguments).
 */
export function scanFilePaths(sql) {
  const out = []
  let m
  FILE_FN_RE.lastIndex = 0
  while ((m = FILE_FN_RE.exec(sql)) !== null) {
    out.push([m[1].toLowerCase(), m[3]])
  }
  return out
}
