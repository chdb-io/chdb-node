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

### One data directory at a time

libchdb binds a single data directory per process, so opening a `Session` takes
the slot the stateless `query`/`queryAsync` calls were using and closes their
connection. A connection closed while an operation is still running on it aborts
the engine for the rest of the process, so `new Session()` refuses instead:

```js
const { queryAsync, Session, drainPending } = require("chdb");

const p = queryAsync("SELECT max(sipHash64(number)) FROM numbers(20000000)");
new Session();   // throws: 1 standalone operation is still running
await p;
new Session();   // fine
```

Awaiting your own promise is not always enough. An aborted or timed-out call
rejects immediately while the engine keeps computing, and `close()` returns
before the connection is really gone when an operation is still using it.
`drainPending()` waits for both:

```js
const ac = new AbortController();
const p = queryAsync("SELECT max(sipHash64(number)) FROM numbers(20000000)", {
  signal: ac.signal,
});
ac.abort();
await p.catch(() => {});   // rejected, but the engine is still computing
await drainPending();      // now the connection is actually free
const s = new Session("./data");
```

Moving between directories works the same way: after `session.close()`, wait with
`drainPending()` before opening one at a different path. Opening another session
at the *same* path needs no wait — those connections coexist by design.

**Behaviour change.** Earlier versions did not refuse — they closed the busy
connection, which usually aborted the engine and on macOS could leave a query
whose promise never settled. Code that opened a session without awaiting its
standalone queries now gets an error at the call site instead of a failure
somewhere later.

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
| chDB ↔ `@clickhouse/client` integration (`chdb/connection`, **experimental**) | ✅ |
| Durable V1 control plane (`chdb/durable`, **experimental**) | ✅ pure TS; native adapter pending |
| Remote object storage for durable (`chdb/durable/s3`) | ✅ verified on AWS S3 and MinIO; R2 untested |

### chDB ↔ `@clickhouse/client` integration (`chdb/connection`, experimental)

> **Status**: this integration uses the experimental
> `createClient({ connection })` hook in `@clickhouse/client`
> ([clickhouse-js#879](https://github.com/ClickHouse/clickhouse-js/pull/879)
> merged; framing follow-up
> [#880](https://github.com/ClickHouse/clickhouse-js/pull/880) merged).
> Upstream considers this a deliberately narrow chDB-only hook — not a
> public plugin system — and the shape may change. We'll keep
> `chdb/connection` working against whatever the upstream hook evolves
> into.

For users coming from `@clickhouse/client`, chdb-node ships a
**Connection** implementation under the `chdb/connection` subpath that
plugs into `@clickhouse/client`'s `createClient({ connection })`
injection point (tracking issue:
[clickhouse-js#865](https://github.com/ClickHouse/clickhouse-js/issues/865)).

```ts
import { createChdbConnection } from 'chdb/connection'

const conn = createChdbConnection({ path: ':memory:' })
const r = await conn.query({ query: 'SELECT * FROM numbers(5)', format: 'JSONEachRow' })
let body = ''
for await (const chunk of r.stream) body += Buffer.from(chunk).toString('utf8')
console.log(JSON.parse(`[${body.trim().split('\n').join(',')}]`))
await conn.close()

// chDB-specific escape hatches (raw ChdbResult, raw insert, session info)
conn.chdb.queryAsync('SELECT 1', { format: 'arrow' })  // bytes/text/json/toArrow
conn.chdb.session.path                                 // bound on-disk path
```

See [docs/design/pluggable-connection.md](docs/design/pluggable-connection.md)
for the full design, the `Connection` interface, the `.chdb` extension
namespace, the `tests/clickhouse-js/skip_list.json` parity blacklist,
and the sync policy with `@clickhouse/client`.

### Remote-authoritative durability (`chdb/durable`, experimental)

> **Status**: implements chDB Durable V1 as specified in
> `CHDB_DURABLE_V1_CONTRACT.md` in the
> [chdb](https://github.com/chdb-io/chdb) repository, which is the source of
> truth for the protocol. The pure-TypeScript control plane is complete; a
> default engine adapter over the native addon is still to come, so today the
> caller supplies the engine.
>
> Requires an engine exporting the durable ABI — currently `26.7.2-rc.2`.
> Compatibility is a floor rather than an equality: an object records
> `min_reader` and `backup_format`, and any engine at or above that floor opens
> it. An object written by `26.7.2-rc.2` stays readable on `26.7.3` and later.

`chdb/durable` makes an embedded chDB database recoverable on a *different*
machine: a full checkpoint plus a statement WAL in object storage, with a
single `head.json` updated by compare-and-swap under a fenced writer lease.

Importing it loads **no native code** — not the addon, not `libchdb`. The
engine arrives as an `EngineAdapter` the caller provides, which is what lets a
Bun process that already owns its own `dlopen(libchdb)` reuse the state machine
without a second engine in the process. The companion `chdb/libchdb` subpath
resolves where the library *is* without opening it.

Recovery on another machine needs the object to live somewhere neither machine
owns, so `chdb/durable/s3` provides an S3-compatible backend — AWS S3,
Cloudflare R2 and MinIO through one implementation. It sits behind its own
subpath, and `@aws-sdk/client-s3` is an optional peer dependency, so callers
who only use the local backend never install it.

```ts
import { DurableNamespace } from 'chdb/durable'
import 'chdb/durable/s3'   // registers the s3:// scheme

const ns = new DurableNamespace('s3://my-bucket/durable?region=eu-west-1', { engineFactory })
const obj = await ns.open('orders', { database: 'default' })

const ticket = await obj.execute("INSERT INTO events VALUES (1, 'a')")
await obj.flushThrough(ticket)   // durability barrier; execute() alone is not one
await obj.checkpoint()
await obj.close()                // rejects if the final flush or lease release failed
```

Writes go through ClickHouse's own parser, not a regex: `execute()` takes
exactly one `MUTATING` statement that core can prove writes only inside this
object's database and embeds no credential, and `query()` takes exactly one
`READ_ONLY` statement. Method names are not the gate.

`obj.stats` gives a consistent snapshot for a status endpoint or log line —
lease generation, committed sequence, pending statements and bytes, last flush
and checkpoint times — with no credentials or SQL in it. `onRestoreProgress`
reports each phase of a recovery, so a slow restore is distinguishable from a
stuck one.

The conditional writes S3 needs are real preconditions on `PutObject`
(`If-None-Match: *` and `If-Match: <etag>`), never a HEAD followed by a PUT.
A provider counts as supported once it has passed
`test/durable/s3-backend.test.ts`, which is parameterised for exactly that.
AWS S3 and MinIO have; Cloudflare R2 has not been run yet.

See [docs/design/durable-control-plane.md](docs/design/durable-control-plane.md)
for the object layout, the lease and fencing rules, the ambiguous-commit
reconcile, both backends' compare-and-swap, and what V1 deliberately leaves
out.

### Design docs

- [Layered API design](docs/design/architecture.md): the Layer 1 / Layer 2 / Layer 3 architecture, package shape, and intended user-facing surfaces.
- [Layer 1 native binding reviewer guide](docs/design/layer1-native-binding.md): the PR #43 design and implementation map, organized by commit and review feedback.
- [chDB ↔ `@clickhouse/client` integration (experimental)](docs/design/pluggable-connection.md): the `chdb/connection` surface, the `Connection` interface chdb-node implements, the `.chdb` extension namespace, and the parity-test sync policy.
- [Durable V1 control plane (experimental)](docs/design/durable-control-plane.md): the `chdb/durable` and `chdb/libchdb` subpaths, the `EngineAdapter` seam, lease/fencing/reconcile behaviour, and the V1 boundary.

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
