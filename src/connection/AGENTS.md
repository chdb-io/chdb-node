# Layer 2 — @clickhouse/client integration

`chdb/connection` is a `Connection` implementation for `@clickhouse/client`. Keep using
`@clickhouse/client` as you do today; just plug chDB in as the connection so the client
runs against an in-process engine instead of a remote server. See `../../llms-full.txt`
for the flat reference.

> Requires `@clickhouse/client` ≥ 1.23.0-head.b25cda1.1, which ships the
> `createClient({ connection })` hook this uses.

## Switching from @clickhouse/client

One change at construction; the rest of your code is unchanged.

```js
import { createClient } from '@clickhouse/client'        // the real client, as before
import { createChdbConnection } from 'chdb/connection'

const client = createClient({
  connection: createChdbConnection({ path: ':memory:' }), // or an on-disk path, e.g. './db'
  // your usual @clickhouse/client options still apply
})

const rs = await client.query({ query: 'SELECT 1 AS n', format: 'JSONEachRow' })
const rows = await rs.json()
await client.insert({ table: 't', values: [{ id: 1 }], format: 'JSONEachRow' })
await client.close()
```

`client.query` / `command` / `exec` / `insert` / `ping` / `close`, and `ResultSet` / `Row`
/ `ClickHouseError`, are exactly `@clickhouse/client`'s — the `Connection` interface and
result types are re-exported verbatim from `@clickhouse/client-common`.

## Notes

- `createChdbConnection({ path })`: `':memory:'` (default) is an ephemeral, process-shared
  in-memory database; pass an on-disk path for persistence. A different on-disk path while
  one is live is rejected (one engine per process).
- `client.query()` buffers the whole result. For large/streaming reads, use the chDB-native
  `Session.queryStream` (Layer 1) or the Layer 3 `.stream()` instead.
