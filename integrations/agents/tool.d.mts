import type { Session } from '../../index.js'
import type { ChDBErrorObject } from './errors.mjs'

export interface QueryResultObject {
  rows: Array<Record<string, unknown>>
  rowCount: number
  truncated: boolean
  columnNames: string[]
  elapsedS: number | null
  bytesRead: number | null
}

/** Result of a query: decoded rows plus honest truncation / stat metadata. */
export class QueryResult {
  rows: Array<Record<string, unknown>>
  rowCount: number
  truncated: boolean
  columnNames: string[]
  elapsedS: number | null
  bytesRead: number | null
  toObject(): QueryResultObject
}

export interface DescribeColumn {
  name: string
  type: string
  default_kind: string
  comment: string
}

/** The tool-dispatch envelope returned by ChDBTool.call() (contract pillar P4). */
export type ToolEnvelope<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: ChDBErrorObject }

export interface ChDBToolOptions {
  /** On-disk path for a new Session (':memory:' default) when `session` is omitted. */
  path?: string
  /** Engine-enforced read-only (SET readonly=2). Default true. Fixed at construction. */
  readOnly?: boolean
  /** Cap on rows returned (default 1000); `truncated` flags when hit. */
  maxRows?: number
  /** Secondary byte guard on the returned rows (default 1_000_000). */
  maxBytes?: number
  /** Optional engine wall-clock bound in seconds; a runaway query raises TIMEOUT_EXCEEDED. */
  maxExecutionTime?: number | null
  /** Optional allowlist of path prefixes for file()/s3()/url() and attachments. */
  fileAllowlist?: string[] | null
  /** Files to register as views before the read-only lock: { name: path | [path, format] }. */
  attachments?: Record<string, string | [string, string]> | null
  /** Reuse an existing chdb Session instead of creating one. */
  session?: Session | null
}

/**
 * The canonical chDB agent tool for the TypeScript binding — the chdb-node
 * implementation of the cross-language CONTRACT.md (Python chdb.agents.ChDBTool
 * is the reference). Agent frameworks shim these methods; behavior is verified
 * against the shared conformance/cases.jsonl fixture.
 */
export class ChDBTool {
  constructor(opts?: ChDBToolOptions)
  readonly readOnly: boolean
  readonly maxRows: number
  readonly maxBytes: number
  readonly maxExecutionTime: number | null
  readonly fileAllowlist: string[] | null
  query(sql: string, opts?: { params?: Record<string, unknown> | null; maxRows?: number | null }): Promise<QueryResult>
  listDatabases(): Promise<string[]>
  listTables(database?: string | null): Promise<string[]>
  describe(target: string, opts?: { database?: string | null; params?: Record<string, unknown> | null }): Promise<DescribeColumn[]>
  getSampleData(target: string, opts?: { database?: string | null; limit?: number }): Promise<QueryResult>
  listFunctions(opts?: { like?: string | null; limit?: number }): Promise<string[]>
  attachFile(name: string, path: string, format?: string | null): Promise<string>
  toolSpecs(dialect?: import('./descriptors.mjs').ToolSpecDialect): object[]
  call(name: string, args?: Record<string, unknown>): Promise<ToolEnvelope>
  close(): void
}

export default ChDBTool
