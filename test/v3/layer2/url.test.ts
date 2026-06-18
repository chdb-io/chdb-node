import { describe, it, expect } from 'vitest'
import { parseChdbUrl } from '../../../dist/layer2/url.js'
import { ChdbEmbeddedOnlyError } from '../../../index.js'

describe('parseChdbUrl', () => {
  it('defaults to in-memory when undefined', () => {
    expect(parseChdbUrl(undefined)).toEqual({ kind: 'memory' })
  })

  it.each(['chdb://memory', 'chdb://:memory:', 'chdb://', 'memory', ':memory:'])(
    'treats %s as in-memory',
    (u) => {
      expect(parseChdbUrl(u)).toMatchObject({ kind: 'memory' })
    },
  )

  it('parses on-disk absolute and relative paths', () => {
    expect(parseChdbUrl('chdb:///var/lib/chdb')).toEqual({ kind: 'path', path: '/var/lib/chdb' })
    expect(parseChdbUrl('chdb://./data')).toEqual({ kind: 'path', path: './data' })
    expect(parseChdbUrl('chdb://mydir')).toEqual({ kind: 'path', path: 'mydir' })
  })

  it('accepts a URL instance', () => {
    expect(parseChdbUrl(new URL('chdb://memory'))).toMatchObject({ kind: 'memory' })
  })

  it('extracts ?database= and ignores other params', () => {
    expect(parseChdbUrl('chdb://memory?database=analytics')).toEqual({
      kind: 'memory',
      database: 'analytics',
    })
    expect(parseChdbUrl('chdb:///data?database=x&foo=bar')).toEqual({
      kind: 'path',
      path: '/data',
      database: 'x',
    })
  })

  it.each(['http://localhost:8123', 'https://x', 'tcp://h:9000', 'clickhouse://h', '/bare/path', 'file:///x'])(
    'rejects non-chdb scheme %s with ChdbEmbeddedOnlyError',
    (u) => {
      expect(() => parseChdbUrl(u)).toThrow(ChdbEmbeddedOnlyError)
    },
  )
})
