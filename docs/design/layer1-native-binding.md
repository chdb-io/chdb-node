# 13.1 Layer 1 - Native Binding Reviewer Guide

> Audience: reviewers and maintainers. This document extracts `13.1 Layer 1 - Native Binding` into a standalone reviewer guide and calibrates the Layer 1 implementation through PR #43 commit `9244db0` (`build(l1): pin libchdb to released chdb-core v26.5.0`).
>
> It is not a high-level roadmap. It is a review aid for a large native-binding diff: what Layer 1 is responsible for, which principles guided the implementation, which features landed, what each commit solved, what review feedback was addressed, how tests and performance checks were done, and which follow-ups remain Layer 1 work.

## 1. Reviewer Summary

Layer 1 does not rewrite chDB or the ClickHouse engine. Its job is to turn `chdb-node` from the v2 synchronous, string-heavy, locally compiled binding into a stable native execution foundation that Layer 2 and Layer 3 can reuse.

Implemented Layer 1 v3 capabilities:

| Capability | Status | What reviewers should check |
| --- | --- | --- |
| v2-compatible API | Implemented | `query`, `queryBind`, and `Session.query` still synchronously return strings. v3 APIs are additive. |
| Typed error hierarchy | Implemented | JS-visible errors map to `ChdbError` subclasses, preserving `.cause` and ClickHouse error codes. |
| Parameterized queries | Implemented | The old JS interpolation / session `SET param_*` path was replaced with server-side `chdb_query_with_params_n`. |
| Async query core | Implemented | `Napi::AsyncWorker` runs `chdb_query_n` / `chdb_query_with_params_n` without freezing the event loop. |
| Session lifecycle / registry | Implemented | One-active-connection process constraint is managed centrally; close/cleanup are idempotent; temp-dir deletion is guarded. |
| Insert | Implemented v1 | Inline multi-row `INSERT ... VALUES`, async execution, avoids stdin fallback hangs; chunked/binary insert remains a follow-up. |
| Streaming | Implemented v1 | Wraps `chdb_stream_query_n` / `chdb_stream_fetch_result` as an `AsyncIterable`; chunk-copy path first, zero-copy later. |
| Arrow output | Implemented copy path | `{ format: 'arrow' }` returns Arrow IPC bytes; `toArrow()` optionally uses `apache-arrow`; zero-copy and Arrow input remain follow-ups. |
| Prebuilt distribution shape | Implemented framework | `@chdb/lib-*` optional dependencies, loader, and publish workflow; now pinned to released `chdb-core v26.5.0`, with tag/subpackage publish still to validate. |
| ESM/CJS dual export | Implemented | The package exports both `import` and `require` entry points. |
| Tests / CI scaffold | Implemented | v2 mocha, v3 vitest, cleanroom install smoke, runtime smoke, and sanitizer scaffold. |

PR #43 review-follow-up commits also strengthened three areas reviewers explicitly care about:

- Parameterized async queries are serialized per connection so `chdb_query_with_params` parameter state cannot be clobbered by overlapping calls.
- Insert, identifier validation, and native error paths now fail with typed errors instead of silently swallowing errors or losing data.
- The release gate moved from a placeholder/unpublished binary to released `chdb-core v26.5.0`; Deno ESM smoke and the macOS x64 runner were fixed.

Explicit non-goals for this round:

| Not completed in this PR | Reason |
| --- | --- |
| Arrow input / `registerArrowTable` | Needs a separate implementation over `chdb_arrow_scan` / `chdb_arrow_array_scan`. |
| Zero-copy Arrow output | Requires external ArrayBuffers and a V8-GC-bound release callback; high UAF risk, intentionally deferred. |
| Large insert chunking / binary insert | Current inline `VALUES` path has clear RSS risk on wide/large batches; chunked or binary path should follow. |
| True single-shot query interrupt | Current C ABI has no interrupt. Abort/timeout is honest cancellation: JS rejects early while native work drains. |
| Thread-safety hardening as release gate | Registry / async-worker concurrency still needs TSan and an explicit final policy. |
| Full Bun/Deno suite | Current coverage is smoke-level; full suites are follow-up work. |

## 2. Layer 1 Responsibility

Layer 1 is the only native bridge:

```text
Layer 2 ClickHouse client compatibility
Layer 3 fluent SDK / federated query authoring
        |
        v
Layer 1 native binding
  - query / queryBind / Session compatibility
  - async query
  - insert
  - stream
  - Arrow IPC output
  - loader / platform subpackages
        |
        v
libchdb C ABI / chdb-core / ClickHouse engine
```

Review boundaries:

1. Layer 2 and Layer 3 should call Layer 1 rather than reimplement native execution.
2. Layer 1 exposes libchdb C ABI capabilities to JS in a stable, typed, installable way. It does not implement a ClickHouse HTTP client and does not implement the Layer 3 query builder.

## 3. Design Principles

### 3.1 Preserve v2, add v3

Existing npm users depend on the v2 surface. Layer 1 v3 keeps:

- `query(sql, format): string`
- `queryBind(sql, args, format): string`
- `Session.query(...): string`

It adds:

- `queryAsync`
- `queryBindAsync`
- `Session.queryAsync`
- `Session.queryBindAsync`
- `insert`
- `Session.insert`
- `Session.queryStream`
- `version`
- typed errors

### 3.2 One native execution spine

The implementation centralizes native execution rather than letting upper layers duplicate logic:

- sync: `Query` / `QueryWithConnection`
- params: `QueryWithParams` / `QueryWithParamsConnection`
- async: `QueryAsync` / `QueryAsyncConnection`
- streaming: `StreamQuery` / `StreamFetch` / `StreamCancel`

Errors are mapped through `src/errors.ts`, result behavior lives in `src/result.ts`, insert SQL building lives in `src/insert.ts`, and JS API composition lives in `index.js`.

### 3.3 Never silently hang, crash, lose precision, or lose data

The implementation enforces this in several places:

- `queryBind` and insert serialization reject unsafe integers, NaN/Infinity, invalid Dates, functions, symbols, and unclear values.
- Insert uses inline SQL to avoid chDB stdin fallback hangs.
- Single-shot abort/timeout is documented honestly: JS rejects early, but native work still finishes in the background.
- Review-fix commits reject silent insert column loss and surfaced native errors that were previously swallowable.

### 3.4 Parameter binding must happen in the engine

Old risk: JS-side SQL interpolation missed backslash escaping, and `Session.queryBind` was not usable.

Current model:

```text
JS params -> formatParamValue -> native names/values arrays -> chdb_query_with_params_n
```

Security boundary:

- SQL never concatenates user values.
- ClickHouse/chDB parses `{name:Type}` placeholders.
- String parameters are transported with TSV/Escaped rules and explicit lengths, including NUL bytes.
- `null` / `undefined` parameters are rejected to avoid ambiguous typing.

References: ClickHouse `{name:Type}` placeholders and chdb-python native parameter support.

### 3.5 Copy-safe first, zero-copy later

Arrow and streaming currently choose safe copies:

- Async query copies `chdb_result_buffer` into a JS-owned `Buffer`.
- Streaming copies each chunk into a JS `Buffer`, then immediately destroys the native chunk.
- Arrow output returns JS-owned IPC bytes; `toArrow()` can hold them safely.

This trades some performance for a simpler lifetime model and avoids use-after-free during the first reviewable version.

### 3.6 Libraries do not own process signals

`installSignalHandlers` defaults to false. If a user opts in, handlers close sessions but never call `process.exit`. Follow-up review fixes also deregister those handlers on `close()`.

### 3.7 Installation should be boring

Goal: `npm i chdb` should not compile, download, or run postinstall on supported platforms.

Implemented shape:

- `src/loader.ts` prefers `@chdb/lib-<platform>`, then falls back to local `build/Release`.
- `scripts/build-platform-pkg.sh` builds per-platform subpackages from build artifacts.
- `.github/workflows/prebuild-publish.yml` publishes platform packages first, then the thin main package.
- Optional dependencies cover `linux-x64-gnu`, `linux-arm64-gnu`, `darwin-x64`, and `darwin-arm64`, with a `>=26.5.0` binary lower bound.

This mirrors the chdb-python model of a thin package plus platform binary artifacts in npm form.

## 4. Commit-Ordered Implementation Map

This section follows the real PR commit order. Each subsection explains the problem, the scenario, the implementation, and any review feedback fixed by the commit or later follow-up commits.

### 4.1 `41d95a1` - TypeScript + Vitest harness

Problem: the original repo was mostly JS plus mocha smoke tests. v3 needed type contracts and a test matrix for JS, TS declarations, native binding behavior, and packaging.

Scenario: reviewers can evaluate each v3 capability through focused tests rather than only reading a large native diff.

Implementation:

- Added `tsconfig.json`, `tsconfig.build.json`, and `vitest.config.ts`.
- Compiles `src/*.ts` into `dist/*.js`.
- Adds `test/v3/*.test.ts`.
- Adds `test:v3`, `test:all`, and `typecheck`.

### 4.2 `89b535a` - Typed error hierarchy

Problem: raw native `Error` objects are hard for upper layers to classify. Query, bind, insert, stream, and loader errors need a stable taxonomy.

Scenario: Layer 2 can rewrap or map errors reliably while preserving the original native cause and ClickHouse error code.

Implementation:

- `ChdbError`
- `ChdbQueryError` / `ChdbSyntaxError`
- `ChdbConnectionError` / `ChdbClosedError`
- `ChdbStreamError` / `ChdbArrowError`
- `ChdbBindError` / `ChdbInsertError`
- `ChdbAbortError` / `ChdbTimeoutError`
- `ChdbPlatformUnsupportedError` / `ChdbBinaryVersionMismatchError`

Key details:

- `ChdbError` restores prototype chains with `Object.setPrototypeOf`.
- `parseClickHouseCode()` extracts `Code: N` from native messages.
- `mapNativeError()` maps known syntax codes to `ChdbSyntaxError`, otherwise preserves `clickhouseCode` on `ChdbQueryError`.

Review feedback addressed:

- Source comments referenced out-of-repo design sections. `6b0053e` removed those references and made comments self-contained.

### 4.3 `eb96210` - Serializer + identifier validator

Problem: query binding and insert both need a clear JS value / identifier safety boundary. The old `queryBind` string path did not fully handle backslashes, creating injection risk.

Scenario: hostile strings, bigint, Dates, Arrays, Maps, objects, typed arrays, and bad identifiers should have one consistent policy.

Implementation:

- `escapeStringLiteral`
- `tsvEscape`
- `serializeValue`
- `formatParamValue`
- `validateIdentifier`

Policy:

- Reject unsafe integers with guidance to use bigint/string.
- Reject `null` / `undefined` as queryBind parameters.
- Validate identifiers with a whitelist, not quote escaping.

Key details:

- `escapeWith()` does a single scan and copies safe runs.
- SQL string literals escape backslash, quote, NUL, and C0 control characters.
- TSV/Escaped parameter transport is separate from SQL string literal escaping.
- `serializeValue()` recursively handles scalars and structured values.

Review feedback addressed:

- Escape-set exhaustiveness: only `\` and `'` are security-critical for leaving a quoted SQL string; control escapes are round-trip niceties; other bytes, including UTF-8, pass through.
- Serializer performance: complexity is O(total cells), called once per query/insert, not a per-row native hot loop. `0f2c1e5` added a benchmark and replaced multi-pass regex replacement with single-pass escaping.
- Test robustness: `d65d75c` added malformed/hostile input matrices and an end-to-end system test.
- Follow-up fix: `1d4ccc6` tightened identifier validation from a flat character whitelist to non-empty dot-separated `[A-Za-z0-9_]+` segments.

### 4.4 `abdc3b5` - Connection registry spine + sync typed errors + `version()`

Problem: libchdb effectively has a one-active-connection-per-process constraint. The old binding mixed a global default connection with sessions, which made repeated start/stop and path switching risky.

Scenario: v2 sync API still works, but active native connection state is centralized. Same-path sessions reuse one handle; different-path concurrent sessions fail explicitly.

Implementation:

- `ActiveConn g_active` tracks the current connection, key, refcount, and default/session status.
- Same-path sessions refcount the same connection.
- Opening a session yields the standalone default in-memory connection.
- Different path conflicts throw `ChdbConnectionError`.
- Sync paths map native errors through typed errors.
- `version()` reports package/libchdb/platform/arch/napi diagnostics.

Review feedback addressed:

- Same path reopen: `6b0053e` normalizes registry keys with `path.resolve`, so relative and absolute forms map to the same connection while preserving public `Session.path`.
- Concurrent params: this was first explained as per-call scoped server-side binding; `08705d9` later hardened it by serializing parameterized async queries per connection because the underlying C ABI still uses connection-scoped parameter state.

### 4.5 `8071f9e` - Session lifecycle & process safety

Problem: connection registry alone is not enough. Session close/cleanup, temp-dir deletion, process exit cleanup, and signal handling need explicit library-safe behavior.

Scenario: user code can create and close sessions repeatedly without crashes, user directories are never deleted by mistake, and the library does not take over process shutdown.

Implementation:

- `Session.open`
- idempotent `close()` / `cleanup()`
- temp dir prefix changed to `chdb-node-`
- deletion gates: only temp sessions, realpath under `os.tmpdir()`, basename starts with `chdb-node-`
- JS `process.on('exit')` cleanup plus native `env.AddCleanupHook` / `std::atexit`
- opt-in `installSignalHandlers`, which only closes and never exits

Review feedback addressed:

- Why `chdb-node-` instead of `tmp-chdb-node-`: the directory is already inside `os.tmpdir()`, the trailing dash separates the random suffix, and cleanup gates key on this prefix.
- Signal lifecycle: `08705d9` deregisters opt-in signal handlers on `close()` to avoid retaining closed sessions and accumulating listeners.

### 4.6 `2f9d3db` - Server-side queryBind

Problem: standalone `queryBind` had JS interpolation risk, `Session.queryBind` was unusable, and interpolation could not match ClickHouse parameter binding semantics.

Scenario: users write ClickHouse `{name:Type}` placeholders and get the same safe binding behavior across standalone, Session, sync, and async paths.

Implementation:

- Native path uses `chdb_query_with_params_n`.
- Standalone and Session both support parameters.
- Async bind reuses the same parameter formatting path.
- Parameter names and formatted values are passed to the C ABI with explicit lengths.

References:

- ClickHouse `{name:Type}` placeholders.
- chdb-python native parameter support.

Review feedback addressed:

- `Session.queryBind` behavior: it is now functional via server-side binding. This is the one intentional v2 behavior change; v2 tests changed from "throws" to "binding works".
- Robustness: `d65d75c` adds malformed parameter tests.
- Native error surfacing: `1d4ccc6` fixes a sync param path that could turn a null native result into an empty string instead of a typed error.
- Async concurrency: `08705d9` serializes parameterized async queries per connection.

### 4.7 `7e1fba6` - Async query core

Problem: v2 `query` blocks the event loop and only returns a string.

Scenario: Node servers, agents, and notebooks can `await` chDB queries, keep the event loop alive, and consume bytes/text/json/Arrow through one result model.

Implementation:

- `QueryAsyncWorker` runs `chdb_query_n` or `chdb_query_with_params_n` in the libuv worker pool.
- Returns `{ bytes, elapsed, rowsRead, bytesRead }`.
- JS wraps the response as `ChdbResult`.
- `ChdbResult` exposes `bytes()`, `text()`, `json()`, and `toArrow()`.

Cancellation policy:

- Abort/timeout races the native Promise and rejects early in JS.
- The native query still runs to completion because the current C ABI has no interrupt.
- Error messages are explicit about this limitation.

### 4.8 `28b76bd` - Insert via inline multi-row `VALUES`

Problem: some complex INSERT cases fall back to stdin and hang.

Scenario: JS applications can write in-memory small/medium batches without hitting stdin fallback.

Implementation:

- `buildInsertSQL` emits a single `INSERT INTO table (cols) VALUES (...), (...)`.
- Data is serialized inline.
- `insert` and `Session.insert` run asynchronously.
- Empty input returns a zero summary.
- Table and column identifiers are validated.

Policy:

- `undefined` is rejected; explicit `null` means SQL NULL.
- Current implementation is one SQL string, not chunked.
- Large/wide inserts remain a follow-up because local measurements showed serious RSS growth.

Review feedback addressed:

- Robustness: `d65d75c` adds malformed insert tests and rejects `undefined` instead of silently serializing it as NULL/default.
- Silent data loss: `1d4ccc6` rejects object rows that contain columns outside the inferred first-row column set, unless `columns` was explicitly provided as an intentional projection.
- Mixed row shapes: `1d4ccc6` rejects object/array batch mixing.

### 4.9 `8fc8ad4` - Streaming queries

Problem: large result materialization can consume too much memory; Node also needs AsyncIterable / Readable forms.

Scenario: users can consume large results chunk by chunk, and early break releases native resources.

Implementation:

- Native: `chdb_stream_query_n`, `chdb_stream_fetch_result`, `chdb_stream_cancel_query`, `chdb_destroy_query_result`.
- JS: `Session.queryStream(sql, opts)`.
- `ChdbQueryStream` implements `AsyncIterable<StreamChunk>`.
- `stream.rows()` flattens JSON row chunks.
- `stream.toReadable()` converts to a Node Readable.
- `stream.cancel()` releases native state.

Memory policy:

- Each native chunk is copied into a JS `Buffer`.
- The native chunk is destroyed immediately after the copy.
- Normal completion, early break, thrown errors, and explicit cancel all clean up.
- A Session allows only one active stream at a time.

### 4.10 `1d9ba05` - Arrow output

Problem: string/JSON output is expensive and loses type interoperability for data tooling.

Scenario: data tools can consume Arrow IPC bytes or an `apache-arrow` Table directly.

Implementation:

- `{ format: 'arrow' }` maps to ClickHouse `ArrowStream`.
- JS prefixes `SET output_format_arrow_compression_method='none';`.
- Async query returns raw IPC bytes.
- `toArrow()` lazily requires optional `apache-arrow`.

Current boundary:

- Copy-based IPC path only; JS owns bytes.
- Int64 can be read as bigint in the `apache-arrow` path.
- DateTime currently round-trips as uint32 seconds in the observed Arrow path.

Follow-ups:

- Zero-copy Arrow output.
- Arrow option knobs.
- 128/256-bit integer fixed_size_binary to bigint decode.
- Selectable compression.
- `stream.recordBatches()`.
- Arrow input / scan.

### 4.11 `b0df1b8` - Native loader

Problem: the old install path required local compilation, Python, node-gyp, and rpath fixes.

Scenario: end users load a platform package after `npm install`; source builds still work for developers.

Implementation:

- `loadNative()` first tries `@chdb/lib-<platform>`.
- Falls back to local `build/Release/chdb_node.node`.
- Unsupported platforms throw `ChdbPlatformUnsupportedError`.
- Present-but-unloadable subpackages throw `ChdbBinaryVersionMismatchError`.

Supported initial packages:

- `linux-x64-gnu`
- `linux-arm64-gnu`
- `darwin-x64`
- `darwin-arm64`

Out of scope:

- Windows, with WSL2 hint.
- musl, pending real demand.

### 4.12 `47d2399` - Per-platform subpackage builder

Problem: once the loader knows how to load `@chdb/lib-*`, release automation needs to create those packages from build artifacts.

Scenario: release workflow can publish native packages for Linux/macOS x64/arm64.

Implementation:

- Adds `scripts/build-platform-pkg.sh`.
- Generates `npm/@chdb/lib-<platform>`.
- Packages native addon plus libchdb artifact.

### 4.13 `9aa2660` - ESM dual export

Problem: existing users may use CommonJS, while modern TS/ESM users expect `import`.

Scenario: both `require('chdb')` and `import { query } from 'chdb'` work against the same Layer 1 surface.

Implementation:

- Keeps `index.js` as CJS.
- Adds `index.mjs` as an ESM view.
- Adds an exports map with `types`, `import`, and `require`.

Review follow-up:

- `9244db0` changes `index.mjs` to load CJS via `createRequire`, fixing Deno behavior where Node-style synthetic default import of `module.exports` is not available.

### 4.14 `bb55d94` - Distribution publish shape + CI + README

Problem: a feature that works from source is not enough; reviewers need to see the install, packaging, CI, and docs story.

Scenario: release publishes per-platform packages first, then the thin main package; cleanroom CI validates installed artifacts rather than repo source.

Implementation:

- `.github/workflows/chdb-node-test.yml`
- `.github/workflows/prebuild-publish.yml`
- `.github/workflows/sanitizer.yml` scaffold
- `scripts/smoke-e2e.mjs`
- README feature matrix

Review follow-up:

- `9244db0` pins the binary to released `chdb-core v26.5.0`, hardens downloads, fixes Deno smoke, and switches macOS x64 CI from retired `macos-13` to `macos-15-intel`.

### 4.15 `6b0053e` - In-code review context

Problem: comments that say "see design doc section X" are not useful in a public PR when the design doc is out-of-repo.

Scenario: reviewers can understand the trade-offs directly in GitHub diff.

Implementation:

- Removes external design-doc references from source comments.
- Makes lifecycle, binding, loader, serializer, and registry comments self-contained.
- Normalizes registry keys with `path.resolve`.
- Explains parameter scoping and temp-dir prefix choices.

### 4.16 `0f2c1e5` - Serialization performance pass + benchmark

Problem: once serialization safety is established, large strings should not pay for multiple full-string regex passes.

Scenario: reviewers can see that escaping is single-pass and that performance-sensitive paths have benchmark coverage.

Implementation:

- Replaces multi-pass string escaping with single-pass table-based escaping.
- Adds `bench/bench.js`.
- Benchmarks string escaping, recursive serialization, 10k-row insert, and 1M-row async materialization.

### 4.17 `d65d75c` - End-to-end + malformed-input robustness

Problem: isolated unit tests do not prove that features compose correctly, and they do not cover naive or hostile inputs.

Scenario: reviewers can verify that Layer 1 does not hang, crash, or silently write wrong values across realistic workflows.

Implementation:

- `test/v3/e2e.test.ts`: create -> insert -> queryBind -> async aggregate -> stream -> Arrow.
- `test/v3/robustness.test.ts`: hostile strings, backslashes, tab/newline, NUL, emoji, 1MB strings, unsafe integers, NaN/Infinity, undefined insert, wrong arity rows.
- Insert rejects `undefined`.

Review feedback addressed:

- Added Python-package-style end-to-end / installed-package validation via `scripts/smoke-e2e.mjs` and cleanroom CI.

### 4.18 `08705d9` - Param-query serialization + signal-handler lifecycle

Problem: deeper review of concurrency showed that `chdb_query_with_params` parameter state is connection-scoped. Two overlapping parameterized async queries on one connection can clobber parameters, producing wrong values or ClickHouse `456 Substitution not set`. Separately, opt-in signal handlers were registered with `process.once` but not removed on close, retaining closed sessions.

Scenario: non-parameterized async queries remain concurrent, but parameterized async queries on the same connection run in deterministic order. Signal-handler opt-in does not leak sessions or listeners.

Implementation:

- Each connection gets its own parameterized-query Promise chain.
- `queryBindAsync` and `Session.queryBindAsync` enter the chain.
- Non-parameterized queries remain concurrent.
- The chain advances on native completion, not on early JS abort/timeout.
- `close()` deregisters opt-in `SIGINT` / `SIGTERM` handlers.
- Adds `test/v3/async-stress.test.ts`.

Review feedback addressed:

- Refines the answer to "what happens with concurrent different params on the same connection": server-side params are per call at the API level, but the underlying C ABI still uses connection-scoped parameter state, so parameterized async queries must be serialized per connection.
- Fixes signal-handler lifecycle so closed sessions are not retained and listener counts return to baseline.

### 4.19 `1d4ccc6` - Swallowed query errors + insert data-loss guard + stricter identifiers

Problem: stress/review follow-up found three silent-failure risks:

- Native sync param path could turn a null `chdb_query_with_params` result into an empty string.
- Object-row insert could silently drop columns that appeared after the first row.
- Identifier validation allowed malformed names such as `.`, `a..b`, `.tbl`, and `tbl.`.

Scenario: wrong columns, bad identifiers, and native failures become typed errors rather than empty results, malformed SQL, or silent data loss.

Implementation:

- Native param sync path now sets an error message on null result.
- Insert rejects object rows with columns outside the inferred first-row column set unless `columns` is explicit.
- Insert rejects mixed object/array row batches.
- Identifier validation now requires non-empty dot-separated `[A-Za-z0-9_]+` segments.
- Adds insert and serialize regression tests.

Review feedback addressed:

- Strengthens the insert malformed-input story from "reject undefined" to "reject silent column loss".
- Tightens identifier safety from character-level whitelist to semantic segment validation.
- Ensures native param failures surface as typed JS errors.

### 4.20 `9244db0` - Pin libchdb to released chdb-core v26.5.0

Problem: the old release gate was `update_libchdb.sh` pointing at `v26.3.0`, while v3 server-side params and Arrow C ABI require a newer libchdb. PR #43 now uses released `chdb-core v26.5.0`.

Scenario: reviewers can evaluate v3 against a real published binary, not a local hand-built libchdb.

Implementation:

- `update_libchdb.sh`: `v26.3.0 -> v26.5.0`.
- Download hardening: `curl --fail --retry`, tar integrity check, `set -e`.
- `@chdb/lib-*` optional dependencies move from a `26.5.1` placeholder to `>=26.5.0`.
- `index.mjs` uses `createRequire`.
- macOS x64 runner switches from retired `macos-13` to `macos-15-intel`.
- Deno smoke uses a script file instead of removed `deno run -e`.

Review feedback addressed:

- The upstream libchdb release gate is now resolved to `v26.5.0`.
- v2 `24/24` and v3 `118/118` were verified against released macOS arm64 libchdb.
- Remaining release validation is tag workflow + four platform packages + thin main package.

### 4.20 Streaming insert: backpressure is flow-control, failures are typed errors (design for the §9.4 stream-input follow-up)

Problem: `Readable` stream input is the place Node observability tends to fall off. Backpressure, source stalls, and source errors silently degrade into hangs, unbounded memory growth, or an `unhandledRejection`. The current insert path is in-memory arrays only, so this section fixes the contract before the stream-input follow-up is implemented, not the code.

Scenario: an application pipes a large or un-sized `Readable` (CSV / NDJSON / object stream) into `insert({ values: stream })`, and the producer rate differs from the chDB write rate.

Backpressure is flow-control, not an error. The worker consumes the source with `for await (const row of stream)`, builds one bounded chunk (N rows / M bytes) at a time, and `await`s that chunk's `INSERT` before pulling more. While a chunk is in flight the source is naturally paused, so a fast producer is throttled to the chDB write rate and at most one chunk is buffered. A fast producer can never grow memory without bound. Normal backpressure never throws.

Backpressure-adjacent failures are typed errors, and never silent. They are wired through `stream.pipeline` / `finished` rather than a bare `.on('error')`, so a source error cannot escape as an `unhandledRejection`, and the returned Promise always settles:

| Failure | Surfaced as |
| --- | --- |
| source `Readable` emits `'error'` | `ChdbInsertError { reason: 'source-error', cause }` |
| producer stalls (no data, no `end`) past an idle deadline | `ChdbTimeoutError { reason: 'stall' }` |
| an un-pausable source pushes past the bounded buffer | `ChdbInsertError { reason: 'backpressure-overflow' }`, refusing to buffer unbounded rather than OOM the host process |
| a chunk's `INSERT` fails in the engine | `ChdbInsertError { reason: 'write-failure', failedAtRow, cause }`, and the remaining stream pull is aborted |
| `AbortSignal` fires mid-stream | `ChdbAbortError`; already-flushed chunks are not rolled back (documented) |

Observability:

- the returned `InsertSummary` accumulates `rows_written` / `bytes_read`;
- on failure the error carries progress so far (`rowsWritten` / `failedAtRow`);
- an optional `onProgress({ rowsWritten, bytesRead, chunks })` callback makes throughput and backpressure visible instead of a black box;
- the Promise always settles, by a normal resolve or one of the typed rejects above, never a silent hang.

Policy:

- This is the contract for the §9.4 `Readable` stream-input follow-up; the current in-memory array insert path is unaffected.
- Read-side streaming (`queryStream`) already provides the symmetric contract: `.cancel()` plus `ChdbStreamError` propagation.
- Tests land with the implementation in `test/v3/robustness.test.ts`: slow consumer keeps RSS at O(one chunk); `source-error`, `stall`, `backpressure-overflow`, `write-failure`, and `abort` each assert the typed error above; `onProgress` is invoked and the error carries `rowsWritten`.

## 5. API Surface Snapshot

Current public Layer 1 API:

```ts
export function query(query: string, format?: string): string
export function queryBind(query: string, args: object, format?: string): string

export function queryAsync(query: string, opts?: QueryOptions): Promise<ChdbResult>
export function queryBindAsync(query: string, params: object, opts?: QueryOptions): Promise<ChdbResult>
export function insert(params: InsertParams): Promise<InsertSummary>

export class Session {
  constructor(path?: string, opts?: SessionOptions)
  get open(): boolean
  query(query: string, format?: string): string
  queryBind(query: string, args: object, format?: string): string
  queryAsync(query: string, opts?: QueryOptions): Promise<ChdbResult>
  queryBindAsync(query: string, params: object, opts?: QueryOptions): Promise<ChdbResult>
  insert(params: InsertParams): Promise<InsertSummary>
  queryStream(query: string, opts?: StreamOptions): ChdbQueryStream
  close(): void
  cleanup(): void
  [Symbol.dispose](): void
}

export function version(): {
  chdb: string
  libchdb: string
  platform: string
  arch: string
  napi?: number
}
```

Not public in the current implementation:

```ts
registerArrowTable(...)
unregisterArrowTable(...)
closeAsync()
[Symbol.asyncDispose]()
stream.recordBatches()
```

These are follow-ups, not current PR requirements.

## 6. Test Design and Evidence

### 6.1 Test layers

| Layer | Command / files | Purpose |
| --- | --- | --- |
| v2 compatibility | `npm run test`, `test_basic.js`, `test_connection.js` | Ensure old APIs are not broken. |
| v3 unit + integration | `npm run test:v3`, `test/v3/*.test.ts` | Covers async, bind, insert, stream, Arrow, lifecycle, registry, errors, robustness, async stress. |
| all | `npm run test:all` | v2 + v3. |
| e2e smoke | `scripts/smoke-e2e.mjs` | Runs query/queryBind/session/insert/stream from an installed package. |
| cleanroom | `.github/workflows/chdb-node-test.yml` cleanroom job | Packs main + platform package, installs them into a fresh project, then runs e2e. |
| runtime smoke | CI `runtimes` job | Bun / Deno can load the N-API binary and run `SELECT 1`. |
| sanitizer scaffold | `.github/workflows/sanitizer.yml` | Experimental ASan/UBSan workflow, currently allowed to fail. |

### 6.2 Functional coverage by feature

| Feature | Main tests |
| --- | --- |
| errors | `errors.test.ts`, `registry.test.ts` |
| serializer | `serialize.test.ts`, `robustness.test.ts` |
| queryBind | `querybind.test.ts`, `async.test.ts`, `robustness.test.ts` |
| async query | `async.test.ts`, `e2e.test.ts`, `async-stress.test.ts` |
| insert | `insert.test.ts`, `e2e.test.ts`, `robustness.test.ts` |
| streaming | `stream.test.ts`, `e2e.test.ts` |
| Arrow output | `arrow.test.ts`, `e2e.test.ts` |
| lifecycle / cleanup | `lifecycle.test.ts` |
| connection registry | `registry.test.ts` |
| loader | `loader.test.ts` |

### 6.3 Robustness policy

`test/v3/robustness.test.ts` is not trying to define ClickHouse semantics for every odd input. It checks the binding contract:

- Do not hang.
- Do not crash.
- Do not silently write wrong values.
- Either bind as inert data or throw a typed chDB error.

Examples covered:

- hostile strings such as `"'; DROP TABLE x; --"`
- backslashes
- tabs/newlines
- NUL bytes
- emoji
- 1MB strings
- unsafe integers, NaN, Infinity
- undefined insert values
- wrong-arity positional rows

### 6.4 Current test status

PR #43 latest commit was verified against released macOS arm64 `chdb-core v26.5.0`:

- v2 suite: `24/24`
- v3 suite: `118/118`

CI interpretation:

- Workflow structure is aligned with the final publish shape.
- The upstream libchdb release gate is resolved by `9244db0`.
- Real npm publish still needs the tag workflow to validate four `@chdb/lib-*` packages plus the thin main package.

## 7. Performance Evaluation

### 7.1 Benchmark entry point

Current branch includes `bench/bench.js`, which measures:

- 100KB string escaping
- large array/object serialization
- 10k-row insert build + execute
- 1M-row async CSV materialization

This is an indicative benchmark, not a CI gate. Its purpose is to make hot paths visible to reviewers.

### 7.2 Local follow-up measurements

From local `FOLLOWUPS.md`, darwin-arm64 / in-memory engine:

| Path | Summary |
| --- | --- |
| small/frequent queries | sync around `0.11 ms`, async around `0.13 ms`; overhead is negligible. |
| string escaping | 100KB heavy string around `~1 ms`; acceptable per query/insert. |
| result materialization | 5M rows around `25-37 ms / 37 MB`; linear and predictable. |
| large/wide insert | `1,000,000 rows x 10 cols` around `+636 MB RSS / ~825 ms`; serious regression risk, needs chunk/binary path. |
| Arrow export | Current default is uncompressed IPC; memory/bytes can be around 2x lz4, but JS `apache-arrow` can read it directly. |
| full materialization | Large results occupy JS heap; large reads should prefer streaming. |

### 7.3 Perf trade-off reviewers should notice

This PR intentionally chooses correctness first:

- Async query, Arrow, and streaming all copy into JS-owned buffers.
- This avoids UAF and makes lifetimes reviewable.
- Zero-copy Arrow, binary insert, prepared caches, and memory pools remain follow-ups.

## 8. Issue / Design Traceability

| Problem / issue | Implementation area | Status |
| --- | --- | --- |
| v2 `Session.queryBind` unusable | `index.js`, `lib/chdb_node.cpp` | Fixed; Session and standalone both use server-side bind. |
| queryBind backslash injection risk / #40 | `src/serialize.ts`, native params path | Fixed by moving from SQL interpolation to engine bind; serializer remains for insert and param transport. |
| insert hang / #26 / chdb#152 | `src/insert.ts`, `index.js` | Fixed with inline `VALUES`; large insert performance remains follow-up. |
| cleanup deletes user dir / #30 | `index.js` `#removeTempDir()` | Fixed with safety gates. |
| repeated start/stop crash / #17 | native registry + close hooks | Mitigated by registry/refcount/exit cleanup; thread-safety follow-up remains. |
| streaming missing / #31 | `StreamQuery`, `StreamFetch`, `ChdbQueryStream` | Implemented chunk streaming. |
| empty result error / #20 | `emptyResult()` / typed result handling | Empty async result returns an empty `ChdbResult`. |
| install fragility | loader + subpackages + CI | Structure implemented; released `chdb-core v26.5.0` pinned; tag/subpackage validation remains. |
| async param query race | `index.js`, `test/v3/async-stress.test.ts` | Parameterized async queries are serialized per connection. |
| opt-in signal handler leak | `index.js`, `lifecycle.test.ts` | `close()` deregisters handlers. |
| silent insert data loss | `src/insert.ts`, `insert.test.ts` | Rows with unexpected inferred columns are rejected; explicit `columns` remains projection. |
| malformed identifier | `src/serialize.ts`, `serialize.test.ts` | Identifier validation now requires non-empty dot-separated segments. |
| released libchdb gate | `update_libchdb.sh`, `package.json`, CI | Pinned to public `chdb-core v26.5.0` with hardened download. |

## 9. Layer 1 Follow-ups

### 9.1 Release gating

High priority:

- Run the tag workflow to publish and validate all four `@chdb/lib-*` platform packages plus the thin main package.
- Keep the cleanroom job green against the real published package combination.

Low priority:

- Link relevant issues in PR/squash description: #26, #30, #31, #40.
- Remove internal design numbering from final squash messages.

### 9.2 Arrow output finish

High priority:

- True zero-copy Arrow output: engine buffer -> external ArrayBuffer, with release callback tied to V8 GC.

Medium priority:

- Arrow knobs such as `unsupported_as_binary=0`, `low_cardinality_as_dictionary`, `string_as_string`.
- 128/256-bit integer fixed-size-binary to bigint decode.
- Selectable Arrow compression.
- `stream.recordBatches()`.

### 9.3 Arrow input / scan

Medium priority:

- `registerArrowTable` over `chdb_arrow_scan` / `chdb_arrow_array_scan`.
- Normalize object arrays, Arrow tables, TypedArrays, or Readable streams into Arrow IPC for engine scan.

### 9.4 Insert finish

High priority:

- Chunk large inserts. Current inline `VALUES` has OOM risk for large/wide batches.

Medium priority:

- Binary insert path: Arrow -> engine Block.
- `Readable` stream input. Must meet the backpressure and observability contract in §4.20: honor backpressure via `for await` plus a bounded single-chunk buffer; surface source-error / stall / backpressure-overflow / write-failure / abort as typed errors wired through `stream.pipeline`; expose progress via `InsertSummary` and an optional `onProgress`.

### 9.5 Streaming finish

Medium priority:

- Actually enforce `maxBatchSize`.

Low priority:

- Zero-copy chunk views.

### 9.6 Concurrency / cancellation / memory safety

High priority:

- Thread-safety hardening: single-process connection plus async-worker / registry model needs TSan and a clear policy.

Low priority:

- True query interrupt, depending on upstream C ABI.
- Symlink-level path canonicalization.

### 9.7 Distribution / CI / docs

Medium priority:

- Turn sanitizer workflow from scaffold into release gate.
- Keep cleanroom green after real subpackage publish.
- Full suite under Bun and Deno.
- Update org-level binding feature matrix, honestly marking Arrow scan/input and zero-copy as incomplete.
- Add README performance guidance for large insert batches, large read streaming, and uncompressed Arrow memory trade-off.

Low priority:

- Minimum glibc baseline smoke.
- musl / Windows remain out of scope.

### 9.8 Deferred IO optimizations

These are Layer 1 native foundation optimizations. Layer 2 and Layer 3 will inherit them, but they do not block current Layer 1 review:

- Prepared statement cache, requiring upstream `chdb_prepare` / `chdb_execute_prepared`.
- Bulk insert optimizer, requiring upstream `chdb_insert_binary` or equivalent wrapper.
- Result memory pool.
- Session-aware pool.

## 10. Suggested Reviewer Reading Order

1. Read `src/errors.ts`, `src/serialize.ts`, `src/insert.ts`, and `src/result.ts` to confirm JS contracts.
2. Read `index.d.ts` to confirm public API and missing/follow-up APIs are not exposed.
3. Read `index.js` to see how JS APIs compose native functions.
4. Read `lib/chdb_node.cpp`, focusing on registry, params, AsyncWorker, and stream lifecycle.
5. Read `test/v3/*.test.ts` to confirm the behavior contract by feature.
6. Read loader / CI / publish workflows to confirm install and distribution shape.

Reviewers do not need to treat every native diff line as an independent design decision. Most changes map back to the commit-ordered feature and review-fix blocks above.
