import { describe, it, expect, beforeEach } from 'vitest'
import { selectFrom, session } from '../../../index.js'

// ClickHouse dialect sugar: FINAL / SAMPLE / PREWHERE / SETTINGS / FORMAT /
// LIMIT BY. Golden-SQL for clause placement, plus execution where the behaviour
// is observable (FINAL dedup, LIMIT BY per-group).

describe('dialect sugar — compilation', () => {
  it('places FINAL and SAMPLE on the FROM clause', () => {
    const q = selectFrom('t').final().sample(0.1).selectAll()
    expect(q.compile().sql).toBe('SELECT * FROM `t` FINAL SAMPLE 0.1')
  })

  it('emits PREWHERE before WHERE, both bound', () => {
    const q = selectFrom('t').prewhere('a', '=', 1).where('b', '=', 2)
    expect(q.compile()).toEqual({
      sql: 'SELECT * FROM `t` PREWHERE `a` = {p0:Int64} WHERE `b` = {p1:Int64}',
      parameters: { p0: 1, p1: 2 },
    })
  })

  it('appends a SETTINGS clause, merging across calls', () => {
    const q = selectFrom('t').settings({ max_threads: 8 }).settings({ max_block_size: 1000 })
    expect(q.compile().sql).toBe('SELECT * FROM `t` SETTINGS max_threads = 8, max_block_size = 1000')
  })

  it('emits a SQL-level FORMAT clause distinct from execute({format})', () => {
    const q = selectFrom('t').select('a').format('JSONEachRow')
    expect(q.compile().sql).toBe('SELECT `a` FROM `t` FORMAT JSONEachRow')
  })

  it('emits LIMIT BY independently of the trailing LIMIT', () => {
    const q = selectFrom('t').limitBy(1, ['country', 'city']).limit(100)
    expect(q.compile().sql).toBe('SELECT * FROM `t` LIMIT 1 BY `country`, `city` LIMIT 100')
  })

  it('rejects an invalid SETTINGS name at compile time', () => {
    expect(() => selectFrom('t').settings({ 'bad name': 1 } as never).compile()).toThrow(
      /Invalid setting name/,
    )
  })
})

describe('dialect sugar — execution', () => {
  let db: ReturnType<typeof session>
  beforeEach(async () => {
    db = session()
    await db.session!.queryAsync(
      'CREATE TABLE r (id UInt64, v UInt64) ENGINE = ReplacingMergeTree(v) ORDER BY id',
      { format: 'CSV' },
    )
    await db.insertInto('r').values([{ id: 1, v: 1 }]).execute()
    await db.insertInto('r').values([{ id: 1, v: 2 }]).execute()
  })

  it('FINAL collapses replaced rows', async () => {
    const withFinal = (await db.selectFrom('r').select('v').final().execute()) as { v: string }[]
    expect(withFinal).toEqual([{ v: '2' }])
  })

  it('LIMIT BY keeps one row per group', async () => {
    await db.insertInto('r').values([{ id: 2, v: 9 }]).execute()
    const rows = (await db
      .selectFrom('r')
      .select(['id', 'v'])
      .final()
      .limitBy(1, 'id')
      .orderBy('id')
      .execute()) as { id: string; v: string }[]
    expect(rows.map((r) => r.id)).toEqual(['1', '2'])
  })
})
