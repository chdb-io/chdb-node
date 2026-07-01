// Vercel AI SDK tools for chDB. Import from 'chdb/ai-sdk'.
//
//   import { chdbTools } from 'chdb/ai-sdk'
//   import { Session } from 'chdb'
//   const db = new Session('./db')
//   const result = await generateText({
//     model, prompt,
//     tools: chdbTools({ session: db }),   // chdbQuery + chdbListTables + chdbDescribeSource
//   })
//
// `ai` and `zod` are optional peer dependencies — install them in your app.

import { tool } from 'ai'
import { z } from 'zod'
import {
  createChdbExecutor,
  CHDB_QUERY_DESCRIPTION,
  CHDB_LIST_TABLES_DESCRIPTION,
  CHDB_DESCRIBE_DESCRIPTION,
  CHDB_SQL_FIELD_DESCRIPTION,
  CHDB_SOURCE_FIELD_DESCRIPTION,
} from './chdb-tool-core.mjs'

/**
 * A schema-aware chDB toolset: discover tables, inspect a source's columns, then run a
 * read-only query. Pass the whole object as `tools` to generateText/streamText.
 * @param {{ session?: object, allowWrite?: boolean, maxRows?: number }} [opts]
 */
export function chdbTools(opts = {}) {
  const ex = createChdbExecutor(opts)
  return {
    chdbQuery: tool({
      description: CHDB_QUERY_DESCRIPTION,
      inputSchema: z.object({ sql: z.string().describe(CHDB_SQL_FIELD_DESCRIPTION) }),
      execute: async ({ sql }) => ex.query(sql),
    }),
    chdbListTables: tool({
      description: CHDB_LIST_TABLES_DESCRIPTION,
      inputSchema: z.object({}),
      execute: async () => ex.listTables(),
    }),
    chdbDescribeSource: tool({
      description: CHDB_DESCRIBE_DESCRIPTION,
      inputSchema: z.object({ source: z.string().describe(CHDB_SOURCE_FIELD_DESCRIPTION) }),
      execute: async ({ source }) => ex.describeSource(source),
    }),
  }
}

/** Just the query tool, for when you only want one. */
export function chdbQueryTool(opts = {}) {
  return chdbTools(opts).chdbQuery
}

export default chdbTools
