import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePrismaSchema, parseDrizzleFile, parseDrizzleSource, emitDatabase } from '../../../index.js'
import { main } from '../../../src/layer3/codegen/cli'

// Static conversion: a .prisma / .ts schema file → IntrospectedDatabase. The
// output is the same shape as runtime introspection (`introspectDatabase`), so
// it drops into `emitDatabase` and into `database<Db>()` unchanged.

const FIXTURE_DIR = join(__dirname, 'fixtures')
const PRISMA_FIXTURE = join(FIXTURE_DIR, 'prisma-schema.prisma')
const DRIZZLE_FIXTURE = join(FIXTURE_DIR, 'drizzle-schema.ts')

describe('from-prisma', () => {
  it('maps each scalar / modifier per the Prisma → CH table', () => {
    const db = parsePrismaSchema(readFileSync(PRISMA_FIXTURE, 'utf-8'))
    expect(Object.keys(db).sort()).toEqual(['Post', 'User'])
    expect(db.User).toEqual({
      id: 'Int32',
      bigId: 'Int64',
      email: 'String',
      name: 'Nullable(String)',
      age: 'Nullable(Int16)',
      height: 'Float64',
      weight: 'Float32',
      balance: 'Decimal(18, 4)',
      price: 'Decimal(38, 9)',
      createdAt: "DateTime('UTC')",
      bornOn: 'Date',
      active: 'Bool',
      tags: 'Array(String)',
      meta: 'Nullable(String)',
      role: 'String',
      fixed: 'FixedString(16)',
      // `posts Post[] @relation(...)` is a relation — must be skipped.
    })
    expect(db.User!.posts).toBeUndefined()
    expect(db.Post).toEqual({
      id: 'Int32',
      title: 'String',
      userId: 'Int32',
      // `user User @relation(...)` is a relation — skipped.
    })
    expect(db.Post!.user).toBeUndefined()
  })

  it('strips // line comments before parsing', () => {
    const db = parsePrismaSchema(`
      model X {
        // this looks like a field but is a comment
        id Int   // trailing comment
        ignored String? // optional too
      }
    `)
    expect(db.X).toEqual({ id: 'Int32', ignored: 'Nullable(String)' })
  })
})

describe('from-drizzle', () => {
  it('parses table factories and chained modifiers (from a fixture file)', () => {
    const db = parseDrizzleFile(DRIZZLE_FIXTURE)
    expect(Object.keys(db).sort()).toEqual(['orders', 'users'])
    expect(db.users).toEqual({
      id: 'Int64',                                    // primaryKey → notNull
      email: 'String',                                // .notNull()
      name: 'Nullable(String)',                       // no modifier
      age: 'Nullable(Int16)',
      height: 'Float32',
      weight: 'Nullable(Float64)',
      balance: 'Decimal(18, 4)',
      price: 'Nullable(Decimal(38, 9))',
      active: 'Bool',
      createdAtUtc: "DateTime('UTC')",
      createdAtNaive: 'DateTime',                     // withTimezone: false
      bornOn: 'Nullable(Date)',
      meta: 'Nullable(String)',
      externalId: 'String',
    })
    expect(db.orders).toEqual({ id: 'Int64', total: 'Decimal(12, 2)' })
  })

  it('accepts a source string directly (no file IO)', () => {
    const ts = `
      const users = pgTable('users', {
        id: integer('id').notNull(),
        flag: boolean('flag'),
      })
    `
    expect(parseDrizzleSource(ts)).toEqual({
      users: { id: 'Int32', flag: 'Nullable(Bool)' },
    })
  })

  it('skips unknown column builders rather than failing the whole table', () => {
    const ts = `
      const t = pgTable('t', {
        ok: integer('ok').notNull(),
        odd: customWhatever('odd').notNull(),
      })
    `
    expect(parseDrizzleSource(ts).t).toEqual({ ok: 'Int32' })
  })
})

describe('CLI — --from drizzle / --from prisma', () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-static-cli-'))
  const out = join(dir, 'db.d.ts')

  it('round-trips Prisma → emitted TypeScript', async () => {
    const r = await main(['--from', `prisma:${PRISMA_FIXTURE}`, '--name', 'PDb', '--out', out], {
      stdout: () => undefined, stderr: () => undefined,
    })
    expect(r.code).toBe(0)
    const ts = readFileSync(out, 'utf-8')
    expect(ts).toMatch(/export interface PDb \{/)
    expect(ts).toMatch(/User: \{[\s\S]*createdAt: 'DateTime\(\\'UTC\\'\)'[\s\S]*role: 'String'/)
    expect(ts).toMatch(/source: prisma:.*prisma-schema\.prisma/)
  })

  it('round-trips Drizzle → emitted TypeScript', async () => {
    let stdout = ''
    const r = await main(['--from', `drizzle:${DRIZZLE_FIXTURE}`, '--name', 'DDb'], {
      stdout: (s) => { stdout += s }, stderr: () => undefined,
    })
    expect(r.code).toBe(0)
    expect(stdout).toMatch(/export interface DDb \{/)
    expect(stdout).toMatch(/users: \{[\s\S]*createdAtUtc: 'DateTime\(\\'UTC\\'\)'[\s\S]*createdAtNaive: 'DateTime'/)
    expect(stdout).toMatch(/orders: \{[\s\S]*total: 'Decimal\(12, 2\)'/)
  })

  it('an invalid --from kind exits 2 with a clear message', async () => {
    let stderr = ''
    const tmpPath = join(dir, 'whatever.txt')
    writeFileSync(tmpPath, 'x')
    const r = await main(['--from', `bogus:${tmpPath}`], { stdout: () => undefined, stderr: (s) => { stderr += s } })
    expect(r.code).toBe(2)
    expect(stderr).toMatch(/Unsupported --from kind 'bogus'/)
  })

  // Cleanup at the end of the describe block.
  it('cleans up', () => {
    rmSync(dir, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})

describe('round-trip — generated module is valid TS that emit can re-render', () => {
  it('parsePrisma → emitDatabase → emitted module is byte-stable', () => {
    const db = parsePrismaSchema(readFileSync(PRISMA_FIXTURE, 'utf-8'))
    const ts1 = emitDatabase(db, { interfaceName: 'Db' })
    const ts2 = emitDatabase(parsePrismaSchema(readFileSync(PRISMA_FIXTURE, 'utf-8')), { interfaceName: 'Db' })
    expect(ts1).toBe(ts2)
  })
})
