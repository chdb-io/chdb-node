# Upstream literal-suite harness

Runs **clickhouse-js's own integration test suite** against embedded chDB, so the
byte-compat surface (Layer 2) is checked by the upstream client's own assertions
— not just by our re-implementation of them (`test/v3/layer2/upstream/conformance.test.ts`).

`rewrite-and-run.mjs` clones clickhouse-js at the version matching the installed
`@clickhouse/client`, runs it on vitest, and redirects the suite's single client
factory (`globalThis.environmentSpecificCreateClient`) to `chdb://memory`. It runs
serially (libchdb allows one active connection per process).

```
npm run test:upstream            # gating run
npm run test:upstream -- --list  # list selected vs skipped spec files
npm run test:upstream -- --keep  # keep the clone (scripts/upstream-suite/clickhouse-js-tmp)
```

This is **gating**. Two mechanisms keep it green while staying honest:

### `skip-list.json` — whole spec files not run

Files for capabilities embedded chDB has no concept of (HTTP transport, sockets,
compression, RBAC, server runtime / `system.*`, cluster, TLS, auth, keep-alive),
matched by basename substring. Also `each_row_with_progress`
(JSONEachRowWithProgress + custom JSON streaming) — a Layer 2 Stage-B feature.

### `expectations.patch` — per-case divergences within run files

Individual cases that legitimately differ on embedded are marked `it.fails(...)`
(the suite still runs them; they must fail, and vitest flags it if one ever starts
passing — i.e. when chDB gains the behavior). Decoupled from the cloned source so
the baseline specs stay pristine. Current categories:

| # | Divergence | Example cases |
|---|------------|---------------|
| 1 | No HTTP `response_headers` (embedded has no HTTP layer) | select / insert / exec_and_command "… response headers" |
| 2 | HTTP compression / `ignore_error_response` / decompression | node_exec, node_command (ignore error response) |
| 3 | Insert formats not yet serialized (`JSON`, `JSONObjectEachRow`, `CustomSeparated`) | insert, node_stream_raw_formats |
| 4 | `Date` insert/format & DateTime session timezone | date_time, data_types "JS Date objects", select_query_binding "DateTime…" |
| 5 | Custom JSON parse/stringify hooks (Stage B) | data_types "custom JSON handling (BigInt and Date)" |
| 6 | Engine specifics (Parquet streamed input, float formatting, nested-json input, some settings) | node_streaming_e2e Parquet, data_types floats/nested, clickhouse_settings |
| 7 | Error-message wording (code/type still match — see conformance.test.ts) | select "returns an error details…" |
| 8 | Misc edge cases (empty column list, stream-error propagation, exec parametrized) | insert_specific_columns, node_stream_error_handling, node_exec |

### Regenerating `expectations.patch` (after a clickhouse-js version bump)

```
npm run test:upstream -- --keep                 # produces the clone + shows new failures
cd scripts/upstream-suite/clickhouse-js-tmp
# mark each genuinely-divergent case it.fails(...) (or move a whole-file family to skip-list.json)
git diff > ../expectations.patch
```

A failure that is NOT a documented divergence is a real byte-compat regression — fix
Layer 2, don't patch it away.
