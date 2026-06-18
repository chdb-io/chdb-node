<img src="https://avatars.githubusercontent.com/u/132536224" width=130 />

[![npm version](https://badge.fury.io/js/chdb.svg)](https://badge.fury.io/js/chdb)

# chdb-node

[chDB](https://github.com/chdb-io/chdb) Node.js bindings — an in-process
ClickHouse engine for Node, Bun and Deno.

> **v3 (Layer 1) is in development.** The v2 `query` / `queryBind` / `Session`
> API is preserved (your v2 code keeps working); v3 adds async queries,
> server-side parameter binding, inserts, streaming, and Arrow output.

### Install

```bash
npm i chdb
```

Prebuilt native binaries ship as per-platform subpackages (`@chdb/lib-*`,
resolved via `optionalDependencies`) — no local compilation, no `node-gyp`, no
Python. First-batch platforms: Linux x64/arm64 (glibc) and macOS x64/arm64.
Windows is not supported (use WSL2).

### Usage

```javascript
const { query, queryAsync, insert, Session } = require("chdb"); // or: import { ... } from "chdb"

// Sync standalone query (v2-compatible, returns a string)
console.log(query("SELECT version(), 'Hello chDB'", "CSV"));

// Async query (non-blocking) -> ChdbResult (text() / json() / bytes() + metrics)
const r = await queryAsync("SELECT number FROM numbers(5)", { format: "JSONEachRow" });
console.log(r.rowsRead, r.elapsed);

// Server-side parameter binding (no SQL injection surface)
const { queryBind } = require("chdb");
console.log(queryBind("SELECT {n:UInt32} * 2 AS v", { n: 21 }, "CSV")); // 42

// Session: persistent/in-memory database
const session = new Session(); // temp dir; or new Session("./data")
session.query("CREATE TABLE t (id UInt32, name String) ENGINE = MergeTree() ORDER BY id");

// Insert (inline, async; never reads stdin)
await session.insert({ table: "t", values: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }] });

// Streaming (chunk-by-chunk, no full buffering)
for await (const row of session.queryStream("SELECT * FROM t").rows()) {
  console.log(row);
}

// Arrow output (no serialization on your side)
const a = await session.queryAsync("SELECT * FROM t", { format: "arrow" });
const table = a.toArrow();   // requires the optional `apache-arrow` peer dep
// const bytes = a.bytes();  // raw Arrow IPC if you bring your own Arrow

session.close(); // (cleanup() is an alias; `using` is supported too)
```

Errors are typed (`ChdbSyntaxError`, `ChdbQueryError`, `ChdbConnectionError`,
`ChdbBindError`, `ChdbInsertError`, `ChdbStreamError`, `ChdbArrowError`,
`ChdbAbortError`, `ChdbTimeoutError`, …), each carrying `.code`, the ClickHouse
`.clickhouseCode`, and `.cause`.

### `@clickhouse/client` drop-in (Layer 2)

Already using [`@clickhouse/client`](https://github.com/ClickHouse/clickhouse-js)?
chDB ships a **byte-compatible, embedded-only** façade — change the import and the
URL, and your existing code runs in-process with no server:

```javascript
// import { createClient } from '@clickhouse/client'
import { createClient } from 'chdb'

const client = createClient({ url: 'chdb://memory' }) // or 'chdb:///abs/path'
const rs = await client.query({ query: 'SELECT 1 AS n', format: 'JSONEachRow' })
console.log(await rs.json())                            // [{ n: 1 }]
await client.close()
```

`createClient`, the six methods (`query`/`insert`/`command`/`exec`/`ping`/`close`),
`ResultSet`/`Row`, and `ClickHouseError` match clickhouse-js field-for-field.
Embedded-only: only `chdb://` URLs are accepted, and there is no bundled HTTP
transport (`@clickhouse/client` stays an optional peer dependency for remote use).

See **[docs/layer2-clickhouse-js-compat.md](docs/layer2-clickhouse-js-compat.md)**
for the full migration guide, capability matrix, config arbitration, type mapping,
and the honest list of embedded-vs-server differences.

### Feature matrix

| Capability | Status |
| --- | --- |
| Stateless query (sync + async) | ✅ |
| Session (persistent / in-memory) | ✅ |
| Server-side parameter binding (`{name:Type}`) | ✅ |
| Insert (object / positional rows) | ✅ |
| Streaming results (`AsyncIterable`) | ✅ |
| Arrow **output** (`format: 'arrow'` + `toArrow()`) | ✅ |
| AbortSignal / timeout | ✅ (single-shot is honest: rejects early; native runs to completion) |
| Arrow **scan** (`registerArrowTable`, Arrow input) | ⏳ follow-up |
| Arrow zero-copy (M2, `{ zeroCopy: true }`) | ⏳ follow-up |

### Design docs

- [Layered API design](docs/design/architecture.md): the Layer 1 / Layer 2 / Layer 3 architecture, package shape, and intended user-facing surfaces.
- [Layer 1 native binding reviewer guide](docs/design/layer1-native-binding.md): the PR #43 design and implementation map, organized by commit and review feedback.

### Runtimes

A single N-API binary serves **Node 18/20/22 + Bun + Deno**.

### Develop / build from source

```bash
npm install              # JS deps only (no compile-on-install)
npm run libchdb          # download libchdb for this platform
npm run build            # node-gyp build + fix loader path + tsc (dist)
npm run test:all         # v2 (mocha) + v3 (vitest)
npm run build:platform   # package this platform's @chdb/lib-* subpackage
```
