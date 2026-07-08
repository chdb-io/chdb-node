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

// --- Table-function source scanning -----------------------------------------
//
// chDB exposes table functions that reach outside the process (file, url, s3,
// remote, postgresql, the RCE-class executable / python, ...). When a
// fileAllowlist is configured, raw SQL is scanned for those calls; this scanner
// mirrors the Python reference (chdb.agents.safety) verbatim in semantics.

// Table functions that are safe by construction: they consume only literal or
// synthetic arguments and never reach outside the chDB process. Lowercase so
// matching against system.table_functions is case-insensitive. Anything the
// engine exposes that is NOT in this set is treated as a potential external
// source when the allowlist is configured — an allowlist over safe functions,
// not a denylist of dangerous ones, so new source functions in future engines
// are gated by default instead of silently allowed.
//
// view / merge / dictionary can *contain* nested table-function calls
// (e.g. view(SELECT * FROM file(...))), but the text-level scanner sees the
// inner file( directly, so allowlisting the wrappers is safe.
export const SAFE_TABLE_FUNCTIONS = new Set([
  'numbers',
  'numbers_mt',
  'zeros',
  'zeros_mt',
  'null',
  'values',
  'format',
  'input',
  'generaterandom',
  'generateseries',
  'generate_series',
  'primes',
  'loop',
  'fuzzquery',
  'fuzzjson',
  'view',
  'viewexplain',
  'viewifpermitted',
  'dictionary',
  'merge',
  'mergetreeindex',
  'mergetreeprojection',
  'mergetreeanalyzeindexes',
  'mergetreeanalyzeindexesuuid',
  'mergetreetextindex',
  'timeseriesdata',
  'timeseriesmetrics',
  'timeseriesselector',
  'timeseriestags',
])

// Conservative fallback when system.table_functions can't be queried (older
// chDB / stripped build). Covers the table functions that reach outside the
// process, including the RCE-class executable / python. Lowercase.
export const FALLBACK_KNOWN_TABLE_FUNCTIONS = new Set([
  'file',
  'filecluster',
  'url',
  'urlcluster',
  'urlwithheaders',
  's3',
  's3cluster',
  'remote',
  'remotesecure',
  'cluster',
  'clusterallreplicas',
  'hdfs',
  'hdfscluster',
  'mongodb',
  'postgresql',
  'mysql',
  'redis',
  'sqlite',
  'odbc',
  'jdbc',
  'iceberg',
  'iceberglocal',
  'iceberglocalcluster',
  'icebergs3',
  'icebergs3cluster',
  'icebergazure',
  'icebergazurecluster',
  'iceberghdfs',
  'iceberghdfscluster',
  'deltalake',
  'deltalakelocal',
  'deltalakeazure',
  'deltalakeazurecluster',
  'deltalakes3',
  'deltalakes3cluster',
  'hudi',
  'hudicluster',
  'paimon',
  'paimonlocal',
  'paimonazure',
  'paimonazurecluster',
  'paimonhdfs',
  'paimonhdfscluster',
  'paimons3',
  'paimons3cluster',
  'paimoncluster',
  'azureblobstorage',
  'azureblobstoragecluster',
  'gcs',
  'cosn',
  'oss',
  'ytsaurus',
  'executable',
  'python',
  'prometheusquery',
  'prometheusqueryrange',
])

// Single pass over the SQL: a token is either a string literal, a line comment,
// or a block comment. Left-to-right alternation guarantees that once a construct
// opens, its body is consumed up to the matching close before any other rule can
// fire — so a call smuggled between two strings whose contents *look* like a
// block comment cannot mislead the scanner. The string sub-pattern accepts the
// escape forms ClickHouse honours: '' doubling and backslash escapes.
const MASK_RE = /'(?:[^'\\]|\\[\s\S]|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g

// A function-call token in masked SQL: a bare word, or a backtick/double-quote
// wrapped word (`file`( / "file"( — quoting a function name must not bypass the
// scan), followed by optional whitespace and '('. Masking already blanked
// comments between name and paren, so \s covers them.
const CALL_RE = /(?:\b(\w+)|([`"])(\w+)\2)\s*\(/g

// A single-quoted string literal immediately at the start of an argument list.
const LEADING_STRING_RE = /^\s*'((?:[^'\\]|\\[\s\S]|'')*)'/

// Blank out string literals and comments, preserving every position.
function mask(sql) {
  return sql.replace(MASK_RE, (m) => ' '.repeat(m.length))
}

// The unescaped leading string-literal argument at sql.slice(argsStart), or
// null when the first argument is anything else (identifier, call, number).
function literalFirstArg(sql, argsStart) {
  const m = LEADING_STRING_RE.exec(sql.slice(argsStart))
  if (!m) return null
  return m[1].replace(/''|\\([\s\S])/g, (e, esc) => (e === "''" ? "'" : esc))
}

/**
 * Return [name, literalFirstArgOrNull] pairs for every table-function call in
 * `sql` whose lowercase name is in `known` but not SAFE.
 *
 * Scans a position-preserving MASKED copy (string literals and comments
 * blanked), so a path-looking string literal never false-positives and a
 * comment between name and paren never hides a call; quoted function names
 * (`file`( / "file"() are matched as calls. The literal argument, when the
 * call has one, is extracted from the ORIGINAL text and unescaped. Scalar
 * functions (sum, length, ...) are not table functions, so they are not in
 * `known` and never flag.
 * @param {string} sql
 * @param {Set<string>} known
 * @returns {Array<[string, string|null]>}
 */
export function findSourceCalls(sql, known) {
  const masked = mask(sql)
  const out = []
  let m
  CALL_RE.lastIndex = 0
  while ((m = CALL_RE.exec(masked)) !== null) {
    const name = (m[1] || m[3]).toLowerCase()
    if (known.has(name) && !SAFE_TABLE_FUNCTIONS.has(name)) {
      out.push([name, literalFirstArg(sql, m.index + m[0].length)])
    }
  }
  return out
}

/**
 * Return the [fn, path] literal pairs of source table functions in `sql`.
 * Kept for compatibility with earlier callers; implemented on the masked
 * scanner with the fallback function set, returning only calls that carry a
 * leading string-literal argument. Allowlist enforcement should use
 * `findSourceCalls` (it also surfaces non-literal calls, which must be denied
 * rather than skipped).
 */
export function scanFilePaths(sql) {
  return findSourceCalls(sql, FALLBACK_KNOWN_TABLE_FUNCTIONS).filter(([, arg]) => arg !== null)
}
