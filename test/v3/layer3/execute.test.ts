import { describe, it, expect, beforeEach } from 'vitest'
import { session, sql } from '../../../index.js'

// Execution-correctness: run compiled SQL on real chDB through a bound Session
// and assert rows / types / order. Focus on ClickHouse-unique types so the
// precision-safe JS↔CH mapping is verified end to end.
//
// The global afterEach (setup.ts) force-closes every session after each test
// (single-connection constraint), so the fixture is rebuilt per test — chDB is
// fast enough that re-seeding a tiny table is negligible.

let db: ReturnType<typeof session>

beforeEach(async () => {
  db = session()
  await db.session!.queryAsync(
    `CREATE TABLE t (
       id UInt64,
       name String,
       score Float64,
       tags Array(String),
       maybe Nullable(Int32),
       ts DateTime
     ) ENGINE = MergeTree ORDER BY id`,
    { format: 'CSV' },
  )
  await db
    .insertInto('t')
    .values([
      { id: 1, name: "O'Brien", score: 1.5, tags: ['a', 'b'], maybe: 7, ts: '2024-01-02 03:04:05' },
      { id: 2, name: 'Bob', score: 2.5, tags: [], maybe: null, ts: '2024-06-07 08:09:10' },
      { id: 18446744073709551615n as unknown as number, name: 'Max', score: 0, tags: ['x'], maybe: 0, ts: '2020-01-01 00:00:00' },
    ])
    .execute()
})

describe('execute — round-trips', () => {
  it('filters with a bound value and returns matching rows', async () => {
    const rows = await db.selectFrom('t').select(['id', 'name']).where('name', '=', "O'Brien").execute()
    expect(rows).toEqual([{ id: '1', name: "O'Brien" }])
  })

  it('keeps 64-bit ids as strings (precision-safe), big value intact', async () => {
    const rows = (await db.selectFrom('t').select('id').orderBy('id').execute()) as { id: string }[]
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '18446744073709551615'])
  })

  it('maps Array, Nullable, and DateTime correctly', async () => {
    const row = (await db
      .selectFrom('t')
      .select(['tags', 'maybe', 'ts'])
      .where('id', '=', 2)
      .executeTakeFirst()) as { tags: string[]; maybe: number | null; ts: string } | undefined
    expect(row).toEqual({ tags: [], maybe: null, ts: '2024-06-07 08:09:10' })
  })

  it('groups and aggregates with HAVING', async () => {
    const rows = (await db
      .selectFrom('t')
      .select([sql`count()`.as('c')])
      .where('score', '>', 1)
      .execute()) as { c: string }[]
    expect(rows[0]!.c).toBe('2')
  })

  it('binds an IN list as one Array parameter', async () => {
    const rows = await db.selectFrom('t').select('id').where('id', 'in', [1, 2]).orderBy('id').execute()
    expect(rows).toEqual([{ id: '1' }, { id: '2' }])
  })

  it('executeTakeFirstOrThrow throws on an empty result', async () => {
    await expect(
      db.selectFrom('t').select('id').where('id', '=', 999).executeTakeFirstOrThrow(),
    ).rejects.toThrow(/no rows/)
  })

  it('returns an Arrow Table for { format: "arrow" }', async () => {
    const table = (await db.selectFrom('t').select('id').execute({ format: 'arrow' })) as {
      numRows: number
    }
    expect(table.numRows).toBe(3)
  })

  it('runs an UPDATE mutation and reflects it', async () => {
    await db.updateTable('t').set({ name: 'Robert' }).where('id', '=', 2).execute()
    const row = (await db
      .selectFrom('t')
      .select('name')
      .where('id', '=', 2)
      .executeTakeFirst()) as { name: string } | undefined
    expect(row).toEqual({ name: 'Robert' })
  })
})
