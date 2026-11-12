# Arrow with chdb in Node.js

The direct Arrow APIs let you query in-memory Arrow data, read typed results,
and insert batches without Arrow IPC. They are implemented in [PR #104](https://github.com/chdb-io/chdb-node/pull/104)
against chdb-core v26.11.0-rc.3; the matching npm platform packages are not
published yet. Once released, install both `chdb` and its optional peer:

```sh
npm install chdb apache-arrow
```

## Choose a path

| Task | API | Result |
| --- | --- | --- |
| Query an Arrow `Table` or `RecordBatch` | `registerArrowSource` + `arrowstream(name)` | SQL result in your chosen format |
| Feed batches as they arrive | `registerArrowReader` + `arrowstream(name)` | One-shot SQL source |
| Read a small typed result | `session.queryArrow(sql)` | `apache-arrow` `Table` |
| Read a large typed result | `session.queryArrowStream(sql)` | Async iterable of `RecordBatch` |
| Insert a table or a batch | `insertArrow(table, input, { session })` | Insert summary |
| Insert a batch iterable | `insertArrowReader(table, source, { session })` | Insert summary |

The existing `queryAsync(sql, { format: 'arrow' }).toArrow()` still uses Arrow
IPC. The direct APIs use Arrow C Data/C Stream instead; **direct is not an
end-to-end zero-copy guarantee**. chdb may copy input while converting columns,
and Node copies output buffers before releasing the native result.

## Query an in-memory Arrow table

```js
import { Session, registerArrowSource } from 'chdb'
import { Table, Int32, vectorFromArray } from 'apache-arrow'

const session = new Session()
const input = new Table({ id: vectorFromArray([1, 2, 3], new Int32()) })
const source = registerArrowSource(input, { session }) // unique, opaque name
try {
  const sql = `SELECT sum(id) FROM arrowstream('${source.name}')`
  console.log((await session.queryAsync(sql, { format: 'CSV' })).text()) // 6

  // A materialized source is consumed by a scan. Refresh only after the
  // previous query has completed, before using it in another query.
  source.refresh()
  console.log((await session.queryAsync(sql, { format: 'CSV' })).text()) // 6
} finally {
  source.close()
  session.close()
}
```

`registerArrowTable(name, input, { session })` is available when you need to
choose the name. Names are process-wide; prefer generated names unless you have
a reason to coordinate them. Close the registration after the last scan. If a
query or lazy stream is active, unregister and buffer release are deferred
until that scan finishes or is cancelled.

## Insert Arrow data

```js
import { Session, insertArrow, insertArrowReader } from 'chdb'
import { Table, Int32, vectorFromArray } from 'apache-arrow'

const session = new Session()
try {
  await session.queryAsync('CREATE TABLE events (id Int32) ENGINE=Memory')
  const input = new Table({ id: vectorFromArray([1, 2], new Int32()) })
  await insertArrow('events', input, { session })

  async function* batches() {
    yield new Table({ id: vectorFromArray([3], new Int32()) }).batches[0]
    yield new Table({ id: vectorFromArray([4], new Int32()) }).batches[0]
  }
  const summary = await insertArrowReader('events', batches(), { session })
  console.log(summary.rowsSubmitted) // 2; not a storage-side commit ledger
} finally {
  session.close()
}
```

Destination fields are matched by name, not table position. Both insert
functions unregister their temporary source on success or error. For a custom
SQL transform over an incoming reader, register it with
`await registerArrowReader(batches(), { session })`, query
`arrowstream(handle.name)` once, then `await handle.close()` in `finally`.
The native queue holds at most two batches not yet handed to
core; producing another waits for capacity. Core can retain delivered batches,
so this is not a bound on the entire query's memory. A cancelled producer
should cooperate with iterator `return()` to release its own resources.

## Read typed results

```js
import { Session } from 'chdb'

const session = new Session()
try {
  const small = await session.queryArrow('SELECT toInt32(number) AS id FROM numbers(3)')
  console.log(small.toArray().map(row => row.id)) // [0, 1, 2]

  const reader = session.queryArrowStream('SELECT toInt32(number) AS id FROM numbers(1000)')
  try {
    for await (const batch of reader) {
      console.log(batch.numRows)
      // Stop early if needed.
    }
  } finally {
    reader.cancel()
  }
} finally {
  session.close()
}
```

Use `queryArrowBind` and `queryArrowStreamBind` for server-side
`{name:Type}` parameters, for example
`await session.queryArrowBind('SELECT {id:Int32} AS id', { id: 7 })`.
For TypeScript return types without making the base `chdb` import require
`apache-arrow`, use the helpers from `chdb/arrow`.

## Limits and errors

- The direct path requires a loaded chdb-core >= v26.11.0-rc.3; an older
  binary raises `CHDB_ABI`. Installing `apache-arrow` alone does not upgrade
  the native platform package.
- Supported input includes primitive scalars, Boolean, UTF-8/Binary,
  Timestamp, Decimal128/256, slices, null bitmaps, and a single-chunk
  dictionary of UTF-8/Binary values with Int32/UInt32 indices. Nested input
  and multi-chunk dictionaries are rejected rather than silently converted.
- Supported output includes basic scalars, Timestamp, Decimal128/256, and
  LowCardinality UTF-8/Binary dictionaries. Options include
  `stringAsString`, `lowCardinalityAsDictionary`, and `unsupportedAsBinary`;
  without the latter, unmappable types fail rather than silently falling back
  to IPC. See [validated type scope](arrow-rc3-conformance.md).
- Keep each `Session` open until its scans and readers finish. Cancel a
  partially consumed output reader, close input registrations, and await
  input reader cleanup. Error paths release the native handles.

For the thread and ownership model, see the [Node Arrow design](design/native-arrow.md).
