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

class Connect {
  constructor(path = ":memory:") {
    let args = []
    if (path === ":memory:") {
      this.in_memory = true;
      this.isTemp = false;
    } else {
      this.in_memory = false;
      if (path === "") {
        // Create a temporary directory
        this.path = mkdtempSync(join(os.tmpdir(), 'tmp-chdb-node'));
        this.isTemp = true;
      } else {
        this.path = path;
        this.isTemp = false;
      }
      args.push(["--path", this.path]);
    }
    this.conn = chdbNode.connectChdb(args);
    if (this.in_memory) {
      this.query("CREATE DATABASE IF NOT EXISTS default ENGINE = Memory; USE default; SHOW DATABASES;");
    } else if (this.isTemp) {
      this.query("CREATE DATABASE IF NOT EXISTS default ENGINE = Atomic; USE default; SHOW DATABASES;");
    }
  }

  query(query, format = "CSV") {

    if (!query) return "";
    let res = chdbNode.queryConn(this.conn, query, format);
    if (res.getErrorMessage()) {
      throw new Error(res.getErrorMessage());
    }
    return res;
  }

  insert_into(query, values, format = "CSV") {
    let q = Buffer.concat([Buffer.from(query), values])
    return this.query(q, format)
  }

  cleanup() {
    console.log("cleanup: ", this.isTemp, this.in_memory);

    if (this.isTemp) {
      console.log("removing: ", this.path);
      rmSync(this.path, { recursive: true }); // Replaced rmdirSync with rmSync
    }
    chdbNode.closeConn(this.conn);
  }


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
    if (this.isTemp) {
      rmSync(this.path, { recursive: true }); // Replaced rmdirSync with rmSync
    }
  }
}

module.exports = { query, Session, Connect };
