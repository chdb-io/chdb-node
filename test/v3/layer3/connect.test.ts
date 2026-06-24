import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { selectFrom, connect, session, query, sql } from '../../../index.js'
import { buildSource } from '../../../src/layer3/connect/url-scheme'
import { buildSnapshotNode } from '../../../src/layer3/connect/snapshot'
import { compileDatabases, compileTables, compileDescribe } from '../../../src/layer3/connect/connect'
import { compileExpr, compileQuery } from '../../../src/layer3/compiler/compile'

// connect() maps a connection URL to a ClickHouse table function. The scheme
// picks the function; every host, credential, path, and option is BOUND
// ({pN:Type}) — a connection string never appears as a byte in the SQL. The
// golden tests pin each scheme's mapping; the injection tests prove hostile
// values stay in parameters; the execution tests read real local files.

const table = (cfg: Parameters<typeof buildSource>[0], name?: string) =>
  compileExpr(buildSource(cfg).table(name))

describe('connect — server source mapping (table args are bound)', () => {
  it('clickhouse:// → remote(addr, db, table, user, pw)', () => {
    expect(table({ url: 'clickhouse://u:p@h:9000/prod' }, 'events')).toEqual({
      sql: 'remote({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
      parameters: { p0: 'h:9000', p1: 'prod', p2: 'events', p3: 'u', p4: 'p' },
    })
  })

  it('clickhouse:// with secure → remoteSecure', () => {
    const c = table({ url: 'clickhouse://h:9440', database: 'prod', secure: true }, 'events')
    expect(c.sql).toBe('remoteSecure({p0:String}, {p1:String}, {p2:String})')
    expect(c.parameters).toEqual({ p0: 'h:9440', p1: 'prod', p2: 'events' })
  })

  it('clickhouse-cloud:// → remoteSecure', () => {
    const c = table(
      { url: 'clickhouse-cloud://x.clickhouse.cloud:9440', username: 'default', password: 'pw', database: 'prod' },
      'prod.users',
    )
    expect(c.sql).toBe('remoteSecure({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})')
    // A dotted table name overrides the default database.
    expect(c.parameters).toEqual({ p0: 'x.clickhouse.cloud:9440', p1: 'prod', p2: 'users', p3: 'default', p4: 'pw' })
  })

  it('postgres:// → postgresql(addr, db, table, user, pw)', () => {
    expect(table({ url: 'postgres://u:p@h:5432/app' }, 'users')).toEqual({
      sql: 'postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
      parameters: { p0: 'h:5432', p1: 'app', p2: 'users', p3: 'u', p4: 'p' },
    })
  })

  it('postgres:// with a dotted name adds the schema arg', () => {
    const c = table({ url: 'postgres://u:p@h:5432/app' }, 'reporting.users')
    expect(c.sql).toBe('postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}, {p5:String})')
    expect(c.parameters).toEqual({ p0: 'h:5432', p1: 'app', p2: 'users', p3: 'u', p4: 'p', p5: 'reporting' })
  })

  it('supabase:// uses the service-role key as the password', () => {
    const c = table(
      { url: 'supabase://abc.supabase.co', database: 'postgres', username: 'postgres', serviceRoleKey: 'srk', schema: 'public' },
      'billing',
    )
    expect(c.sql).toBe('postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}, {p5:String})')
    expect(c.parameters).toEqual({ p0: 'abc.supabase.co', p1: 'postgres', p2: 'billing', p3: 'postgres', p4: 'srk', p5: 'public' })
  })

  it('mysql:// → mysql(addr, db, table, user, pw)', () => {
    expect(table({ url: 'mysql://u:p@h:3306/shop' }, 'orders')).toEqual({
      sql: 'mysql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
      parameters: { p0: 'h:3306', p1: 'shop', p2: 'orders', p3: 'u', p4: 'p' },
    })
  })

  it('mongodb:// and mongodb+srv:// → mongodb(addr, db, collection, user, pw)', () => {
    expect(table({ url: 'mongodb://u:p@h:27017/app' }, 'events').sql).toBe(
      'mongodb({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
    )
    expect(table({ url: 'mongodb+srv://u:p@cluster.net/app' }, 'events').parameters).toEqual({
      p0: 'cluster.net',
      p1: 'app',
      p2: 'events',
      p3: 'u',
      p4: 'p',
    })
  })
})

describe('connect — location source mapping', () => {
  it('s3:// → s3(url[, key, secret][, format]); name is ignored', () => {
    expect(table({ url: 's3://b/*.parquet', format: 'Parquet' })).toEqual({
      sql: 's3({p0:String}, {p1:String})',
      parameters: { p0: 's3://b/*.parquet', p1: 'Parquet' },
    })
    const withCreds = table({ url: 's3://b/x', accessKeyId: 'AK', secretAccessKey: 'SK', format: 'CSV' })
    expect(withCreds.sql).toBe('s3({p0:String}, {p1:String}, {p2:String}, {p3:String})')
    expect(withCreds.parameters).toEqual({ p0: 's3://b/x', p1: 'AK', p2: 'SK', p3: 'CSV' })
  })

  it('gcs:// and gs:// → gcs(url, ...)', () => {
    expect(table({ url: 'gcs://b/a.csv', format: 'CSV' }).sql).toBe('gcs({p0:String}, {p1:String})')
    expect(table({ url: 'gs://b/a.csv' }).sql).toBe('gcs({p0:String})')
  })

  it('azureblob:// → azureBlobStorage(url[, format])', () => {
    expect(table({ url: 'azureblob://acct/container/blob', format: 'Parquet' })).toEqual({
      sql: 'azureBlobStorage({p0:String}, {p1:String})',
      parameters: { p0: 'azureblob://acct/container/blob', p1: 'Parquet' },
    })
  })

  it('iceberg://, delta://, hudi:// → lakehouse functions (no format arg)', () => {
    expect(table({ url: 'iceberg://b/t' }).sql).toBe('iceberg({p0:String})')
    expect(table({ url: 'delta://b/t', accessKeyId: 'AK', secretAccessKey: 'SK' }).sql).toBe(
      'deltaLake({p0:String}, {p1:String}, {p2:String})',
    )
    expect(table({ url: 'hudi://b/t' }).sql).toBe('hudi({p0:String})')
  })

  it('http(s):// → url(url[, format])', () => {
    expect(table({ url: 'https://e.com/d.csv', format: 'CSV' })).toEqual({
      sql: 'url({p0:String}, {p1:String})',
      parameters: { p0: 'https://e.com/d.csv', p1: 'CSV' },
    })
  })

  it('file:// → file(path[, format]); the path is the decoded url path', () => {
    expect(table({ url: 'file:///data/x.csv', format: 'CSV' })).toEqual({
      sql: 'file({p0:String}, {p1:String})',
      parameters: { p0: '/data/x.csv', p1: 'CSV' },
    })
  })
})

describe('connect — input validation', () => {
  it('rejects a missing or unsupported url', () => {
    expect(() => buildSource({ url: '' } as any)).toThrow(/requires a non-empty url/)
    expect(() => buildSource({ url: 'redis://h/0' })).toThrow(/Unsupported connect url scheme/)
  })

  it('requires a username and password for postgres/mysql/mongodb', () => {
    expect(() => buildSource({ url: 'postgres://h:5432/app' }).table('users')).toThrow(/username and password/)
    expect(() => buildSource({ url: 'mysql://h:3306/d' }).table('orders')).toThrow(/username and password/)
  })

  it('requires a table name for a server source', () => {
    expect(() => buildSource({ url: 'clickhouse://h:9000/db' }).table()).toThrow(/needs a table name/)
  })

  it('requires both object-storage credentials or neither', () => {
    expect(() => buildSource({ url: 's3://b/x', accessKeyId: 'AK' }).table()).toThrow(/both accessKeyId and secretAccessKey/)
  })
})

describe('connect — injection (urls, credentials, names are bound)', () => {
  const HOSTILE = "'; DROP TABLE users; --"

  it('keeps a hostile password out of the SQL', () => {
    const c = table({ url: 'postgres://h:5432/app', username: 'u', password: HOSTILE }, 'users')
    expect(c.sql).not.toContain('DROP')
    expect(Object.values(c.parameters)).toContain(HOSTILE)
  })

  it('keeps a hostile table name out of the SQL (it is a bound table-function arg)', () => {
    const c = table({ url: 'clickhouse://u:p@h:9000/db' }, HOSTILE)
    expect(c.sql).toBe('remote({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})')
    expect(Object.values(c.parameters)).toContain(HOSTILE)
  })

  it('keeps a hostile url out of the SQL', () => {
    const c = table({ url: `s3://b/x`, accessKeyId: HOSTILE, secretAccessKey: HOSTILE })
    expect(c.sql).not.toContain('DROP')
    expect(Object.values(c.parameters)).toContain(HOSTILE)
  })
})

describe('connect — snapshot (INSERT … SELECT)', () => {
  it('materializes a source table into a local destination', () => {
    const plan = buildSource({ url: 'postgres://u:p@h:5432/app' })
    const compiled = compileQuery(buildSnapshotNode(plan, 'users', 'users_local'))
    expect(compiled).toEqual({
      sql: 'INSERT INTO `users_local` SELECT * FROM postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
      parameters: { p0: 'h:5432', p1: 'app', p2: 'users', p3: 'u', p4: 'p' },
    })
  })

  it('quote-escapes a dotted / hostile destination identifier', () => {
    const plan = buildSource({ url: 's3://b/x', format: 'Parquet' })
    const compiled = compileQuery(buildSnapshotNode(plan, '', 'db.events`local'))
    expect(compiled.sql).toBe('INSERT INTO `db`.`events\\`local` SELECT * FROM s3({p0:String}, {p1:String})')
  })
})

describe('connect — metadata discovery SQL (catalog reads, output column aliased `name`)', () => {
  it('ClickHouse reads system.databases / system.tables', () => {
    expect(compileDatabases(buildSource({ url: 'clickhouse://u:p@h:9000' }))).toEqual({
      sql: 'SELECT `name` AS `name` FROM remote({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}) ORDER BY `name` ASC',
      parameters: { p0: 'h:9000', p1: 'system', p2: 'databases', p3: 'u', p4: 'p' },
    })
    const tbl = compileTables(buildSource({ url: 'clickhouse://h:9000' }), 'prod')
    expect(tbl.sql).toBe(
      'SELECT `name` AS `name` FROM remote({p0:String}, {p1:String}, {p2:String}) WHERE `database` = {p3:String} ORDER BY `name` ASC',
    )
    expect(tbl.parameters).toEqual({ p0: 'h:9000', p1: 'system', p2: 'tables', p3: 'prod' })
  })

  it('Postgres reads information_schema.schemata / .tables (schemas are its databases)', () => {
    expect(compileDatabases(buildSource({ url: 'postgres://u:p@h:5432/app' })).sql).toBe(
      'SELECT `schema_name` AS `name` FROM postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}, {p5:String}) ORDER BY `name` ASC',
    )
    const tbl = compileTables(buildSource({ url: 'postgres://u:p@h:5432/app' }), 'public')
    expect(tbl.sql).toBe(
      'SELECT `table_name` AS `name` FROM postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}, {p5:String}) WHERE `table_schema` = {p6:String} ORDER BY `name` ASC',
    )
    expect(tbl.parameters).toEqual({ p0: 'h:5432', p1: 'app', p2: 'tables', p3: 'u', p4: 'p', p5: 'information_schema', p6: 'public' })
  })

  it('MySQL reads information_schema.SCHEMATA / .TABLES (upper-case relations/columns)', () => {
    expect(compileDatabases(buildSource({ url: 'mysql://u:p@h:3306/shop' })).sql).toBe(
      'SELECT `SCHEMA_NAME` AS `name` FROM mysql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}) ORDER BY `name` ASC',
    )
    const tbl = compileTables(buildSource({ url: 'mysql://u:p@h:3306/shop' }), 'shop')
    expect(tbl.sql).toBe(
      'SELECT `TABLE_NAME` AS `name` FROM mysql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}) WHERE `TABLE_SCHEMA` = {p5:String} ORDER BY `name` ASC',
    )
    expect(tbl.parameters).toEqual({ p0: 'h:3306', p1: 'information_schema', p2: 'TABLES', p3: 'u', p4: 'p', p5: 'shop' })
  })

  it('describe() compiles DESCRIBE TABLE over any source', () => {
    const c = compileDescribe(buildSource({ url: 'file:///d/x.csv', format: 'CSV' }))
    expect(c).toEqual({
      sql: 'DESCRIBE TABLE file({p0:String}, {p1:String})',
      parameters: { p0: '/d/x.csv', p1: 'CSV' },
    })
  })

  it('databases()/tables() reject sources without a SQL catalog', () => {
    expect(() => compileDatabases(buildSource({ url: 'mongodb://u:p@h/app' }))).toThrow(/not available for a mongodb source/)
    expect(() => compileTables(buildSource({ url: 's3://b/x' }))).toThrow(/not available for a s3 source/)
  })
})

describe('connect — config field arbitration (mirrors Layer 2)', () => {
  it('forwards clickhouseSettings to the chDB engine as a SETTINGS clause', () => {
    const plan = buildSource({ url: 'clickhouse://u:p@h:9000' })
    expect(compileDatabases(plan, { max_threads: 4 }).sql).toMatch(/ SETTINGS max_threads = 4$/)
    expect(compileTables(plan, 'prod', { max_threads: 4 }).sql).toMatch(/ SETTINGS max_threads = 4$/)
    expect(compileDescribe(buildSource({ url: 'file:///d/x.csv' }), undefined, { max_memory_usage: 1000 }).sql).toBe(
      'DESCRIBE TABLE file({p0:String}) SETTINGS max_memory_usage = 1000',
    )
    const snap = compileQuery(
      buildSnapshotNode(buildSource({ url: 'postgres://u:p@h:5432/app' }), 'users', 'dst', { max_threads: 2 }),
    )
    expect(snap.sql).toMatch(/ SETTINGS max_threads = 2$/)
  })

  it('accepts remote-only fields without error and never emits them in SQL', () => {
    // region/sessionToken/headers/catalogConfig have no table-function slot and
    // do not change what the local engine executes, so they are ignored.
    const c = table({
      url: 's3://b/x',
      region: 'us-east-1',
      sessionToken: 'tok',
      headers: { Authorization: 'secret' },
      catalogConfig: { uri: 'https://catalog' },
    })
    expect(c).toEqual({ sql: 's3({p0:String})', parameters: { p0: 's3://b/x' } })
    expect(JSON.stringify(c)).not.toMatch(/us-east-1|tok|secret|catalog/)
  })
})

describe('connect — execution against real local files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-connect-'))
  const users = join(dir, 'users.csv')
  const events = join(dir, 'events.csv')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  beforeEach(() => {
    writeFileSync(users, 'id,country\n1,US\n2,FR\n3,US\n')
    writeFileSync(events, 'uid,action\n1,login\n1,buy\n3,login\n')
  })

  it('reads rows through a file:// connection', async () => {
    const conn = connect({ url: `file://${users}`, format: 'CSVWithNames' })
    const rows = (await selectFrom(conn.table().as('u'))
      .select('country')
      .where('country', '=', 'US')
      .orderBy('country')
      .execute()) as { country: string }[]
    expect(rows).toEqual([{ country: 'US' }, { country: 'US' }])
  })

  it('describe() returns the inferred columns', async () => {
    const conn = connect({ url: `file://${users}`, format: 'CSVWithNames' })
    const cols = await conn.describe()
    expect(cols.map((c) => c.name)).toContain('country')
  })

  it('joins two file:// connections (cross-source JOIN)', async () => {
    const u = connect({ url: `file://${users}`, format: 'CSVWithNames' })
    const e = connect({ url: `file://${events}`, format: 'CSVWithNames' })
    const rows = (await selectFrom(u.table().as('u'))
      .innerJoin(e.table().as('e'), 'u.id', 'e.uid')
      .select(['u.country', 'e.action'])
      .orderBy('e.action')
      .execute()) as { country: string; action: string }[]
    expect(rows).toEqual([
      { country: 'US', action: 'buy' },
      { country: 'US', action: 'login' },
      { country: 'US', action: 'login' },
    ])
  })

  it('snapshot() materializes a file source into a local table', async () => {
    const db = session()
    try {
      await db.session!.queryAsync('CREATE TABLE snap (id Int64, country String) ENGINE = Memory')
      const conn = db.connect({ url: `file://${users}`, format: 'CSVWithNames' })
      await conn.snapshot('', { destination: 'snap' })
      const rows = (await db.selectFrom('snap').select('country').orderBy('id').execute()) as {
        country: string
      }[]
      expect(rows).toEqual([{ country: 'US' }, { country: 'FR' }, { country: 'US' }])
    } finally {
      db.close()
    }
  })
})

// Real federation against live Postgres / MySQL servers. These prove the table
// functions, metadata catalogs, snapshots, and cross-source joins work against
// actual databases — not just that the SQL looks right. They skip cleanly when
// no server is reachable (e.g. a CI job without the services), and the URLs are
// overridable so CI can point at its own instances.
const PG_URL = process.env.CHDB_TEST_PG_URL ?? 'postgres://postgres:pw@127.0.0.1:55432/app'
const MY_URL = process.env.CHDB_TEST_MYSQL_URL ?? 'mysql://app:pw@127.0.0.1:33060/shop'

function reachable(probe: string): boolean {
  try {
    query(probe, 'CSV')
    return true
  } catch {
    return false
  }
}

const PG_OK = reachable(`SELECT 1 FROM ${tfn(PG_URL, 'users')} LIMIT 1`)
const MY_OK = reachable(`SELECT 1 FROM ${tfn(MY_URL, 'orders')} LIMIT 1`)

// Build the raw probe table-function call from a connection url (so the probe
// and the public connect() path read the same servers).
function tfn(url: string, name: string): string {
  const c = compileExpr(buildSource({ url }).table(name))
  let sql = c.sql
  // Inline the bound probe params (probe only — the library never does this).
  for (const [k, v] of Object.entries(c.parameters)) {
    sql = sql.replace(`{${k}:String}`, `'${String(v).replace(/'/g, "''")}'`)
  }
  return sql
}

describe.skipIf(!PG_OK)('connect — live Postgres federation', () => {
  it('reads rows through a postgres:// connection', async () => {
    const pg = connect({ url: PG_URL })
    const rows = (await selectFrom(pg.table('users').as('u'))
      .select('country')
      .where('country', '=', 'US')
      .orderBy('country')
      .execute()) as { country: string }[]
    expect(rows).toEqual([{ country: 'US' }, { country: 'US' }])
  })

  it('databases() lists schemas and tables(schema) lists tables', async () => {
    const pg = connect({ url: PG_URL })
    expect(await pg.databases()).toContain('public')
    expect(await pg.tables('public')).toContain('users')
  })

  it('describe() returns the inferred columns', async () => {
    const cols = await connect({ url: PG_URL }).describe('users')
    expect(cols.map((c) => c.name)).toEqual(['id', 'country'])
  })

  it('snapshot() materializes a remote table into a local one', async () => {
    const db = session()
    try {
      await db.session!.queryAsync('CREATE TABLE snap (id Int64, country String) ENGINE = Memory')
      await db.connect({ url: PG_URL }).snapshot('users', { destination: 'snap' })
      const n = (await db.selectFrom('snap').select('country').where('country', '=', 'US').execute()) as unknown[]
      expect(n).toHaveLength(2)
    } finally {
      db.close()
    }
  })
})

describe.skipIf(!MY_OK)('connect — live MySQL federation', () => {
  it('reads rows and lists the catalog', async () => {
    const my = connect({ url: MY_URL })
    const rows = (await selectFrom(my.table('orders').as('o'))
      .select('country')
      .where('country', '=', 'US')
      .orderBy('country')
      .execute()) as { country: string }[]
    expect(rows).toEqual([{ country: 'US' }, { country: 'US' }])
    expect(await my.databases()).toContain('shop')
    expect(await my.tables('shop')).toContain('orders')
  })
})

describe.skipIf(!(PG_OK && MY_OK))('connect — cross-source JOIN (Postgres × MySQL)', () => {
  it('joins a Postgres table to a MySQL table through the local engine', async () => {
    const pg = connect({ url: PG_URL })
    const my = connect({ url: MY_URL })
    const rows = (await selectFrom(pg.table('users').as('u'))
      .innerJoin(my.table('orders').as('o'), 'u.id', 'o.id')
      .select(['u.id', sql.raw('`u`.`country`').as('pg_country'), sql.raw('`o`.`country`').as('my_country')])
      .orderBy('u.id')
      .execute()) as { id: string; pg_country: string; my_country: string }[]
    expect(rows).toEqual([
      { id: '1', pg_country: 'US', my_country: 'US' },
      { id: '2', pg_country: 'FR', my_country: 'FR' },
      { id: '3', pg_country: 'US', my_country: 'US' },
    ])
  })
})
