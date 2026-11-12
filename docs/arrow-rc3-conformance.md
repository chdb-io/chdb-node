# Native Arrow A1–A6 against chdb-core v26.11.0-rc.3

The development baseline is the `macos-arm64-libchdb.tar.gz` asset from
`v26.11.0-rc.3` (SHA-256 `7b0ea049efcf75a851e744c7d74325d7a9b143227f9b72097e5df252564e3d58`).
The release tag is #323's merge commit `574f212fb5ee`. The manifest and
lockfile target `@chdb/lib-*` version `26.11.0-rc.3.1`, but those npm packages
have **not yet been published**. npm omitted their package metadata from the
lockfile; regenerate it after publication to capture `resolved` and `integrity`.
The local macOS arm64 tests used the official rc.3
tarball with the previous ignored `libchdb.so` backed up under
`/tmp/chdb-node-rc3-verify/`. A cleanroom install from locally packed main and
arm64 subpackage tarballs passed `smoke-arrow-e2e.mjs`. The other three
platforms and registry-installed packages remain CI/release gates.

The shared contract is `chdb-core/docs/NATIVE_ARROW_BINDING_CONTRACT.md`. In
this binding, **direct** means C Data/C Stream without Arrow IPC. Input and
output may copy buffers; no end-to-end zero-copy claim is made.
For application examples see the [Arrow guide](arrow.md); for the bounded
queue and release sequence see the [Node Arrow design](design/native-arrow.md).
The optional `chdb/arrow` subpath supplies TypeScript `Table`/`RecordBatch`
return types without making the base `chdb` entry require `apache-arrow`.

| Capability | Implemented now | Further validation / documented scope |
| --- | --- | --- |
| A1 SQL source | `registerArrowTable` accepts supported column descriptors, `RecordBatch`, and materialized multi-batch `Table`; C Stream callbacks use pinned JS buffers. `registerArrowSource` generates opaque process-unique names. Primitive, Timestamp, Decimal128/256, sliced buffers/bitmaps, and one-chunk Dictionary<Int32/UInt32, Utf8/Binary> input are tested. Borrowed sources cannot coexist with a Session in another Node isolate. | Nested types and multi-chunk dictionary input explicitly reject; more platform/isolate stress remains. |
| A2 reader source | `registerArrowReader` accepts sync/async RecordBatch iterables. The JS producer awaits capacity in a two-batch native queue; worker-thread `get_next` never calls JS. Empty schema, producer error, schema mismatch, cancellation, one-release-per-delivered-batch, one-shot behavior and worker-isolate teardown are tested. | ASan/RSS stress and platform matrix. Core may retain batches after pulling them (e.g. sorting); queue capacity counts only batches not yet handed to core. `close()` cancels native promptly even if a user producer never resolves `next()`; that producer must cooperate to release its own resources. |
| A3 typed result | `Session.queryArrow` calls `chdb_query_arrow_n`, copies C buffers before release, and constructs an `apache-arrow.Table`; `queryArrowBind` materializes the bound A4 stream. Empty schema and SQL errors tested. | Nested types and large-result memory stress. |
| A4 typed batches | `Session.queryArrowStream` pulls C Data per batch; `queryArrowStreamBind` uses `chdb_stream_query_arrow_with_params_n` with server-side binding. Early-break, in-flight cancel and bound values are tested. | Nested types, repeated cancellation and memory stress. |
| A5 bulk insert | `insertArrow` handles materialized batches; `insertArrowReader` uses A2's bounded source. Both map destination fields by name and use engine-side `INSERT … SELECT`. | Storage-side write ledger (current `rowsSubmitted` is only the input count), settings/mapping matrix and cancellation under write load. |
| A6 ABI/types | New direct Arrow paths verify the loaded `EngineVersion()` is at least `v26.11.0-rc.3` and reject older builds with `CHDB_ABI`. Basic numeric, Bool, Utf8, Binary, Timestamp, Decimal128/256 and LowCardinality Utf8/Binary dictionary output are mapped. `unsupportedAsBinary` is tested for an otherwise unsupported AggregateFunction; IPC `toArrow()` remains unchanged. | Four-platform build/runtime CI; publish all four rc.3 npm packages and regenerate the lockfile afterwards. Additional nested/type-option cases are outside this supported subset. |

## Core ownership regression and release follow-up

rc.2 predates `chdb-core#323`, which is included in rc.3. Core issues
[`#321`](https://github.com/chdb-io/chdb-core/issues/321) and
[`#322`](https://github.com/chdb-io/chdb-core/issues/322) already record its
`get_schema` release and failed array-registration wrapper leaks. Do not open
duplicate issues. The previously conditional registration-schema release test
now runs unconditionally on rc.3. An ASan/RSS *failed-registration leak budget*
is still a future stress gate, not a test claimed here. Node's own close/eviction
path unregisters from core before dropping pinned buffers.

If another **new** rc.3 core defect appears: keep a small reproducer, file a
core issue before designing around its proposed fix, link the issue from a
clearly skipped/conditional test, and describe the required follow-up. Filing
an issue is a remote write and requires separate per-action confirmation; other
local implementation and unaffected tests can continue meanwhile.
