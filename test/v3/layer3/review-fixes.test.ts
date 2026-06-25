import { describe, it, expect } from 'vitest'
import {
  selectFrom,
  chTable,
  registerArrowTable,
  parsePrismaSchema,
  emitDatabase,
  ChdbCompileError,
} from '../../../index.js'
import { main } from '../../../src/layer3/codegen/cli'

// Regression tests for the PR #55 review fixes (Copilot + chibugai). Each test
// pins a specific behaviour a reviewer flagged so it can't silently regress.

describe('SETTINGS string values use SQL-standard quote doubling', () => {
  it("escapes ' by doubling, not with a backslash", () => {
    const { sql } = selectFrom(chTable.numbers(1n).as('t'))
      .selectAll()
      .settings({ log_comment: "o'brien" })
      .compile()
    expect(sql).toContain("log_comment = 'o''brien'")
    expect(sql).not.toContain("\\'")
  })
})

describe('chTable credential pairs are both-or-neither', () => {
  it('throws when only one S3 credential is supplied', () => {
    expect(() => chTable.s3({ url: 's3://b/k', accessKeyId: 'AK' })).toThrow(ChdbCompileError)
    expect(() => chTable.s3({ url: 's3://b/k', secretAccessKey: 'SK' })).toThrow(/secretAccessKey|accessKeyId/)
  })
  it('accepts both, or neither', () => {
    expect(() => chTable.s3({ url: 's3://b/k' })).not.toThrow()
    expect(() => chTable.s3({ url: 's3://b/k', accessKeyId: 'AK', secretAccessKey: 'SK' })).not.toThrow()
  })
  it('applies to postgresql/mysql/iceberg/deltaLake too', () => {
    expect(() => chTable.postgresql({ host: 'h:5432', database: 'd', table: 't', user: 'u' })).toThrow(ChdbCompileError)
    expect(() => chTable.mysql({ host: 'h:3306', database: 'd', table: 't', password: 'p' })).toThrow(ChdbCompileError)
    expect(() => chTable.iceberg({ url: 's3://b/k', accessKeyId: 'AK' })).toThrow(ChdbCompileError)
    expect(() => chTable.deltaLake({ url: 's3://b/k', secretAccessKey: 'SK' })).toThrow(ChdbCompileError)
  })
})

describe('registerArrowTable validates the nulls mask length', () => {
  it('rejects a nulls mask that does not cover every row', () => {
    expect(() =>
      registerArrowTable('bad_nulls', [{ name: 'v', type: 'Int32', data: new Int32Array([1, 2, 3]), nulls: [true, false] }]),
    ).toThrow(/nulls mask/)
  })
})

describe('Prisma static conversion', () => {
  it('does not truncate values containing // (e.g. URLs in strings)', () => {
    const db = parsePrismaSchema(`
      model M {
        id  Int    @id
        url String @default("postgresql://user@host:5432/db") // trailing comment
      }
    `)
    expect(Object.keys(db)).toContain('M')
    expect(db['M']!['url']).toBe('String')
    // The field after the URL line must still be parsed (comment stripping
    // didn't swallow the rest of the model).
    expect(db['M']!['id']).toBe('Int32')
  })

  it('uses null-prototype maps so a __proto__ model is an own key', () => {
    const db = parsePrismaSchema('model __proto__ {\n  id Int @id\n}\n')
    expect(Object.prototype.hasOwnProperty.call(db, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(db)).toBeNull()
  })
})

describe('emitDatabase validates the interface name', () => {
  it('rejects a name that is not a valid TS identifier', () => {
    expect(() => emitDatabase({ t: { a: 'Int32' } }, { interfaceName: 'not valid' })).toThrow(ChdbCompileError)
    expect(() => emitDatabase({ t: { a: 'Int32' } }, { interfaceName: '1Bad' })).toThrow(/identifier/)
  })
})

describe('gen-types CLI rejects duplicate --table', () => {
  it('errors instead of silently dropping a source', async () => {
    let err = ''
    const res = await main(['--from-url', 'http://localhost', '--table', 'a', '--table', 'a'], {
      stdout: () => {},
      stderr: (s) => (err += s),
    })
    expect(res.code).toBe(2)
    expect(err).toMatch(/Duplicate --table 'a'/)
  })
})
