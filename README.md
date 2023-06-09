<a href="https://chdb.fly.dev" target="_blank">
  <img src="https://user-images.githubusercontent.com/1423657/236688026-812c5d02-ddcc-4726-baf8-c7fe804c0046.png" width=130 />
</a>

[![chDB-node](https://github.com/chdb-io/chdb-node/actions/workflows/chdb-node-test.yml/badge.svg)](https://github.com/chdb-io/chdb-node/actions/workflows/chdb-node-test.yml)

# chdb-node
[chDB](https://github.com/auxten/chdb) nodejs bindings for fun and hacking.

### Status

- experimental, unstable, subject to changes
- requires [`libchdb`](https://github.com/metrico/libchdb) on the system

#### Example
```javascript
const chdb = require('chdb-node');
var result = chdb.Execute('SELECT version()', 'CSV');
console.log(result) // 22.12.1.1
```

<br>

:wave: _C/Node developer? Jump in and help us evolve this prototype into a stable module!_
