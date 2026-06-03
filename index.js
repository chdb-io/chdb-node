const path = require('path');
const fs = require('fs');
// Resolve the native addon via the loader: per-platform subpackage in prod,
// locally compiled build/Release in dev, else a diagnostic error.
const chdbNode = require('./dist/loader.js').loadNative();
const { mkdtempSync, rmSync, realpathSync } = fs;
const { join, resolve: resolvePath } = require('path');
const os = require('os');
const {
  ChdbConnectionError,
  ChdbClosedError,
  ChdbAbortError,
  ChdbTimeoutError,
  ChdbInsertError,
  ChdbStreamError,
  mapNativeError,
} = require('./dist/errors.js');

const streamDecoder = new TextDecoder('utf-8');

// User-facing 'arrow' is an alias for ClickHouse's Arrow IPC stream format.
// Use the async/Buffer path for Arrow (binary-safe; the sync string path would
// truncate at NUL bytes). ClickHouse compresses Arrow IPC (lz4) by default,
// which apache-arrow JS cannot decode out of the box, so for 'arrow' we prefix
// a SET that disables Arrow output compression.
function prepArrow(query, opts, defaultFormat) {
  if (opts.format === 'arrow') {
    return {
      sql: `SET output_format_arrow_compression_method='none'; ${query}`,
      format: 'ArrowStream',
    };
  }
  return { sql: query, format: opts.format || defaultFormat };
}
const { formatParamValue } = require('./dist/serialize.js');
const { ChdbResult } = require('./dist/result.js');
const { buildInsertSQL } = require('./dist/insert.js');

// Map a native/query error into a typed ChdbInsertError (preserving message,
// clickhouseCode and cause).
function asInsertError(e) {
  if (e instanceof ChdbInsertError) return e;
  const q = asQueryError(e);
  return new ChdbInsertError(q.message, { cause: q, clickhouseCode: q.clickhouseCode });
}

// Shared insert impl: build the inline INSERT...VALUES and run it through the
// async native path (no event-loop freeze, no stdin read -> closes #26).
function runInsert(nativeAsyncCall, params) {
  let built;
  try {
    built = buildInsertSQL(params);
  } catch (e) {
    return Promise.reject(asInsertError(e));
  }
  if (built.rowsWritten === 0) {
    return Promise.resolve({ rowsWritten: 0, bytesRead: 0, elapsed: 0 });
  }
  return nativeAsyncCall(built.sql).then(
    (raw) => ({ rowsWritten: built.rowsWritten, bytesRead: raw.bytesRead, elapsed: raw.elapsed }),
    (e) => { throw asInsertError(e); },
  );
}

function emptyResult() {
  return new ChdbResult({ bytes: new Uint8Array(0), elapsed: 0, rowsRead: 0, bytesRead: 0 });
}

// Wrap a native query Promise ({bytes,elapsed,...}) into a ChdbResult, applying
// optional AbortSignal / timeout. Single-shot queries cannot be truly cancelled
// (no interrupt in the C ABI), so abort/timeout reject early and the native
// computation runs to completion in the background — the message says so.
function withAbortTimeout(nativePromise, opts) {
  const signal = opts && opts.signal;
  const timeout = opts && opts.timeout;
  if (!signal && !timeout) {
    return nativePromise.then((raw) => new ChdbResult(raw), (e) => { throw asQueryError(e); });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (fn, v) => { if (!settled) { settled = true; cleanup(); fn(v); } };
    function onAbort() {
      finish(reject, new ChdbAbortError(
        'Query aborted (the underlying computation may still run to completion in the background)'));
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeout) {
      timer = setTimeout(() => finish(reject, new ChdbTimeoutError(
        `Query timed out after ${timeout}ms (the underlying computation may still run in the background)`)), timeout);
    }
    nativePromise.then(
      (raw) => finish(resolve, new ChdbResult(raw)),
      (e) => finish(reject, asQueryError(e)),
    );
  });
}

// Format a JS params object into { name: paramString } for server-side binding
// (chdb_query_with_params). Throws ChdbBindError (typed) on bad values; that
// propagates as-is.
function formatParams(args) {
  const bound = {};
  for (const k of Object.keys(args || {})) {
    bound[k] = formatParamValue(args[k]);
  }
  return bound;
}

// Temp-dir prefix. The previous binding used 'tmp-chdb-node' — that has no
// separator before mkdtemp's random suffix, and 'tmp-' is redundant since the
// dir already lives under os.tmpdir(). 'chdb-node-' is a clean, recognizable
// prefix that the cleanup safety gate below keys on (basename must start with
// it before we will ever delete a directory).
const TMP_PREFIX = 'chdb-node-';

// Map an error thrown by the native addon to a typed ChdbError, preserving the
// original message (so v2 string matching keeps working) and chaining .cause.
function asQueryError(e) {
  if (e && typeof e.code === 'string' && e.code.startsWith('CHDB_')) return e;
  const message = e && e.message != null ? String(e.message) : String(e);
  return mapNativeError(message, undefined, e);
}

function asConnectionError(e) {
  if (e instanceof ChdbConnectionError) return e;
  const message = e && e.message != null ? String(e.message) : String(e);
  return new ChdbConnectionError(message, { cause: e });
}

// One materialized chunk of a streaming result.
class StreamChunk {
  constructor(bytes, numRows, format) {
    this._bytes = bytes;
    this.numRows = numRows;
    this.numBytes = bytes.length;
    this._format = format;
  }
  raw() { return this._bytes; }
  text() { return streamDecoder.decode(this._bytes); }
  rows() {
    if (this._format === 'JSONEachRow' || this._format === 'JSONCompactEachRow') {
      const t = this.text().replace(/\n$/, '');
      return t.length ? t.split('\n').map((l) => JSON.parse(l)) : [];
    }
    throw new ChdbStreamError(
      `rows() requires a JSON row format (got ${this._format}); use raw()/text() instead`);
  }
}

// AsyncIterable over StreamChunks. Each fetch runs off the event loop; the
// stream is cancelled/freed on completion, break, throw, or cancel().
class ChdbQueryStream {
  constructor(handle, format, signal) {
    this._handle = handle;
    this._format = format;
    this._signal = signal;
    this._closed = false;
  }

  get closed() { return this._closed; }

  async *[Symbol.asyncIterator]() {
    try {
      while (true) {
        if (this._signal && this._signal.aborted) {
          throw new ChdbAbortError('Stream aborted');
        }
        let raw;
        try {
          raw = await chdbNode.StreamFetch(this._handle);
        } catch (e) {
          this._closed = true;
          throw new ChdbStreamError(asQueryError(e).message, { cause: e });
        }
        if (raw.done) { this._closed = true; break; }
        yield new StreamChunk(raw.bytes, raw.numRows, this._format);
      }
    } finally {
      this.cancel();
    }
  }

  // Row-level sugar: flattens chunk.rows() across the stream.
  async *rows() {
    for await (const chunk of this) {
      for (const row of chunk.rows()) yield row;
    }
  }

  // Node Readable (object mode) over rows.
  toReadable() {
    const { Readable } = require('stream');
    return Readable.from(this.rows());
  }

  cancel() {
    if (this._closed) return;
    this._closed = true;
    try { chdbNode.StreamCancel(this._handle); } catch (_) { /* best effort */ }
  }
}

// Standalone exported query function
function query(query, format = "CSV") {
  if (!query) {
    return "";
  }
  try {
    return chdbNode.Query(query, format);
  } catch (e) {
    throw asQueryError(e);
  }
}

function queryBind(query, args = {}, format = "CSV") {
  if (!query) {
    return "";
  }
  const bound = formatParams(args); // may throw a typed ChdbBindError
  try {
    return chdbNode.QueryWithParams(query, format, bound);
  } catch (e) {
    throw asQueryError(e);
  }
}

// v3 async (non-blocking) standalone query. opts: { format?, signal?, timeout? }
function queryAsync(query, opts = {}) {
  if (!query) return Promise.resolve(emptyResult());
  const { sql, format } = prepArrow(query, opts, "CSV");
  return withAbortTimeout(chdbNode.QueryAsync(sql, format), opts);
}

function queryBindAsync(query, params = {}, opts = {}) {
  if (!query) return Promise.resolve(emptyResult());
  const { sql, format } = prepArrow(query, opts, "CSV");
  let bound;
  try { bound = formatParams(params); } catch (e) { return Promise.reject(e); }
  return withAbortTimeout(chdbNode.QueryAsync(sql, format, bound), opts);
}

// v3 insert (default connection). opts: { table, values, columns? }
function insert(opts) {
  return runInsert((sql) => chdbNode.QueryAsync(sql, "CSV"), opts || {});
}

// Track open sessions so a normal process exit can release native connections
// and remove temp dirs even when the user forgot to close. This
// complements the native env cleanup hook + std::atexit backstop.
const openSessions = new Set();
let exitHookInstalled = false;
function ensureExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const s of openSessions) {
      try { s.close(); } catch (_) { /* best effort */ }
    }
  });
}

// Session class with connection-based path handling
class Session {
  #closed = false;

  constructor(path = "", opts = {}) {
    if (path === "") {
      // Create a temporary directory
      this.path = mkdtempSync(join(os.tmpdir(), TMP_PREFIX));
      this.isTemp = true;
    } else {
      this.path = path;
      this.isTemp = false;
    }

    // Create a connection for this session (the native registry enforces a
    // single active connection per process). The registry key is normalized to
    // an absolute path so e.g. "./data" and its absolute form map to the same
    // connection; this.path is left as the caller passed it (public surface).
    try {
      const key = this.path ? resolvePath(this.path) : this.path;
      this.connection = chdbNode.CreateConnection(key);
    } catch (e) {
      if (this.isTemp) { try { this.#removeTempDir(); } catch (_) {} }
      throw asConnectionError(e);
    }
    if (!this.connection) {
      if (this.isTemp) { try { this.#removeTempDir(); } catch (_) {} }
      throw new ChdbConnectionError("Failed to create connection");
    }

    ensureExitHook();
    openSessions.add(this);
    if (opts && opts.installSignalHandlers) this.#installSignalHandlers();
  }

  /** True while the native connection is live (i.e. not yet closed). */
  get open() {
    return !this.#closed && this.connection != null;
  }

  query(query, format = "CSV") {
    if (!query) return "";
    if (!this.connection) {
      throw new ChdbClosedError("No active connection available");
    }
    try {
      return chdbNode.QueryWithConnection(this.connection, query, format);
    } catch (e) {
      throw asQueryError(e);
    }
  }

  // Session.queryBind binds {name:Type} placeholders against this session's
  // connection using server-side parameter binding. (The earlier binding had no
  // working session implementation here — it unconditionally threw; this makes
  // it functional. Standalone queryBind() behaves the same way.)
  queryBind(query, args = {}, format = "CSV") {
    if (!query) return "";
    if (!this.connection) {
      throw new ChdbClosedError("No active connection available");
    }
    const bound = formatParams(args); // may throw a typed ChdbBindError
    try {
      return chdbNode.QueryWithParamsConnection(this.connection, query, format, bound);
    } catch (e) {
      throw asQueryError(e);
    }
  }

  // v3 async (non-blocking) session query. opts: { format?, signal?, timeout? }
  queryAsync(query, opts = {}) {
    if (!this.connection) return Promise.reject(new ChdbClosedError("No active connection available"));
    if (!query) return Promise.resolve(emptyResult());
    const { sql, format } = prepArrow(query, opts, "CSV");
    return withAbortTimeout(chdbNode.QueryAsyncConnection(this.connection, sql, format), opts);
  }

  queryBindAsync(query, params = {}, opts = {}) {
    if (!this.connection) return Promise.reject(new ChdbClosedError("No active connection available"));
    if (!query) return Promise.resolve(emptyResult());
    const { sql, format } = prepArrow(query, opts, "CSV");
    let bound;
    try { bound = formatParams(params); } catch (e) { return Promise.reject(e); }
    return withAbortTimeout(chdbNode.QueryAsyncConnection(this.connection, sql, format, bound), opts);
  }

  // v3 insert. opts: { table, values, columns? }. Inline INSERT ... VALUES,
  // executed async; never reads stdin (closes #26).
  insert(opts) {
    if (!this.connection) return Promise.reject(new ChdbClosedError("No active connection available"));
    return runInsert((sql) => chdbNode.QueryAsyncConnection(this.connection, sql, "CSV"), opts || {});
  }

  // v3 streaming. opts: { format?='JSONEachRow', signal? }. Returns a
  // ChdbQueryStream (AsyncIterable). Only one stream may be active per session
  // at a time (single active connection).
  queryStream(sql, opts = {}) {
    if (!this.connection) throw new ChdbClosedError("No active connection available");
    if (!sql) throw new ChdbStreamError("queryStream requires a non-empty query");
    if (this._activeStream && !this._activeStream.closed) {
      throw new ChdbStreamError("a stream is already active on this session; finish or cancel it first");
    }
    const prep = prepArrow(sql, opts, "JSONEachRow");
    let handle;
    try {
      handle = chdbNode.StreamQuery(this.connection, prep.sql, prep.format);
    } catch (e) {
      throw asQueryError(e);
    }
    const stream = new ChdbQueryStream(handle, prep.format, opts.signal);
    this._activeStream = stream;
    return stream;
  }

  // close(): release the connection and (for temp sessions) remove the temp
  // dir. Idempotent and never throws.
  close() {
    if (this.#closed) return;
    this.#closed = true;
    openSessions.delete(this);
    if (this.connection) {
      try { chdbNode.CloseConnection(this.connection); } catch (_) { /* best effort */ }
      this.connection = null;
    }
    if (this.isTemp) this.#removeTempDir();
  }

  // v2 alias for close().
  cleanup() {
    this.close();
  }

  // `using` support (TS 5.2 / Node 20+).
  [Symbol.dispose]() {
    this.close();
  }

  // #30 cleanup safety gates: NEVER delete a non-temp (user) directory; only
  // delete a directory that resolves inside the real tmpdir AND carries the
  // chdb-node- prefix.
  #removeTempDir() {
    if (!this.isTemp) return; // gate 1: user-provided dirs are never deleted
    let real;
    let realTmp;
    try {
      real = realpathSync(this.path);
      realTmp = realpathSync(os.tmpdir());
    } catch (_) {
      return; // already removed / unreadable
    }
    // gate 2: resolve symlinks on BOTH sides before comparing. os.tmpdir() is a
    // symlink on macOS (/var -> /private/var), so a literal `real === this.path`
    // check would reject every legitimate temp dir; resolving both sides still
    // blocks a symlink that escapes the tmpdir.
    const inTmp = real.startsWith(realTmp + path.sep);
    const named = path.basename(real).startsWith(TMP_PREFIX);
    if (inTmp && named) {
      rmSync(real, { recursive: true, force: true });
    } else {
      process.emitWarning(`chdb: refusing to delete ${real}: not a chdb-node temp dir`);
    }
  }

  // Opt-in only (default OFF — a library must not steal the user's signals).
  // NEVER calls process.exit; it only releases resources and lets the app
  // decide how to terminate. See the README for the recommended app pattern.
  #installSignalHandlers() {
    const handler = () => { try { this.close(); } catch (_) { /* best effort */ } };
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, handler);
  }
}

// Diagnostic version info. libchdb is probed via SELECT version();
// falls back to 'unknown' if a session is holding the single active connection.
function version() {
  let libchdb = 'unknown';
  try {
    libchdb = query('SELECT version()', 'CSV').trim();
  } catch (_) {
    /* diagnostic only — never throws */
  }
  const pkg = require('./package.json');
  const napi = parseInt(process.versions.napi || '', 10);
  return {
    chdb: pkg.version,
    libchdb,
    platform: process.platform,
    arch: process.arch,
    napi: Number.isNaN(napi) ? undefined : napi,
  };
}

module.exports = { query, queryBind, queryAsync, queryBindAsync, insert, Session, version };
