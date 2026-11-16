---
name: chdb-arrow
description: Choose chdb-node direct Arrow, serialized Arrow, or standard driver routes for apache-arrow tables, async batch sources, typed results, or bulk insert. Not for ordinary SQL or fluent queries.
---

# Node Arrow path selection

Arrow Inter-Process Communication (IPC) is a serialized byte format; the direct API exchanges typed Arrow batches with the native engine instead. Arrow Database Connectivity (ADBC) is a separate standard driver API. A `RecordBatch` is a typed group of columnar rows.

- For an `apache-arrow.Table` / `RecordBatch` as a temporary SQL source, use `registerArrowSource(input, { session })` and query `arrowstream('${source.name}')`; close the source in `finally`. For a one-shot sync/async batch iterable, `await registerArrowReader(iterable, { session })` and later `await handle.close()`. Use async queries while a JS producer refills the native queue.
- Typed results: `await session.queryArrow(sql)` returns a whole `Table`; `session.queryArrowStream(sql)` yields batches via `for await` and needs `reader.cancel()` if stopped early. Bulk insert: `await insertArrow(table, input, { session })` or `await insertArrowReader(table, iterable, { session })`.
- `queryAsync(sql, { format: 'arrow' }).toArrow()` remains an Arrow IPC compatibility route, not direct C Data. Prefer a verified ADBC client only if the application already uses ADBC for standard results or bulk ingest; general ADBC `BindStream` does not create a temporary SQL source. Install the optional `apache-arrow` peer. Start with `docs/arrow.md` for this binding's documentation map, examples, types, and isolate constraints.
