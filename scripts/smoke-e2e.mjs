// Minimal end-to-end smoke against the INSTALLED package (import 'chdb'), used
// by the clean-room CI job and the Bun/Deno runtime jobs. Exits non-zero on any
// mismatch. Intentionally tiny and dependency-free (no test runner) so it runs
// identically under Node, Bun and Deno.
import { query, queryBind, Session } from 'chdb'

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1) } }

assert(query('SELECT 1', 'CSV').trim() === '1', 'standalone query')
assert(queryBind('SELECT {n:UInt32} * 2 AS v', { n: 21 }, 'CSV').trim() === '42', 'queryBind')

const s = new Session()
s.query('CREATE TABLE t (id UInt32, name String) ENGINE = MergeTree() ORDER BY id')
await s.insert({ table: 't', values: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
assert(s.query('SELECT count() FROM t', 'CSV').trim() === '2', 'insert+count')

const r = await s.queryAsync('SELECT sum(id) FROM t', { format: 'CSV' })
assert(r.text().trim() === '3', 'queryAsync aggregate')

const ids = []
for await (const row of s.queryStream('SELECT id FROM t ORDER BY id').rows()) ids.push(Number(row.id))
assert(ids.join(',') === '1,2', 'streaming rows')

s.close()
console.log('smoke-e2e OK')
