// Framework-agnostic core for the chDB agent toolset. The Vercel AI SDK and Mastra
// adapters (./ai-sdk.mjs, ./mastra.mjs) wrap these executors, so behavior is identical
// across frameworks. Authored as ESM because both target frameworks are ESM-only.

import { Session, queryAsync } from '../index.mjs'

export const CHDB_QUERY_DESCRIPTION =
  'Run a read-only ClickHouse SQL query with chDB, an in-process ClickHouse engine ' +
  '(full SQL dialect: 1000+ functions, window functions, arrays, JSON). First use ' +
  'chdbListTables / chdbDescribeSource to learn the schema, then write the query. Read ' +
  'external data inline with table functions: file(\'path\'[, \'format\']), s3(\'url\', \'format\'), ' +
  'url(\'url\', \'format\'), postgresql(\'host:port\',\'db\',\'table\',\'user\',\'pass\'), mysql(...), ' +
  'mongodb(...). Returns result rows as JSON. Only SELECT-style reads are allowed.'

export const CHDB_LIST_TABLES_DESCRIPTION =
  'List the tables and views available in the chDB session. Call this to discover what ' +
  'you can query before writing SQL.'

export const CHDB_DESCRIBE_DESCRIPTION =
  'Describe the columns and types of a chDB source so you can write a correct query. The ' +
  'source is a table name, or a table function for external data, e.g. ' +
  "s3('https://bucket/f.parquet','Parquet'), file('data.csv'), postgresql('host:5432','db','tbl','u','p')."

export const CHDB_SQL_FIELD_DESCRIPTION = 'A complete read-only ClickHouse SQL statement.'
export const CHDB_SOURCE_FIELD_DESCRIPTION =
  "A table name or a table-function expression, e.g. \"events\" or \"s3('s3://b/f.parquet','Parquet')\"."

/**
 * Build the shared executors the framework adapters wrap.
 * @param {{ session?: any, allowWrite?: boolean, maxRows?: number }} [opts]
 *   session: a chdb Session whose data to query (defaults to the in-process default
 *     connection, suitable for stateless file/s3/url queries).
 *   allowWrite: false (default) runs reads on a dedicated engine-level read-only session
 *     (SET readonly = 1) bound to the same data path, so a write/DDL the model emits is
 *     rejected by the engine, not just by a prompt. true uses the session directly.
 *   maxRows: cap on rows returned (default 1000); `truncated` flags when hit.
 */
export function createChdbExecutor(opts = {}) {
  const { session, allowWrite = false, maxRows = 1000 } = opts
  let roSession // lazy read-only twin

  function conn() {
    if (allowWrite) return session ?? null
    if (roSession === undefined) {
      roSession = new Session(session ? session.path : '')
      roSession.query('SET readonly = 1', 'CSV')
    }
    return roSession
  }

  async function runJson(sql) {
    const c = conn()
    return c ? c.queryAsync(sql, { format: 'JSON' }) : queryAsync(sql, { format: 'JSON' })
  }

  return {
    async query(sql) {
      if (typeof sql !== 'string' || sql.trim() === '') {
        return { rows: [], rowCount: 0, truncated: false, error: 'sql must be a non-empty string' }
      }
      try {
        const parsed = (await runJson(sql)).json() // ClickHouse JSON: { data, rows, statistics }
        const data = Array.isArray(parsed?.data) ? parsed.data : []
        const truncated = data.length > maxRows
        return {
          rows: truncated ? data.slice(0, maxRows) : data,
          rowCount: typeof parsed?.rows === 'number' ? parsed.rows : data.length,
          truncated,
        }
      } catch (e) {
        // Return the engine error to the model (so it can fix the SQL) rather than throw.
        return { rows: [], rowCount: 0, truncated: false, error: (e && e.message) || String(e) }
      }
    },

    async listTables() {
      try {
        const parsed = (await runJson('SHOW TABLES')).json()
        return { tables: (parsed?.data ?? []).map((r) => r.name) }
      } catch (e) {
        return { tables: [], error: (e && e.message) || String(e) }
      }
    },

    async describeSource(source) {
      if (typeof source !== 'string' || source.trim() === '') {
        return { columns: [], error: 'source must be a non-empty string' }
      }
      try {
        const parsed = (await runJson(`DESCRIBE TABLE ${source}`)).json()
        return { columns: (parsed?.data ?? []).map((r) => ({ name: r.name, type: r.type })) }
      } catch (e) {
        return { columns: [], error: (e && e.message) || String(e) }
      }
    },
  }
}
