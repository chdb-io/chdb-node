import { describe, it, expect, afterEach } from 'vitest'
import { Session, version } from '../../index.js'

// End-to-end scenario stitching the whole v3 surface together the way a real
// app would: create -> insert (mixed types) -> bound filter -> async aggregate
// -> streaming -> Arrow output. A system-style test rather than a unit test.

describe('end-to-end: events analytics pipeline', () => {
  let session: Session
  afterEach(() => session?.close())

  it('runs create -> insert -> queryBind -> queryAsync -> stream -> arrow consistently', async () => {
    session = new Session()
    session.query(`
      CREATE TABLE events (
        id Int64, user String, amount UInt32, tags Array(String), ts DateTime
      ) ENGINE = MergeTree() ORDER BY id
    `)

    // insert mixed types (bigint, array, Date)
    const summary = await session.insert({
      table: 'events',
      values: [
        { id: 1n, user: 'alice', amount: 100, tags: ['a', 'b'], ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)) },
        { id: 2n, user: 'bob', amount: 50, tags: [], ts: new Date(Date.UTC(2026, 0, 1, 1, 0, 0)) },
        { id: 3n, user: 'alice', amount: 200, tags: ['a'], ts: new Date(Date.UTC(2026, 0, 2, 0, 0, 0)) },
      ],
    })
    expect(summary.rowsWritten).toBe(3)

    // bound filter (server-side params)
    expect(
      session.queryBind('SELECT count() FROM events WHERE user = {u:String}', { u: 'alice' }, 'CSV').trim(),
    ).toBe('2')

    // async aggregate as JSON
    const agg = await session.queryAsync(
      'SELECT user, sum(amount) AS total FROM events GROUP BY user ORDER BY total DESC',
      { format: 'JSONEachRow' },
    )
    const rows = agg.text().trim().split('\n').map((l) => JSON.parse(l))
    expect(rows[0]).toMatchObject({ user: 'alice', total: 300 })

    // streaming
    const ids: number[] = []
    for await (const row of session.queryStream('SELECT id FROM events ORDER BY id').rows<{ id: string }>()) {
      ids.push(Number(row.id))
    }
    expect(ids).toEqual([1, 2, 3])

    // Arrow output
    const arrow = await session.queryAsync('SELECT id, amount FROM events ORDER BY id', { format: 'arrow' })
    const table: any = arrow.toArrow()
    expect(table.numRows).toBe(3)
    expect([...table.getChild('amount')].map(Number)).toEqual([100, 50, 200])
    // Int64 column -> bigint in Arrow
    expect(table.getChild('id').get(0)).toBe(1n)

    // diagnostics (libchdb is probed lazily and is 'unknown' while a session
    // holds the single connection — assert the always-available fields here)
    const v = version()
    expect(typeof v.chdb).toBe('string')
    expect(v.platform).toBe(process.platform)
  })
})
