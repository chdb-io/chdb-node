// chdb/agents — the framework-agnostic chDB agent-tool base.
//
// This is the TypeScript binding's implementation of the cross-language
// CONTRACT.md (the Python chdb.agents package is the reference). Import ChDBTool
// directly for any agent runtime, or use the thin framework adapters at
// 'chdb/ai-sdk' and 'chdb/mastra', which are built on top of this.

export { ChDBTool, QueryResult } from './tool.mjs'
export {
  ChDBError,
  ChDBReadOnlyError,
  ChDBSyntaxError,
  ChDBUnknownObjectError,
  parseError,
} from './errors.mjs'
export { quoteIdent, quoteString, InvalidIdentifier } from './safety.mjs'
export { default } from './tool.mjs'
