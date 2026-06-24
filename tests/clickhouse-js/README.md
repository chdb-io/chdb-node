# chdb-node × @clickhouse/client parity runner

This directory carries everything chdb-node needs to verify that the
`@clickhouse/client` integration suite passes against `ChdbConnection`.
**All chdb-side parity logic lives here, in chdb-node's repo.** The
upstream `@clickhouse/client` repo carries zero chdb-specific code and
zero chdb CI dependency — the only upstream change is the
`createClient({ connection })` injection point.

## What's in this directory

| File | Purpose |
|---|---|
| `skip_list.json` | The AUTHORITATIVE blacklist of upstream tests chdb does not support. Maintained by the chdb team. |
| `runner.mjs` | Clones `@clickhouse/client` at the configured ref, links this chdb-node checkout into it, **patches the upstream `vitest.node.setup.ts` in-place** to wrap `globalThis.environmentSpecificCreateClient` with `createChdbConnection`, runs the integration suite with `skip_list.json` applied as `--exclude` patterns, then restores the patch in a `try/finally` block. |

## Sync policy

`skip_list.json#syncedAgainst.ref` records which `@clickhouse/client`
version chdb-node currently asserts parity against. The policy:

| `@clickhouse/client` state | Runner targets |
|---|---|
| `createClient({ connection })` PR open on the personal fork | `ShawnChen-Sirius/clickhouse-js feat/pluggable-connection` |
| **PR merged to upstream (current state — [#879](https://github.com/ClickHouse/clickhouse-js/pull/879))** | **`ClickHouse/clickhouse-js main`** |
| Released | the latest released tag (e.g. `v1.24.0`) |

**chdb-node only re-runs parity (and updates `skip_list.json`) when
`@clickhouse/client` cuts a new release.** During the rolling period
the runner stays pointed at whichever ref the policy table specifies;
that's a single line in `skip_list.json#syncedAgainst.ref`.

## Running the runner

```sh
node tests/clickhouse-js/runner.mjs                 # full run
node tests/clickhouse-js/runner.mjs --refresh       # re-clone fresh
```

Environment overrides:

```sh
CHDB_CLICKHOUSE_JS_REPO=https://github.com/.../clickhouse-js.git
CHDB_CLICKHOUSE_JS_REF=feat/pluggable-connection
CHDB_RUNNER_WORK_DIR=/tmp/chdb-runner/clickhouse-js
node tests/clickhouse-js/runner.mjs
```

## Adding / removing a skip entry

When a new release lands and the runner surfaces a NEW failing test:

1. **Real capability gap** (chdb does not support the feature):
   add the file to `skipFiles` with a one-line `reason`.
2. **Bug in `ChdbConnection`** (chdb should support the case but the
   adapter is wrong): fix in `src/connection/chdb-connection.ts`.
3. **Per-test divergence inside an otherwise-runnable file**: add the
   full vitest node-id (`packages/.../foo.test.ts > describe > it`) to
   `skipTests`.

When chdb implements a previously-missing capability and the test now
passes, remove the entry from `skipFiles`.

## Categories already in the skip list

The initial `skip_list.json` was populated from a representative run
against `ClickHouse/clickhouse-js main` (post-[#879](https://github.com/ClickHouse/clickhouse-js/pull/879)).
The categories are:

- **HTTP transport** (no socket, no headers, no compression, no
  keep-alive, no agents): `node_socket_handling`, `node_keep_alive*`,
  `node_max_open_connections`, `node_custom_http_agent`,
  `node_compression`, `node_ping` (HTTP `/ping`), `node_summary`
  (X-ClickHouse-Summary header), `node_logger_support`,
  `multipart_params`, `request_compression`, `response_compression`,
  `exception_header`.
- **Auth / RBAC** (chdb has no auth layer): `auth`, `role`,
  `read_only_user`, `node_jwt_auth`, `tls`.
- **Server runtime / cluster topology**: `query_log`, `multiple_clients`.
- **HTTP session semantics**: `session`.
- **AbortSignal divergence**: `abort_request` (chdb's single-shot abort
  rejects early while the underlying computation runs to completion;
  documented divergence).
- **Default-timezone divergence** (per-test, in `skipTests`): chdb
  resolves DateTime[64] values without an explicit TZ argument against
  the host's system timezone, not UTC — libchdb captures the ICU TZ
  at load time and `SET session_timezone='UTC'` does not influence the
  output formatter. Round-trip is lossless at the instant level; only
  the display string differs by the host's UTC offset.
- **Float64 output precision** (per-test): chdb prints 17 significant
  digits for IEEE 754 round-trip; clickhouse-server prints 15.

Each entry has a `reason`. When `@clickhouse/client` cuts a new release
and a previously-passing test starts failing under the runner, the
triage rule is: fixable in `ChdbConnection` → patch
`src/connection/chdb-connection.ts`, real capability gap → add to
`skipFiles` / `skipTests` with a one-line reason.
