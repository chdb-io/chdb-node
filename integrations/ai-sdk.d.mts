import type { ChDBTool, ChDBToolOptions, ToolEnvelope } from './agents/tool.mjs'

export { ChDBTool } from './agents/tool.mjs'
export {
  ChDBError,
  ChDBReadOnlyError,
  ChDBSyntaxError,
  ChDBUnknownObjectError,
} from './agents/errors.mjs'

export interface ChdbToolsOptions extends ChDBToolOptions {
  /** Inverse of `readOnly`, accepted for convenience (allowWrite:true === readOnly:false). */
  allowWrite?: boolean
  /** Use a prebuilt ChDBTool instead of constructing one from these options. */
  tool?: ChDBTool
}

/** A Vercel AI SDK tool whose `execute` resolves to the dispatch envelope. */
export interface ChdbAgentTool {
  description: string
  execute(input: Record<string, unknown>, options?: unknown): Promise<ToolEnvelope>
  [key: string]: unknown
}

/** The canonical CONTRACT.md tool set, keyed by contract tool name. */
export type ChdbToolset = Record<
  | 'run_select_query'
  | 'list_databases'
  | 'list_tables'
  | 'describe_table'
  | 'get_sample_data'
  | 'list_functions'
  | 'attach_file',
  ChdbAgentTool
>

/** The canonical chDB agent toolset for the Vercel AI SDK (thin over ChDBTool). */
export function chdbTools(opts?: ChdbToolsOptions): ChdbToolset
/** Just the read-only run_select_query tool. */
export function chdbQueryTool(opts?: ChdbToolsOptions): ChdbAgentTool
export default chdbTools
