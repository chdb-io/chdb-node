// ChDBTool — the canonical chDB agent tool for the TypeScript binding.
//
// This is the chdb-node implementation of the language-neutral CONTRACT.md. The
// Python chdb.agents.ChDBTool is the reference; this class implements the SAME
// methods with the SAME semantics and is verified against the SAME fixture
// (conformance/cases.jsonl). Agent frameworks (Vercel AI SDK, Mastra, ...) shim
// these methods in a few lines instead of each re-implementing query +
// introspection + safety with subtly different behavior.
//
// Four contract pillars:
//   P1 read-only by the engine  (SET readonly=2 at session creation; opt out with readOnly:false)
//   P2 value binding            (values bound as chDB params, never concatenated; identifiers quoted)
//   P3 result cap               (maxRows / maxBytes; truncation is flagged, never silent)
//   P4 error-to-model           (call() returns an error envelope; query() rejects with typed errors)
//
// The Python-only dataframe_query (in-process pandas via Python()) is
// intentionally NOT part of this binding — it's a language-specific capability,
// outside the cross-language base (see CONTRACT.md).

import { Session } from '../../index.mjs'
import { ChDBError, ChDBReadOnlyError, parseError } from './errors.mjs'
import { pathAllowed, quoteIdent, quoteString, scanFilePaths } from './safety.mjs'

/** Result of a query: decoded rows plus honest truncation / stat metadata. */
export class QueryResult {
  constructor(rows, truncated, columnNames, elapsedS = null, bytesRead = null) {
    this.rows = rows
    this.rowCount = rows.length
    this.truncated = truncated
    this.columnNames = columnNames
    this.elapsedS = elapsedS
    this.bytesRead = bytesRead
  }

  toObject() {
    return {
      rows: this.rows,
      rowCount: this.rowCount,
      truncated: this.truncated,
      columnNames: this.columnNames,
      elapsedS: this.elapsedS,
      bytesRead: this.bytesRead,
    }
  }
}

// Tool name -> method. Names match ClickHouse's MCP server (mcp-clickhouse) and
// the Python reference so the agent-facing corpus is consistent across bindings.
const TOOL_METHODS = {
  run_select_query: 'query',
  list_databases: 'listDatabases',
  list_tables: 'listTables',
  describe_table: 'describe',
  get_sample_data: 'getSampleData',
  list_functions: 'listFunctions',
  attach_file: 'attachFile',
}

export class ChDBTool {
  #session
  #ownsSession

  /**
   * @param {{
   *   path?: string, readOnly?: boolean, maxRows?: number, maxBytes?: number,
   *   maxExecutionTime?: number|null, fileAllowlist?: string[]|null,
   *   attachments?: Record<string, string|[string, string]>|null,
   *   session?: import('../../index.mjs').Session|null
   * }} [opts]
   */
  constructor(opts = {}) {
    const {
      path = ':memory:',
      readOnly = true,
      maxRows = 1000,
      maxBytes = 1_000_000,
      maxExecutionTime = null,
      fileAllowlist = null,
      attachments = null,
      session = null,
    } = opts

    this.readOnly = Boolean(readOnly)
    this.maxRows = Math.max(1, Math.floor(Number(maxRows) || 1000))
    this.maxBytes = Math.max(1, Math.floor(Number(maxBytes) || 1_000_000))
    this.maxExecutionTime =
      maxExecutionTime == null ? null : Math.max(0, Math.floor(Number(maxExecutionTime)))
    // null = no allowlist (all paths allowed); a list = only these prefixes.
    this.fileAllowlist = fileAllowlist && fileAllowlist.length ? [...fileAllowlist] : null

    this.#ownsSession = session == null
    // chdb-node Session('') is an ephemeral temp dir (the :memory: equivalent).
    this.#session =
      session ?? new Session(path === ':memory:' || path === '' || path == null ? '' : path)

    // If any setup below throws (a bad attachment path, an engine SET error),
    // the constructor never returns, so a Session we own would otherwise leak
    // (the caller has no instance to close()). Close it before re-throwing.
    try {
      // Exact 64-bit integers survive JSON as strings rather than lossy floats.
      this.#session.query('SET output_format_json_quote_64bit_integers=1', 'CSV')
      if (this.maxExecutionTime != null) {
        // engine-side wall-clock bound; a runaway query raises TIMEOUT_EXCEEDED
        this.#session.query(`SET max_execution_time=${this.maxExecutionTime}`, 'CSV')
      }
      // Attachments must be materialized BEFORE the read-only lock, because
      // CREATE VIEW is a write that readonly=2 rejects. This is why read-only
      // tools declare files at construction rather than via attachFile().
      for (const [name, spec] of Object.entries(attachments || {})) {
        const [p, fmt] = Array.isArray(spec) ? spec : [spec, null]
        this.#createFileView(name, p, fmt)
      }
      if (this.readOnly) {
        // readonly=2 (NOT 1): blocks INSERT/CREATE/ALTER/DROP while still allowing
        // SELECT and the file()/s3()/url() table functions that are chDB's whole
        // point. readonly=1 rejects those. Cannot be un-set.
        this.#session.query('SET readonly=2', 'CSV')
      }
    } catch (e) {
      if (this.#ownsSession && this.#session) {
        try {
          this.#session.close()
        } catch {
          /* best effort */
        }
        this.#session = null
      }
      throw e
    }
  }

  // ---- core query -------------------------------------------------------

  /**
   * Run read SQL. Values MUST be passed via `params` ({name:Type} + object),
   * never formatted into `sql`. Resolves to a QueryResult; rejects with ChDBError.
   * @param {string} sql
   * @param {{ params?: object|null, maxRows?: number|null }} [opts]
   */
  async query(sql, { params = null, maxRows = null } = {}) {
    if (typeof sql !== 'string' || sql.trim() === '') {
      throw new ChDBError('sql must be a non-empty string')
    }
    this.#enforceAllowlist(sql)
    const cap = maxRows == null ? this.maxRows : Math.max(1, Math.floor(Number(maxRows)))
    let obj
    try {
      const hasParams = params && Object.keys(params).length > 0
      const res = hasParams
        ? await this.#session.queryBindAsync(sql, params, { format: 'JSON' })
        : await this.#session.queryAsync(sql, { format: 'JSON' })
      obj = res.json() || {}
    } catch (e) {
      // Malformed / non-JSON engine output and engine errors alike become a
      // typed ChDBError rather than a bare error leaking to the caller.
      throw parseError(e)
    }
    const data = Array.isArray(obj.data) ? obj.data : []
    const meta = Array.isArray(obj.meta) ? obj.meta : []
    const stats = obj.statistics || {}
    const cols = meta.map((m) => m.name)
    let truncated = data.length > cap
    let rows = truncated ? data.slice(0, cap) : data
    // Secondary byte guard, applied whether or not the row cap already fired: a
    // few very large rows under maxRows must still be capped by maxBytes.
    if (this.maxBytes) {
      let size = 0
      for (let i = 0; i < rows.length; i++) {
        size += JSON.stringify(rows[i]).length
        if (size > this.maxBytes) {
          rows = rows.slice(0, i)
          truncated = true
          break
        }
      }
    }
    return new QueryResult(rows, truncated, cols, stats.elapsed ?? null, stats.bytes_read ?? null)
  }

  #enforceAllowlist(sql) {
    if (!this.fileAllowlist) return
    for (const [, path] of scanFilePaths(sql)) {
      if (!pathAllowed(path, this.fileAllowlist)) {
        throw new ChDBError(`source path not in file_allowlist: ${JSON.stringify(path)}`, {
          type: 'ACCESS_DENIED',
        })
      }
    }
  }

  // ---- source catalog ---------------------------------------------------

  #createFileView(name, path, format = null) {
    if (this.fileAllowlist && !pathAllowed(path, this.fileAllowlist)) {
      throw new ChDBError(`attach path not in file_allowlist: ${JSON.stringify(path)}`, {
        type: 'ACCESS_DENIED',
      })
    }
    let src = `file(${quoteString(path)}`
    if (format) src += `, ${quoteString(format)}`
    src += ')'
    // The path/format are baked in as string literals (a stored view definition
    // can't carry bound params); the view name is a quoted identifier. This is a
    // write, so it only succeeds before the read-only lock.
    this.#session.query(`CREATE VIEW ${quoteIdent(name)} AS SELECT * FROM ${src}`, 'CSV')
  }

  /**
   * Register a local file as a queryable named table (a view over file()).
   * On a read-only tool this rejects (CREATE VIEW is a write) — declare files via
   * the `attachments` constructor arg instead (attached before the read-only lock).
   */
  async attachFile(name, path, format = null) {
    if (this.readOnly) {
      throw new ChDBReadOnlyError(
        `attachFile needs a writable tool; for a read-only tool pass ` +
          `attachments: { ${JSON.stringify(name)}: ${JSON.stringify(path)} } to the ` +
          `constructor (attached before the read-only lock)`,
        { code: 164, type: 'READONLY' },
      )
    }
    try {
      this.#createFileView(name, path, format)
    } catch (e) {
      if (e instanceof ChDBError) throw e
      throw parseError(e)
    }
    return name
  }

  // ---- introspection ----------------------------------------------------

  async listDatabases() {
    return (await this.query('SHOW DATABASES')).rows.map((r) => r.name)
  }

  async listTables(database = null) {
    if (database == null) {
      const sql =
        'SELECT name FROM system.tables WHERE database = currentDatabase() ORDER BY name'
      return (await this.query(sql)).rows.map((r) => r.name)
    }
    const sql = 'SELECT name FROM system.tables WHERE database = {db:String} ORDER BY name'
    return (await this.query(sql, { params: { db: database } })).rows.map((r) => r.name)
  }

  // Turn (target[, database]) into a safe SQL source reference:
  // - target containing '(' is a table-function expression, passed through as
  //   SQL (a database qualifier is invalid); read-only + no-write makes its
  //   literal args inert.
  // - otherwise target is a table identifier, backtick-quoted; with `database`
  //   each part is quoted independently as `db`.`table` (a dotted name is never
  //   mis-quoted as one identifier).
  #qualify(target, database = null) {
    if (target.includes('(')) {
      if (database) {
        throw new ChDBError('database qualifier is not valid for a table-function target')
      }
      return target
    }
    const ident = quoteIdent(target)
    return database ? `${quoteIdent(database)}.${ident}` : ident
  }

  /**
   * Describe a table (optionally `database`-qualified) OR a table-function
   * expression (e.g. file('x.parquet')).
   */
  async describe(target, { database = null, params = null } = {}) {
    const ref = this.#qualify(target, database)
    const rows = (await this.query(`DESCRIBE TABLE ${ref} `, { params })).rows
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      default_kind: r.default_type || '',
      comment: r.comment || '',
    }))
  }

  async getSampleData(target, { database = null, limit = 5 } = {}) {
    const ref = this.#qualify(target, database)
    const n = Math.floor(Number(limit))
    return this.query(`SELECT * FROM ${ref} LIMIT {n:UInt32}`, {
      params: { n },
      maxRows: n,
    })
  }

  async listFunctions({ like = null, limit = 200 } = {}) {
    const n = Math.floor(Number(limit))
    let rows
    if (like) {
      const sql =
        'SELECT name FROM system.functions WHERE name ILIKE {like:String} ORDER BY name LIMIT {n:UInt32}'
      rows = (await this.query(sql, { params: { like, n }, maxRows: n })).rows
    } else {
      const sql = 'SELECT name FROM system.functions ORDER BY name LIMIT {n:UInt32}'
      rows = (await this.query(sql, { params: { n }, maxRows: n })).rows
    }
    return rows.map((r) => r.name)
  }

  // ---- agent integration ------------------------------------------------

  /** JSON-schema tool definitions for auto-registration into any framework. */
  toolSpecs() {
    const s = (properties) => ({ type: 'object', properties })
    return [
      {
        name: 'run_select_query',
        description: 'Run a read-only ClickHouse SQL query via chDB and return rows.',
        input_schema: s({ sql: { type: 'string' }, params: { type: 'object' } }),
      },
      { name: 'list_databases', description: 'List databases.', input_schema: s({}) },
      {
        name: 'list_tables',
        description: 'List tables in a database (current if omitted).',
        input_schema: s({ database: { type: 'string' } }),
      },
      {
        name: 'describe_table',
        description: 'Describe a table (optionally database-qualified) or table function.',
        input_schema: s({ target: { type: 'string' }, database: { type: 'string' } }),
      },
      {
        name: 'get_sample_data',
        description: 'Return a few sample rows from a table or table function.',
        input_schema: s({
          target: { type: 'string' },
          database: { type: 'string' },
          limit: { type: 'integer' },
        }),
      },
      {
        name: 'list_functions',
        description: 'List available SQL functions.',
        input_schema: s({ like: { type: 'string' }, limit: { type: 'integer' } }),
      },
      {
        name: 'attach_file',
        description: 'Register a local file as a queryable named table (writable tools only).',
        input_schema: s({
          name: { type: 'string' },
          path: { type: 'string' },
          format: { type: 'string' },
        }),
      },
    ]
  }

  /**
   * Dispatch a tool call, resolving to an error ENVELOPE instead of throwing, so
   * the model reads the engine message and can self-correct (P4).
   * @returns {Promise<{ok: true, result: any} | {ok: false, error: {code:number, type:string, message:string}}>}
   */
  async call(name, args = {}) {
    const a = { ...(args || {}) }
    const methodName = TOOL_METHODS[name]
    if (!methodName) {
      return { ok: false, error: { code: 0, type: 'UNKNOWN_TOOL', message: 'unknown tool: ' + name } }
    }
    try {
      let result
      if (methodName === 'query') {
        result = (await this.query(a.sql ?? '', { params: a.params })).toObject()
      } else if (methodName === 'describe') {
        result = await this.describe(a.target, { database: a.database })
      } else if (methodName === 'getSampleData') {
        result = (await this.getSampleData(a.target, { database: a.database, limit: a.limit ?? 5 })).toObject()
      } else if (methodName === 'listTables') {
        result = await this.listTables(a.database ?? null)
      } else if (methodName === 'listFunctions') {
        result = await this.listFunctions({ like: a.like ?? null, limit: a.limit ?? 200 })
      } else if (methodName === 'attachFile') {
        result = await this.attachFile(a.name, a.path, a.format ?? null)
      } else {
        result = await this[methodName]()
      }
      return { ok: true, result }
    } catch (e) {
      if (e instanceof ChDBError) return { ok: false, error: e.toObject() }
      // non-engine failure still reaches the model
      return { ok: false, error: { code: 0, type: 'TOOL_ERROR', message: (e && e.message) || String(e) } }
    }
  }

  close() {
    if (this.#ownsSession && this.#session) {
      try {
        this.#session.close()
      } catch {
        /* best effort */
      }
      this.#session = null
    }
  }
}

export default ChDBTool
