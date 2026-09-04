/**
 * WAL segment encoding and decoding (contract §4.4).
 *
 * The format is deliberately dull: UTF-8 JSONL, one `{"sql": "..."}` object
 * per line, newline-terminated, replayed in manifest order then line order.
 * Being dull is what lets four language bindings agree on it.
 *
 * Two limits are enforced on the write side and tolerated on the read side, as
 * the contract requires: a reader must be able to load anything a conforming
 * writer could have produced, so it only refuses what is over the *frozen*
 * ceiling, never a lower local preference.
 *
 * What this file does not do is make statements deterministic. `now()`,
 * `rand()` and reads of mutable external sources are replayed verbatim and
 * will produce whatever they produce; V1 promises ordered replay of the
 * original statement text and nothing more. Materialising those values before
 * calling `execute()` is the caller's job.
 */

import { DurableCorruptError, DurableLimitExceededError } from './errors'
import { LIMITS } from './types'

/**
 * Bytes this statement will occupy in a segment, counting its newline.
 *
 * Must stay exactly consistent with {@link encodeWalSegment}: it is what the
 * object layer budgets against before executing, and a budget that disagrees
 * with the encoder by even one byte per line puts the boundary in the wrong
 * place. `encodeWalSegment` joins with `\n` and appends one, which comes to a
 * newline per line, so the per-statement cost is additive and this can be
 * summed. A test asserts the two agree.
 */
export function walLineBytes(sql: string): number {
  return Buffer.byteLength(JSON.stringify({ sql }), 'utf8') + 1
}

/** Refuse a statement that could not be written into a conforming segment. */
export function assertStatementWithinLimit(sql: string): void {
  const bytes = Buffer.byteLength(sql, 'utf8')
  if (bytes > LIMITS.MAX_SQL_BYTES) {
    throw new DurableLimitExceededError(
      `durable: statement is ${bytes} UTF-8 bytes, over the V1 per-statement limit of ${LIMITS.MAX_SQL_BYTES}`,
      { limit: LIMITS.MAX_SQL_BYTES, actual: bytes },
    )
  }
}

/**
 * Encode buffered statements into one segment. Throws `limit_exceeded` rather
 * than splitting: a segment boundary is a commit boundary, so silently
 * splitting would turn one caller-visible flush into two, and a crash between
 * them would commit a prefix the caller was never told about.
 */
export function encodeWalSegment(statements: readonly string[]): Uint8Array {
  const lines: string[] = []
  for (const sql of statements) {
    assertStatementWithinLimit(sql)
    lines.push(JSON.stringify({ sql }))
  }
  const bytes = Buffer.from(lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8')
  if (bytes.byteLength > LIMITS.MAX_WAL_SEGMENT_BYTES) {
    throw new DurableLimitExceededError(
      `durable: WAL segment would be ${bytes.byteLength} bytes, over the V1 limit of ` +
        `${LIMITS.MAX_WAL_SEGMENT_BYTES}; flush more often`,
      { limit: LIMITS.MAX_WAL_SEGMENT_BYTES, actual: bytes.byteLength },
    )
  }
  return bytes
}

/**
 * Decode a verified segment into its statements.
 *
 * Strict on every count the contract names: exactly one JSON object per line,
 * a string `sql`, and a terminating newline. A tolerant reader here would be
 * the worst kind of bug — it would skip a statement and hand back a database
 * that looks fine and is missing a write.
 */
export function decodeWalSegment(bytes: Uint8Array, key: string): string[] {
  if (bytes.byteLength > LIMITS.MAX_WAL_SEGMENT_BYTES) {
    throw new DurableLimitExceededError(
      `durable: WAL segment ${key} is ${bytes.byteLength} bytes, over the V1 limit of ${LIMITS.MAX_WAL_SEGMENT_BYTES}`,
      { limit: LIMITS.MAX_WAL_SEGMENT_BYTES, actual: bytes.byteLength },
    )
  }
  const text = Buffer.from(bytes).toString('utf8')
  if (text.length === 0) return []
  if (!text.endsWith('\n')) {
    throw new DurableCorruptError(
      `durable: WAL segment ${key} does not end with a newline; it may be truncated`,
    )
  }
  const out: string[] = []
  const lines = text.slice(0, -1).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (e) {
      throw new DurableCorruptError(`durable: WAL segment ${key} line ${i + 1} is not valid JSON`, {
        cause: e,
      })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new DurableCorruptError(`durable: WAL segment ${key} line ${i + 1} is not a JSON object`)
    }
    const sql = (parsed as Record<string, unknown>)['sql']
    if (typeof sql !== 'string') {
      throw new DurableCorruptError(
        `durable: WAL segment ${key} line ${i + 1} has no string "sql" field`,
      )
    }
    out.push(sql)
  }
  return out
}
