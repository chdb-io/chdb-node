import { describe, it, expect, afterEach } from 'vitest'
import { queryAsync, Session } from '../../index.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Arrow output (Item 4, M1: format=arrow -> IPC + toArrow)', () => {
  it("emits intact Arrow IPC bytes for format 'arrow'", async () => {
    const r = await queryAsync('SELECT number AS n FROM numbers(1000)', { format: 'arrow' })
    const b = r.bytes()
    expect(b.length).toBeGreaterThan(0)
    expect(b.includes(0)).toBe(true) // binary (would be truncated on the sync string path)
  })

  it('toArrow() returns a Table with correct rows and columns', async () => {
    const r = await queryAsync(
      "SELECT number AS n, concat('row', toString(number)) AS s FROM numbers(3)",
      { format: 'arrow' },
    )
    const t: any = r.toArrow()
    expect(t.numRows).toBe(3)
    expect([...t.getChild('s')].map(String)).toEqual(['row0', 'row1', 'row2'])
  })

  it('maps Int64 to bigint in the Arrow path', async () => {
    const r = await queryAsync('SELECT toInt64(9007199254740993) AS n', { format: 'arrow' })
    const t: any = r.toArrow()
    expect(t.getChild('n').get(0)).toBe(9007199254740993n)
  })

  it('maps DateTime to Arrow uint32 (Unix seconds, no timezone) — conversion dropped', async () => {
    const r = await queryAsync("SELECT toDateTime('2026-01-02 03:04:05', 'UTC') AS ts", {
      format: 'arrow',
    })
    const t: any = r.toArrow()
    const expectedSeconds = Math.floor(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000)
    expect(Number(t.getChild('ts').get(0))).toBe(expectedSeconds)
  })
})

describe('Arrow output via session', () => {
  let session: Session | undefined
  afterEach(async () => { session?.close(); session = undefined; await sleep(50) })

  it('Session.queryAsync({format:arrow}).toArrow() works', async () => {
    session = new Session()
    session.query('CREATE TABLE t (id UInt32, v Float64) ENGINE = Memory')
    session.query('INSERT INTO t VALUES (1, 1.5), (2, 2.5)')
    const r = await session.queryAsync('SELECT id, v FROM t ORDER BY id', { format: 'arrow' })
    const t: any = r.toArrow()
    expect(t.numRows).toBe(2)
    expect([...t.getChild('id')].map(Number)).toEqual([1, 2])
    expect([...t.getChild('v')].map(Number)).toEqual([1.5, 2.5])
  })
})
