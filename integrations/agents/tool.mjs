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
import { toolSpecs } from './descriptors.mjs'
import { ChDBError, ChDBReadOnlyError, parseError } from './errors.mjs'
import { pathAllowed, quoteIdent, quoteString, scanFilePaths } from './safety.mjs'

// Coerce a numeric argument to an integer, or throw a typed INVALID_ARGUMENT.
// A non-numeric cap must fail loudly: Number('lots') is NaN, and every NaN
// comparison is false, so before this guard a garbage maxRows silently
// disabled the result cap (the Python reference raises instead — same
// behavior now, per CONTRACT.md).
function intArg(value, name) {
  const n = Math.floor(Number(value))
  if (value == null || value === '' || !Number.isFinite(n)) {
    throw new ChDBError(`${name} must be an integer, got ${JSON.stringify(value)}`, {
      type: 'INVALID_ARGUMENT',
    })
  }
  return n
}

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
    this.maxRows = Math.max(1, intArg(maxRows, 'maxRows'))
    this.maxBytes = Math.max(1, intArg(maxBytes, 'maxBytes'))
    this.maxExecutionTime =
      maxExecutionTime == null ? null : Math.max(0, intArg(maxExecutionTime, 'maxExecutionTime'))
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
    const cap = maxRows == null ? this.maxRows : Math.max(1, intArg(maxRows, 'maxRows'))
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
    // Rows are measured in UTF-8 BYTES of their compact JSON encoding —
    // String.length counts UTF-16 units ("汉" = 1) while the Python reference
    // would count its ASCII-escaped form ("汉" = 6); UTF-8 bytes is the one
    // measure both bindings can produce identically (CONTRACT.md P3).
    if (this.maxBytes) {
      let size = 0
      for (let i = 0; i < rows.length; i++) {
        size += Buffer.byteLength(JSON.stringify(rows[i]), 'utf8')
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
  // `null`/`undefined` mean "not provided"; any other value (including '') is a
  // real database argument and must be validated — an empty string flows into
  // quoteIdent() and is rejected rather than silently treated as unqualified
  // (a falsy check here once made '' skip qualification; the Python reference
  // rejects it).
  #qualify(target, database = null) {
    if (target.includes('(')) {
      if (database != null) {
        throw new ChDBError('database qualifier is not valid for a table-function target')
      }
      return target
    }
    const ident = quoteIdent(target)
    return database != null ? `${quoteIdent(database)}.${ident}` : ident
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
    const n = intArg(limit, 'limit')
    return this.query(`SELECT * FROM ${ref} LIMIT {n:UInt32}`, {
      params: { n },
      maxRows: n,
    })
  }

  async listFunctions({ like = null, limit = 200 } = {}) {
    const n = intArg(limit, 'limit')
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

  /**
   * Tool definitions for auto-registration into any framework, generated from
   * descriptors.json (the single source of the model-visible surface).
   * @param {'anthropic'|'openai'|'mcp'} [dialect] selects the shape
   */
  toolSpecs(dialect = 'anthropic') {
    return toolSpecs(dialect)
  }

  /**
   * Dispatch a tool call, resolving to an error ENVELOPE instead of throwing, so
   * the model reads the engine message and can self-correct (P4).
   * @returns {Promise<{ok: true, result: any} | {ok: false, error: {code:number, type:string, message:string}}>}
   */
  async call(name, args = {}) {
    const methodName = TOOL_METHODS[name]
    if (!methodName) {
      return { ok: false, error: { code: 0, type: 'UNKNOWN_TOOL', message: 'unknown tool: ' + name } }
    }
    // Caller mistakes on the dispatch path never throw (P4): a non-object
    // arguments payload comes back as an envelope, same as an unknown tool.
    // (Spreading a string would silently produce {0: 'S', 1: 'E', ...} garbage,
    // and the Python reference would raise on dict("...").)
    if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
      return {
        ok: false,
        error: {
          code: 0,
          type: 'INVALID_ARGUMENT',
          message: 'arguments must be an object, got ' + (Array.isArray(args) ? 'array' : typeof args),
        },
      }
    }
    const a = { ...(args || {}) }
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
