export interface ChDBErrorObject {
  code: number
  type: string
  message: string
}

export class ChDBError extends Error {
  code: number
  type: string
  constructor(message: string, opts?: { code?: number; type?: string })
  toObject(): ChDBErrorObject
}

/** A write/DDL was rejected because the tool session is read-only (code 164). */
export class ChDBReadOnlyError extends ChDBError {}
/** Parse / type / argument error in the submitted SQL. */
export class ChDBSyntaxError extends ChDBError {}
/** Unknown table / database / function / column / setting. */
export class ChDBUnknownObjectError extends ChDBError {}

/** Return a typed ChDBError for a raw engine exception or message string. */
export function parseError(excOrMessage: unknown): ChDBError
