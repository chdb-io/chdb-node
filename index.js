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

  queryBind(query, args = {}, format = "CSV") {
    if(!query) return "";
    return chdbNode.QueryBindSession(query, args, format, this.path)
  }

  // Cleanup method to delete the temporary directory
  cleanup() {
    rmSync(this.path, { recursive: true }); // Replaced rmdirSync with rmSync
  }
}

module.exports = { query, queryBind, Session };
