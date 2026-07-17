export interface ChDBErrorObject {
  code: number
  type: string
  message: string
  /** Model-facing recovery instruction (present on resource-limit errors). */
  hint?: string
}

export class ChDBError extends Error {
  code: number
  type: string
  hint: string | null
  constructor(message: string, opts?: { code?: number; type?: string; hint?: string | null })
  toObject(): ChDBErrorObject
}

/** A write/DDL was rejected because the tool session is read-only (code 164). */
export class ChDBReadOnlyError extends ChDBError {}
/**
 * The query hit an engine resource limit (rows / bytes / time / memory);
 * the SQL is valid — carries a `hint` telling the model to narrow the query.
 */
export class ChDBResourceError extends ChDBError {}
/** Parse / type / argument error in the submitted SQL. */
export class ChDBSyntaxError extends ChDBError {}
/** Unknown table / database / function / column / setting. */
export class ChDBUnknownObjectError extends ChDBError {}

/** The recovery instruction attached to every resource-limit error (binding-identical wording). */
export declare const RESOURCE_HINT: string

/** The recovery instruction attached to a NETWORK_TIMEOUT watchdog error (binding-identical wording). */
export declare const NETWORK_HINT: string

/** Return a typed ChDBError for a raw engine exception or message string. */
export function parseError(excOrMessage: unknown): ChDBError
