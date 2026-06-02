const path = require('path');
const chdbNode = require(path.join(__dirname, 'build', 'Release', 'chdb_node.node'));
const { mkdtempSync, rmSync } = require('fs');
const { join } = require('path');
const os = require('os');
const {
  ChdbConnectionError,
  ChdbClosedError,
  mapNativeError,
} = require('./dist/errors.js');

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
  try {
    return chdbNode.QueryBindSession(query, args, format);
  } catch (e) {
    throw asQueryError(e);
  }
}

// Session class with connection-based path handling
class Session {
  constructor(path = "") {
    if (path === "") {
      // Create a temporary directory
      this.path = mkdtempSync(join(os.tmpdir(), 'tmp-chdb-node'));
      this.isTemp = true;
    } else {
      this.path = path;
      this.isTemp = false;
    }

    // Create a connection for this session (registry enforces single-active).
    try {
      this.connection = chdbNode.CreateConnection(this.path);
    } catch (e) {
      throw asConnectionError(e);
    }
    if (!this.connection) {
      throw new ChdbConnectionError("Failed to create connection");
    }
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

  queryBind(query, args = {}, format = "CSV") {
    // v2 behaviour preserved (fixed in Item 5 once the C ABI param path lands).
    throw new Error("QueryBind is not supported with connection-based sessions. Please use the standalone queryBind function instead.");
  }

  // Cleanup method to close connection and delete directory if temp
  cleanup() {
    // Close the connection if it exists
    if (this.connection) {
        chdbNode.CloseConnection(this.connection);
        this.connection = null;
    }

    // Only delete directory if it's temporary
    if (this.isTemp) {
      rmSync(this.path, { recursive: true });
    }
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
