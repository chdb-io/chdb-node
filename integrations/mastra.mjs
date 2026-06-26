// Mastra integration for chDB. Import from 'chdb/mastra'.
//
//   import { chdbTools, ChDBVector } from 'chdb/mastra'
//   import { Session } from 'chdb'
//   const db = new Session('./db')
//   const agent = new Agent({ name: 'analyst', model, tools: chdbTools({ session: db }) })
//   const store = new ChDBVector({ session: db })   // RAG vector store (HNSW index)
//
// `@mastra/core` and `zod` are optional peer dependencies — install them in your app.

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import {
  createChdbExecutor,
  CHDB_QUERY_DESCRIPTION,
  CHDB_LIST_TABLES_DESCRIPTION,
  CHDB_DESCRIBE_DESCRIPTION,
  CHDB_SQL_FIELD_DESCRIPTION,
  CHDB_SOURCE_FIELD_DESCRIPTION,
} from './chdb-tool-core.mjs'

export { ChDBVector } from './chdb-vector.mjs'

const rowsOutput = z.object({
  rows: z.array(z.record(z.string(), z.any())),
  rowCount: z.number(),
  truncated: z.boolean(),
  error: z.string().optional(),
})

// Mastra passes inputs under `.context`; fall back to the bare object for older versions.
const field = (input, name) => (input && input.context && input.context[name]) ?? (input && input[name])

/**
 * A schema-aware chDB toolset for Mastra agents (discover → inspect → read-only query).
 * @param {{ session?: object, allowWrite?: boolean, maxRows?: number }} [opts]
 */
export function chdbTools(opts = {}) {
  const ex = createChdbExecutor(opts)
  return {
    chdbQuery: createTool({
      id: 'chdb-query',
      description: CHDB_QUERY_DESCRIPTION,
      inputSchema: z.object({ sql: z.string().describe(CHDB_SQL_FIELD_DESCRIPTION) }),
      outputSchema: rowsOutput,
      execute: async (input) => ex.query(field(input, 'sql')),
    }),
    chdbListTables: createTool({
      id: 'chdb-list-tables',
      description: CHDB_LIST_TABLES_DESCRIPTION,
      inputSchema: z.object({}),
      outputSchema: z.object({ tables: z.array(z.string()), error: z.string().optional() }),
      execute: async () => ex.listTables(),
    }),
    chdbDescribeSource: createTool({
      id: 'chdb-describe-source',
      description: CHDB_DESCRIBE_DESCRIPTION,
      inputSchema: z.object({ source: z.string().describe(CHDB_SOURCE_FIELD_DESCRIPTION) }),
      outputSchema: z.object({
        columns: z.array(z.object({ name: z.string(), type: z.string() })),
        error: z.string().optional(),
      }),
      execute: async (input) => ex.describeSource(field(input, 'source')),
    }),
  }
}

/** Just the query tool, for when you only want one. */
export function chdbQueryTool(opts = {}) {
  return chdbTools(opts).chdbQuery
}

export default chdbTools
