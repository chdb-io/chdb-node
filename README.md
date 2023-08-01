<a href="https://chdb.fly.dev" target="_blank">
  <img src="https://user-images.githubusercontent.com/1423657/236688026-812c5d02-ddcc-4726-baf8-c7fe804c0046.png" width=130 />
</a>

[![chDB-node](https://github.com/chdb-io/chdb-node/actions/workflows/chdb-node-test.yml/badge.svg)](https://github.com/chdb-io/chdb-node/actions/workflows/chdb-node-test.yml)

# chdb-node
[chDB](https://github.com/auxten/chdb) nodejs bindings for fun and hacking.

### Status

- experimental, unstable, subject to changes
- requires [`libchdb`](https://github.com/metrico/libchdb) on the system

- :wave: _C/Node developer? Jump in and help us evolve this prototype into a stable module!_

<br>

### Examples

#### Query Constructor
```javascript
const chdb = require('chdb-node');
const db = new chdb.db('CSV', '/tmp/mysession') // format, storage path
var result;

// Query (ephemeral)
result = db.query("SELECT version()", "TabSeparated");
console.log(result)

// Query Session (persistent)
db.session("CREATE FUNCTION IF NOT EXISTS hello AS () -> 'chDB'");
result = db.session("SELECT hello()", "TabSeparated");
console.log(result)
```

#### Query _(query, format)_
```javascript
const chdb = require('chdb-node').chdb;
var result = chdb.Execute('SELECT version()', 'CSV');
console.log(result) // 23.6.1.1
```

#### Session _(query, *format, *path)_
```javascript
const chdb = require('chdb-node').chdb;
chdb.Session("CREATE FUNCTION IF NOT EXISTS hello AS () -> 'chDB'")
var result =  = chdb.Session("SELECT hello();")
console.log(result) // chDB
```

Sessions persist table data to disk. You can specify `path` to implement auto-cleanup strategies:
```javascript
const temperment = require('temperment');
const tmp = temperment.directory();
chdb.Session("CREATE FUNCTION IF NOT EXISTS hello AS () -> 'chDB'", "CSV", tmp)
var result =  = chdb.Session("SELECT hello();")
console.log(result) // chDB
tmp.cleanup.sync();
```

⚠️ _Session folders are persistent and NOT automatically cleaned_

<br>


