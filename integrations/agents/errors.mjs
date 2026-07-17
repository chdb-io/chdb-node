// Typed errors for the chDB agent tool, parsed from chDB's stable exception shape.
//
// chDB raises messages of the form:
//   Code: 164. DB::Exception: <message>. (READONLY)
//
// parseError() turns that into a ChDBError carrying the numeric `code`, the
// symbolic `type`, and a cleaned `message`, so callers — and, across languages,
// every other chdb-io agent tool — map the *same* engine failure to the *same*
// typed surface. The regex and the code->class mapping are the single source of
// truth referenced by the cross-language CONTRACT.md (this mirrors the Python
// reference chdb.agents.errors verbatim).

// `Code: N. DB::Exception: <msg>. (TYPE)` — TYPE is the LAST (UPPER_SNAKE) token.
// `msg` is greedy (the `[\s\S]*`) so a parenthesized UPPER_SNAKE inside the
// message body stays in the message and the real trailing type wins.
const ERR_RE = /Code:\s*(\d+)\.\s*DB::Exception:\s*([\s\S]*)\(([A-Z0-9_]+)\)/

// Base error. `code`/`type`/`message` are always populated; `hint` is an
// optional model-facing recovery instruction (set for resource-limit errors,
// where the model must learn "narrow the query" rather than "give up" or
// "retry unchanged").
export class ChDBError extends Error {
  constructor(message, { code = 0, type = 'UNKNOWN', hint = null } = {}) {
    super(message)
    this.name = 'ChDBError'
    this.code = code
    this.type = type
    this.message = message
    this.hint = hint
  }

  toObject() {
    const d = { code: this.code, type: this.type, message: this.message }
    if (this.hint) d.hint = this.hint
    return d
  }
}

/** A write/DDL was rejected because the tool session is read-only (code 164). */
export class ChDBReadOnlyError extends ChDBError {
  constructor(message, opts) {
    super(message, opts)
    this.name = 'ChDBReadOnlyError'
  }
}

/**
 * The query hit an engine resource limit (rows / bytes / time / memory).
 *
 * Distinct from a logic error: the SQL is valid, the result was just too big
 * or too slow. Carries a `hint` telling the model how to shrink the query, so
 * an agent distinguishes "narrow and retry" from "abandon".
 */
export class ChDBResourceError extends ChDBError {
  constructor(message, opts) {
    super(message, opts)
    this.name = 'ChDBResourceError'
  }
}

/** Parse / type / argument error in the submitted SQL. */
export class ChDBSyntaxError extends ChDBError {
  constructor(message, opts) {
    super(message, opts)
    this.name = 'ChDBSyntaxError'
  }
}

/** Unknown table / database / function / column / setting. */
export class ChDBUnknownObjectError extends ChDBError {
  constructor(message, opts) {
    super(message, opts)
    this.name = 'ChDBUnknownObjectError'
  }
}

// Hint on NETWORK_TIMEOUT: the model must switch strategy, not wait or retry.
export const NETWORK_HINT =
  'The query referenced a remote source (url()/s3()/...) and did not return ' +
  'within the network deadline. Network egress may be disabled or firewalled ' +
  'in this environment. Use file() on data already available locally, or ask ' +
  'the operator to enable egress. Do not retry the same query unchanged.'

// ClickHouse error code -> ChDBError subclass. Kept small and explicit; the
// CONTRACT lists exactly these so other languages classify identically.
const CODE_TO_CLASS = {
  164: ChDBReadOnlyError, // READONLY
  62: ChDBSyntaxError, // SYNTAX_ERROR
  46: ChDBUnknownObjectError, // UNKNOWN_FUNCTION
  47: ChDBUnknownObjectError, // UNKNOWN_IDENTIFIER
  60: ChDBUnknownObjectError, // UNKNOWN_TABLE
  81: ChDBUnknownObjectError, // UNKNOWN_DATABASE
  115: ChDBUnknownObjectError, // UNKNOWN_SETTING
  158: ChDBResourceError, // TOO_MANY_ROWS
  159: ChDBResourceError, // TIMEOUT_EXCEEDED
  241: ChDBResourceError, // MEMORY_LIMIT_EXCEEDED
  307: ChDBResourceError, // TOO_MANY_BYTES
  396: ChDBResourceError, // TOO_MANY_ROWS_OR_BYTES (max_result_rows/bytes)
}

// The recovery instruction attached to every resource-limit error. Wording is
// model-facing: name the fix (filter / project / aggregate / limit) and forbid
// the two failure loops (verbatim retry, silent abandonment).
export const RESOURCE_HINT =
  'The query exceeded a resource limit; the SQL itself is valid. ' +
  'Narrow it and retry: add a WHERE filter, select fewer columns, ' +
  'aggregate before returning, or add/lower LIMIT. ' +
  'Do not retry the same query unchanged.'

const TYPE_TO_CLASS = {
  READONLY: ChDBReadOnlyError,
}

/**
 * Return a typed ChDBError for a raw engine exception or message string.
 * Non-conforming input yields a generic ChDBError wrapping the text, so the
 * caller never has to special-case "the message didn't parse".
 * @param {unknown} excOrMessage
 * @returns {ChDBError}
 */
export function parseError(excOrMessage) {
  const message =
    excOrMessage instanceof Error ? excOrMessage.message : String(excOrMessage)
  const m = ERR_RE.exec(message)
  if (!m) return new ChDBError(message.trim())
  const code = parseInt(m[1], 10)
  const type = m[3]
  // greedy msg keeps the trailing ". " that precedes the (TYPE); trim it
  const msg = m[2].trim().replace(/\.+$/, '').trim()
  const Cls = CODE_TO_CLASS[code] || TYPE_TO_CLASS[type] || ChDBError
  const hint = Cls === ChDBResourceError ? RESOURCE_HINT : null
  return new Cls(msg, { code, type, hint })
}
