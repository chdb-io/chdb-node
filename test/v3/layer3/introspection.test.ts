import { describe, it, expect, beforeEach } from 'vitest'
import { session } from '../../../index.js'

// Kysely-style `db.introspection` against the real local engine: create a
// table and a view on a bound Session, then assert getSchemas / getTables /
// getMetadata reflect them. The global afterEach (setup.ts) force-closes every
// session, so the fixture is rebuilt per test.

let db: ReturnType<typeof session>

beforeEach(async () => {
  db = session()
  await db.session!.queryAsync(
    `CREATE TABLE events (
       id UInt64,
       name String,
       maybe Nullable(Int32),
       created DateTime DEFAULT now()
     ) ENGINE = MergeTree ORDER BY id`,
    { format: 'CSV' },
  )
  await db.session!.queryAsync('CREATE VIEW events_v AS SELECT id, name FROM events', {
    format: 'CSV',
  })
})

describe('db.introspection — local engine', () => {
  it('getSchemas lists databases including default and system', async () => {
    const names = (await db.introspection.getSchemas()).map((s) => s.name)
    expect(names).toContain('default')
    expect(names).toContain('system')
  })

  it('getTables excludes system databases by default and returns the user table', async () => {
    const tables = await db.introspection.getTables()
    expect(tables.every((t) => t.schema !== 'system')).toBe(true)
    const events = tables.find((t) => t.name === 'events')
    expect(events).toBeDefined()
    expect(events!.schema).toBe('default')
    expect(events!.isView).toBe(false)
  })

  it('marks a VIEW with isView', async () => {
    const tables = await db.introspection.getTables()
    const view = tables.find((t) => t.name === 'events_v')
    expect(view).toBeDefined()
    expect(view!.isView).toBe(true)
  })

  it('reports column metadata (type, nullability, defaults) in storage order', async () => {
    const events = (await db.introspection.getTables()).find((t) => t.name === 'events')!
    expect(events.columns.map((c) => c.name)).toEqual(['id', 'name', 'maybe', 'created'])

    const maybe = events.columns.find((c) => c.name === 'maybe')!
    expect(maybe.dataType).toBe('Nullable(Int32)')
    expect(maybe.isNullable).toBe(true)

    const id = events.columns.find((c) => c.name === 'id')!
    expect(id.isNullable).toBe(false)
    expect(id.isAutoIncrementing).toBe(false)

    const created = events.columns.find((c) => c.name === 'created')!
    expect(created.hasDefaultValue).toBe(true)
  })

  it('getMetadata wraps getTables', async () => {
    const meta = await db.introspection.getMetadata()
    expect(meta.tables.some((t) => t.name === 'events')).toBe(true)
  })

  it('withSystemTables includes the system database', async () => {
    const tables = await db.introspection.getTables({ withSystemTables: true })
    expect(tables.some((t) => t.schema === 'system')).toBe(true)
  })
})
