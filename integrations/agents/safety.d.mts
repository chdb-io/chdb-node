/** Raised when an identifier cannot be safely quoted. */
export class InvalidIdentifier extends Error {}

/** Backtick-quote a ClickHouse identifier (doubles backticks; rejects NUL). */
export function quoteIdent(name: string): string
/** Escape a value as a ClickHouse single-quoted string literal (rejects NUL). */
export function quoteString(value: unknown): string
/** True if `path` starts with one of the allowlist prefixes (empty allowlist -> true). */
export function pathAllowed(path: string, allowlist: string[] | null | undefined): boolean
/** Best-effort scan of file()/s3()/url() literal path arguments in SQL. */
export function scanFilePaths(sql: string): Array<[string, string]>
