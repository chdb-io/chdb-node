import { describe, it, expect } from 'vitest'
import {
  createClient,
  ClickHouseError,
  ChdbError,
  ChdbEmbeddedNotSupportedError,
  ChdbInsertError,
  ChdbAbortError,
} from '../../../index.js'
// Pure string→object parser (no class identity involved) — safe to import from dist.
import { parseClickHouseErrorString } from '../../../dist/layer2/error_map.js'

describe('parseClickHouseErrorString — clickhouse-js regex (verbatim)', () => {
  it('extracts code / type / message from a canonical exception', () => {
    const p = parseClickHouseErrorString(
      "Code: 60. DB::Exception: Table default.x doesn't exist. (UNKNOWN_TABLE)",
    )
    expect(p).toMatchObject({ code: '60', type: 'UNKNOWN_TABLE' })
    expect(p?.message).toMatch(/Table default\.x/)
  })
  it('returns undefined for a non-canonical string', () => {
    expect(parseClickHouseErrorString('some random message')).toBeUndefined()
  })
})

// wrapError's contract is exercised through the public client path so that all
// class identities come from one module graph (the runtime's).
describe('error rewrap — engine errors → ClickHouseError; boundaries stay honest', () => {
  it('engine error is a ClickHouseError AND a ChdbError (double instanceof) with code/type/cause', async () => {
    const c = createClient()
    try {
      await c.query({ query: 'SELECT * FROM definitely_missing_table' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ClickHouseError)
      expect(e).toBeInstanceOf(ChdbError) // whole hierarchy stays catchable
      const che = e as ClickHouseError
      expect(che.code).toBe('60')
      expect(che.type).toBe('UNKNOWN_TABLE')
      expect((che as { cause?: unknown }).cause).toBeInstanceOf(ChdbError) // .cause preserved
    } finally {
      await c.close()
    }
  })

  it('syntax error from query() is a ClickHouseError', async () => {
    const c = createClient()
    try {
      await expect(c.query({ query: 'SELEKT 1' })).rejects.toBeInstanceOf(ClickHouseError)
    } finally {
      await c.close()
    }
  })

  it('cluster topology SQL → ChdbEmbeddedNotSupportedError (NOT ClickHouseError)', async () => {
    const c = createClient()
    try {
      await c.query({ query: 'SELECT * FROM clusterAllReplicas(x, system.one)' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ChdbEmbeddedNotSupportedError)
      expect(e).not.toBeInstanceOf(ClickHouseError)
    } finally {
      await c.close()
    }
  })

  it('insert serialization error stays a ChdbInsertError (NOT masqueraded as ClickHouseError)', async () => {
    const c = createClient()
    try {
      await c.command({ query: 'CREATE TABLE wm (a UInt32, b String) ENGINE = Memory' })
      await c.insert({ table: 'wm', values: [{ a: 1, b: undefined } as never], format: 'JSONEachRow' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ChdbInsertError)
      expect(e).not.toBeInstanceOf(ClickHouseError)
    } finally {
      await c.close()
    }
  })

  it('a pre-aborted signal rejects with an AbortError (NOT a ClickHouseError)', async () => {
    const c = createClient()
    try {
      const ac = new AbortController()
      ac.abort()
      await c.query({ query: 'SELECT 1', abort_signal: ac.signal })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ChdbAbortError)
      expect((e as Error).name).toBe('AbortError')
      expect(e).not.toBeInstanceOf(ClickHouseError)
    } finally {
      await c.close()
    }
  })

  it('ping never throws — returns {success:false,error} after close', async () => {
    const c = createClient()
    await c.close()
    const r = await c.ping()
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toBeInstanceOf(Error)
  })
})
