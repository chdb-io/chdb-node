<a href="https://chdb.fly.dev" target="_blank">
  <img src="https://avatars.githubusercontent.com/u/132536224" width=130 />
</a>

[![chDB-node](https://github.com/chdb-io/chdb-node/actions/workflows/chdb-node-test.yml/badge.svg)](https://github.com/chdb-io/chdb-node/actions/workflows/chdb-node-test.yml)

# chdb-node
[chDB](https://github.com/chdb-io/chdb) nodejs bindings for fun and hacking.

### Status

- experimental, unstable, subject to changes
- requires [`libchdb`](https://github.com/chdb-io/chdb) on the system
- :wave: _C/Node developer? Jump in and help us evolve this prototype into a stable module!_

<br>

### Examples

#### Query Constructor
```javascript
const chdb = require("chdb-node");

// Query (ephemeral)
const db = new chdb.db("CSV") // format
var result = db.query("SELECT version()");
console.log(result) // 23.10.1.1

// Query Session (persistent)
const dbdisk = new chdb.db("CSV", "/tmp/mysession") // format, storage path
dbdisk.session("CREATE FUNCTION IF NOT EXISTS hello AS () -> 'chDB'");
var result = dbdisk.session("SELECT hello()", "TabSeparated"); // optional format override
console.log(result) // chDB
```

#### Query _(query, format)_
```javascript
const chdb = require("chdb-node").chdb;
var result = chdb.Execute("SELECT version()", "CSV");
console.log(result) // 23.10.1.1
```

#### Session _(query, *format, *path)_
```javascript
const chdb = require("chdb-node").chdb;
chdb.Session("CREATE FUNCTION IF NOT EXISTS hello AS () -> 'chDB'")
var result =  = chdb.Session("SELECT hello();")
console.log(result) // chDB
```

> ⚠️ Sessions persist table data to disk. You can specify `path` to implement auto-cleanup strategies:
```javascript
const temperment = require("temperment");
const tmp = temperment.directory();
chdb.Session("CREATE FUNCTION IF NOT EXISTS hello AS () -> 'chDB'", "CSV", tmp)
var result =  = chdb.Session("SELECT hello();")
console.log(result) // chDB
tmp.cleanup.sync();
```

<br>
