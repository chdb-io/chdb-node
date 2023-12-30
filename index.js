const chdbNode = require('./build/Release/chdb_node.node');
const { mkdtempSync, rmdirSync } = require('fs');
const { join } = require('path');
const os = require('os');

// Standalone exported query function
function query(query, format = "CSV") {
  if (!query) {
    return "";
  }
  return chdbNode.Query(query, format);
}

// Session class with path handling
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
  }

  query(query, format = "CSV") {
    if (!query) return "";
    return chdbNode.QuerySession(query, format, this.path);
  }

  // Cleanup method to delete the temporary directory
  cleanup() {
    rmdirSync(this.path, { recursive: true });
  }
}

module.exports = { query, Session };
