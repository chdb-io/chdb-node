# chDB Node Layered API Design

This document describes the public design direction for `chdb-node` v3. It is intended for community reviewers, downstream library authors, and users who want to understand how the native binding, ClickHouse-client compatibility layer, and fluent SDK fit together.

The design keeps a single npm package, `chdb`, and exposes three API layers for different users. The layers are organized by user intent, not by marketing surface.

```text
Layer 2: ClickHouse client compatibility
Layer 3: Fluent SDK / federated query authoring
        |
        v
Layer 1: Native binding
        |
        v
libchdb C ABI / chdb-core / ClickHouse engine
```

Layer 2 and Layer 3 are siblings. Both execute through Layer 1. Layer 2 does not call Layer 3, and Layer 3 does not call Layer 2.

## Goals

- Preserve the existing `chdb` npm package and v2 low-level API.
- Target Node, Bun, and Deno through one N-API binding, with full Bun/Deno test suites tracked as follow-up work.
- Provide a stable native foundation for higher-level JavaScript APIs.
- Give ClickHouse users a Dockerless embedded development and CI path.
- Give TypeScript and AI-agent users an ergonomic SQL-first API for local and federated analytics.
- Avoid implementing a second ClickHouse HTTP client inside `chdb-node`; use `@clickhouse/client` for pure remote HTTP access.

## Non-goals

- Do not rewrite ClickHouse or chDB core in JavaScript.
- Do not replace SQL with a custom DSL.
- Do not make Layer 2 a general remote HTTP transport.
- Do not hide native constraints such as process-level connection behavior, query interrupt limitations, or copy-vs-zero-copy trade-offs.

## Package Shape

The npm package remains:

```ts
import { query, Session } from "chdb";
```

The v3 direction is a single package with layered exports and documentation:

| Layer | Primary users | Role |
| --- | --- | --- |
| Layer 1 - Native binding | Existing v2 users, library authors, performance-sensitive users | Low-level `query`, `Session`, async query, bind, insert, streaming, Arrow output, loader, platform packages. |
| Layer 2 - Driver compatibility | ClickHouse users who want embedded dev/CI/test execution | `@clickhouse/client`-shaped API for `chdb://` embedded URLs. |
| Layer 3 - Fluent SDK + federation | TypeScript app developers, AI agents, non-SQL-specialist workflows | SQL-first fluent authoring, raw SQL templates, natural-language entry points, and federated data-source helpers. |

## Data Access Modes

`chdb-node` should make the distinction between embedded execution, federated execution, and pure remote HTTP explicit.

| Mode | Entry | chDB engine participates? | Intended use |
| --- | --- | --- | --- |
| Embedded local | `chdb://memory`, `chdb:///path`, or Layer 1 `Session` | Yes | Local analysis, dev, CI, notebooks, agents. |
| Federated query | Layer 3 `connect({ url, ... })` and table-function-backed SQL | Yes, local engine queries remote sources | Cross-source analysis, local joins over remote data, ClickHouse/S3/Postgres/MySQL/etc. |
| Pure remote HTTP | `@clickhouse/client` peer dependency | No | Remote ClickHouse Server / Cloud client access. |

## Layer 1 - Native Binding

Layer 1 is the only direct bridge to libchdb. It owns the N-API binding, native loader, process/session lifecycle, async workers, streaming handles, and binary result ownership.

Current PR #43 Layer 1 capabilities include:

- v2-compatible synchronous `query`, `queryBind`, and `Session.query`.
- Typed errors with ClickHouse code preservation.
- Server-side `{name:Type}` parameter binding via `chdb_query_with_params_n`.
- Non-blocking `queryAsync` / `queryBindAsync`.
- `Session` lifecycle and process-safety hardening.
- Inline async insert for in-memory row batches.
- Streaming query results as an `AsyncIterable`.
- Arrow IPC output and optional `apache-arrow` conversion.
- Native loader and `@chdb/lib-*` per-platform subpackage shape.
- CJS and ESM entry points.

See [Layer 1 Native Binding Design and Implementation](./layer1-native-binding.md) for the full reviewer guide.

## Layer 2 - ClickHouse Client Compatibility

Layer 2 is designed for users who already have ClickHouse-oriented code and want a local embedded backend for development, CI, and agent workflows.

The target shape is compatible with the familiar `@clickhouse/client` API, but scoped to embedded chDB URLs:

```ts
import { createClient } from "chdb";

const client = createClient({ url: "chdb://memory" });

await client.query({
  query: "SELECT {n:UInt32} * 2 AS v",
  query_params: { n: 21 },
  format: "JSONEachRow",
});

await client.insert({
  table: "events",
  values: [{ id: 1, name: "signup" }],
  format: "JSONEachRow",
});

await client.close();
```

### Layer 2 principles

- Embedded only: `chdb://` URLs are handled by chDB. Remote `https://` ClickHouse endpoints should use `@clickhouse/client`.
- Compatibility first: method names, option shapes, result-set behavior, and error shape should follow `@clickhouse/client` where practical.
- Dev-to-prod consistency: the same logical application code can target local chDB in dev/CI and ClickHouse Server/Cloud in production through a small backend switch.
- CI Dockerless ClickHouse testing: projects should be able to run ClickHouse-like tests without starting a full ClickHouse server container.

### Layer 2 intended backend switch

```ts
type Backend = "chdb" | "clickhouse";

export function createAnalyticsClient(backend: Backend) {
  if (backend === "chdb") {
    return createClient({ url: "chdb://memory" });
  }

  // Use @clickhouse/client for pure remote HTTP access.
  return createClickHouseClient({ url: process.env.CLICKHOUSE_URL });
}
```

Layer 2 should be especially useful for reusable CI workflows such as:

```yaml
uses: chdb-io/test-with-chdb@v1
```

The selling point is not that chDB replaces production ClickHouse. The selling point is that local and CI testing can use an in-process ClickHouse-compatible engine with minimal setup.

## Layer 3 - Fluent SDK and Federated Query Authoring

Layer 3 is the TypeScript-friendly authoring layer. It should help humans and LLMs write correct analytical code while still treating SQL as the source of truth.

Layer 3 is SQL-first, not DSL-first.

The fluent API should follow a Kysely-style builder. We prefer that style
because it maps naturally to OLAP semantics: projection, filtering, grouping,
joins, CTEs, windows, raw SQL escape hatches, and typed result rows. It is also
a shape that LLMs have already seen in training data, so generated TypeScript is
more likely to be syntactically correct and easy for users to repair.

It should provide three entry points:

| Entry | Use case | Shape |
| --- | --- | --- |
| Fluent chain | Simple ad-hoc queries | `db.selectFrom("events").where(...).execute()` |
| Raw SQL template | Complex ClickHouse SQL and OLAP-specific features | `chdb.sql\`SELECT ...\`` |
| Natural language | Agent / notebook exploration | `chdb.ask("...")` |

### Layer 3 principles

- Do not hide ClickHouse SQL. Complex OLAP should remain raw SQL.
- Use TypeScript to make common workflows safer without inventing a new query language.
- Make LLM-generated code more likely to be correct by exposing familiar shapes.
- Expose federated query helpers over chDB table functions rather than routing through an HTTP client.

### Federated query direction

Layer 3 should expose a `connect({ url, ...config })` shape aligned with `@clickhouse/client.createClient`, while compiling to chDB engine table functions internally.

Examples of intended source families:

- `clickhouse-cloud://...` -> `remoteSecure(...)`
- `s3://...` -> `s3(...)`
- `postgres://...` -> `postgresql(...)`
- `mysql://...` -> `mysql(...)`
- `mongodb://...` -> `mongodb(...)`

This makes chDB an in-process federated query engine: the engine runs locally, while data can live in local files, object storage, ClickHouse, or other external systems.

## Runtime and Distribution Design

The package targets Node, Bun, and Deno through one N-API binary per platform. PR #43 includes runtime smoke coverage; full Bun/Deno suites remain follow-up work.

The first prebuilt platforms are:

- Linux x64 glibc
- Linux arm64 glibc
- macOS x64
- macOS arm64

The main package should stay thin:

- JS/TS API files
- type declarations
- no local compile on install
- platform binaries resolved through optional `@chdb/lib-*` dependencies

Windows and musl are out of scope until there is clear demand.

## Review Model

For the current PR, reviewers should read the implementation in this order:

1. Layer 1 native foundation and tests.
2. Public API and type declarations.
3. Loader and distribution shape.
4. Layer 2 / Layer 3 design implications.

The Layer 1 document explains the large native diff commit by commit so reviewers do not have to infer the whole design from source changes alone.
