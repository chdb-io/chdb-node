import type { Session } from '../index.js'

export interface ChdbToolOptions {
  /** A chdb Session whose data to query. Defaults to the in-process default connection. */
  session?: Session
  /** Allow writes/DDL. Default false: reads run on an engine-level read-only session. */
  allowWrite?: boolean
  /** Cap on rows returned to the model (default 1000); `truncated` flags when hit. */
  maxRows?: number
}

/** A schema-aware chDB toolset: { chdbQuery, chdbListTables, chdbDescribeSource }. */
export function chdbTools(opts?: ChdbToolOptions): Record<string, unknown>
/** Just the read-only query tool. */
export function chdbQueryTool(opts?: ChdbToolOptions): unknown
export default chdbTools
