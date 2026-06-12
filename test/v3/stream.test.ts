import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Session } from '../../index.js'

let session: Session
beforeEach(() => { session = new Session() })
afterEach(() => { session.close() })

describe('Session.queryStream (Item 3)', () => {
  it('streams chunks and exposes parsed rows', async () => {
    const rows: number[] = []
    for await (const row of session.queryStream('SELECT number AS n FROM numbers(5)').rows<{ n: number }>()) {
      rows.push(row.n)
    }
    expect(rows).toEqual([0, 1, 2, 3, 4])
  })

  it('iterates chunk objects with numRows/raw/text', async () => {
    const stream = session.queryStream('SELECT number AS n FROM numbers(3)')
    let total = 0
    let sawBytes = false
    for await (const chunk of stream) {
      total += chunk.numRows
      if (chunk.numBytes > 0) sawBytes = true
      expect(chunk.raw()).toBeInstanceOf(Uint8Array)
    }
    expect(total).toBe(3)
    expect(sawBytes).toBe(true)
    expect(stream.closed).toBe(true)
  })

  it('streams a large result chunk-by-chunk without buffering it all', async () => {
    let total = 0
    let chunks = 0
    for await (const chunk of session.queryStream('SELECT number FROM numbers(1000000)')) {
      total += chunk.numRows
      chunks++
    }
    expect(total).toBe(1000000)
    expect(chunks).toBeGreaterThan(1) // proves it actually chunked
  })

  it('releases the stream on early break and allows a new stream afterwards', async () => {
    const stream = session.queryStream('SELECT number FROM numbers(1000000)')
    for await (const _chunk of stream) {
      break // stop after the first chunk
    }
    expect(stream.closed).toBe(true)
    // a fresh stream works after the previous one was released
    const out: number[] = []
    for await (const r of session.queryStream('SELECT number AS n FROM numbers(2)').rows<{ n: number }>()) {
      out.push(r.n)
    }
    expect(out).toEqual([0, 1])
  })

  it('allows only one active stream per session', () => {
    const s1 = session.queryStream('SELECT number FROM numbers(1000)')
    try {
      let name = ''
      try {
        session.queryStream('SELECT 1')
      } catch (e: any) {
        name = e.name
      }
      expect(name).toBe('ChdbStreamError')
    } finally {
      s1.cancel()
    }
  })

  it('rows() requires a JSON row format; text() always works', async () => {
    const stream = session.queryStream('SELECT 1 AS n', { format: 'CSV' })
    for await (const chunk of stream) {
      expect(chunk.text()).toContain('1')
      expect(() => chunk.rows()).toThrow(/JSON row format/)
      break
    }
  })

  it('aborts between chunks with ChdbAbortError', async () => {
    const ac = new AbortController()
    const stream = session.queryStream('SELECT number FROM numbers(100000000)', { signal: ac.signal })
    ac.abort()
    let name = ''
    try {
      for await (const _chunk of stream) { /* consume */ }
    } catch (e: any) {
      name = e.name
    }
    expect(name).toBe('AbortError')
  })
})
