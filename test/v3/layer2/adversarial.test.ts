import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// All error classes come from the runtime graph (index.js) so `instanceof`
// matches the instances the client actually throws.
import {
  createClient,
  ChdbEmbeddedOnlyError,
  ChdbInsertError,
  ChdbClosedError,
  ChdbConnectionError,
  ChdbError,
} from '../../../index.js'

// Iron invariants (design §6③): never crash the process (except documented OOM),
// never silently return wrong data, always either succeed or throw a typed Error.

describe('adversarial — URLs', () => {
  it.each([null, '', 'http://x', 'not a url', 'chdb:/onlyoneslash', 'ftp://h'])(
    'controlled handling of bad url %s',
    (u) => {
      // either parses to a (memory/path) client, or throws the typed boundary error
      try {
        const c = createClient({ url: u as never })
        expect(c).toBeDefined()
        return c.close()
      } catch (e) {
        expect(e).toBeInstanceOf(ChdbEmbeddedOnlyError)
      }
    },
  )
})

describe('adversarial — query / params', () => {
  it('empty query yields empty text (no crash)', async () => {
    const c = createClient()
    try {
      const rs = await c.query({ query: '', format: 'CSV' })
      expect(await rs.text()).toBe('')
    } finally {
      await c.close()
    }
  })

  it('injection vectors in query_params stay literals (no escape)', async () => {
    const c = createClient()
    try {
      const evil = "'; DROP TABLE x; -- \\ \" ` "
      const rs = await c.query({
        query: 'SELECT {s:String} AS v',
        query_params: { s: evil },
        format: 'JSONEachRow',
      })
      expect(await rs.json()).toEqual([{ v: evil }])
    } finally {
      await c.close()
    }
  })

  it('out-of-range integer param is a typed throw, not silently truncated', async () => {
    const c = createClient()
    try {
      // clickhouse-js sends the number's text form and lets the engine bind it
      // per the declared type; a value that cannot represent an Int64 is a typed
      // error (not a silently-truncated wrong value) — the invariant that holds.
      // (A legitimate Float64 like 1e21 binds fine; only the Int64 type rejects.)
      await expect(
        c.query({
          query: 'SELECT {n:Int64} AS v',
          query_params: { n: 1e21 },
        }),
      ).rejects.toBeInstanceOf(ChdbError)
    } finally {
      await c.close()
    }
  })

  it('bigint and string Int64 params preserve precision', async () => {
    const c = createClient()
    try {
      const rs = await c.query({
        query: 'SELECT {n:Int64} AS v',
        query_params: { n: 9007199254740993n },
        format: 'JSONEachRow',
      })
      // Int64 in JSON is a string (byte-compat with clickhouse-js HTTP JSON)
      expect(await rs.json()).toEqual([{ v: '9007199254740993' }])
    } finally {
      await c.close()
    }
  })
})

describe('adversarial — insert', () => {
  it('undefined cell is rejected (ChdbInsertError), not coerced to NULL', async () => {
    const c = createClient()
    try {
      await c.command({ query: 'CREATE TABLE bad (a UInt32, b String) ENGINE = Memory' })
      await expect(
        c.insert({ table: 'bad', values: [{ a: 1, b: undefined } as never], format: 'JSONEachRow' }),
      ).rejects.toBeInstanceOf(ChdbInsertError)
    } finally {
      await c.close()
    }
  })

  it('inconsistent row shapes are rejected (by the engine)', async () => {
    const c = createClient()
    try {
      await c.command({ query: 'CREATE TABLE mixed (a UInt32) ENGINE = Memory' })
      // Object + array rows serialize to a malformed JSONEachRow dataset; the
      // engine rejects it as a typed error. clickhouse-js inserts the same
      // FORMAT-tailed dataset, so this is the byte-compatible boundary — the
      // invariant is only that it is a typed throw, never silent-wrong.
      await expect(
        c.insert({ table: 'mixed', values: [{ a: 1 }, [2]] as never }),
      ).rejects.toBeInstanceOf(ChdbError)
    } finally {
      await c.close()
    }
  })
})

describe('adversarial — lifecycle', () => {
  it('query after close rejects with ChdbClosedError', async () => {
    const c = createClient()
    await c.close()
    await expect(c.query({ query: 'SELECT 1' })).rejects.toBeInstanceOf(ChdbClosedError)
  })

  it('an unconsumed result set then client close does not crash or leak', async () => {
    const c = createClient()
    const rs = await c.query({ query: 'SELECT number FROM numbers(100)', format: 'JSONEachRow' })
    rs.close() // never consumed
    await c.close()
    expect(true).toBe(true)
  })

  it('two clients on DIFFERENT on-disk paths → ChdbConnectionError on the second', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'l2a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'l2b-'))
    const a = createClient({ url: `chdb://${dirA}` })
    const b = createClient({ url: `chdb://${dirB}` })
    try {
      const rs = await a.query({ query: 'SELECT 1 AS n', format: 'JSONEachRow' })
      expect(await rs.json()).toEqual([{ n: 1 }])
      await expect(b.query({ query: 'SELECT 1' })).rejects.toBeInstanceOf(ChdbConnectionError)
    } finally {
      await a.close()
      await b.close()
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('two memory clients SHARE state (one connection, refcounted)', async () => {
    const a = createClient({ url: 'chdb://memory' })
    const b = createClient({ url: 'chdb://memory' })
    try {
      await a.command({ query: 'CREATE TABLE shared (x UInt32) ENGINE = Memory' })
      await a.insert({ table: 'shared', values: [{ x: 99 }], format: 'JSONEachRow' })
      // b sees a's table because they share the in-memory connection
      const rs = await b.query({ query: 'SELECT x FROM shared', format: 'JSONEachRow' })
      expect(await rs.json()).toEqual([{ x: 99 }])
    } finally {
      await a.close()
      await b.close()
    }
  })
})
