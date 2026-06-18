/**
 * Typed, lazy accessor for the Layer 1 runtime (the package's CommonJS entry,
 * `index.js`). Layer 2 is a thin translation layer that forwards everything to
 * Layer 1; it never touches the native addon directly.
 *
 * The require is lazy (resolved on first call, not at module load) to break the
 * load-time cycle: `index.js` re-exports Layer 2 at its bottom, while Layer 2
 * pulls Layer 1 back in here. By the time any Layer 2 method actually runs,
 * `index.js`'s exports are fully populated.
 *
 * Types are sourced from their `src/` origins (kept inside `rootDir`); the two
 * option shapes that only exist on the hand-written root `index.d.ts`
 * (`QueryOptions`/`StreamOptions`) are mirrored locally.
 */

import type { ChdbResult } from '../result'

export interface L1QueryOptions {
  format?: string
  signal?: AbortSignal
  timeout?: number
  // When set, the `params` passed to queryBindAsync are already the engine's
  // `{name: literal}` bound map and are bound verbatim (Layer 2 formats query
  // parameters with clickhouse-js semantics, not Layer 1's serializer).
  preformatted?: boolean
}

export interface L1StreamOptions {
  format?: string
  signal?: AbortSignal
}

export interface L1InsertParams {
  table: string
  values: ReadonlyArray<Record<string, unknown> | ReadonlyArray<unknown>>
  columns?: ReadonlyArray<string> | { except: ReadonlyArray<string> }
}

export interface L1InsertSummary {
  rowsWritten: number
  bytesRead: number
  elapsed: number
}

/** The subset of Layer 1's Session surface Layer 2 uses. */
export interface Layer1Session {
  readonly path: string
  readonly isTemp: boolean
  readonly open: boolean
  query(query: string, format?: string): string
  queryBind(query: string, args: object, format?: string): string
  queryAsync(query: string, opts?: L1QueryOptions): Promise<ChdbResult>
  queryBindAsync(query: string, params: object, opts?: L1QueryOptions): Promise<ChdbResult>
  insert(params: L1InsertParams): Promise<L1InsertSummary>
  queryStream(query: string, opts?: L1StreamOptions): unknown
  close(): void
}

export interface Layer1SessionCtor {
  new (path?: string, opts?: { installSignalHandlers?: boolean }): Layer1Session
}

export interface Layer1 {
  Session: Layer1SessionCtor
  query(query: string, format?: string): string
  queryBind(query: string, args: object, format?: string): string
  queryAsync(query: string, opts?: L1QueryOptions): Promise<ChdbResult>
  queryBindAsync(query: string, params: object, opts?: L1QueryOptions): Promise<ChdbResult>
  insert(params: L1InsertParams): Promise<L1InsertSummary>
  version(): { chdb: string; libchdb: string; platform: string; arch: string; napi?: number }
}

let cached: Layer1 | undefined

export function layer1(): Layer1 {
  if (cached === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = require('../../index.js') as Layer1
  }
  return cached
}
