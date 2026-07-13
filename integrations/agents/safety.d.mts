/** Raised when an identifier cannot be safely quoted. */
export class InvalidIdentifier extends Error {}

/** Backtick-quote a ClickHouse identifier (doubles backticks; rejects NUL). */
export function quoteIdent(name: string): string
/** Escape a value as a ClickHouse single-quoted string literal (rejects NUL). */
export function quoteString(value: unknown): string
/** True if `path` starts with one of the allowlist prefixes (empty allowlist -> true). */
export function pathAllowed(path: string, allowlist: string[] | null | undefined): boolean
/** Table functions that never reach outside the process (lowercase). */
export const SAFE_TABLE_FUNCTIONS: Set<string>
/** Static fallback set of external source table functions (lowercase). */
export const FALLBACK_KNOWN_TABLE_FUNCTIONS: Set<string>
/**
 * Every non-safe table-function call in `sql` (masked scan: string literals and
 * comments blanked, quoted function names matched) whose lowercase name is in
 * `known`, with its unescaped leading string-literal argument or null.
 */
export function findSourceCalls(sql: string, known: Set<string>): Array<[string, string | null]>
/** Source table-function calls carrying a literal argument (compat wrapper). */
export function scanFilePaths(sql: string): Array<[string, string]>
