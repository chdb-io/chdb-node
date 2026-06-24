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
const { buildRawInsertPrefix, isRawValues, isStreamValues } = require('./dist/rawInsert.js');
const { streamInsert } = require('./dist/streamInsert.js');

// Map a native/query error into a typed ChdbInsertError (preserving message,
// clickhouseCode and cause). The engine's "(at row N)" marker is parsed into
// failedAtRow (1-based; chunk-local for streamed chunks — streamInsert
// rebases it to an absolute row number).
function asInsertError(e) {
  if (e instanceof ChdbInsertError) return e;
  const q = asQueryError(e);
  const m = /\(at row (\d+)\)/.exec(q.message);
  return new ChdbInsertError(q.message, {
    cause: q,
    clickhouseCode: q.clickhouseCode,
    failedAtRow: m ? Number(m[1]) : undefined,
  });
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
  // Track so Session.close() defers connection teardown until this write
  // drains (see withAbortTimeout) — releasing mid-flight aborts the engine.
  const np = nativeAsyncCall(built.sql);
  trackNative(np);
  return np.then(
    (raw) => ({ rowsWritten: built.rowsWritten, bytesRead: raw.bytesRead, elapsed: raw.elapsed }),
    (e) => { throw asInsertError(e); },
  );
}

// Normalize a raw payload to a Buffer. Uint8Array views are wrapped zero-copy;
// strings are encoded once on the main thread (documented as a small-payload
// convenience — large payloads should be born as Buffers).
function toPayloadBuffer(v) {
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (Buffer.isBuffer(v)) return v;
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

// Abort/timeout wrapper for raw inserts. Same honest single-shot semantics as
// withAbortTimeout: JS settles early, the native write runs to completion and
// the payload Buffer stays pinned until it does.
function wrapRawNative(nativePromise, opts, mapOk) {
  const signal = opts && opts.signal;
  const timeout = opts && opts.timeout;
  const base = nativePromise.then(mapOk, (e) => { throw asInsertError(e); });
  // Track every raw insert (see withAbortTimeout): a connection must never be
  // released while its native write is still running on the libuv worker.
  trackNative(nativePromise);
  if (!signal && !timeout) return base;
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
        'Insert aborted (the underlying write may still complete in the background)'));
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeout) {
      timer = setTimeout(() => finish(reject, new ChdbTimeoutError(
        `Insert timed out after ${timeout}ms (the underlying write may still complete in the background)`)), timeout);
    }
    base.then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

// Raw passthrough: the payload Buffer is handed to the native side
// zero-copy; prefix assembly and execution happen on the libuv thread.
function runRawInsert(nativeRawCall, params) {
  let built;
  try { built = buildRawInsertPrefix(params); } catch (e) { return Promise.reject(asInsertError(e)); }
  const buf = toPayloadBuffer(params.values);
  if (buf.length === 0) {
    return Promise.resolve({
      rowsWritten: 0, bytesWritten: 0,
      rowsSent: built.fmt.lineDelimited ? 0 : undefined,
      bytesSent: 0, elapsed: 0,
    });
  }
  return wrapRawNative(nativeRawCall(built.prefix, buf, built.fmt.lineDelimited), params, (raw) => ({
    // Engine-side ledger (chdb-io/chdb-core#88): includes MV-cascade writes.
    rowsWritten: raw.rowsWritten,
    bytesWritten: raw.bytesWritten,
    // Payload-side ledger: non-empty lines minus a WithNames header line.
    rowsSent: raw.rowsSent === undefined ? undefined : Math.max(0, raw.rowsSent - built.fmt.headerLines),
    bytesSent: buf.length,
    elapsed: raw.elapsed,
  }));
}

// Streaming input over the raw entry (backpressure contract; see src/streamInsert.ts).
function runStreamInsert(nativeRawCall, params) {
  let built;
  try { built = buildRawInsertPrefix(params); } catch (e) { return Promise.reject(asInsertError(e)); }
  if (!built.fmt.lineDelimited || built.fmt.headerLines !== 0) {
    return Promise.reject(new ChdbInsertError(
      `Format '${params.format}' cannot be safely re-chunked for stream input ` +
      '(CSV may hold raw newlines inside quoted fields; WithNames headers cannot repeat per chunk). ' +
      'Use JSONEachRow/JSONCompactEachRow/TabSeparated for streams, or a single-shot Buffer insert.'));
  }
  // NOTE: objectMode streams are NOT pre-rejected — Readable.from() is
  // objectMode even when it yields Buffers/strings (a perfectly good byte
  // source). Object rows are rejected at the first non-byte chunk instead
  // (streamInsert's toChunkBuffer, with the NDJSON-mapping recipe).
  const insertChunk = (data) =>
    wrapRawNative(nativeRawCall(built.prefix, data, true),
                  { signal: params.signal, timeout: params.timeout }, (raw) => raw);
  return streamInsert(insertChunk, params);
}

// insert() dispatch (never guesses on a conflicting signature; every rejected
// branch's message carries its workaround).
function dispatchInsert(nativeSqlCall, nativeRawCall, params) {
  const v = params.values;
  if (isRawValues(v)) {
    if (params.format === undefined) {
      return Promise.reject(new ChdbInsertError(
        "Raw insert requires an explicit 'format': insert({ table, values: buffer, format: 'JSONEachRow' })"));
    }
    return runRawInsert(nativeRawCall, params);
  }
  if (Array.isArray(v)) {
    if (params.format !== undefined) {
      return Promise.reject(new ChdbInsertError(
        "'format' is not supported with row arrays (reserved for chunked object inserts); " +
        "drop 'format' for the VALUES path, or pre-serialize: values = Buffer.from(rows.map(r => JSON.stringify(r)).join('\\n') + '\\n')"));
    }
    return runInsert(nativeSqlCall, params);
  }
  if (isStreamValues(v)) {
    if (params.format === undefined) {
      return Promise.reject(new ChdbInsertError(
        "Stream insert requires an explicit 'format' (e.g. 'JSONEachRow')"));
    }
    return runStreamInsert(nativeRawCall, params);
  }
  return runInsert(nativeSqlCall, params);
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
  // Track EVERY async query, not just the abort/timeout ones. The native op
  // runs on a libuv worker; if a connection is released (CloseConnection)
  // while its query is still executing on that worker, the in-process engine
  // is torn down mid-op — which aborts the engine (code 236) and, on some
  // platforms, leaves the worker blocked inside chdb_query so its promise
  // NEVER settles (the caller's `await` hangs until the test timeout). Plain
  // queryAsync (no signal/timeout) used to skip tracking, so close() saw an
  // empty pendingNativeOps and tore the connection down mid-flight. Tracking
  // here makes Session.close() defer teardown until the op drains.
  trackNative(nativePromise);
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

// Parameterized queries set+reset parameter state around each call
// (chdb-core's CApiQueryParameterGuard). With the bundled libchdb this set/reset
// is NOT isolated per connection under real concurrency: two parameterized
// queries running at the same time on DIFFERENT connections clobber each other
// (wrong values / "Substitution not set", code 456) — and the resulting race can
// fatally abort the in-process engine (code 236). (Thread-based bindings like
// chdb-python rarely surface this because the GIL serializes the short
// set/clear/execute window; node's libuv worker pool runs them with true
// parallelism and reliably hits it under CI scheduling.) We therefore serialize
// the parameterized async path through a SINGLE process-wide chain shared by the
// default connection and every Session. Non-parameterized queries are never
// chained and run in parallel (the multi-connection win). The chain advances on
// NATIVE completion (not on early abort/timeout), so an aborted param query still
// fully drains before the next starts.
const globalParamChain = { tail: Promise.resolve() };

function runExclusiveParam(chain, startNative, opts) {
  // Pre-check the caller's cancellation BEFORE the chain head fires startNative.
  // Otherwise a query that was queued behind earlier param queries and whose
  // caller already observed CHDB_ABORT/CHDB_TIMEOUT (settled early by
  // withAbortTimeout) would still dispatch the native call when its turn came up,
  // leaking unintended side effects (e.g. queued DDL/DML). The chain still
  // advances on the guarded promise so the next queued query is not stalled.
  const signal = opts && opts.signal;
  const timeout = opts && opts.timeout;
  const deadline = timeout ? Date.now() + timeout : 0;
  const guardedStart = () => {
    if (signal && signal.aborted) {
      return Promise.reject(new ChdbAbortError(
        'Query aborted before execution (queued behind earlier parameterized queries)'));
    }
    if (deadline && Date.now() >= deadline) {
      return Promise.reject(new ChdbTimeoutError(
        `Query timed out (${timeout}ms) before execution (queued behind earlier parameterized queries)`));
    }
    return startNative();
  };
  const nativeP = chain.tail.then(guardedStart);
  chain.tail = nativeP.then(() => {}, () => {});
  return withAbortTimeout(nativeP, opts);
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
  return runExclusiveParam(globalParamChain, () => chdbNode.QueryAsync(sql, format, bound), opts);
}

// v3 insert (default connection). Dispatches on the shape of `values`:
// row arrays -> inline VALUES; Buffer/Uint8Array/string + format -> raw
// passthrough; Readable/AsyncIterable + format -> backpressured stream insert.
function insert(opts) {
  return dispatchInsert(
    (sql) => chdbNode.QueryAsync(sql, "CSV"),
    (prefix, buf, countLines) => chdbNode.InsertRawAsync(prefix, buf, countLines),
    opts || {});
}

// Track open sessions so a normal process exit can release native connections
// and remove temp dirs even when the user forgot to close. This
// complements the native env cleanup hook + std::atexit backstop.
const openSessions = new Set();

// Track EVERY in-flight native async operation (async query/insert), keyed on
// NATIVE completion. There is no interrupt in the C ABI, so the native
// computation runs on the libuv thread to completion regardless of when the JS
// promise settles — whether early (an abort/timeout reject) or normally. A
// connection torn down while one of its ops is still running is a use-after-free
// on that connection: it aborts the shared in-process engine ("server is
// shutting down due to a fatal error", ABORTED), cascading into later work, and
// on some platforms leaves the worker blocked so its promise never settles (the
// caller's await hangs). We therefore drain pending ops before closing a
// connection (close() below) and in test teardown. Each tracked promise settles
// on NATIVE completion and never rejects — for early-settled ops the caller
// already received the mapped error; here we only need the timing.
//
// NB: plain queryAsync/insert (no signal/timeout) MUST be tracked too, not just
// the abort/timeout ones — close() landing mid-flight on an untracked op was the
// macos-14/Node-20 120s hang (chdb-io/chdb-node#53).
const pendingNativeOps = new Set();
function trackNative(nativePromise) {
  const done = nativePromise.then(() => {}, () => {});
  pendingNativeOps.add(done);
  done.then(() => pendingNativeOps.delete(done));
  return nativePromise;
}

// Wait for every native op started before now to fully settle. Internal helper
// for test teardown: drained in the global afterEach before sessions are closed
// so an early-settled (aborted/timed-out) op stays local to the test that
// started it instead of poisoning the shared single-connection engine.
function _drainPendingOps() {
  return Promise.allSettled([...pendingNativeOps]);
}

// Force-close every session still open in this process. Internal helper for
// test teardown: chdb-core binds one data directory per process, so a single
// test that creates a Session and never closes it (e.g. it threw before its own
// close) blocks every later `new Session()` with a DIFFERENT path (same-path
// sessions would coexist). A global afterEach calling this guarantees no session
// leaks across test boundaries, instead of relying on every test to clean up
// perfectly.
function _closeAllSessions() {
  for (const s of [...openSessions]) {
    try { s.close(); } catch (_) { /* best effort */ }
  }
}

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
const SESSION_SIGNALS = ['SIGINT', 'SIGTERM'];

class Session {
  #closed = false;
  #signalHandler = null; // opt-in signal handler, deregistered on close()

  constructor(path = "", opts = {}) {
    if (path === "") {
      // Create a temporary directory
      this.path = mkdtempSync(join(os.tmpdir(), TMP_PREFIX));
      this.isTemp = true;
    } else {
      this.path = path;
      this.isTemp = false;
    }

    // Create a connection for this session. Each Session owns its OWN native
    // connection: the native registry allows N independent connections to the
    // same bound path (they share the one process-wide EmbeddedServer and its
    // data, but each carries its own query/parameter state, so same-path
    // sessions run in parallel without clobbering). A *different* data directory
    // while one is live is still rejected. The registry key is normalized to an
    // absolute path so e.g. "./data" and its absolute form bind the same server;
    // this.path is left as the caller passed it (public surface).
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
    return runExclusiveParam(globalParamChain, () => chdbNode.QueryAsyncConnection(this.connection, sql, format, bound), opts);
  }

  // v3 insert. Same dispatch as the standalone insert(): row arrays -> inline
  // VALUES; raw bytes + format -> passthrough; stream + format -> backpressured
  // stream insert. Executed async; never reads stdin (closes #26).
  insert(opts) {
    if (!this.connection) return Promise.reject(new ChdbClosedError("No active connection available"));
    return dispatchInsert(
      (sql) => chdbNode.QueryAsyncConnection(this.connection, sql, "CSV"),
      (prefix, buf, countLines) => chdbNode.InsertRawAsyncConnection(this.connection, prefix, buf, countLines),
      opts || {});
  }

  // v3 streaming. opts: { format?='JSONEachRow', signal? }. Returns a
  // ChdbQueryStream (AsyncIterable). Only one stream may be active per session
  // at a time (one streaming cursor per connection); other sessions stream in
  // parallel on their own connections.
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
    // Deregister the opt-in signal handler so its closure (which retains `this`)
    // is released and the listeners don't accumulate across many short-lived
    // sessions when no signal ever fires.
    if (this.#signalHandler) {
      for (const sig of SESSION_SIGNALS) process.removeListener(sig, this.#signalHandler);
      this.#signalHandler = null;
    }
    const conn = this.connection;
    this.connection = null;
    const teardown = () => {
      if (conn) { try { chdbNode.CloseConnection(conn); } catch (_) { /* best effort */ } }
      if (this.isTemp) { try { this.#removeTempDir(); } catch (_) { /* best effort */ } }
    };
    // Destroying the native connection while an op is still running on it aborts
    // the engine for the rest of the process. abort/timeout settle the JS promise
    // early but leave the native computation running (no interrupt in the C ABI),
    // so close() may land mid-flight. When ops are still pending, defer teardown
    // until they drain rather than racing them. _drainPendingOps() awaits these
    // deferred closes too, so a new session is never created before the prior
    // connection is fully released.
    if (conn && pendingNativeOps.size > 0) {
      const deferred = Promise.allSettled([...pendingNativeOps]).then(teardown);
      pendingNativeOps.add(deferred);
      deferred.finally(() => pendingNativeOps.delete(deferred));
    } else {
      teardown();
    }
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
    this.#signalHandler = handler;
    for (const sig of SESSION_SIGNALS) process.once(sig, handler);
  }
}

// Diagnostic version info. libchdb is probed via SELECT version();
// falls back to 'unknown' if a session is holding a different data directory
// than the standalone default would bind.
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

// Arrow C Data Interface — low-level binding. The high-level helper lives in
// Layer 3 (`src/layer3/execute/arrow-input.ts`); this module just routes the
// call to the native addon. The connection arg is a `Session._handle` (the
// External returned by CreateConnection) or null for the process-wide default.
function _arrowRegisterColumns(connection, tableName, columns) {
  return chdbNode.ArrowRegisterColumns(connection ?? null, tableName, columns);
}
function _arrowUnregister(connection, tableName) {
  return chdbNode.ArrowUnregister(connection ?? null, tableName);
}

module.exports = {
  query, queryBind, queryAsync, queryBindAsync, insert,
  Session, version,
  _closeAllSessions, _drainPendingOps,
  _arrowRegisterColumns, _arrowUnregister,
};

// Layer 3: the fluent, immutable query builder. It sits on Layer 1, a sibling of
// the pluggable Connection surface (`chdb/connection`). Required at the BOTTOM,
// after module.exports is populated, so the lazy Layer 1 accessor in dist/layer3
// sees a fully-formed export object. ChdbCompileError (the only net-new error)
// rides along via dist/layer3's own re-export.
const layer3 = require('./dist/layer3/index.js');
for (const name of Object.keys(layer3)) {
  if (module.exports[name] === undefined) module.exports[name] = layer3[name];
}
