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

| Subpath | What it is | Loads native code |
| --- | --- | --- |
| `chdb/durable` | The control plane: object layout, `head.json`, manifest, lease, CAS, fencing, WAL, checkpoint orchestration, error categories, local backend | no |
| `chdb/durable/s3` | S3-compatible backend — AWS S3, Cloudflare R2, MinIO. Registers the `s3` scheme on import | no |
| `chdb/libchdb` | A path resolver. Says where `libchdb.so` is; does not open it | no |
| `chdb/durable/node` | The default `EngineAdapter`, over this package's addon | **yes** |

The S3 backend sits behind its own subpath so that `chdb/durable` never pulls
in the AWS SDK. A caller using only the local backend should not have to
install several megabytes of it, and `@aws-sdk/client-s3` is an *optional* peer
dependency for the same reason.

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

Injected does not have to mean hand-written. `chdb/durable/node` is the adapter
over this package's addon, so a Node caller writes an engine factory rather
than an engine:

```ts
import { DurableNamespace } from 'chdb/durable'
import { nodeEngineFactory } from 'chdb/durable/node'

const ns = new DurableNamespace('file:///var/lib/chdb-durable', {
  engineFactory: nodeEngineFactory(),
})
```

It sits behind its own subpath rather than in the barrel for the reason above:
importing it *does* load the addon, and putting it in `chdb/durable` would make
that subpath's whole guarantee vacuous.

### On the addon

`lib/chdb_node.cpp` binds the four entry points the seam needs —
`chdb_version`, `chdb_backup_database_n`, `chdb_restore_database_n`,
`chdb_classify_query_n` — and three of them run on the libuv pool. Backup and
restore are unbounded (a checkpoint archives a whole database) and
classification joins them there because the parser reads the entire statement
text, inline data included. That is also what keeps the two mutexes below
worth having: heartbeat lands on the head mutex while a checkpoint holds the
operation mutex, and neither is stuck behind a blocked event loop.

Two things the adapter owns rather than the ABI:

- **Connect-time settings.** `--backups.allowed_path` is server configuration,
  not a session setting, and `--async_insert=0`, `--wait_for_async_insert=1`,
  `--mutations_sync=2`, `--alter_sync=2` all mean "the statement has landed
  before it returns" — without them a statement could reach the WAL while its
  local effect is not yet in the database the next checkpoint archives. They
  are connect arguments because `SET` classifies as CONTROL, so nothing can
  undo them through the public surface later.
- **Quoting the two statements with no C entry point.** `CREATE DATABASE` and
  `USE` are built in the adapter, and their quoting has to agree with the
  quoting core does for `BACKUP`/`RESTORE`. Both escapes matter: doubling
  backticks alone leaves a backslash as an escape introducer, so a database
  named `a\b` would be created as `a<backspace>` — under a name the backup
  call would then not find. The suite round-trips a name carrying both.

`chdb_version` is bound as its own export, taking no connection, because the
compatibility gate runs before a lease is taken or a scratch directory made.

Beyond that, one constraint is the adapter's to hold rather than the control
plane's: a native call runs on a libuv thread holding the connection, so
`close()` waits for anything in flight instead of releasing under it. There is
no interrupt for a running query, so waiting is the only correct answer.

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

### The buffer is bounded where a refusal is still cheap

`execute()` checks two limits before running the statement: the frozen 64 MiB
per-statement ceiling, and whether this statement would take the unflushed
buffer past the 128 MiB a WAL segment can hold.

Checking at flush instead would be too late in a way that is hard to get out
of. A statement that has executed cannot be un-executed, so once the buffer is
larger than a segment, every flush fails while encoding and the local database
has already moved on. `checkpoint()` can still rescue it — it archives the
database rather than the buffer — but the caller has to know that, and nothing
would have told it.

What makes that worth guarding rather than documenting is how reachable it is
from one transient failure. A flush that fails leaves the buffer intact, by
design; a caller that keeps writing walks straight into a buffer no flush can
encode. So a single network blip escalates into a state needing manual
intervention. Refusing at `execute()` turns that into an ordinary recoverable
error: nothing ran, and `pendingBytes` lets a caller apply its own backpressure
long before the ceiling.

The budget has to agree with the encoder exactly, so `walLineBytes` and
`encodeWalSegment` are pinned to each other by a test rather than left to stay
in step by inspection.

### Observability

`stats` returns a consistent point-in-time snapshot — generation, lease expiry,
committed sequence, base key, WAL segment count, executed and committed
statement counts, pending statements and bytes, and the times of the last
successful flush and checkpoint. It is taken as one object rather than field by
field because reading a generation and a sequence number through separate
getters can straddle a commit and describe a state that never existed.

It carries no credentials and no SQL, so it is safe to log verbatim; a test
asserts that.

Recovery reports progress through `onRestoreProgress`: creating the database or
restoring the base, then each WAL segment as it replays, then ready with a
statement count. Restoring a large object is not instantaneous, and "starting"
with no further detail is indistinguishable from "stuck" — which is the pair an
operator most needs to tell apart. The callback is best-effort: a throw from it
is swallowed, because reporting must not be able to fail a good recovery.

### Backends: local is for testing, S3 is for the point

Which also settles what the local backend is worth hardening against. It
defends two things, because both are real whatever the scope: keys taken out of
`head.json`, which is untrusted input fetched from object storage and could
name `..` or an absolute path; and losing data it has already reported as
written, which is a correctness bug rather than a security one, and disqualifies
a conformance baseline.

It does not defend against a hostile local filesystem. Guarding against, say, a
symlink planted inside the object prefix buys no privilege boundary — whoever
can plant it can rewrite the objects directly — and check-then-use cannot be
made atomic without `openat`, which Node does not expose. Anything wanting that
property should not be on this backend.

A local directory cannot be a remote authority. When the machine holding it is
gone, so is the object — so the local backend is what conformance and
development run on, not what makes a database recoverable somewhere else.

`chdb/durable/s3` is the one that does. One implementation serves three
providers, since the differences are endpoint and addressing:

```text
AWS     s3://my-bucket/durable?region=eu-west-1
R2      s3://my-bucket/durable?region=auto&endpoint=https://<id>.r2.cloudflarestorage.com
MinIO   s3://my-bucket/durable?region=us-east-1&endpoint=http://127.0.0.1:9000&forcePathStyle=true
```

Credentials are deliberately not in the URL. They come from the environment or
the standard credential chain, because a namespace URL is the sort of thing
that ends up in a config file, a log line and an issue comment.

The conditional operations map onto preconditions on `PutObject`:

| Backend method | HTTP |
| --- | --- |
| `putBytesIfAbsent` / `putFileIfAbsent` | `PUT` + `If-None-Match: *` |
| `replaceIfMatch` | `PUT` + `If-Match: <etag>` |
| 412, or 409 `ConditionalRequestConflict` | a CAS outcome, not a transport error |
| timeout, reset connection, 5xx | `'ambiguous'`, resolved upstream by re-reading |

**The SDK's own retries are safe, for a specific reason.** A retry can turn a
request that did land into a precondition failure: the first `PutObject`
succeeds, the response is lost, the retry finds the object there and gets a
412. So this backend can report `already-exists` for an object it wrote itself.
That is fine because nothing upstream concludes anything from a status code —
`already-exists` sends the object layer to re-read that unique key and compare
length and SHA-256, `not-replaced` sends it to re-read the head and look for
its own intent under its own lease. A design that trusted the status code would
need retries disabled; this one does not.

**One assumption the ETag forces, worth naming.** An S3 ETag is a content hash
for single-part uploads, so writing byte-identical content does not advance it,
and the token used for that write stays valid — a second racer holding it also
wins. This was measured against MinIO, not assumed. Durable is safe from it
because every head write changes the bytes: lease acquisition moves the
generation, heartbeat moves `expires_at`, flush and checkpoint move
`manifest.seq`. That is a real dependency rather than a happy accident, which
is why `test/durable/s3-backend.test.ts` pins the behaviour — anything that
made a head write byte-idempotent would break CAS on any content-hash provider.

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
npm run test:durable:node     # the control plane over this package's addon
npm run test:durable:s3       # S3-compatible provider conformance (needs a bucket)
npm run test:durable:e2e      # end-to-end against a real libchdb, under Bun
npm run test:durable:stack    # the whole stack: Bun + libchdb + real object storage
```

The last one is the arrangement a downstream actually deploys, and the only
place the other two suites' halves meet. Each of them covers one: a real engine
over a local directory, or a real bucket under a fake engine. Both can pass
while an assumption held by only one of them is wrong.

```sh
CHDB_LIBCHDB_PATH=/path/to/libchdb.so \
CHDB_DURABLE_S3_BUCKET=my-bucket CHDB_DURABLE_S3_REGION=us-east-2 \
  npm run test:durable:stack
```

Both Bun suites pass `--timeout`, because the default five seconds is fine for
a local engine and not for a checkpoint round-tripping through real object
storage.

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

`CHDB_LIBCHDB_PATH` is only needed when a platform package that predates the
durable ABI is installed. The resolver prefers `@chdb/lib-*` over anything in
the working tree, so a stale one shadows a local `chdb-core` build — and until
the RC platform packages are published, the newest on npm is
`26.7.0-stable.1`, which exports none of the durable symbols. Either override
the path or `rm -rf node_modules/@chdb/lib-*`, which is what CI already does.
Running against a shadowing build fails with a message naming the missing ABI
rather than a bare `dlopen` TypeError.

`test/durable/libchdb-ffi.ts` is the adapter it uses. It is deliberately not
shipped: a Bun-only module in the dependency graph would be a trap for Node
users, and the shipped default is `chdb/durable/node`. Downstreams that want
the FFI shape should own their copy — it is a symbol table and fifty lines of
`dlopen`.

`npm run test:durable:node` covers the other half of the seam, which the Bun
suite by construction cannot reach: the addon's own bindings, the connect-time
settings, and the adapter's identifier quoting. It re-runs the load-bearing
scenarios rather than every scenario twice — version recording, WAL replay
after losing the machine, checkpoint and restore, the refusal matrix, an
odd database name — plus the cases that exist only here, like refusing to
release the connection under a call still on a libuv thread. It needs a built
addon and no prebuilt shadowing it:

```sh
npm run build && rm -rf node_modules/@chdb/lib-*
npm run test:durable:node
```

That second command is not optional housekeeping. The loader prefers a
published `@chdb/lib-<platform>` over a local build, and until one is published
from a tree that binds the durable ABI, the adapter refuses to start against it
— with a message naming the missing exports rather than a `TypeError`.

### Conformance status

Against the V1 conformance list, this binding's position:

| Requirement | Status |
| --- | --- |
| Core ABI and query-classification matrix | covered by the end-to-end suite, and again through the addon |
| All three `backup_format` / `min_reader` gate outcomes | covered |
| Format fixtures: empty, checkpoint-only, checkpoint-plus-WAL, quoted database | covered |
| Missing/corrupt base and WAL, future protocol, unknown feature, incompatible engine | covered |
| Single-writer races, fencing, heartbeat, failed and ambiguous commits | covered |
| Unknown-field round trips, size limits, secret redaction, close failure | covered |
| Full provider suite against a real object store | covered — AWS S3 and MinIO |
| Restoring full backups from *earlier* core releases | not applicable yet — `v26.7.2-rc.2` is the first release with the Durable ABI, so there is no earlier archive to restore |
| New-header/old-library and old-header/new-library ABI tests | not applicable yet — same reason; the promise starts here |
| Every writer's fixture read by two other bindings | pending — needs Python and Go to reach V1 |

The two "not applicable" rows become real on the second Durable-capable core
release, and the fixtures written now are what they will be tested against.

### Provider conformance

The contract is explicit that a provider is supported because this suite passed
against it, not because it advertises S3 compatibility (§7.5). So
`test/durable/s3-backend.test.ts` is parameterised — point it anywhere:

```sh
docker run -d --name minio -p 9000:9000 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  quay.io/minio/minio:latest server /data

CHDB_DURABLE_S3_BUCKET=durable-test \
CHDB_DURABLE_S3_ENDPOINT=http://127.0.0.1:9000 \
CHDB_DURABLE_S3_REGION=us-east-1 \
CHDB_DURABLE_S3_FORCE_PATH_STYLE=true \
AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
  npm run test:durable:s3
```

Without a bucket configured it skips, so the rest of the suite stays runnable
with no network. It writes everything under one unique prefix and deletes it
afterwards — the protocol has no destroy, but a test that leaves objects in
someone's bucket costs them money.

Beyond the six backend methods, it runs the claim the feature actually makes: a
durable object written on one "machine" — one namespace instance, one engine,
one scratch tree — reopened on another that shares nothing but the bucket, for
both a WAL-only object and a checkpointed one.

Run against engine `26.7.2-rc.2`:

| Provider | Status |
| --- | --- |
| AWS S3 (`us-east-2`) | 11/11 conformance, plus 4/4 full stack |
| MinIO (`RELEASE.2025-09-07`) | 11/11 conformance, run repeatedly |
| Cloudflare R2 | not run — the code path is the same, but the claim is not made until measured |

The two that have run agree on every point, including the ETag behaviour above:
`If-None-Match: *` and `If-Match` are atomic on both, an eight-way race leaves
exactly one winner on both, and re-PUTting identical bytes advances the token on
neither.

## Not in V1

Deliberately absent, each requiring its own proposal, feature name and fixtures
before it arrives (contract §8):

- preamble / global state — all `MUTATING_GLOBAL` fails closed today
- incremental checkpoints
- Parquet or data WAL
- garbage collection and destroy — nothing here deletes an object (see below)
- multiple writers, multiple databases per object, cross-object transactions
- cross-engine-version migration orchestration — V1 already lets later chdb-core
  releases restore earlier V1 full backups through the `backup_format` and
  `min_reader` gates, but it does not define an online upgrade/rollback flow
- multipart upload: a single `PutObject` caps an object at 5 GiB, and a larger
  checkpoint fails with `limit_exceeded` rather than truncating. Note where that
  failure lands — the size is known only after the archive exists, so the backup
  has already been taken and the local disk already used when it is refused.
  There is no earlier check to make; the engine does not predict archive size
- GCS and Azure backends: register one with `registerBackendScheme()`

### Engine compatibility is a floor, not an equality

The protocol gates on two explicit fields rather than on which build wrote the
object:

```text
backup_format > this engine's generation  ->  engine_incompatible
running version < min_reader              ->  engine_incompatible
otherwise                                 ->  open
```

`engine.version` records the producer, for diagnosis. It is deliberately not a
gate — an exact match would refuse every later release, which is the opposite
of what chdb-core promises: a newer release restores full backups made by an
earlier one. An object written by `26.7.2-rc.2` opens on `26.7.2`, `26.7.3` and
`26.8.1`.

The two checks guard different failures and neither subsumes the other.
`min_reader` catches a reader that is simply too old. `backup_format` is the
escape hatch for the day the compatibility promise is withdrawn: version
numbers keep rising whether or not old archives still restore, so a broken
format needs its own signal — otherwise a reader compares a larger version,
concludes it is fine, and finds out partway through RESTORE. Core increments
the generation; a reader refuses anything above its own. Until the C ABI
exposes it, `EngineAdapter.backupFormat()` is optional and everything is the V1
baseline of 1.

Versions are ordered by release precedence, never as strings. That is not
pedantry: lexicographically `"26.10.0" < "26.7.0"` and `"26.7.2-rc.2" >
"26.7.2"`, and either one would let a reader open an object it cannot restore.
A version string that cannot be parsed is refused rather than guessed at.

chDB ships only `X.Y.Z` and `X.Y.Z-rc.N`, and a patch number that had a release
candidate never gets a stable of the same number — after `26.7.2-rc.2` the next
stable is `26.7.3`. The comparison is semver-shaped rather than a match on those
two exact forms, which makes it more permissive than the convention: a future
`26.7.2-beta.1` would sort correctly instead of being rejected. Tightening it
would fail closed in the wrong place — refusing an object that could have been
opened safely.

A writer raises the floor on every head write and never lowers it — `max` of
what is stored and what this engine requires — so an older engine reaching a
write cannot advertise the object as readable by a build that cannot restore
its base.

If RESTORE fails anyway on an archive the gate admitted, that is the promise
being violated rather than an ordinary engine error, and it surfaces as
`engine_incompatible` so the caller knows to upgrade rather than to retry.

### Objects only grow

This is the V1 cost most likely to surprise someone in production, so it is
worth stating plainly rather than leaving as an absence.

Every checkpoint publishes a new base and empties the WAL list. The previous
base and the WAL segments it subsumed stop being referenced at that moment —
and stay in the bucket forever, because nothing in V1 deletes anything. A busy
object accumulates one orphaned archive per checkpoint indefinitely.

The reflex fix does not work: **a plain age-based lifecycle rule will corrupt
objects.** The current base can be arbitrarily old — an object written once and
then only read keeps the same base for as long as it exists — so "delete objects
older than N days" happily deletes the base a live manifest points at, and the
next open fails with `corrupt`.

Reclaiming safely means reading `head.json`, keeping every key it references,
and deleting only the rest, with a grace period long enough to cover a reader
that fetched a manifest just before a checkpoint replaced it. That is a real
design — concurrent-reader safety and orphan windows are the hard parts, which
is why the contract holds it back to V2 (§8.1 item 4) rather than bolting it
onto checkpoint. Until then, plan for the growth or run that reclaim as an
external tool.

One more constraint is not the control plane's to hide: chdb-core binds one data
path per process, so **one process holds one open durable object at a time**.
Fan-out has to be sequential, or spread across worker processes.

## Still to do on the chdb-node side

Both halves now exist — the addon binds the durable ABI and
`chdb/durable/node` ships the default adapter over it. What is left is not in
this package:

1. Publish `@chdb/lib-<platform>` packages built from a tree that binds the
   durable ABI. `optionalDependencies` already pins `26.7.2-rc.2.1`, but a
   prebuilt from before this work exports none of the four entry points, and
   the loader prefers it over a local build — so until those are published,
   using `chdb/durable/node` from an installed package means `npm run build`
   plus `rm -rf node_modules/@chdb/lib-*`.
2. Add the shared cross-binding fixtures from the chdb repository once they
   exist, and read a Python-written object with them.
