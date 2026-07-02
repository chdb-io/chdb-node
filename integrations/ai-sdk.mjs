// Vercel AI SDK tools for chDB. Import from 'chdb/ai-sdk'.
//
//   import { chdbTools } from 'chdb/ai-sdk'
//   import { Session } from 'chdb'
//   const db = new Session('./db')
//   const result = await generateText({
//     model, prompt,
//     tools: chdbTools({ session: db }),
//   })
//
// The tools are the canonical chDB agent surface defined in
// integrations/agents/CONTRACT.md — run_select_query, list_databases,
// list_tables, describe_table, get_sample_data, list_functions, attach_file —
// each a thin wrapper that delegates to ChDBTool.call(), so behavior is identical
// to the Mastra adapter and to the Python reference (chdb.agents.ChDBTool).
//
// `ai` and `zod` are optional peer dependencies — install them in your app.

import { tool } from 'ai'
import { ChDBTool } from './agents/tool.mjs'
import { AGENT_TOOL_DESCRIPTORS, resolveTool } from './agents/framework.mjs'

export { ChDBTool } from './agents/tool.mjs'
export {
  ChDBError,
  ChDBReadOnlyError,
  ChDBSyntaxError,
  ChDBUnknownObjectError,
} from './agents/errors.mjs'

/**
 * The canonical chDB agent toolset for the Vercel AI SDK: run_select_query,
 * list_databases, list_tables, describe_table, get_sample_data, list_functions,
 * attach_file. Pass the whole object as `tools` to generateText/streamText. Each
 * tool resolves to the contract's dispatch envelope ({ ok, result } | { ok, error }),
 * so the model reads engine errors and self-corrects (P4).
 * @param {{ session?: object, readOnly?: boolean, allowWrite?: boolean, maxRows?: number,
 *   maxBytes?: number, maxExecutionTime?: number|null, fileAllowlist?: string[]|null,
 *   attachments?: object|null, path?: string, tool?: ChDBTool }} [opts]
 */
export function chdbTools(opts = {}) {
  const t = resolveTool(opts)
  const tools = {}
  for (const d of AGENT_TOOL_DESCRIPTORS) {
    tools[d.name] = tool({
      description: d.description,
      inputSchema: d.schema,
      execute: async (input) => t.call(d.name, input ?? {}),
    })
  }
  return tools
}

/** Just the read-only query tool, for when you only want one. */
export function chdbQueryTool(opts = {}) {
  return chdbTools(opts).run_select_query
}

export default chdbTools
