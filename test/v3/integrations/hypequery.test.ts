import { describe, it, expect, beforeEach } from 'vitest'
import { createQueryBuilder } from '@hypequery/clickhouse'
import { Session } from '../../../index.js'
// @ts-ignore - .mjs adapter has a sibling .d.mts; vitest resolves the runtime file
import { chdbAdapter } from '../../../integrations/hypequery.mjs'

// Runs hypequery's own query builder against embedded chDB through the adapter.
// hypequery renders final SQL (?-positional params) and the adapter executes it
// on chDB, returning JSONEachRow rows.

let s: Session
let db: ReturnType<typeof createQueryBuilder>

beforeEach(() => {
  s = new Session()
  s.query(`CREATE TABLE trips (trip_id String, passenger_count UInt8, total_amount Float64) ENGINE = MergeTree ORDER BY trip_id`)
  s.query(`INSERT INTO trips VALUES ('a',1,10),('b',2,20),('c',2,35),('d',4,50)`)
  db = createQueryBuilder({ adapter: chdbAdapter({ session: s }) })
})

describe('chdb/hypequery', () => {
  it('runs a builder query (filter + aggregate + group + order) on chDB', async () => {
    const rows = await (db as any)
      .table('trips')
      .where('passenger_count', 'gte', 2)
      .select(['passenger_count'])
      .count('trip_id', 'trip_count')
      .sum('total_amount', 'revenue')
      .groupBy(['passenger_count'])
      .orderBy('passenger_count', 'ASC')
      .execute()
    expect(rows).toEqual([
      { passenger_count: 2, trip_count: 2, revenue: 55 },
      { passenger_count: 4, trip_count: 1, revenue: 50 },
    ])
  })

  it('binds where-values through hypequery rendering (no injection of raw input)', async () => {
    const rows = await (db as any).table('trips').select(['trip_id']).where('trip_id', 'eq', "a' OR '1'='1").execute()
    expect(rows).toEqual([]) // the value is escaped, not interpreted as SQL
  })

  it('rawQuery passes through to chDB', async () => {
    const r = await (db as any).rawQuery('SELECT count() AS n FROM trips')
    expect(r).toEqual([{ n: 4 }])
  })

  it('streams rows as a ReadableStream<T[]>', async () => {
    const stream = await (db as any).table('trips').select(['trip_id']).orderBy('trip_id', 'ASC').stream()
    const ids: string[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const row of value) ids.push(row.trip_id)
    }
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
  })
})
