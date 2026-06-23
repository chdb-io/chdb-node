# Pluggable Connection — design

> **Status**: implemented in this branch (`feat/layer2-pluggable-backend`).
> Upstream tracking issue: [ClickHouse/clickhouse-js#865](https://github.com/ClickHouse/clickhouse-js/issues/865).
> Parallel Python proposal: [ClickHouse/clickhouse-connect#809](https://github.com/ClickHouse/clickhouse-connect/issues/809).

## What this delivers

A public `chdb/connection` subpath export that lets users plug
in-process chDB into `@clickhouse/client` with a one-line change at
construction:

```ts
import { createClient }         from "@clickhouse/client";
import { createChdbConnection } from "chdb/connection";

const client = createClient({
  connection: createChdbConnection({ path: ":memory:" }),
});
```

All downstream code (`client.query` / `client.insert` / `client.exec` /
`client.command` / `client.ping` / `client.close`) runs unchanged
against the in-process backend.

## Design principle: chdb-owned, upstream-clean

The pluggable design is asymmetric **by construction**:

```
┌──────────────────────────────────────┐        ┌──────────────────────────────────────┐
│  @clickhouse/client (upstream)        │        │   chdb-node (this repo)              │
│                                       │        │                                      │
│  • Connection<Stream> interface       │        │  • ChdbConnection implements          │
│    (already public, unchanged)        │        │    Connection<Readable> verbatim     │
│  • createClient({ connection })       │   ◄──  │  • chdb/connection subpath export     │
│    one new public option              │        │  • tests/clickhouse-js/skip_list.json │
│                                       │        │    (chdb-owned blacklist)             │
│  ❌ zero chdb code                    │        │  • tests/clickhouse-js/runner.mjs     │
│  ❌ zero chdb tests                   │        │    clones upstream, injects chdb,     │
│  ❌ zero chdb CI dependency           │        │    applies skip_list                  │
└──────────────────────────────────────┘        └──────────────────────────────────────┘
```

The only upstream change is the `createClient({ connection })`
injection point (≈3 lines wrapping `NodeConfigImpl`). Everything else
— the chdb-side adapter, the test sync policy, the skip list of
unsupported tests, the CI matrix that exercises both — lives in
chdb-node. **Adding a future backend repeats this pattern in that
backend's own repo, with no PR to `@clickhouse/client` needed.**

## Public surface (this repo)

`chdb/connection` exports:

| name | purpose |
|---|---|
| `createChdbConnection(opts)` | factory; default `path: ':memory:'` (refcounted shared temp dir across same-process memory connections) |
| `ChdbConnection` | class implementing `Connection<Readable>` |
| `ChdbExtension` | type for the `.chdb` namespace |
| `Connection`, `ConnQueryResult`, `ConnInsertParams`, … | RE-EXPORTED from `@clickhouse/client-common` (chdb-node does not define its own) |

### Why re-export, not redefine

ChdbConnection must match `@clickhouse/client-common`'s
`Connection<Stream.Readable>` interface EXACTLY for the injection to
work. Defining our own "compatible" interface here would silently
drift. Instead we add `@clickhouse/client-common` as a devDependency,
re-export the real types, and let TypeScript prove conformance at
compile time. Bumping the upstream package forces a deliberate
decision in chdb-node about which contract version we conform to.

### `.chdb` extension namespace

`ChdbConnection.chdb` exposes chDB-specific operations that do NOT
belong on the cross-backend Connection contract:

```ts
conn.chdb.session.path           // bound on-disk path
conn.chdb.session.isTemp         // process-managed temp dir?
conn.chdb.queryAsync(sql, opts)  // native ChdbResult (bytes/text/json/toArrow)
conn.chdb.queryStream(sql, opts) // chunked streaming
conn.chdb.rawInsert(params)      // Buffer-passthrough insert
conn.chdb.streamInsert(params)   // backpressured streaming insert
```

The exposed set is intentionally limited to what chdb-node actually
supports today; aspirational items (`Python()` table function, UDF
registration) are NOT exposed because chdb-node does not implement
them yet.

### `supportsZeroCopyStreaming`

A ChdbConnection-only property (NOT part of the upstream Connection
contract) flagging whether the connection can surface result buffers
to JS without copying. **`false` today**: chdb-node copies each result
chunk into a JS Buffer (see `lib/chdb_node.cpp:678–680` "true zero-copy
is a later optimization"; `src/result.ts:56–58` "bytes are owned by
JS (copied off the engine)"). The flag will flip to `true` once
chdb-node lands the N-API external-ArrayBuffer Arrow path. Downstream
code that wants to make a routing decision today can read it as
`Boolean((conn as any).supportsZeroCopyStreaming)`.

## Test sync policy

Cross-suite parity (running `@clickhouse/client`'s integration suite
against `ChdbConnection`) is governed by `tests/clickhouse-js/`. The
upstream `@clickhouse/client` repo has NO chdb-related test
infrastructure — no markers, no skip-profile loader, no chdb test
runner. Everything lives here.

### Which upstream ref we test against

`tests/clickhouse-js/skip_list.json#syncedAgainst.ref` records the
`@clickhouse/client` ref this skip list is calibrated against:

| `@clickhouse/client` PR state | Runner targets |
|---|---|
| `createClient({ connection })` open on personal fork | `ShawnChen-Sirius/clickhouse-js feat/pluggable-connection` |
| PR merged to upstream | `ClickHouse/clickhouse-js main` |
| Released | the latest released tag |

### When chdb-node re-runs parity

**Only when `@clickhouse/client` cuts a new release.** Between
releases, the suite is frozen against the recorded ref; the
`skip_list.json` is stable. When a new release lands:

1. Bump `syncedAgainst.ref` in `skip_list.json`.
2. Run `node tests/clickhouse-js/runner.mjs --refresh`.
3. For each NEW failure, decide: real capability gap (add to
   `skipFiles`) vs ChdbConnection bug (fix in `src/connection/`).
4. Commit the updated `skip_list.json` and any ChdbConnection fixes.

This means chdb-node does **not** participate in upstream CI on every
upstream commit — that would impose maintenance cost on
`@clickhouse/client` (and contradict the "minimal upstream
modification" principle). The skip_list is a snapshot, refreshed on
release boundaries.

### Initial categories on the skip list

The first `skip_list.json` (calibrated against
`ShawnChen-Sirius/feat/pluggable-connection`) carries 23 files
grouped as:

- **HTTP transport** — no socket, no keep-alive, no agents, no
  HTTP-level compression / headers / `/ping`.
- **Auth / RBAC / TLS** — chdb has no auth layer.
- **Server runtime / cluster** — `system.query_log`, multi-client
  cluster scenarios.
- **HTTP session_id semantics** — chdb persistence is its
  `Session.path`, not an HTTP session.
- **Abort divergence** — chdb's single-shot abort rejects early while
  the underlying computation runs to completion (C ABI has no
  interrupt); documented divergence.

The `underInvestigation` array carries files where the failure looks
fixable in `ChdbConnection` rather than a capability gap.

## Implementation notes

### Memory model

`createChdbConnection({ path: ':memory:' })` doesn't ask Layer 1 for
a fresh temp dir each time — that would fail libchdb's
single-active-data-directory rule. Instead chdb-node maintains a
process-shared, refcounted memory dir; all `:memory:` connections
share it. The multi-connection model from
[chdb-node#51](https://github.com/chdb-io/chdb-node/pull/51) lets N
native connections coexist on the same bound path, so this gives the
same shared-state semantics as clickhouse-js's `chdb://memory` while
keeping each ChdbConnection's query state independent.

### Eager-buffered `query` / `exec`

Both materialize via `Session.queryAsync` and surface the result as a
one-shot Readable. clickhouse-js's `Client.query` callers expect
errors at `await connection.query(...)`, not mid-stream — eager
buffering preserves that. The day chdb-node lands the N-API
external-ArrayBuffer reader, ChdbConnection will route streaming
through `queryStream`-equivalents and `supportsZeroCopyStreaming` will
flip to `true`.

### `insert`: inline body

clickhouse-js sends `INSERT INTO t (...) FORMAT X` with the body as a
SEPARATE `values` parameter. chDB's parser accepts the body inline
after the statement, so ChdbConnection materializes the values stream
into a string and concatenates with the query before executing as a
single statement. Callers that want chdb's zero-copy
Buffer-passthrough insert can reach for the `.chdb.rawInsert` escape
hatch.

### Synthetic `query_id` / `response_headers` / `http_status_code`

The Connection contract requires these on every result. chdb has no
server-side query_id, no HTTP layer; ChdbConnection synthesizes a
UUIDv4, returns `{}` for headers and `200` for status. Test code that
relies on `query_id` for log correlation should expect a unique value
but cannot map it back to any cross-process log entry.

## What this design deliberately does NOT do

- **No chdb-specific code in `@clickhouse/client`.** The only upstream
  change is the one `connection?:` option on `createClient`.
- **No per-feature test markers in upstream tests.** Backends own
  their own blacklists.
- **No HTTP loopback inside chdb-node.** Going through a wire format
  would erase chdb's reason for existing (in-process, no marshalling).
- **No client-web support.** chdb is N-API; browsers cannot run it. A
  future web-runtime embedded backend would repeat this pattern in
  `client-web` symmetrically.
