// Shared glue for framework adapters (Vercel AI SDK, Mastra). Both adapters build
// their native tools from the SAME descriptor list and delegate execution to
// ChDBTool.call(), so every framework exposes the identical canonical contract
// surface (CONTRACT.md) with identical behavior — the adapters are thin shims,
// not parallel implementations. `zod` is an optional peer of the adapters that
// pull this in.

import { z } from 'zod'
import { ChDBTool } from './tool.mjs'

/**
 * Resolve a ChDBTool from adapter options. Pass a prebuilt `tool`, or the
 * construction options; `allowWrite` is accepted as the inverse of `readOnly`
 * for convenience.
 * @param {{ tool?: ChDBTool, session?: any, path?: string, readOnly?: boolean,
 *   allowWrite?: boolean, maxRows?: number, maxBytes?: number,
 *   maxExecutionTime?: number|null, fileAllowlist?: string[]|null,
 *   attachments?: object|null }} [opts]
 */
export function resolveTool(opts = {}) {
  if (opts.tool instanceof ChDBTool) return opts.tool
  const readOnly = opts.readOnly ?? (opts.allowWrite != null ? !opts.allowWrite : true)
  return new ChDBTool({
    session: opts.session ?? null,
    path: opts.path,
    readOnly,
    maxRows: opts.maxRows,
    maxBytes: opts.maxBytes,
    maxExecutionTime: opts.maxExecutionTime ?? null,
    fileAllowlist: opts.fileAllowlist ?? null,
    attachments: opts.attachments ?? null,
  })
}

// The canonical tool set (names + argument schemas match CONTRACT.md and the
// Python reference / mcp-clickhouse). `name` is the contract name the model sees;
// `id` is the kebab form Mastra requires. The input schema is exactly the
// arguments ChDBTool.call() expects, so an adapter is `execute → tool.call(name,
// input)`.
export const AGENT_TOOL_DESCRIPTORS = [
  {
    name: 'run_select_query',
    id: 'chdb-run-select-query',
    description:
      'Run a read-only ClickHouse SQL query with chDB, an in-process ClickHouse engine ' +
      '(full SQL dialect: 1000+ functions, window functions, arrays, JSON). Pass values ' +
      'via `params` as {name:Type} placeholders (e.g. WHERE id = {id:Int64}); never ' +
      'concatenate values into the SQL. Read external data inline with table functions: ' +
      "file('path'[, 'format']), s3('url','format'), url(...), postgresql(...), mysql(...). " +
      'Returns rows plus a `truncated` flag. First use list_tables / describe_table to learn the schema.',
    schema: z.object({
      sql: z.string().describe('A complete read-only ClickHouse SQL statement; use {name:Type} placeholders for values.'),
      params: z.record(z.string(), z.any()).optional().describe('Values bound to the {name:Type} placeholders in `sql`.'),
    }),
  },
  {
    name: 'list_databases',
    id: 'chdb-list-databases',
    description: 'List the databases available in the chDB session.',
    schema: z.object({}),
  },
  {
    name: 'list_tables',
    id: 'chdb-list-tables',
    description: 'List the tables in a database (the current database if `database` is omitted).',
    schema: z.object({
      database: z.string().optional().describe('Database to list tables from; current database if omitted.'),
    }),
  },
  {
    name: 'describe_table',
    id: 'chdb-describe-table',
    description:
      'Describe the columns and types of a table (optionally database-qualified) or a ' +
      "table-function expression, e.g. s3('https://bucket/f.parquet','Parquet') or file('data.csv').",
    schema: z.object({
      target: z.string().describe("A table name or a table-function expression, e.g. \"events\" or \"s3('s3://b/f.parquet','Parquet')\"."),
      database: z.string().optional().describe('Database qualifier for a table name (invalid for a table function).'),
    }),
  },
  {
    name: 'get_sample_data',
    id: 'chdb-get-sample-data',
    description: 'Return a few sample rows from a table or table-function expression, to see real values before querying.',
    schema: z.object({
      target: z.string().describe('A table name or a table-function expression.'),
      database: z.string().optional(),
      limit: z.number().int().optional().describe('Number of sample rows (default 5).'),
    }),
  },
  {
    name: 'list_functions',
    id: 'chdb-list-functions',
    description: 'List available ClickHouse SQL functions, optionally filtered by an ILIKE pattern.',
    schema: z.object({
      like: z.string().optional().describe('ILIKE pattern to filter function names, e.g. "%array%".'),
      limit: z.number().int().optional().describe('Max function names to return (default 200).'),
    }),
  },
  {
    name: 'attach_file',
    id: 'chdb-attach-file',
    description:
      'Register a local file as a queryable named table (a view over file()). Writable tools only; ' +
      'on a read-only tool this returns a READONLY error — declare files via the tool\'s attachments option instead.',
    schema: z.object({
      name: z.string().describe('The table name to register the file under.'),
      path: z.string().describe('Path to the local file.'),
      format: z.string().optional().describe('chDB/ClickHouse input format (auto-detected from the extension if omitted).'),
    }),
  },
]
