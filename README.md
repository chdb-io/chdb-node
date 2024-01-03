<img src="https://avatars.githubusercontent.com/u/132536224" width=130 />

[![chDB-node](https://github.com/chdb-io/chdb-node/actions/workflows/chdb-node-test.yml/badge.svg)](https://github.com/chdb-io/chdb-node/actions/workflows/chdb-node-test.yml)

# chdb-node
[chDB](https://github.com/chdb-io/chdb) nodejs bindings for fun and hacking.

### Install
```bash
npm i chdb
```

### Usage

```javascript
const { query, Session } = require("chdb");

var ret;

// Test standalone query
ret = query("SELECT version(), 'Hello chDB', chdb()", "CSV");
console.log("Standalone Query Result:", ret);

// Test session query
// Create a new session instance
const session = new Session("./chdb-node-tmp");
ret = session.query("SELECT 123", "CSV")
console.log("Session Query Result:", ret);
ret = session.query("CREATE DATABASE IF NOT EXISTS testdb;" +
    "CREATE TABLE IF NOT EXISTS testdb.testtable (id UInt32) ENGINE = MergeTree() ORDER BY id;");

session.query("USE testdb; INSERT INTO testtable VALUES (1), (2), (3);")

ret = session.query("SELECT * FROM testtable;")
console.log("Session Query Result:", ret);

// Clean up the session
session.cleanup();

```

#### Build from source

```bash
npm run libchdb
npm install
npm run test
```
