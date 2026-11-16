# Direct Arrow release validation for chdb 3.6.0

`chdb@3.6.0` pins chdb-core `v26.11.1` through the four platform packages
`@chdb/lib-{darwin-arm64,darwin-x64,linux-arm64-gnu,linux-x64-gnu}@26.11.1-stable.1`.
Install the optional `apache-arrow` peer to use typed Arrow objects:

```sh
npm install chdb@3.6.0 apache-arrow
```

The [v26.11.1 native Arrow binding contract](https://github.com/chdb-io/chdb-core/blob/v26.11.1/docs/NATIVE_ARROW_BINDING_CONTRACT.md)
defines direct C Data/C Stream transfer, ownership, and compatibility. "Direct"
excludes Arrow IPC serialization at the binding boundary; it does **not** promise
end-to-end zero-copy. Node copies output buffers before releasing the C result.
The older `queryAsync(sql, { format: 'arrow' }).toArrow()` remains an IPC route.

| User capability | Node API and behavior |
| --- | --- |
| Query an in-memory table or batch | `registerArrowSource` (or named `registerArrowTable`) supplies `arrowstream(name)` and a closable registration. Refresh a materialized source before a second scan. |
| Query a one-shot batch producer | `registerArrowReader` accepts sync/async `RecordBatch` iterables. Await registration, query asynchronously, and await `close()`; its native queue bounds batches not yet handed to core. |
| Read a complete typed result | `Session.queryArrow` / `queryArrowBind` return an `apache-arrow.Table` without an IPC conversion. |
| Pull typed result batches | `Session.queryArrowStream` / `queryArrowStreamBind` yield `RecordBatch` values. Cancel a partially consumed result. |
| Insert batches | `insertArrow` accepts a batch or materialized multi-batch table; `insertArrowReader` consumes an iterable. Both map destination columns by name and use engine-side `INSERT … SELECT`. `rowsSubmitted` counts input rows, not committed storage rows. |
| Reject incompatible paths | Direct APIs check the loaded engine (minimum `v26.11.0-rc.3`) and return `CHDB_ABI` for older builds. Unmappable types error unless an explicit binary option is chosen; IPC is not silently substituted. |

Registration names are process-wide. A registration's callbacks and borrowed
buffers stay alive while a scan or lazy result is active; closing during a scan
defers unregister and release until query cleanup. Borrowed Arrow sources cannot
coexist with a Session in another Node isolate. Input readers are one-shot and
their producers must cooperate with cancellation to release their own resources.
See the [Node Arrow guide](arrow.md) for examples and the supported type subset.
Nested input and multi-chunk dictionary layouts are explicitly rejected;
large-result memory stress and an AddressSanitizer/resident-memory leak budget
are not claimed as completed validation.

## Release evidence

- The [core v26.11.1 compatibility run](https://github.com/chdb-io/chdb-node/actions/runs/43935462757)
  passed against the released engine on Linux x64/arm64 and macOS x64/arm64.
- The [Node v3.6.0 publication and verification run](https://github.com/chdb-io/chdb-node/actions/runs/43960573434)
  completed with all 20 jobs successful on its failed-job rerun. The four native
  packages and main package were already published in the first attempt;
  several early clean installs had skipped optional native packages while npm
  processed them. Fresh verification jobs then passed on all four platforms
  with Node 18/20/22, plus Debian bookworm on both Linux architectures.
- The installed-package checks load `chdb` by package name, verify the exact
  native subpackage, and run both the ordinary install tests and
  [`smoke-arrow-e2e.mjs`](https://github.com/chdb-io/chdb-node/blob/v3.6.0/scripts/smoke-arrow-e2e.mjs).
  The smoke covers an in-memory dictionary source, typed and bound output,
  incremental batches, reader-backed insert, and a dictionary result option.
  The [direct Arrow](https://github.com/chdb-io/chdb-node/blob/v3.6.0/test/v3/arrow-direct.test.ts)
  and [input/reader/insert](https://github.com/chdb-io/chdb-node/tree/v3.6.0/test/v3/layer3)
  tests cover empty schemas, multiple batches, release counts, errors,
  cancellation, and deferred cleanup.

The earlier [rc.3 validation](https://github.com/chdb-io/chdb-node/blob/v3.6.0/docs/arrow-rc3-conformance.md)
is retained as a historical snapshot, not as a statement of the current
published package status.
