import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { selectFrom, chTable, chFn, session } from '../../../index.js'

// Table-function and CH-function helpers. Their arguments bind server-side like
// any value (table-function args included), so the golden SQL shows only
// placeholders; one execution test reads a real local file through file().

describe('chTable — compilation (arguments are bound)', () => {
  it('numbers(count) and numbers(start, count)', () => {
    expect(selectFrom(chTable.numbers(5).as('t')).select('number').compile()).toEqual({
      sql: 'SELECT `number` FROM numbers({p0:UInt64}) AS `t`',
      parameters: { p0: 5 },
    })
    expect(selectFrom(chTable.numbers(10, 5).as('t')).selectAll().compile().parameters).toEqual({
      p0: 10,
      p1: 5,
    })
  })

  it('s3 with and without credentials keeps the URL out of the SQL', () => {
    const noCreds = selectFrom(chTable.s3({ url: 's3://b/*.parquet', format: 'Parquet' }).as('e'))
      .selectAll()
      .compile()
    expect(noCreds).toEqual({
      sql: 'SELECT * FROM s3({p0:String}, {p1:String}) AS `e`',
      parameters: { p0: 's3://b/*.parquet', p1: 'Parquet' },
    })
    const withCreds = selectFrom(
      chTable.s3({ url: 's3://b/x', accessKeyId: 'AK', secretAccessKey: 'SK', format: 'CSV' }).as('e'),
    )
      .selectAll()
      .compile()
    expect(withCreds.parameters).toEqual({ p0: 's3://b/x', p1: 'AK', p2: 'SK', p3: 'CSV' })
    expect(withCreds.sql).not.toContain('SK')
  })

  it('postgresql binds host/db/table/auth', () => {
    const q = selectFrom(
      chTable.postgresql({ host: 'h:5432', database: 'd', table: 'u', user: 'usr', password: 'pw' }).as('p'),
    ).selectAll()
    expect(q.compile()).toEqual({
      sql: 'SELECT * FROM postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}) AS `p`',
      parameters: { p0: 'h:5432', p1: 'd', p2: 'u', p3: 'usr', p4: 'pw' },
    })
  })
})

describe('chFn — compilation', () => {
  it('argMax / argMin / uniqExact take column references', () => {
    expect(selectFrom('t').select(chFn.argMax('name', 'score').as('m')).compile().sql).toBe(
      'SELECT argMax(`name`, `score`) AS `m` FROM `t`',
    )
    expect(selectFrom('t').select(chFn.uniqExact('a', 'b').as('u')).compile().sql).toBe(
      'SELECT uniqExact(`a`, `b`) AS `u` FROM `t`',
    )
  })

  it('parametric aggregates render name(params)(args) with bound params', () => {
    expect(selectFrom('t').select(chFn.topK(3, 'country').as('k')).compile()).toEqual({
      sql: 'SELECT topK({p0:Int64})(`country`) AS `k` FROM `t`',
      parameters: { p0: 3 },
    })
    expect(selectFrom('t').select(chFn.quantileTDigest(0.9, 'latency').as('q')).compile()).toEqual({
      sql: 'SELECT quantileTDigest({p0:Float64})(`latency`) AS `q` FROM `t`',
      parameters: { p0: 0.9 },
    })
  })

  it('sequenceMatch binds the pattern string (not a column ref)', () => {
    const q = selectFrom('t').select(chFn.sequenceMatch('(?1)(?2)', 'ts', 'a', 'b').as('s'))
    expect(q.compile()).toEqual({
      sql: 'SELECT sequenceMatch({p0:String})(`ts`, `a`, `b`) AS `s` FROM `t`',
      parameters: { p0: '(?1)(?2)' },
    })
  })
})

describe('chTable — execution against a real local file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-tf-'))
  const csv = join(dir, 'data.csv')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  let db: ReturnType<typeof session>
  beforeEach(() => {
    writeFileSync(csv, '1,US\n2,FR\n3,US\n')
    db = session()
  })

  it('reads rows through file() with a bound path', async () => {
    const rows = (await db
      .selectFrom(chTable.file({ path: csv, format: 'CSV', structure: 'id UInt64, country String' }).as('f'))
      .select(['id', 'country'])
      .where('country', '=', 'US')
      .orderBy('id')
      .execute()) as { id: string; country: string }[]
    expect(rows).toEqual([
      { id: '1', country: 'US' },
      { id: '3', country: 'US' },
    ])
  })
})
