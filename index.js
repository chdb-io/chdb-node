const path = require('path');
const chdbNode = require(path.join(__dirname, 'build', 'Release', 'chdb_node.node'));
const fs = require('fs');
const { mkdtempSync, rmSync, realpathSync } = fs;
const { join } = require('path');
const os = require('os');
const {
  ChdbConnectionError,
  ChdbClosedError,
  mapNativeError,
} = require('./dist/errors.js');
const { formatParamValue } = require('./dist/serialize.js');

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

// D4: the v2 temp prefix was 'tmp-chdb-node' (no separator before the random
// suffix); 'chdb-node-' gives a clean, recognizable prefix used by the cleanup
// safety gate below.
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

// Track open sessions so a normal process exit can release native connections
// and remove temp dirs even when the user forgot to close (design §10). This
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

    // Create a connection for this session (registry enforces single-active).
    try {
      this.connection = chdbNode.CreateConnection(this.path);
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

  // Item 5: server-side parameter binding now works on sessions too (the v2
  // behaviour was an unconditional throw; chdb_query_with_params makes it real).
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

  // close(): release the connection and (for temp sessions) remove the temp
  // dir. Idempotent and never throws (design §10).
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

// Diagnostic version info (design §5). libchdb is probed via SELECT version();
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

module.exports = { query, queryBind, Session, version };
