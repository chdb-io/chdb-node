/**
 * Single-point engine-error → byte-compat `ClickHouseError` mapping (design
 * §4.4). Every Layer 2 method funnels failures through {@link wrapError}.
 *
 * The rule:
 *  - A real **engine** error (its message carries ClickHouse's `Code: N …
 *    (TYPE)` shape, or Layer 1 captured a numeric `clickhouseCode`) becomes a
 *    {@link ClickHouseError} with `code`/`type`/`message` exactly as
 *    clickhouse-js would produce, and `.cause` preserving the Layer 1 error.
 *  - Everything else — boundary errors ({@link ChdbEmbeddedOnlyError} /
 *    {@link ChdbEmbeddedNotSupportedError}), lifecycle/abort/timeout/connection/
 *    bind errors — passes through UNCHANGED. They are not engine errors and must
 *    stay honestly typed (e.g. an aborted query keeps `name === 'AbortError'`,
 *    not masquerade as a server exception).
 */

import { ChdbError, ChdbQueryError } from '../errors'
import { ClickHouseError } from './errors'

/**
 * clickhouse-js's error regex, copied verbatim (byte-compat). Extracts `code`
 * (digits), `message`, and `type` (the trailing `(UPPER_SNAKE)` token) from e.g.
 *   `Code: 60. DB::Exception: Table x doesn't exist. (UNKNOWN_TABLE)`
 */
const ERROR_RE =
  /(Code|Error): (?<code>\d+).*Exception: (?<message>.+)\((?<type>(?=.+[A-Z]{3})[A-Z0-9_]+?)\)/s

/** Parse a raw ClickHouse error string, mirroring clickhouse-js `parseError`. */
export function parseClickHouseErrorString(
  input: string,
): { message: string; code: string; type?: string } | undefined {
  const m = ERROR_RE.exec(input)
  if (m?.groups) {
    return {
      message: m.groups.message as string,
      code: m.groups.code as string,
      type: m.groups.type,
    }
  }
  return undefined
}

export function wrapError(err: unknown): Error {
  // Already the byte-compat type — nothing to do.
  if (err instanceof ClickHouseError) return err

  const message = err instanceof Error ? err.message : String(err)

  // Canonical ClickHouse exception string → ClickHouseError.
  const parsed = parseClickHouseErrorString(message)
  if (parsed) {
    return new ClickHouseError(parsed, { cause: err, clickhouseCode: Number(parsed.code) })
  }

  // Engine query error that carried a numeric code but no parseable type token.
  if (err instanceof ChdbQueryError && typeof err.clickhouseCode === 'number') {
    return new ClickHouseError(
      { message, code: String(err.clickhouseCode), type: undefined },
      { cause: err, clickhouseCode: err.clickhouseCode },
    )
  }

  // Non-engine typed error (abort / timeout / closed / connection / bind /
  // boundary) — keep it honest and unchanged.
  if (err instanceof ChdbError) return err
  return err instanceof Error ? err : new Error(message)
}
