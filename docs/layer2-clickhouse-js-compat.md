# chDB Node — `@clickhouse/client` compatibility (Layer 2)

Layer 2 is a **byte-compatible, embedded-only** façade over
[`@clickhouse/client`](https://github.com/ClickHouse/clickhouse-js)
(clickhouse-js). Swap the import and point the URL at `chdb://` — your existing
code and tests run in-process against the embedded ClickHouse engine, with no
server and no HTTP.

```ts
// before — talks to a remote ClickHouse server over HTTP
import { createClient } from '@clickhouse/client'
const client = createClient({ url: 'http://localhost:8123' })

// after — runs the same ClickHouse engine in-process, no server
import { createClient } from 'chdb'
const client = createClient({ url: 'chdb://memory' })
```

The surface is identical: `createClient`, the six methods (`query` / `insert` /
`command` / `exec` / `ping` / `close` + `[Symbol.asyncDispose]`), `ResultSet` /
`Row`, and `ClickHouseError` are field-for-field the same as clickhouse-js.

`@clickhouse/client` itself is an **optional peer dependency** — Layer 2 does not
bundle an HTTP transport. Keep it installed if you also talk to a remote server;
you don't need it for embedded use.

---

## 1. Migration guide

| Step | clickhouse-js | chDB (embedded) |
| --- | --- | --- |
| Import | `from '@clickhouse/client'` | `from 'chdb'` |
| URL | `http://host:8123` | `chdb://memory` (in-memory) or `chdb:///abs/path` (on-disk) |
| Multiple environments | different `url` per env | keep one chdb engine, vary `database` (the URL is dev≠prod anyway) |
| Large results | streaming | stream + set `max_memory_usage` (see §5) |
| Auth / TLS | `username`/`password`/`tls` | omit — embedded has no auth layer (ignored, not an error) |

Everything else — `query`/`insert`/`command`/`exec`/`ping`, formats,
`query_params`, `clickhouse_settings`, `ResultSet.json()/.text()/.stream()`,
`ClickHouseError` handling — stays the same.

### Connection model

- `chdb://memory` clients **share one in-process connection** (reference-counted),
  so multiple memory clients see the same data and streaming works.
- `chdb:///path` clients open an on-disk store at that path; the same path is
  shared across clients.
- The embedded engine allows **one active data directory per process**. Opening a
  *different* on-disk path while one is live throws `ChdbConnectionError` — use the
  same URL with a different `database`, or close the first client. (This is an
  engine-level constraint shared with chdb-python, not a Node limitation.)

---

## 2. chDB vs ClickHouse capability matrix

> Read this top-down: what you **can't** do, then what behaves **differently**,
> then what's **identical**.

### 🚫 Not supported — raises a typed error

| Capability | Behavior | Error |
| --- | --- | --- |
| Non-`chdb://` URL (remote server) | no HTTP transport | `ChdbEmbeddedOnlyError` |
| `ON CLUSTER` / `Distributed` engine / `cluster()` / `clusterAllReplicas()` | no cluster topology | `ChdbEmbeddedNotSupportedError` |

Federated **table functions** are *not* blocked — `remote()`, `remoteSecure()`,
`s3()`, `postgresql()`, `url()` are native engine I/O and work in embedded mode.

### ⚠️ Behaves differently — documented

| Capability | Server | Embedded |
| --- | --- | --- |
| `request_timeout` | HTTP socket timeout | query deadline; **not** defaulted to 30 s (won't kill long OLAP queries) |
| `session_id` | server-side temp tables | provided implicitly by the persistent embedded connection |
| `async_insert` | server buffer flush | degrades to a synchronous inline INSERT; `executed` is always true |
| `abort_signal` (single-shot) | aborts the HTTP request | rejects the JS promise immediately; the native compute may finish in the background — use streaming for true between-chunk cancellation |
| `query_id` / `response_headers` | server-assigned / real headers | client-generated UUID / synthesized `{}` |
| `ping()` | HTTP `/ping` | `SELECT 1` self-check, no network |
| connection pool / `max_open_connections` / `keep_alive` | HTTP pool | single engine; same path/`memory` shared; only multiple on-disk paths conflict → `ChdbConnectionError` |
| HTTP-only settings (`enable_http_compression`, `wait_end_of_query`, …) | steer HTTP | ignored (no HTTP), no error |
| `Replicated*` / multi-replica | Keeper coordination | single process; use a local `MergeTree` |
| auth (`username`/`password`/`access_token`) | HTTP auth | ignored — embedded has no auth layer |
| **OOM / resource exhaustion** | kills one query, server survives | with no limit set, can crash the host process (same as chdb-python — an embedded-architecture property). Set `max_memory_usage` for a graceful `MEMORY_LIMIT_EXCEEDED` (241) like the server, and stream large results |
| `system.*` (`processes`/`clusters`/`replicas`) | complete | partially empty (no server runtime state) |

### ✅ Identical

SELECT / INSERT / DDL / 1000+ functions / window functions / CTEs / JOINs /
aggregation precision · `FINAL` / `SAMPLE` (single-node logic) · `query_params`
(`{name:Type}`) · streamable-format streaming · engine-level
`clickhouse_settings` · Arrow / Parquet output (embedded is zero-copy, often
faster) · `remote()`/`s3()`/`postgresql()`/`url()` table functions.

---

## 3. Config / parameter arbitration reference

Maximally compatible: Layer 2 only **errors** on the two genuinely-unsupported
server features; every remote/HTTP/auth-only field is **ignored** so "change the
import and run" holds.

| Order | Class | Fields | Handling |
| --- | --- | --- | --- |
| ① **Error** | unsupported server features | non-`chdb://` URL; cluster-topology SQL | `ChdbEmbeddedOnlyError` / `ChdbEmbeddedNotSupportedError` — never swallowed |
| ② **Ignore** | remote / HTTP / auth-only | `username`, `password`, `access_token`, `tls`, `role`, `http_agent`, `host`, `pathname`, `max_open_connections`, `keep_alive`, `compression`, `http_headers`, `application`, HTTP-only `clickhouse_settings` | accepted, no error; the honest boundary (no auth / no transport security) is documented, not enforced by throwing |
| ③ **Retained, different** | embedded has an analog with different behavior | `request_timeout` (→ query deadline, no 30 s default), `session_id` (→ persistent connection), `query_id` (client-generated), `response_headers` (synthesized `{}`), `async_insert` (→ synchronous) | accepted and effective; differences per §2 |
| ④ **Equivalent** | native parity | `url` (`chdb://`), `database`, engine-level `clickhouse_settings`, `log`, `json` | forwarded directly |

Security-sensitive ignored fields (`access_token`, `tls`) are silently accepted
by default; the honest "embedded has no auth/transport security" boundary is the
documentation above, not a thrown error (throwing would break "change the import
and run").

---

## 4. Type mapping reference

chDB *is* the ClickHouse engine, so there are no engine-level unsupported types.
The only constraints live in the **JS representation layer**:

| ClickHouse type | JSON / text out | Arrow out | In (params / insert) |
| --- | --- | --- | --- |
| Int8..32 / UInt8..32 / Float | `number` | `number` | `number` |
| **Int64 / UInt64 / Int128+ / 256** | **`string`** (lossless; matches clickhouse-js HTTP JSON) | `bigint` (lossless) | `bigint` or `string` (first-class); `number` only when `Number.isSafeInteger` — out-of-range `number` is rejected with `ChdbBindError`, never silently truncated |
| DateTime / DateTime64 | `string` | string / timestamp | `Date` or `string` |
| Nullable(T) / Array / Map / Tuple / LowCardinality(T) | `T \| null` / nested / `T` | same | recursive; `null` → NULL |

**64-bit integers in JSON are strings by default.** Layer 2 sets
`output_format_json_quote_64bit_integers=1` for JSON output (the ClickHouse
server default, and what clickhouse-js sees), so `Int64`/`UInt64` round-trip
losslessly instead of being mangled by `JSON.parse`. Override it via
`clickhouse_settings` if you really want unquoted numbers (and accept the
precision loss).

**Silent-conversion policy:** lossless conversions are silent; any precision loss
(an out-of-range `number`) is rejected, never performed. The JSON↔Arrow
asymmetry for 64-bit ints (string vs bigint) is intentional and documented.

---

## 5. Honest differences — the short version

These are the points where embedded chDB cannot, by construction, behave exactly
like a remote ClickHouse server. We surface them honestly rather than pretend:

- **No auth / no transport security.** `username`/`password`/`access_token`/`tls`
  are accepted but ignored. An embedded engine in your process has no auth layer.
- **OOM can crash the process.** Without `max_memory_usage`, a runaway query can
  take down the host process (the same property chdb-python has). Set a memory
  limit and stream large results.
- **`request_timeout` is not defaulted to 30 s.** A long analytical query is not
  killed by a hidden default; set `request_timeout` yourself if you want a
  deadline.
- **One active on-disk path per process.** Multiple `chdb://memory` (or same-path)
  clients share a connection; a second *different* on-disk path throws
  `ChdbConnectionError`.
- **`query_id` / `response_headers` are synthesized**, not server-assigned.
- **`system.*` runtime tables are partial/empty** — there is no server runtime to
  report processes, clusters, or replicas.

---

## Error handling

```ts
import {
  createClient,
  ClickHouseError,              // engine errors — code/type byte-compat with clickhouse-js
  ChdbEmbeddedOnlyError,        // non-chdb:// URL
  ChdbEmbeddedNotSupportedError,// cluster-topology SQL
  ChdbConnectionError,          // second concurrent on-disk path
  ChdbError,                    // base of the whole hierarchy
} from 'chdb'

try {
  await client.query({ query: 'SELECT * FROM missing' })
} catch (e) {
  if (e instanceof ClickHouseError) {
    console.log(e.code, e.type) // e.g. "60", "UNKNOWN_TABLE"  (== clickhouse-js)
  }
}
```

Engine errors are rewrapped as `ClickHouseError` (with `code`/`type`/`message`
identical to clickhouse-js, and the originating chdb error preserved on
`.cause`). Boundary errors stay their own honest types — they are **not**
disguised as server exceptions.
