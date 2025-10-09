const path = require('path');
const chdbNode = require(path.join(__dirname, 'build', 'Release', 'chdb_node.node'));
const { mkdtempSync, rmSync } = require('fs');
const { join } = require('path');
const os = require('os');

// Standalone exported query function
function query(query, format = "CSV") {
  if (!query) {
    return "";
  }
  return chdbNode.Query(query, format);
}

function queryBind(query, args = {}, format = "CSV") {
  if(!query) {
    return "";
  }
  return chdbNode.QueryBindSession(query, args, format);
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

    // Create a connection for this session
    this.connection = chdbNode.CreateConnection(this.path);
    if (!this.connection) {
      throw new Error("Failed to create connection");
    }
  }

  query(query, format = "CSV") {
    if (!query) return "";
    if (!this.connection) {
      throw new Error("No active connection available");
    }
    return chdbNode.QueryWithConnection(this.connection, query, format);
  }

  queryBind(query, args = {}, format = "CSV") {
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

module.exports = { query, queryBind, Session };
