# 13.2 Layer 2 - ClickHouse Client Compatibility Reviewer Guide

## 1. Reviewer Summary

Layer 2 is an embedded-only façade that mirrors the `@clickhouse/client` surface
on top of the Layer 1 connection/session model. The goal is byte-compatibility:
code written against clickhouse-js should run unchanged against an in-process
chDB by changing only the import and the URL (`chdb://memory`).

Layer 2 owns no execution path of its own — every operation is encoded to SQL /
a FORMAT-tailed dataset / a bound parameter map and handed to Layer 1, so the
chDB engine (not a re-implementation) decodes it.

| Capability | Status | What reviewers should check |
| --- | --- | --- |
| `createClient` / `ChdbClickHouseClient` | Implemented | `query` / `command` / `exec` / `insert` / `ping` / `close`, embedded-only URL gate. |
| `ResultSet` | Implemented | `json()` / `text()` / `stream()`; `ResponseJSON` shape (`data`/`meta`/`rows`/`statistics`). |
| Query parameters | Implemented | clickhouse-js-faithful `formatQueryParams`, incl. `TupleParam`; bound verbatim via Layer 1's `preformatted` path. |
| Insert | Implemented | Encoded as `INSERT … FORMAT <fmt>` (never SQL `VALUES`); applies `clickhouse_settings` + timeout/abort. |
| Settings / config arbitration | Implemented | client + per-call `clickhouse_settings` merged into a `SET` prefix; unsupported remote/HTTP fields ignored, not errored. |
| Typed errors | Implemented | engine errors → `ClickHouseError` (also a `ChdbError`); boundary errors stay `Chdb*Error`. |
| Cluster-topology guard | Implemented | `ON CLUSTER` / `clusterAllReplicas(` / `Distributed(` raise a typed "not supported" error. |
| Verification harness | Implemented | conformance (backend-swappable), parity (real server), and clickhouse-js's own suite — all gating CI. |

What this PR additionally hardened (review follow-ups, `4a105d8`):

- Insert now applies `clickhouse_settings` / `request_timeout` / `abort_signal`
  like `query`/`command`/`exec` (they were previously dropped).
- A failed `USE <database>` no longer poisons the client (the memoized promise
  is cleared on rejection).
- Parameters are type-aware via the engine rather than guarded client-side: an
  out-of-range `Int64` is a typed error, while the same `1e21` binds to a
  `Float64`.

## 2. Layer 2 Responsibility

Layer 2 does **not** talk to a remote ClickHouse and does **not** open its own
engine. It is a thin translation layer:

- **In:** `@clickhouse/client`-shaped calls (`createClient({url})`, `query`,
  `insert`, …).
- **Out:** Layer 1 primitives (`Session.queryAsync` / `queryBindAsync` /
  `insert`), i.e. the single native execution spine.

It is a sibling of Layer 3, not a dependency of it: both execute through Layer 1,
neither calls the other (see [`architecture.md`](./architecture.md)). Anything
that is genuinely remote/HTTP belongs in `@clickhouse/client`, not here.

## 3. Design Principles

### 3.1 Byte-compatibility is the contract

The reason to use Layer 2 instead of Layer 1 directly is that an existing
clickhouse-js codebase can switch backends with no other changes. So where a
behavior is observable (result shape, parameter encoding, default formats, error
`code`/`type`), Layer 2 matches clickhouse-js — even when chDB or Layer 1 would
do something different on its own. The compatibility claim is only credible if it
is tested against clickhouse-js itself (§7).

### 3.2 Façade over Layer 1, never a second engine path

Layer 2 never reaches the native addon directly. It builds SQL / datasets /
bound-parameter maps and calls Layer 1. This keeps the single-active-connection
and process-safety guarantees in one place (Layer 1) and means Layer 2 cannot
introduce a divergent execution path.

### 3.3 Encode, then let the engine decode — do not re-implement semantics

Inserts and parameters are encoded into the exact text the engine parses, rather
than re-implementing ClickHouse value semantics in JS:

- insert serializes rows to a FORMAT-tailed dataset (`INSERT … FORMAT JSONEachRow`),
  so the engine's format parser handles arrays / maps / tuples / Nested / JSON;
- parameters are formatted to ClickHouse literal syntax and bound through the
  engine's `{name:Type}` mechanism.

This is both simpler and more correct than the alternative (a SQL `VALUES`
literal builder mis-encodes complex types).

### 3.4 Embedded honesty: unsupported is a typed error, divergence is documented

Features embedded chDB has no concept of (auth, RBAC, HTTP transport, cluster
topology) either raise a typed "not supported" error or are ignored where
clickhouse-js treats them as no-ops (HTTP-only config fields). Where embedded
output legitimately differs from a server, it is documented (§8) and asserted as
a known divergence in the verification harness, never hidden.

### 3.5 One deliberate JS guard is kept

clickhouse-js maps a `null`/`undefined` parameter to the TSV null token. Layer 2
matches that for `null` (the user's explicit intent). For an **insert cell**, an
`undefined` is rejected (`JSON.stringify` would silently drop the key → a column
default → data loss); this guard has no clickhouse-js-visible cost because a
server never receives a JS `undefined`. On the **query-parameter** path, the
formatter mirrors clickhouse-js exactly (`undefined → \N`) because that path is a
byte-compat surface; Layer 1's own binder still rejects `undefined`.

## 4. Module Map (`src/layer2/`)

| Module | Responsibility |
| --- | --- |
| `index.ts` | Public surface re-exported from the package root: `createClient`, `ChdbClickHouseClient`, `ResultSet`, `TupleParam`, typed errors. |
| `create_client.ts` | URL gate (`chdb://memory` / `chdb:///path`), config arbitration, and the reference-counted connection registry. |
| `client.ts` | `ChdbClickHouseClient`: `query` / `command` / `exec` / `insert` / `ping` / `close`; lazy `USE database`; settings + opts wiring. |
| `params.ts` | clickhouse-js-faithful query-parameter formatter and the `TupleParam` wrapper. |
| `result_set.ts` | `ChdbResultSet`: `json()` / `text()` / `stream()` over the buffered bytes. |
| `settings.ts` | `buildSettingsPrefix` — merges JSON defaults + client + per-call `clickhouse_settings` into a `SET …;` prefix; drops HTTP-only keys. |
| `formats.ts` | Output-format classification (JSON family detection, etc.). |
| `errors.ts` / `error_map.ts` | `ClickHouseError` and the engine-error → typed-error mapping. |
| `sql_guard.ts` | Rejects cluster-topology constructs (`ON CLUSTER`, `clusterAllReplicas(`, `Distributed(`) with a typed error. |
| `url.ts` | `chdb://` URL parsing (memory vs path, database). |
| `types.ts` | The `@clickhouse/client`-shaped parameter/result/config type surface. |
| `layer1.ts` | The narrow Layer 1 `Session` interface Layer 2 depends on (decouples Layer 2 from `index.js` internals). |

## 5. Commit-Ordered Implementation Map

| Commit | What it landed |
| --- | --- |
| `a25929d` feat(l2) | The façade: `createClient` + client surface, ResultSet, URL gate, SQL guard, settings prefixing, error mapping; insert via FORMAT-tailed dataset; the clickhouse-js-faithful parameter formatter + `TupleParam`; entrypoint re-exports; the vitest single-instance config fix. |
| `d0487c1` test(l2) | Verification: backend-swappable conformance test, real-server parity test, and the vitest runner that executes clickhouse-js's own integration suite against embedded chDB, with `skip-list.json` + `expectations.patch`; gating CI workflow. |
| `fe175e7` (CI) | CI environment fixes: `CLICKHOUSE_SKIP_USER_SETUP=1` for the 26.5 server image, `TZ=UTC` for the upstream job (so DateTime assertions are byte-compat); pruned the DateTime/Date expected-fails that pass under UTC. |
| `4a105d8` fix(l2) | Review follow-ups: insert applies settings/timeout/abort; `USE` failure no longer poisons the client; skip-list matches basename; the row transform flushes a final unterminated row; doc/comment fixes. |

## 6. Key Implementation Decisions

### 6.1 Connection and session model

- `chdb://memory` clients share **one** process-wide, reference-counted Layer 1
  `Session` (a temp directory). This lets multiple in-memory clients coexist and
  share state, and is what makes a `CREATE TABLE` in one client visible to
  another in the same process.
- `chdb:///path` clients share one Session per absolute path, also
  reference-counted.
- libchdb allows one active data directory per process; opening a *different*
  on-disk path while one is live surfaces a `ChdbConnectionError`. Connection
  creation is lazy (on first operation), so `createClient` itself never throws on
  a connection condition — matching clickhouse-js, whose `createClient` does not
  connect eagerly.
- `client.close()` releases the client's reference; the underlying Session is
  closed when the refcount reaches zero.

### 6.2 `query()` is eager-buffered; `stream()` replays the buffer

`query()` runs through Layer 1 `queryAsync` and materializes the result, so
errors surface at `await query()` (byte-compat with clickhouse-js). `stream()`
replays the buffered bytes through a newline transform whose `flush` handler
emits a final non-newline-terminated fragment, so the last row is never dropped.
True zero-copy streaming is a follow-up (§9).

### 6.3 Insert via a FORMAT-tailed dataset, not SQL `VALUES`

Row arrays are serialized to the requested format and inserted as
`INSERT INTO t (cols) FORMAT <fmt>\n<data>` — `JSONEachRow` for object rows,
`JSONCompactEachRow` for positional arrays, inferred when the caller omits a
format. This matches clickhouse-js and lets the engine decode complex types,
which a hand-built `VALUES` literal mis-encodes. The written-row count is the
number of rows submitted (the inline INSERT channel reports no engine row
ledger), matching the prior Layer 1 VALUES behavior.

Insert also applies the same `clickhouse_settings` prefix and timeout/abort
options as `query`/`command`/`exec` (`4a105d8`). An `undefined` cell is rejected
(§3.5); an explicit `null` serializes to JSON `null` and binds as ClickHouse NULL.

### 6.4 Query parameters: a faithful clickhouse-js formatter + a clean bind seam

`params.ts` reproduces clickhouse-js's `formatQueryParams` exactly:

- top-level strings are unquoted and `null` is the TSV token `\N`;
- inside an `Array` / `Tuple` / `Map`, strings are quoted, `null` is the `NULL`
  keyword, and booleans are `TRUE`/`FALSE` (vs `1`/`0` at top level);
- `Date` → a Unix timestamp with a sub-second fraction (so `DateTime64`
  round-trips);
- a `Tuple` must be wrapped in `TupleParam` (JS has no native tuple type, so —
  exactly like clickhouse-js — an array alone is an `Array`). chDB exports its own
  `TupleParam`, and a clickhouse-js `TupleParam` is accepted structurally for
  drop-in migration.

The formatted `{name: literal}` map is bound **verbatim** through a `preformatted`
option added to Layer 1's `queryBindAsync`, so Layer 2 owns the clickhouse-js
parameter dialect without disturbing Layer 1's own serializer (and its tests).
Verified empirically that chDB's native binding parses `(42,'foo',NULL)`,
`(TRUE,FALSE)`, `[1,NULL,3]`, `{'a':1}` identically to the server.

### 6.5 64-bit integer quoting

chDB defaults `output_format_json_quote_64bit_integers=0` (unquoted → `JSON.parse`
precision loss). Layer 2 injects `=1` for JSON-family output so `Int64`/`UInt64`
come back as lossless strings — matching how clickhouse-js's own client (and its
test suite) is configured.

### 6.6 Settings arbitration and error mapping

`buildSettingsPrefix` merges JSON-family defaults, client `clickhouse_settings`,
and per-call `clickhouse_settings` (call wins) into a `SET …;` prefix, and drops
HTTP-only keys. Remote/HTTP/auth-only config fields are accepted and ignored
(never errored), because clickhouse-js treats them as transport config. Engine
errors map to `ClickHouseError` (which is also a `ChdbError`, exposing
`code`/`type`); boundary conditions stay as their specific `Chdb*Error`.

### 6.7 The vitest single-instance gotcha

The package entrypoint is plain CJS and holds the process-wide session registry.
Imported via different relative specifiers (test files vs the compiled Layer 2's
`require('../../index.js')`), vitest would evaluate it twice, and the global
session-cleanup `afterEach` would operate on a different instance than the tests
use — leaking sessions across files. `vitest.config.ts` externalizes the
entrypoint so every importer shares one Node-cached instance.

## 7. Verification Strategy and Evidence

The byte-compat claim is checked three ways, all gating CI:

1. **Conformance** (`test/v3/layer2/upstream/conformance.test.ts`) — assertions
   about true ClickHouse semantics, backend-swappable via `_backend.ts`: embedded
   chDB by default, or a real server with `CHDB_UPSTREAM_BACKEND=server`. Whatever
   passes against a server must pass against embedded.
2. **Parity** (`test/v3/layer2/parity.test.ts`) — the same queries run through
   embedded chDB and a real `clickhouse-server` (pinned to chDB's kernel version,
   26.5), comparing decoded output (normalizing `query_id`/timings). Both clients
   set `output_format_json_quote_64bit_integers=1` (clickhouse-js's own default).
3. **Upstream-literal** (`scripts/upstream-suite/`) — clickhouse-js's OWN
   integration suite, run on vitest against embedded chDB by redirecting its
   client factory (`globalThis.environmentSpecificCreateClient`) to
   `chdb://memory`. Two decoupled mechanisms keep this gating and honest:
   - `skip-list.json` drops whole spec files for capabilities embedded lacks
     (HTTP transport / sockets / compression / RBAC / server runtime / cluster /
     TLS / keep-alive; plus JSONEachRowWithProgress, a Stage-B feature);
   - `expectations.patch` marks per-case embedded-vs-server divergences `it.fails`
     (they still run and must fail; vitest flags any that start passing). A
     failure that is not a documented divergence is a real regression.
   See [`scripts/upstream-suite/README.md`](../../scripts/upstream-suite/README.md)
   for the divergence categories and how to regenerate the patch.

Status against clickhouse-js 1.20.0 on embedded chDB: **182 passing, 25
expected-fail, 12 skipped, 0 unexpected**. v3 unit/behavior suite: 257 passing.
`npm run test:parity`: 23/23 against a local 26.5 server.

## 8. Honest Differences

Embedded chDB is not a server, so part of the `@clickhouse/client` surface cannot
behave identically. The categories:

**Not supported — raises a typed error**

- Cluster topology: `ON CLUSTER`, `clusterAllReplicas(...)`, `Distributed(...)`.
- A second on-disk data directory while one is active (one active data directory
  per process).

**Ignored — accepted as a no-op**

clickhouse-js treats these as transport/auth config; embedded has no layer to
apply them to, so they are accepted and ignored rather than errored:

- auth/RBAC fields: `username` / `password` / `access_token` / `role`;
- HTTP-only fields: `max_open_connections`, `keep_alive`, `compression`,
  `http_headers`, `tls`, `application`, …

**Behaves differently — documented**

- No HTTP transport ⇒ no `response_headers`, no request/response compression, no
  sockets / keep-alive; `ping` is `SELECT 1`, not an HTTP `/ping`.
- No server runtime ⇒ no `system.query_log` or other operational `system.*`
  tables.
- `query_id` is generated client-side (no server-assigned id).
- 64-bit integers (`Int64` / `UInt64`) decode to lossless strings in JSON-family
  output: chDB defaults to unquoted (`JSON.parse` would lose precision), so
  Layer 2 injects `output_format_json_quote_64bit_integers=1` — the same setting
  clickhouse-js's own client uses.

**Identical**

- SQL execution and result sets; `JSON` / `JSONEachRow` / `JSONCompactEachRow` /
  CSV / TSV output; `{name:Type}` parameter binding (including arrays, tuples,
  maps, nested types, and NULL); error `code` and `type`.

## 9. Layer 2 Follow-ups (Stage B)

Deferred and currently marked expected-fail in the upstream suite:

- streaming formats: `JSONEachRowWithProgress`, custom JSON parse/stringify hooks,
  the remaining `JSON`/`JSONObjectEachRow` insert formats;
- true zero-copy `stream()` (currently buffers the whole result);
- Parquet streamed input;
- the DateTime session-timezone difference (byte-compat under UTC today).
