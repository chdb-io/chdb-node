# AGENT.md — working on chdb-node

Orientation and gotchas for agents (and humans) editing this repo. Pairs with
`README.md` (user-facing) and `docs/design/` (architecture).

## Layered surface

- **Layer 1** — `index.js` (CommonJS entrypoint): the process-wide session,
  `queryAsync` / `queryBindAsync` (server-side parameter binding), `Session`,
  inserts, `queryStream`, and the native addon bindings. It owns the
  pending-op and session registries.
- **Layer 3** — `src/layer3/` (TypeScript fluent builder): compiles a chain to
  `{ sql, parameters }` and forwards execution to Layer 1. **It never touches
  the native addon directly** and never puts values into SQL text — values are
  pre-serialized and bound server-side (`runtime.ts`). Keep that invariant.

### One connection per process

libchdb allows exactly **one active data directory per process**. All v3 tests
share a single fork and run serially (`vitest.config.ts`); a leaked session
cascades into unrelated files. The global `afterEach` in `test/v3/setup.ts`
force-closes anything a test left open. Every importer must share one `index.js`
instance — that's why vitest externalizes `…/index.js` imports.

## Arrow input — `registerArrowTable` lifecycle

`registerArrowTable(name, columns, { session })` pins JS columnar data as an
`arrowstream('<name>')` table the engine scans with zero IPC copy
(`src/layer3/execute/arrow-input.ts`). The native side holds the JS buffers via
`Napi::Reference` until the table is unregistered.

**Always `close()` the handle — ideally in `try/finally`:**

```ts
const t = registerArrowTable('events', [
  { name: 'id', type: 'Int32', data: new Int32Array([1, 2, 3]) },
])
try {
  const rows = await selectFrom(chTable.arrowstream('events').as('e'))
    .select('id').execute()
} finally {
  t.close()   // releases the native-side buffer pins
}
```

- **Single-pass semantics.** The engine consumes the underlying Arrow array on
  each scan, so a *second* query against the same handle reads zero rows. Call
  `t.refresh()` between repeated reads of the same data, or build a new handle
  per query.
- **GC safety net (best-effort, non-deterministic).** A handle dropped without
  `close()` is unregistered by a `FinalizationRegistry` fallback so native stops
  pinning its buffers. This is *not* a substitute for `close()`: the JS spec
  gives no guarantee finalizers run at all (or when). Treat it purely as a
  backstop against forgotten handles, and still `close()` explicitly.
- A long-lived `session` that registers tables in a loop **without** closing
  them grows memory monotonically — the connection only sweeps registrations on
  close.

## Streaming large results — follow-up, not yet shipped

`.execute()` buffers the whole result (peak ≈ 3–4×N for the row view). For very
large result sets a lazy `.stream()` terminal on the SELECT builder is the right
tool, but it is **deliberately not in the builder yet**:

- Layer 1 streaming (`queryStream` → `query_conn_streaming_n`) has **no params
  argument**, so a streaming terminal could not bind parameters server-side
  without either throwing on bound queries (a footgun shaped by a temporary ABI
  gap) or rendering literals into SQL text (violates the no-values-in-SQL
  invariant).
- The clean fix is upstream: add server-side binding to the streaming C ABI,
  then build `.stream()` once with the same safety as `.execute()`. Tracked as a
  follow-up; don't add a half-feature in the meantime.

When `.stream()` does land, document here: when to prefer it over `.execute()`,
the async-iterator usage, and that a session allows only one active stream at a
time.

## Build & test

- **TypeScript only** (Layer 3, the common case): `npm run build:ts`, then
  `npm run test:v3` (`vitest run`).
- **Native addon** (anything under `lib/`, or running the Arrow tests, which
  exercise the real addon): rebuild with `npm run build` (`node-gyp configure
  build` + `fixloaderpath` + `build:ts`). Use the repo's node-gyp, not a global
  one. `test/v3/layer3/arrow-input.test.ts` needs the rebuilt addon.
- The GC fallback test needs `--expose-gc`; it's wired via `execArgv` in
  `vitest.config.ts` and self-skips if unavailable.
- Legacy v2 byte-compat tests stay on mocha (`npm test`) as the untouched
  regression anchor.

## Conventions

Commit/PR titles: capitalized imperative verb, **no prefix tags** (ClickHouse
style) — e.g. `Add a FinalizationRegistry safety net for Arrow input`, not
`feat: …`.
