# Layer 3 — fluent builder + federation

The native, type-safe query API. Kysely-shaped, immutable, lazy. Every interpolated or
passed value is bound server-side (`{pN:Type}` placeholder), so injection is impossible.
See the root `AGENTS.md` for when to pick this vs the others, and `../../llms-full.txt`
for the flat API list.

## Entry points

- `selectFrom(source)` / `insertInto(table)` / `updateTable(table)` / `deleteFrom(table)`
  — standalone builders on the default connection.
- `session(path?)` → a `Database` bound to a `Session` (use this for a real DB; the
  builders hang off it: `db.selectFrom(...)`). `database({ session })` wraps an existing one.
- `connect(config)` → a `Connection` for external sources (federation, below).

## SelectQueryBuilder

Immutable: each method returns a new builder, so a query can be composed/passed around.

- projection: `.select(col | [cols])` `.selectAll()` `.distinct()`
- filter: `.where(col, op, val)` or `.where(expr)`; `.andWhere` `.orWhere` `.having`
- group/order/page: `.groupBy(cols)` `.orderBy(col, 'asc'|'desc')` `.limit(n)` `.offset(n)`
- joins: `.innerJoin/.leftJoin/.fullJoin(src, leftKey, rightKey)` `.crossJoin(src)`
- set ops: `.union/.unionAll/.intersect/.except(otherBuilder)`
- ClickHouse dialect: `.final()` `.sample(rate)` `.prewhere(...)` `.settings({...})`
  `.format(name)` `.limitBy(n, cols)`
- compose: `.as(alias)` `.toNode()` `.compile() -> { sql, parameters }`
- terminals:
  - `.execute(opts?) -> O[]` — `opts.format`: `'json'` (default, rows) | `'arrow'` (Table) | a raw format name
  - `.executeTakeFirst() -> O | undefined` · `.executeTakeFirstOrThrow() -> O`
  - `.stream(opts?) -> AsyncIterableIterator<O>` — lazy, O(chunk); **requires a bound
    session** (the default connection has no streaming cursor); cancel via `opts.signal`

Operators accepted by `where/having`: `=  !=  <>  <  <=  >  >=  +  -  *  /  %  like
'not like'  ilike  'not ilike'  in  'not in'  is  'is not'`.

```js
import { session, sql } from 'chdb'
const db = session('./db')

const top = await db.selectFrom('events')
  .select(['user_id', sql`count()`.as('n')])
  .where('ts', '>', cutoff)              // bound, not spliced
  .groupBy('user_id').orderBy('n', 'desc').limit(10)
  .execute()

for await (const row of db.selectFrom('events').selectAll().stream()) { /* O(chunk) */ }

await db.insertInto('events').values([{ user_id: 1, ts: 1700000000 }]).execute()
```

## Expression helpers

- `` sql`…` `` — tagged template; interpolations are bound, the literal fragments are SQL.
- `ref(name)` `val(v)` `fn(name, ...args)`, and the bundle `eb = { ref, val, fn, sql }`.
- `chTable(name, ...args)` — a table-function call (e.g. `chTable('s3', url, 'Parquet')`).
- `chFn(name, ...args)` — a parametric/scalar function expression.

## Federation — connect({ url })

The URL scheme selects the ClickHouse table function; the returned `Connection` exposes
the same builders, so cross-source JOINs are native (not raw-SQL strings).

```js
import { connect } from 'chdb'
const pg = connect({ url: 'postgres://user:pass@host:5432/db' })
await pg.selectFrom('orders').selectAll().where('total', '>', 100).execute()
```

Schemes → table function:
`clickhouse:`→remote · `clickhouse-cloud:`→remoteSecure · `postgres:`/`postgresql:`/`supabase:`→postgresql ·
`mysql:`→mysql · `mongodb:`/`mongodb+srv:`→mongodb · `s3:`→s3 · `gcs:`/`gs:`→gcs ·
`azureblob:`→azureBlobStorage · `https:` `file:` `chdb:` `memory:`.

`config.clickhouseSettings` is forwarded to the engine; `@clickhouse/client`-only HTTP
fields are accepted for parity but not applied. A pure copy streams entirely in the engine:
`INSERT INTO FUNCTION s3(...) SELECT * FROM postgresql(...)` — no client buffering.

## Codegen / introspection

- CLI `chdb-gen-types` — generate a typed schema (`types.ts`) from a live DB, or from a
  Drizzle / Prisma schema file. The typed schema flows through `Database<DB>` to row types.
- Programmatic: `introspectDatabase` / `introspectTable` / `describeSource` / `emitDatabase`;
  static conversion: `parseDrizzleFile` / `parseDrizzleSource` / `parsePrismaSchema`.
- `registerArrowTable(...)` registers an in-memory Arrow/columnar dataset as `arrowstream('name')`.
