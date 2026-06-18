import { describe, it, expect } from 'vitest'
import { makeRowTransform } from '../../../dist/layer2/result_set.js'
import { createClient } from '../../../index.js'

interface Row {
  text: string
  json<T = unknown>(): T
}

function runTransform(chunks: Buffer[]): Promise<Row[]> {
  const t = makeRowTransform()
  const out: Row[] = []
  return new Promise((resolve, reject) => {
    t.on('data', (rows: Row[]) => out.push(...rows))
    t.on('end', () => resolve(out))
    t.on('error', reject)
    for (const c of chunks) t.write(c)
    t.end()
  })
}

describe('makeRowTransform — half-row carry-over across chunk boundaries', () => {
  it('reassembles rows regardless of where chunk boundaries fall', async () => {
    const full = '{"n":0}\n{"n":1}\n{"n":2}\n'
    const bytes = Buffer.from(full)
    // try every possible single split point
    for (let i = 1; i < bytes.length; i++) {
      const rows = await runTransform([bytes.subarray(0, i), bytes.subarray(i)])
      expect(rows.map((r) => r.text)).toEqual(['{"n":0}', '{"n":1}', '{"n":2}'])
      expect(rows.map((r) => r.json())).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
    }
  })

  it('handles byte-at-a-time delivery', async () => {
    const bytes = Buffer.from('aa\nbbb\nc\n')
    const rows = await runTransform([...bytes].map((b) => Buffer.from([b])))
    expect(rows.map((r) => r.text)).toEqual(['aa', 'bbb', 'c'])
  })
})

describe('ChdbResultSet — byte-compat json() dispatch + Row asymmetry', () => {
  it('JSON (single-doc) → ResponseJSON shape', async () => {
    const c = createClient()
    try {
      const rs = await c.query({ query: 'SELECT 1 AS n', format: 'JSON' })
      const j = (await rs.json()) as { data: unknown[]; meta?: unknown[]; rows?: number }
      expect(Array.isArray(j.data)).toBe(true)
      expect(j.data).toEqual([{ n: 1 }])
      expect(j.rows).toBe(1)
      expect(Array.isArray(j.meta)).toBe(true)
    } finally {
      await c.close()
    }
  })

  it('JSONEachRow (streamable) → T[]', async () => {
    const c = createClient()
    try {
      const rs = await c.query({ query: 'SELECT toUInt32(number) AS n FROM numbers(3)', format: 'JSONEachRow' })
      expect(await rs.json()).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
    } finally {
      await c.close()
    }
  })

  it('JSONObjectEachRow (records) → Record<string,T>', async () => {
    const c = createClient()
    try {
      const rs = await c.query({
        query: 'SELECT toUInt32(number) AS n FROM numbers(2)',
        format: 'JSONObjectEachRow',
      })
      const j = (await rs.json()) as Record<string, unknown>
      expect(typeof j).toBe('object')
      expect(Array.isArray(j)).toBe(false)
      expect(Object.values(j)).toEqual([{ n: 0 }, { n: 1 }])
    } finally {
      await c.close()
    }
  })

  it('CSV (raw) → json() throws, text() works', async () => {
    const c = createClient()
    try {
      const rs1 = await c.query({ query: 'SELECT 1, 2', format: 'CSV' })
      await expect(rs1.json()).rejects.toThrow(/Cannot decode CSV as JSON/)
      const rs2 = await c.query({ query: 'SELECT 1, 2', format: 'CSV' })
      expect((await rs2.text()).trim()).toBe('1,2')
    } finally {
      await c.close()
    }
  })

  it('stream() yields Row[] for streamable, throws for non-streamable', async () => {
    const c = createClient()
    try {
      const rs = await c.query({ query: 'SELECT toUInt32(number) AS n FROM numbers(3)', format: 'JSONEachRow' })
      const texts: string[] = []
      for await (const rows of rs.stream()) {
        expect(Array.isArray(rows)).toBe(true)
        for (const r of rows) texts.push(r.text)
      }
      expect(texts).toEqual(['{"n":0}', '{"n":1}', '{"n":2}'])

      const rsJson = await c.query({ query: 'SELECT 1 AS n', format: 'JSON' })
      expect(() => rsJson.stream()).toThrow(/not streamable/)
    } finally {
      await c.close()
    }
  })

  it('Row.text is a property, Row.json() is a method', async () => {
    const c = createClient()
    try {
      const rs = await c.query({ query: 'SELECT 7 AS n', format: 'JSONEachRow' })
      for await (const rows of rs.stream()) {
        const row = rows[0]
        expect(typeof row.text).toBe('string') // property
        expect(typeof row.json).toBe('function') // method
        expect(row.json()).toEqual({ n: 7 })
      }
    } finally {
      await c.close()
    }
  })

  it('consumed-once: a second terminal call throws', async () => {
    const c = createClient()
    try {
      const rs = await c.query({ query: 'SELECT 1 AS n', format: 'JSONEachRow' })
      await rs.json()
      await expect(rs.text()).rejects.toThrow(/already consumed/)
    } finally {
      await c.close()
    }
  })

  it('query_id passthrough + synthesized empty frozen response_headers', async () => {
    const c = createClient()
    try {
      const rs = await c.query({ query: 'SELECT 1', format: 'JSONEachRow', query_id: 'my-id-123' })
      expect(rs.query_id).toBe('my-id-123')
      expect(rs.response_headers).toEqual({})
      expect(Object.isFrozen(rs.response_headers)).toBe(true)
      await rs.json()
    } finally {
      await c.close()
    }
  })
})
