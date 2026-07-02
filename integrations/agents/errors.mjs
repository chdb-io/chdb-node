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

export class ChDBError extends Error {
  constructor(message, { code = 0, type = 'UNKNOWN' } = {}) {
    super(message)
    this.name = 'ChDBError'
    this.code = code
    this.type = type
    this.message = message
  }

  toObject() {
    return { code: this.code, type: this.type, message: this.message }
  }
}

/** A write/DDL was rejected because the tool session is read-only (code 164). */
export class ChDBReadOnlyError extends ChDBError {
  constructor(message, opts) {
    super(message, opts)
    this.name = 'ChDBReadOnlyError'
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
}

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
  return new Cls(msg, { code, type })
}
