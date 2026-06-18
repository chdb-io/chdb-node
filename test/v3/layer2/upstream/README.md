# Upstream conformance suite (clickhouse-js pipeline, import-rewritten)

This directory implements design §6① — *"run the clickhouse-js pipeline with the
import rewritten (`@clickhouse/client` → `chdb`) + URL rewrite (→ `chdb://memory`)
+ an embedded skip-list, all green"* — as a **deterministic, backend-swappable**
suite.

`conformance.test.ts` is written exactly as a `@clickhouse/client` user writes it.
The only indirection is `_backend.ts`, the single **import-rewrite point**:

| `CHDB_UPSTREAM_BACKEND` | client |
| --- | --- |
| _(unset, default)_ | `createClient` from **chdb** on `chdb://memory` |
| `server` | the real **@clickhouse/client** on `CHDB_PARITY_URL` |

The same spec runs both ways. Whatever passes against a real `clickhouse-server`
must pass against embedded chDB — that is the byte-compat proof.

```bash
# embedded (default; no server needed) — runs in the normal `npm run test:v3`
npx vitest run test/v3/layer2/upstream

# against a real server (CI wires a docker clickhouse-server)
CHDB_UPSTREAM_BACKEND=server CHDB_PARITY_URL=http://localhost:8123 \
  npx vitest run test/v3/layer2/upstream
```

## What is covered (the ✅ "runs as-is" set)

`select` · `select_result` · `query_binding` · `insert` · `exec_and_command` ·
`data_types` (incl. Int64→string) · `totals` · `error_parsing` · `ping`.

## Skip-list (intentionally excluded)

Embedded chDB has no concept of these, so the corresponding clickhouse-js suites
are **not** ported (they would be `❌` skips in a literal port):

| Excluded suite | Why |
| --- | --- |
| `auth` | embedded has no auth layer (username/password/access_token ignored) |
| `role` | no RBAC |
| `compression` | no HTTP transport to compress |
| `query_log` / `system.processes` | no server runtime to log into |
| `multiple_clients` over different on-disk paths | one active data directory per process |
| `ON CLUSTER` / `Distributed` / `cluster()` | no cluster topology |

The following clickhouse-js suites have embedded-different semantics and are
covered by Layer 2's own tests (`../config.test.ts`, `../errors.test.ts`) rather
than here, because the *assertions* differ from the server: `ping` (SELECT 1 vs
`/ping`), `clickhouse_settings` (HTTP-only keys dropped), `session`
(persistent connection), `abort_request` (single-shot rejects early),
`request_timeout` (query deadline, no 30 s default).

## Literal upstream port

`scripts/upstream-suite/` additionally fetches clickhouse-js's *own* integration
spec files and runs them through the same import-rewrite shim. That harness is a
triage scaffold (clickhouse-js's jest suite is tightly coupled to a server), wired
as a **non-gating** CI job; this `conformance.test.ts` is the verified gate.
