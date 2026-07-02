// Mastra integration for chDB. Import from 'chdb/mastra'.
//
//   import { chdbTools, ChDBVector } from 'chdb/mastra'
//   import { Session } from 'chdb'
//   const db = new Session('./db')
//   const agent = new Agent({ name: 'analyst', model, tools: chdbTools({ session: db }) })
//   const store = new ChDBVector({ session: db })   // RAG vector store (HNSW index)
//
// The tools are the canonical chDB agent surface defined in
// integrations/agents/CONTRACT.md — run_select_query, list_databases,
// list_tables, describe_table, get_sample_data, list_functions, attach_file —
// each a thin wrapper that delegates to ChDBTool.call(), so behavior is identical
// to the AI SDK adapter and to the Python reference (chdb.agents.ChDBTool).
//
// `@mastra/core` and `zod` are optional peer dependencies — install them in your app.

import { createTool } from '@mastra/core/tools'
import { ChDBTool } from './agents/tool.mjs'
import { AGENT_TOOL_DESCRIPTORS, resolveTool } from './agents/framework.mjs'

export { ChDBVector } from './chdb-vector.mjs'
export { ChDBStore } from './chdb-store.mjs'
export { ChDBTool } from './agents/tool.mjs'
export {
  ChDBError,
  ChDBReadOnlyError,
  ChDBSyntaxError,
  ChDBUnknownObjectError,
} from './agents/errors.mjs'

// Mastra passes inputs under `.context`; fall back to the bare object for older versions.
const inputArgs = (input) => (input && input.context) || input || {}

/**
 * The canonical chDB agent toolset for Mastra agents: run_select_query,
 * list_databases, list_tables, describe_table, get_sample_data, list_functions,
 * attach_file. Each tool resolves to the contract's dispatch envelope
 * ({ ok, result } | { ok, error }), so the model reads engine errors and
 * self-corrects (P4).
 *
 * When you don't pass `session`/`tool`, the toolset owns a Session; call the
 * non-enumerable `tools.close()` when done to release it (a no-op if you passed
 * your own). It's non-enumerable so Mastra doesn't treat it as a tool.
 * @param {{ session?: object, readOnly?: boolean, allowWrite?: boolean, maxRows?: number,
 *   maxBytes?: number, maxExecutionTime?: number|null, fileAllowlist?: string[]|null,
 *   attachments?: object|null, path?: string, tool?: ChDBTool }} [opts]
 */
export function chdbTools(opts = {}) {
  const t = resolveTool(opts)
  const tools = {}
  for (const d of AGENT_TOOL_DESCRIPTORS) {
    tools[d.name] = createTool({
      id: d.id,
      description: d.description,
      inputSchema: d.schema,
      execute: async (input) => t.call(d.name, inputArgs(input)),
    })
  }
  Object.defineProperty(tools, 'close', { value: () => t.close(), enumerable: false })
  return tools
}

/**
 * Just the read-only query tool, for when you only want one. Carries the same
 * non-enumerable `close()` as the full toolset (owned Session lifetime).
 */
export function chdbQueryTool(opts = {}) {
  const tools = chdbTools(opts)
  const t = tools.run_select_query
  Object.defineProperty(t, 'close', { value: tools.close, enumerable: false })
  return t
}

export default chdbTools
