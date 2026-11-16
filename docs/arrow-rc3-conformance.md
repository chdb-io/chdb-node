# Historical Arrow validation against chdb-core v26.11.0-rc.3

This is a pre-release snapshot, not the current status of npm packages or
platform validation. For the released `chdb@3.6.0` and `v26.11.1` engine, see
the [current Arrow release validation](arrow-release-validation.md).

The development baseline is the `macos-arm64-libchdb.tar.gz` asset from
`v26.11.0-rc.3` (SHA-256 `7b0ea049efcf75a851e744c7d74325d7a9b143227f9b72097e5df252564e3d58`).
At the time of this snapshot, the manifest targeted `@chdb/lib-*`
`26.11.0-rc.3.1` and the packages had not yet been published. The local
macOS arm64 tests used the official rc.3 tarball with the previous ignored
`libchdb.so` backed up under `/tmp/chdb-node-rc3-verify/`. A cleanroom install from locally packed main and
arm64 subpackage tarballs passed `smoke-arrow-e2e.mjs`. The other three
platforms and registry-installed packages were then outstanding release gates.

The shared contract is the [rc.3 core native Arrow binding contract](https://github.com/chdb-io/chdb-core/blob/v26.11.0-rc.3/docs/NATIVE_ARROW_BINDING_CONTRACT.md). In
this binding, **direct** means Arrow's in-memory C Data/C Stream interfaces
without Inter-Process Communication (IPC) serialization. Input and output
may copy buffers; no end-to-end zero-copy claim is made. An Arrow schema names
the columns and their types; a batch holds a group of rows in columnar form.
Below, ABI means application binary interface, CI means continuous-integration
tests, ASan means AddressSanitizer, and RSS is the process's resident memory use.
For application examples see the [Arrow guide](arrow.md); for the bounded
queue and release sequence see the [Node Arrow design](design/native-arrow.md).
The optional `chdb/arrow` subpath supplies TypeScript `Table`/`RecordBatch`
return types without making the base `chdb` entry require `apache-arrow`.

| Capability | Implemented at the rc.3 snapshot | Outstanding at the rc.3 snapshot / documented scope |
| --- | --- | --- |
| In-memory SQL source | `registerArrowTable` accepts supported column descriptors, `RecordBatch`, and materialized multi-batch `Table`; C Stream callbacks use pinned JS buffers. `registerArrowSource` generates opaque process-unique names. Primitive, Timestamp, Decimal128/256, sliced buffers/bitmaps, and one-chunk Dictionary<Int32/UInt32, Utf8/Binary> input are tested. Borrowed sources cannot coexist with a Session in another Node isolate. | Nested types and multi-chunk dictionary input explicitly reject; more platform/isolate stress remains. |
| Reader as SQL source | `registerArrowReader` accepts sync/async RecordBatch iterables. The JS producer awaits capacity in a two-batch native queue; worker-thread `get_next` never calls JS. Empty schema, producer error, schema mismatch, cancellation, one-release-per-delivered-batch, one-shot behavior and worker-isolate teardown are tested. | ASan/RSS stress and platform matrix. Core may retain batches after pulling them (e.g. sorting); queue capacity counts only batches not yet handed to core. `close()` cancels native promptly even if a user producer never resolves `next()`; that producer must cooperate to release its own resources. |
| Complete typed result | `Session.queryArrow` calls `chdb_query_arrow_n`, copies C buffers before release, and constructs an `apache-arrow.Table`; `queryArrowBind` materializes the bound incremental result. Empty schema and SQL errors tested. | Nested types and large-result memory stress. |
| Typed result batches | `Session.queryArrowStream` pulls C Data per batch; `queryArrowStreamBind` uses `chdb_stream_query_arrow_with_params_n` with server-side binding. Early-break, in-flight cancel and bound values are tested. | Nested types, repeated cancellation and memory stress. |
| Bulk insert | `insertArrow` handles materialized batches; `insertArrowReader` uses the bounded reader source described above. Both map destination fields by name and use engine-side `INSERT … SELECT`. | Storage-side write ledger (current `rowsSubmitted` is only the input count), settings/mapping matrix and cancellation under write load. |
| Engine compatibility and types | New direct Arrow paths verify the loaded `EngineVersion()` is at least `v26.11.0-rc.3` and reject older builds with `CHDB_ABI`. Basic numeric, Bool, Utf8, Binary, Timestamp, Decimal128/256 and LowCardinality Utf8/Binary dictionary output are mapped. `unsupportedAsBinary` is tested for an otherwise unsupported AggregateFunction; IPC `toArrow()` remains unchanged. | Four-platform build/runtime CI; publish all four rc.3 npm packages and regenerate the lockfile afterwards. Additional nested/type-option cases are outside this supported subset. |

## Core ownership regression and release follow-up

Core rc.2 could leak a returned schema or a wrapper when Arrow registration
failed. The rc.3 engine fixes both ownership paths. The registration-schema release test
now runs unconditionally on rc.3. An ASan/RSS *failed-registration leak budget*
is still a future stress gate, not a test claimed here. Node's own close/eviction
path unregisters from core before dropping pinned buffers.
