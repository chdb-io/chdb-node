import { describe, it, expect } from 'vitest'
import {
  selectFrom,
  insertInto,
  updateTable,
  deleteFrom,
  sql,
  fn,
  ref,
  val,
} from '../../../index.js'

// Golden-SQL tests: assert .compile()'s { sql, parameters } exactly. Every user
// value must show up as a {pN:Type} placeholder in the SQL and as a separate
// entry in parameters — so the zero-interpolation rule is auditable at a glance.

describe('SELECT compilation', () => {
  it('compiles the canonical filtered, ordered, limited query', () => {
    const q = selectFrom('events').where('country', '=', 'US').limit(10)
    expect(q.compile()).toEqual({
      sql: 'SELECT * FROM `events` WHERE `country` = {p0:String} LIMIT 10',
      parameters: { p0: 'US' },
    })
  })

  it('quotes dotted identifiers segment by segment', () => {
    const q = selectFrom('db.events').select('events.country')
    expect(q.compile().sql).toBe('SELECT `events`.`country` FROM `db`.`events`')
  })

  it('accumulates projections and supports aliases via "as"', () => {
    const q = selectFrom('t').select(['a', 'b as bee']).select('c')
    expect(q.compile().sql).toBe('SELECT `a`, `b` AS `bee`, `c` FROM `t`')
  })

  it('chains AND / OR predicates with flattening and grouping', () => {
    const q = selectFrom('t')
      .where('a', '=', 1)
      .andWhere('b', '>', 2)
      .orWhere('c', '<', 3)
    expect(q.compile()).toEqual({
      sql: 'SELECT * FROM `t` WHERE ((`a` = {p0:Int64} AND `b` > {p1:Int64}) OR `c` < {p2:Int64})',
      parameters: { p0: 1, p1: 2, p2: 3 },
    })
  })

  it('binds an IN list as a single Array parameter', () => {
    const q = selectFrom('t').where('id', 'in', [1, 2, 3])
    expect(q.compile()).toEqual({
      sql: 'SELECT * FROM `t` WHERE `id` IN {p0:Array(Int64)}',
      parameters: { p0: [1, 2, 3] },
    })
  })

  it('compiles joins with ON key equality', () => {
    const q = selectFrom('users as u')
      .innerJoin('orders as o', 'u.id', 'o.user_id')
      .leftJoin('refunds as r', 'o.id', 'r.order_id')
      .select(['u.name', 'o.total'])
    expect(q.compile().sql).toBe(
      'SELECT `u`.`name`, `o`.`total` FROM `users` AS `u` ' +
        'INNER JOIN `orders` AS `o` ON `u`.`id` = `o`.`user_id` ' +
        'LEFT JOIN `refunds` AS `r` ON `o`.`id` = `r`.`order_id`',
    )
  })

  it('compiles group by / having / order by / offset', () => {
    const q = selectFrom('t')
      .select(['country', sql`count()`.as('c')])
      .groupBy('country')
      .having('c', '>', 100)
      .orderBy('c', 'desc')
      .limit(5)
      .offset(10)
    expect(q.compile()).toEqual({
      sql:
        'SELECT `country`, count() AS `c` FROM `t` GROUP BY `country` ' +
        'HAVING `c` > {p0:Int64} ORDER BY `c` DESC LIMIT 5 OFFSET 10',
      parameters: { p0: 100 },
    })
  })

  it('supports DISTINCT and set operations with unique placeholders', () => {
    const a = selectFrom('t').select('x').where('x', '>', 1).distinct()
    const b = selectFrom('u').select('y').where('y', '<', 9)
    expect(a.unionAll(b).compile()).toEqual({
      sql:
        'SELECT DISTINCT `x` FROM `t` WHERE `x` > {p0:Int64} ' +
        'UNION ALL SELECT `y` FROM `u` WHERE `y` < {p1:Int64}',
      parameters: { p0: 1, p1: 9 },
    })
  })

  it('compiles a subquery source via .as()', () => {
    const sub = selectFrom('t').select('id').where('id', '>', 0)
    const q = selectFrom(sub.as('s')).select('s.id')
    expect(q.compile()).toEqual({
      sql: 'SELECT `s`.`id` FROM (SELECT `id` FROM `t` WHERE `id` > {p0:Int64}) AS `s`',
      parameters: { p0: 0 },
    })
  })

  it('binds explicit types via val() and references via ref()', () => {
    const q = selectFrom('t').where('id', '=', val(7, 'UInt64')).where('a', '=', ref('b'))
    expect(q.compile()).toEqual({
      sql: 'SELECT * FROM `t` WHERE (`id` = {p0:UInt64} AND `a` = `b`)',
      parameters: { p0: 7 },
    })
  })

  it('binds sql`` interpolations but not fn() column refs', () => {
    const q = selectFrom('t').select(fn('toStartOfDay', ['ts']).as('d')).where(sql`age > ${18}`)
    expect(q.compile()).toEqual({
      sql: 'SELECT toStartOfDay(`ts`) AS `d` FROM `t` WHERE age > {p0:Int64}',
      parameters: { p0: 18 },
    })
  })
})

describe('mutation compilation', () => {
  it('compiles UPDATE to an ALTER TABLE … UPDATE mutation', () => {
    const q = updateTable('t').set({ n: 99, name: 'x' }).where('id', '=', 1)
    expect(q.compile()).toEqual({
      sql: 'ALTER TABLE `t` UPDATE `n` = {p0:Int64}, `name` = {p1:String} WHERE `id` = {p2:Int64}',
      parameters: { p0: 99, p1: 'x', p2: 1 },
    })
  })

  it('compiles DELETE to an ALTER TABLE … DELETE mutation', () => {
    const q = deleteFrom('t').where('id', 'in', [2, 3])
    expect(q.compile()).toEqual({
      sql: 'ALTER TABLE `t` DELETE WHERE `id` IN {p0:Array(Int64)}',
      parameters: { p0: [2, 3] },
    })
  })

  it('compiles INSERT … SELECT', () => {
    const q = insertInto('dst')
      .columns(['id', 'v'])
      .values(selectFrom('src').select(['id', 'v']).where('v', '>', 0))
    expect(q.compile()).toEqual({
      sql: 'INSERT INTO `dst` (`id`, `v`) SELECT `id`, `v` FROM `src` WHERE `v` > {p0:Int64}',
      parameters: { p0: 0 },
    })
  })

  it('refuses an unguarded UPDATE / DELETE at compile time', () => {
    expect(() => updateTable('t').set({ n: 1 }).compile()).toThrow(/requires a \.where/)
    expect(() => deleteFrom('t').compile()).toThrow(/requires a \.where/)
  })
})
