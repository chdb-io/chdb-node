import type { Session } from '../index.js'

export interface ChdbToolOptions {
  /** A chdb Session whose data to query. Defaults to the in-process default connection. */
  session?: Session
  /** Allow writes/DDL. Default false: reads run on an engine-level read-only session. */
  allowWrite?: boolean
  /** Cap on rows returned to the model (default 1000); `truncated` flags when hit. */
  maxRows?: number
}

export interface ChdbQueryResult {
  rows: Array<Record<string, unknown>>
  rowCount: number
  truncated: boolean
  error?: string
}
export interface ChdbListTablesResult {
  tables: string[]
  error?: string
}
export interface ChdbDescribeResult {
  columns: Array<{ name: string; type: string }>
  error?: string
}

/** A tool whose `execute` resolves to a typed result `T` (the framework adds its own fields). */
export interface ChdbTool<T> {
  description: string
  execute(args: Record<string, unknown>, options?: unknown): Promise<T>
  [key: string]: unknown
}

/** A schema-aware chDB toolset for the Vercel AI SDK. */
export function chdbTools(opts?: ChdbToolOptions): {
  chdbQuery: ChdbTool<ChdbQueryResult>
  chdbListTables: ChdbTool<ChdbListTablesResult>
  chdbDescribeSource: ChdbTool<ChdbDescribeResult>
}
/** Just the read-only query tool. */
export function chdbQueryTool(opts?: ChdbToolOptions): ChdbTool<ChdbQueryResult>
export default chdbTools
