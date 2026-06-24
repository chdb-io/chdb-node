/**
 * Identifier quoting for table / column / alias names. Identifiers are the one
 * thing that legitimately enters the SQL string (a value never does), so they
 * are backtick-quoted and the two characters that could break out of a
 * backtick-quoted ClickHouse identifier — the backslash and the backtick — are
 * escaped. This makes an arbitrary identifier safe to emit without restricting
 * it to an alphanumeric whitelist.
 *
 * A dotted name is treated as a qualifier path (`db.table`, `t.col`): each
 * segment is quoted independently so `events.country` becomes
 * `` `events`.`country` ``, not a single quoted name containing a dot.
 */

import { ChdbCompileError } from '../../errors'

function quoteSegment(segment: string): string {
  // Escape the backslash first (it is the escape introducer), then the backtick.
  return '`' + segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'
}

/**
 * Quote a possibly-dotted identifier. An empty name or an empty segment
 * (leading/trailing/double dot) is a build-time error, since it can only come
 * from a malformed builder call.
 */
export function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ChdbCompileError(`Invalid identifier ${JSON.stringify(name)}: must be a non-empty string`)
  }
  const segments = name.split('.')
  if (segments.some((s) => s.length === 0)) {
    throw new ChdbCompileError(
      `Invalid identifier ${JSON.stringify(name)}: empty segment (a leading, trailing, or doubled '.')`,
    )
  }
  return segments.map(quoteSegment).join('.')
}

// Function and aggregate-combinator names are emitted into the SQL text, so they
// are validated against a strict pattern rather than quoted (ClickHouse function
// names are unquoted). This blocks any attempt to smuggle SQL through a function
// name passed to the generic `fn()` helper.
const FUNCTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateFunctionName(name: string): string {
  if (typeof name !== 'string' || !FUNCTION_NAME_RE.test(name)) {
    throw new ChdbCompileError(
      `Invalid function name ${JSON.stringify(name)}: expected [A-Za-z_][A-Za-z0-9_]*`,
    )
  }
  return name
}
