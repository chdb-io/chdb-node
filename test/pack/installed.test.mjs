// Installed-package test. Unlike the unit tests (which import the source tree via
// relative paths), this imports `chdb` BY NAME, so it only ever exercises the
// published, installed package in node_modules: the packed files, the per-platform
// @chdb/lib-* native binary resolved through optionalDependencies, its rpath at the
// installed location, and the subpath `exports` map.
//
// This is the gate that would have caught #50 (a binary with the build machine's
// absolute rpath loaded in CI's build dir but threw on a clean host): here the very
// first `import 'chdb'` loads the native addon from where npm actually put it.
//
// Run it from a clean directory that has only `npm install chdb@<version>` (plus
// vitest), NOT from the repo — see .github/workflows verify job.

import { describe, it, expect } from 'vitest'
import { query, queryAsync, Session, version } from 'chdb'

describe('installed chdb package', () => {
  it('loads the native binary and reports a version', () => {
    const v = version()
    expect(typeof v).toBe('object')
    expect(typeof v.libchdb).toBe('string')
    expect(v.libchdb.length).toBeGreaterThan(0)
  })

  it('runs a stateless query (engine actually executes)', () => {
    expect(query('SELECT 1 AS n', 'CSV').trim()).toBe('1')
  })

  it('runs an async query and parses rows', async () => {
    const r = await queryAsync("SELECT number FROM numbers(3)", { format: 'JSONEachRow' })
    expect(r.text().trim().split('\n')).toHaveLength(3)
  })

  it('creates a Session and round-trips an insert + query + stream', async () => {
    const s = new Session()
    try {
      s.query('CREATE TABLE t (id UInt64, name String) ENGINE = MergeTree ORDER BY id')
      await s.insert({ table: 't', values: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] })
      const rows = (await s.queryAsync('SELECT name FROM t ORDER BY id', { format: 'JSONEachRow' })).text().trim()
      expect(rows).toBe('{"name":"Alice"}\n{"name":"Bob"}')
      const streamed = []
      for await (const row of s.queryStream('SELECT id FROM t ORDER BY id').rows()) streamed.push(String(row.id))
      expect(streamed).toEqual(['1', '2'])
    } finally {
      s.close()
    }
  })

  it('resolves the subpath exports the package advertises', async () => {
    const conn = await import('chdb/connection')
    expect(typeof conn.createChdbConnection).toBe('function')
  })
})
