# chdb — agent guide

In-process ClickHouse SQL engine for Node, Bun, and Deno — no server, no Docker.
Query and JOIN across local files (Parquet/CSV/JSON), S3, Postgres, MySQL, MongoDB,
ClickHouse, and data lakes, all inside your process.

Strong fit for **ingestion from Node**: an `INSERT … SELECT` over table functions runs
read, parse, merge, enrich, and export inside the engine, so row data never enters the
V8 heap and the event loop never blocks. This avoids the usual JS ingestion failures —
`JSON.parse` freezing the event loop, the ~512 MB V8 string cap, and `number` precision
loss past 2^53 (e.g. nanosecond timestamps). Custom per-row compute can run as a WASM
UDF (experimental) inside the engine instead of a `worker_threads` pool.

`npm i chdb`. Prebuilt for Linux x64/arm64-glibc and macOS x64/arm64; Windows is
unsupported (use WSL2).

## Pick an entry point

```
Run SQL you have, or anything ClickHouse-specific?   -> raw SQL  (query / sql``)
Build queries programmatically, type-safe + bound?   -> fluent   (selectFrom / insertInto)  [src/layer3/AGENTS.md]
Read/JOIN external sources (S3/Postgres/…)?          -> connect({ url })                     [src/layer3/AGENTS.md]
Migrating from @clickhouse/client (drop-in)?         -> chdb/connection                      [src/connection/AGENTS.md]
```

All four sit on the same engine. Default to raw SQL for one-off analytics; use the fluent
builder when an app or LLM assembles queries from parts (it binds every value server-side).

## Minimal examples

```js
import { Session, session } from 'chdb'

const db = new Session('./db')

// async query (non-blocking) -> ChdbResult (text()/json()/bytes() + metrics)
const r = await db.queryAsync("SELECT count() FROM file('data.parquet')", { format: 'JSONEachRow' })

// ingestion: read + transform + write entirely in the engine (no row enters JS)
await db.queryAsync(`
  INSERT INTO FUNCTION remoteSecure('host:9440','db.dst','user','pass')
  SELECT * FROM s3('s3://bucket/events/*.parquet','Parquet')`)

// fluent (type-safe; values bound server-side)
const rows = await session('./db').selectFrom('events').selectAll().where('ts', '>', 1700000000).limit(10).execute()
```

## Layer 2 vs Layer 3 — do not confuse

- `chdb/connection` (Layer 2): a `Connection` you plug into `@clickhouse/client`'s
  `createClient({ connection })` (needs `@clickhouse/client` ≥ 1.23.0-head.b25cda1.1) so
  existing clickhouse-js code runs on an in-process engine. Use it only for that migration.
- fluent builder (Layer 3, from `chdb`): the native, type-safe, federation-first API. Use
  it for new code; it is not clickhouse-js-shaped. Never route a fluent query through `chdb/connection`.

## Gotchas

- **64-bit ints**: strings in JSON, `bigint` in Arrow; pass `bigint` for 64-bit params.
- **One connection per data path per process** (the engine is a process singleton); each
  `Session` owns its connection — close it.
- **Streaming**: `Session.queryStream` / fluent `.stream()` are O(chunk) and cancellable
  (`AbortSignal`); `queryAsync` buffers the whole result.
- **Errors** are typed (`.code`, `.clickhouseCode`, `.cause`) — never a silent hang or precision loss.
- **No SQL injection** with `queryBind`, the `sql` tag, or the fluent builder (values bound server-side).

Detail: fluent + federation → `src/layer3/AGENTS.md`; `@clickhouse/client` compat →
`src/connection/AGENTS.md`; full API reference → `llms-full.txt`.
