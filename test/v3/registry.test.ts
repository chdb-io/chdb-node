import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, version, Session } from '../../index.js'

// Errors thrown by index.js come from the compiled dist/ module, so a different
// class identity than src/. Assert on the stable .name/.code/.clickhouseCode
// contract rather than instanceof.

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'chdb-reg-'))
}

describe('typed errors end-to-end (through index.js + native + engine)', () => {
  it('routes a syntax error to ChdbSyntaxError (code 62)', () => {
    try {
      query('SELECT 1 1 1', 'CSV')
      expect.unreachable('expected a syntax error')
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error)
      expect(e.name).toBe('ChdbSyntaxError')
      expect(e.code).toBe('CHDB_SYNTAX')
      expect(e.clickhouseCode).toBe(62)
    }
  })

  it('routes an unknown-table error to ChdbQueryError and preserves the message', () => {
    try {
      query('SELECT * FROM no_such_table_xyz', 'CSV')
      expect.unreachable('expected a query error')
    } catch (e: any) {
      expect(e.name).toBe('ChdbQueryError')
      expect(e.code).toBe('CHDB_QUERY')
      expect(e.clickhouseCode).toBe(60)
      expect(e.message).toMatch(/Unknown table expression identifier/)
    }
  })
})

describe('connection registry (single-active-connection constraint)', () => {
  it('rejects a second concurrent data directory with ChdbConnectionError', () => {
    const a = mkTmp()
    const b = mkTmp()
    let sa: Session | undefined
    let sb: Session | undefined
    try {
      sa = new Session(a)
      expect(sa.connection).toBeTruthy()
      try {
        sb = new Session(b)
        expect.unreachable('expected a connection conflict')
      } catch (e: any) {
        expect(e.name).toBe('ChdbConnectionError')
        expect(e.code).toBe('CHDB_CONNECTION')
        expect(e.message).toMatch(/only one active data directory/)
      }
    } finally {
      sa?.cleanup()
      sb?.cleanup()
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('shares one native connection across same-path sessions (refcount)', () => {
    const dir = mkTmp()
    let s1: Session | undefined
    let s2: Session | undefined
    try {
      s1 = new Session(dir)
      s2 = new Session(dir) // same path -> reuse, refcount 2
      expect(s1.connection).toBeTruthy()
      expect(s2.connection).toBeTruthy()

      s1.query('CREATE TABLE t (x UInt32) ENGINE = MergeTree() ORDER BY x')
      s1.query('INSERT INTO t VALUES (1), (2)')
      // Both handles see the same connection/data.
      expect(s2.query('SELECT count() FROM t', 'CSV').trim()).toBe('2')

      s1.cleanup() // refcount 2 -> 1, connection stays open
      s1 = undefined
      // s2 still works after the first handle closed.
      expect(s2.query('SELECT sum(x) FROM t', 'CSV').trim()).toBe('3')
    } finally {
      s1?.cleanup()
      s2?.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows standalone query again after all sessions are closed', () => {
    expect(query('SELECT 7', 'CSV').trim()).toBe('7')
  })
})

describe('version()', () => {
  it('reports package, libchdb and runtime info', () => {
    const v = version()
    expect(typeof v.chdb).toBe('string')
    expect(v.libchdb).toMatch(/\d+\./) // e.g. 26.3.9.1
    expect(v.platform).toBe(process.platform)
    expect(v.arch).toBe(process.arch)
  })
})
