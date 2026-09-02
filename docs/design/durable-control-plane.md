# `chdb/durable` — Durable V1 control plane

`chdb/durable` is a pure-TypeScript implementation of the chDB Durable V1
protocol. It turns an embedded chDB database into an object in remote storage
that a *different machine* can recover: a full checkpoint, a statement WAL on
top of it, and a single `head.json` updated by compare-and-swap under a fenced
writer lease.

The protocol itself is specified in `CHDB_DURABLE_V1_CONTRACT.md` in the
[chdb](https://github.com/chdb-io/chdb) repository. **That document is the
source of truth, not this implementation.** Semantics change there first, then
here.

## What ships

Two subpaths, neither of which loads native code:

| Subpath | What it is |
| --- | --- |
| `chdb/durable` | The control plane: object layout, `head.json`, manifest, lease, CAS, fencing, WAL, checkpoint orchestration, error categories, local backend |
| `chdb/libchdb` | A path resolver. Says where `libchdb.so` is; does not open it |

## The engine is injected, and that is the point

`chdb/durable` never touches a native library. The engine arrives as an
`EngineAdapter` the caller supplies:

```ts
interface EngineAdapter {
  start(options: { dataPath: string; backupsAllowedPath: string }): Promise<void>
  version(): Promise<string>
  createDatabase(database: string): Promise<void>
  useDatabase(database: string): Promise<void>
  analyze(sql: string, targetDatabase: string): Promise<QueryAnalysis>
  query(sql: string, format: string): Promise<string>
  run(sql: string): Promise<void>
  backupDatabase(database: string, filePath: string): Promise<void>
  restoreDatabase(database: string, filePath: string): Promise<void>
  close(): Promise<void>
}
```

This is not abstraction for its own sake. The first downstream user of the
package reaches `libchdb` through its own Bun FFI bindings, and chdb-core binds
**one data path per process** — so a control plane that transitively loaded
`chdb_node.node` would put a second engine in a process that can only have one.
`test/durable/subpath.test.ts` asserts the no-native-load property in a child
process with `process.dlopen` replaced by a throw, which is the only version of
that check that cannot pass by accident.

The five methods that matter map onto the C ABI directly. Two of them are the
reason the seam exists at all:

- **`analyze` is `chdb_classify_query_n`.** No prefix lists, no regular
  expressions, in any binding. Only ClickHouse's own parser can say how many
  executable statements a text holds, see through `INSERT ... FORMAT` inline
  data, or resolve an unqualified table name against the session database.
- **`backupDatabase` / `restoreDatabase` take an identifier and a path.** Core
  builds the AST and does the quoting. A binding that concatenated
  `BACKUP DATABASE ` + name would be one adversarial database name away from
  injection, in four languages independently.

`backupDatabase` has no incremental-base parameter even though the C ABI accepts
one: an incremental archive records the absolute path of its base, and that path
does not exist on the machine doing the restore. V1 checkpoints are always full.

## Usage

```ts
import { DurableNamespace } from 'chdb/durable'

const ns = new DurableNamespace('file:///var/lib/chdb-durable', {
  engineFactory: () => new MyEngineAdapter(),
})

const obj = await ns.open('orders', { database: 'default' })

// A read. Refused unless core proves it is exactly one READ_ONLY statement.
const rows = await obj.query('SELECT count() FROM events', { format: 'JSONEachRow' })

// A write. Runs locally, then joins the WAL buffer. NOT yet durable.
const ticket = await obj.execute("INSERT INTO events VALUES (1, 'a')")

// Durability barrier. After this resolves, losing the machine loses nothing.
await obj.flushThrough(ticket)

await obj.checkpoint()   // full backup replaces the base, WAL list is cleared
await obj.close()        // drains, flushes, releases the lease — and rejects if any of that failed
```

### `execute()` succeeding is not durability

`execute()` returning means the statement ran against the local database and
was appended to the in-memory WAL buffer. That is all. Durability is `flush()`,
or `flushThrough(ticket)` for one specific statement.

A service that answers a client before flushing has chosen to lose that write on
a crash. That can be the right trade — it should just be a choice, not a
surprise. `flushThrough` exists so a caller that expands one request into
several statements can hold the whole request open behind a single watermark:
concurrent waiters coalesce onto one head commit, because the first through the
operation queue publishes a segment covering all of them and the rest find their
watermark already met.

### Entry-point gates

Method names are not the gate; the analysis is. `query("INSERT …")` and
`execute("SELECT …")` are both refused, by core, not by inspecting the string.

| | `query()` | `execute()` |
| --- | --- | --- |
| statement count | exactly 1 | exactly 1 |
| class | `READ_ONLY` | `MUTATING` |
| writes confined to this database | — | required |
| changes database lifecycle | — | refused |
| carries a credential | allowed | refused |

A read-only statement may carry a secret because it never reaches the WAL. A
mutation may not, because the WAL outlives the statement — so the credential
would outlive it too. `MUTATING_GLOBAL` (global UDFs, named collections, access
entities, `system` writes) is refused outright in V1: a checkpoint is
`BACKUP DATABASE`, which cannot carry state that lives outside every database,
so logging it would mean losing it silently at the next checkpoint.

`UNKNOWN` fails closed.

## Design notes

### Two mutexes, not one

`execute`, `query`, `flush`, `checkpoint` and `close` serialize on an
**operation** mutex. A single head compare-and-swap serializes on a separate
**head** mutex, and heartbeat only ever takes that one.

With one mutex, checkpointing a large database would block heartbeat for the
whole backup and upload, and the writer would fence itself out of an object it
was legitimately in the middle of checkpointing. With the split, heartbeat keeps
landing during a long backup, and the checkpoint's own final commit takes the
head mutex afterwards and therefore sees the ETag heartbeat just produced.

### Nothing is reported as committed without proof

Every conditional operation can answer `'ambiguous'`, because a request whose
response was lost is not a failure. The state machine resolves that by looking
at what is actually there:

- an immutable upload is settled by re-reading its unique key and comparing
  size and SHA-256 — matching bytes are a commit, different bytes are
  `corrupt`, an absent object means retry;
- a head CAS is settled by re-reading the head — the intent visible with
  ownership intact is a commit, ownership lost is `lease_fenced`, neither is a
  retry inside the deadline;
- nothing provable by the deadline is `commit_ambiguous`.

Reporting a lost response as success is the one failure a caller cannot defend
against, so it is the one thing this never does.

### A writer that cannot confirm its lease stops writing

Not on the next error — at the moment its locally believed validity window
lapses. `assertWriter()` checks that on every write, and a lapsed window fences
the handle permanently. The alternative is two processes each convinced they are
the only writer.

Takeover of an *expired* lease waits out a clock-skew allowance on top of the
recorded expiry, because the two writers' clocks are not the same clock. Taking
an *unexpired* lease requires an explicit `force`, and costs the previous
writer's unflushed local work.

Defaults, all configurable per namespace or per open:

| Setting | Default | Rule |
| --- | --- | --- |
| `leaseTtlMs` | 30 000 | validity after a successful head write |
| `heartbeatIntervalMs` | 10 000 | must be ≤ TTL/3 |
| `clockSkewAllowanceMs` | 5 000 | added to a recorded expiry before takeover |
| `commitDeadlineMs` | 30 000 | per commit, across retries and reconcile |
| `maxCommitAttempts` | 5 | inside that deadline |

### Unknown fields survive a write-back

A writer that rebuilt `head.json` from scratch on every write would delete every
field it did not recognise, which makes the whole named-feature mechanism a lie:
a future revision's state would survive exactly until an older writer touched
the object. So the parsed raw JSON is carried alongside the typed view and known
fields are patched onto a clone of it — at the top level and inside `protocol`,
`engine`, `lease` and `manifest`.

Preserving unknown fields is not the same as being lenient about known ones.
Wrong types are `corrupt`, not coerced.

Features are named rather than versioned because a monotonic minimum version
requires features to be linearly ordered, and with several bindings developed in
parallel they are not: a client can implement B without A, and under a version
floor it would be locked out of an object that only ever used B. Unknown
*reader* feature refuses the open; unknown *writer* feature still allows a
read-only open and refuses only the lease.

### The local backend's compare-and-swap is real

POSIX has no CAS on file contents, and the usual workarounds are worse than the
problem — a lock file turns a crash into a stuck object needing a staleness
heuristic; read-compare-rename has the race it is meant to prevent. So the
mutable key is a chain of immutable versions plus a symlink naming the current
one:

```text
head.json               -> symlink to .head-versions/7.json
.head-versions/7.json   immutable
```

The ETag is the version number. Replacing against `v7` means creating
`.head-versions/8.json`, and `link(2)` lets exactly one racer do that — the
`EEXIST` *is* the CAS failure. The symlink is then swapped in with an atomic
`rename`. Immutable objects use the same `link(2)` primitive for
create-if-absent.

A fixture written by another binding has a plain `head.json`, which reads fine
(the ETag is then a content digest) and is adopted into the chain on the first
replace. A plain-file reader continues to see a correct `head.json` through the
symlink.

## Testing

```sh
npm run test:durable          # protocol + state machine + fault matrix (no engine)
npm run test:durable:e2e      # end-to-end against a real libchdb, under Bun
```

The unit suites run the **real** `LocalDurableBackend` — mocking it would mean
the conditional-create and CAS paths, the only parts of a backend that can be
subtly wrong, were never exercised. `FaultBackend` wraps it rather than
replacing it, so a fault scenario runs the real code right up to the injected
failure, including the modes that write for real and *then* lose the response.

The engine in those suites is a fake, because the state machine's correctness
does not depend on ClickHouse executing anything, and a real engine binds one
data path per process.

The end-to-end suite closes that gap. It runs under Bun because it reaches
`libchdb` through `bun:ffi` — which is also the shape a downstream owning its
own `dlopen` will use — and it is the only place the entry-point gates are
checked against the real `chdb_classify_query_n`:

```sh
CHDB_LIBCHDB_PATH=/path/to/chdb-core/buildlib/libchdb.so npm run test:durable:e2e
```

`test/durable/libchdb-ffi.ts` is the adapter it uses. It is deliberately not
shipped: the published package's default adapter belongs on the native addon,
and a Bun-only module in the dependency graph would be a trap for Node users.
Downstreams that want this shape should own their copy — it is a symbol table
and fifty lines of `dlopen`.

## Not in V1

Deliberately absent, each requiring its own proposal, feature name and fixtures
before it arrives (contract §8):

- preamble / global state — all `MUTATING_GLOBAL` fails closed today
- incremental checkpoints
- Parquet or data WAL
- garbage collection and destroy — nothing here deletes an object
- multiple writers, multiple databases per object, cross-object transactions
- cross-engine-version restore — V1 pins `chdb_version()` exactly
- cloud backends: the provider interface is here, the implementations are not.
  Register one with `registerBackendScheme()`

One more constraint is not the control plane's to hide: chdb-core binds one data
path per process, so **one process holds one open durable object at a time**.
Fan-out has to be sequential, or spread across worker processes.

## Still to do on the chdb-node side

The pure-JS layer is complete; the native side is not:

1. Bind `chdb_backup_database_n`, `chdb_restore_database_n`,
   `chdb_classify_query_n` and `chdb_version` in `lib/chdb_node.cpp`.
2. Ship a default `EngineAdapter` over the addon's async API
   (`src/durable/adapters/chdb-node.ts`), so `chdb/durable` works out of the box
   for Node callers who are not bringing their own engine.
3. Point `optionalDependencies` at `@chdb/lib-*` builds carrying the new ABI.
4. Add the shared cross-binding fixtures from the chdb repository once they
   exist, and read a Python-written object with them.
