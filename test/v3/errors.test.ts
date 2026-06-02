import { describe, it, expect } from 'vitest'
import {
  ChdbError,
  ChdbQueryError,
  ChdbSyntaxError,
  ChdbConnectionError,
  ChdbClosedError,
  ChdbStreamError,
  ChdbArrowError,
  ChdbBindError,
  ChdbInsertError,
  ChdbAbortError,
  ChdbTimeoutError,
  ChdbPlatformUnsupportedError,
  ChdbBinaryVersionMismatchError,
  ChdbInternalError,
  isChdbError,
  parseClickHouseCode,
  mapNativeError,
} from '../../src/errors'

// One row per subclass: [class, expected .code, expected .name].
const CASES: Array<[new (m: string) => ChdbError, string, string]> = [
  [ChdbQueryError, 'CHDB_QUERY', 'ChdbQueryError'],
  [ChdbSyntaxError, 'CHDB_SYNTAX', 'ChdbSyntaxError'],
  [ChdbConnectionError, 'CHDB_CONNECTION', 'ChdbConnectionError'],
  [ChdbClosedError, 'CHDB_CLOSED', 'ChdbClosedError'],
  [ChdbStreamError, 'CHDB_STREAM', 'ChdbStreamError'],
  [ChdbArrowError, 'CHDB_ARROW', 'ChdbArrowError'],
  [ChdbBindError, 'CHDB_BIND', 'ChdbBindError'],
  [ChdbInsertError, 'CHDB_INSERT', 'ChdbInsertError'],
  [ChdbTimeoutError, 'CHDB_TIMEOUT', 'ChdbTimeoutError'],
  [ChdbPlatformUnsupportedError, 'CHDB_PLATFORM', 'ChdbPlatformUnsupportedError'],
  [ChdbBinaryVersionMismatchError, 'CHDB_ABI', 'ChdbBinaryVersionMismatchError'],
  [ChdbInternalError, 'CHDB_INTERNAL', 'ChdbInternalError'],
]

describe('ChdbError hierarchy', () => {
  it.each(CASES)('%s has stable code/name and is an Error+ChdbError', (Cls, code, name) => {
    const e = new Cls('boom')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(ChdbError)
    expect(isChdbError(e)).toBe(true)
    expect(e.code).toBe(code)
    expect(e.name).toBe(name)
    expect(e.message).toBe('boom')
  })

  it('ChdbAbortError keeps web-platform name "AbortError"', () => {
    const e = new ChdbAbortError()
    expect(e).toBeInstanceOf(ChdbError)
    expect(e.code).toBe('CHDB_ABORT')
    expect(e.name).toBe('AbortError')
    expect(e.message).toBe('The operation was aborted')
  })

  it('encodes the documented subclass relationships', () => {
    expect(new ChdbSyntaxError('x')).toBeInstanceOf(ChdbQueryError)
    expect(new ChdbInsertError('x')).toBeInstanceOf(ChdbQueryError)
    expect(new ChdbArrowError('x')).toBeInstanceOf(ChdbStreamError)
  })

  it('preserves .cause (ES2022) and omits it when not provided', () => {
    const root = new Error('root')
    const wrapped = new ChdbQueryError('wrapped', { cause: root })
    expect(wrapped.cause).toBe(root)

    const bare = new ChdbQueryError('bare')
    expect('cause' in bare).toBe(false)
  })

  it('preserves clickhouseCode when provided', () => {
    const e = new ChdbQueryError('x', { clickhouseCode: 57 })
    expect(e.clickhouseCode).toBe(57)
  })

  it('isChdbError rejects non-chdb errors', () => {
    expect(isChdbError(new Error('x'))).toBe(false)
    expect(isChdbError('x')).toBe(false)
    expect(isChdbError(null)).toBe(false)
  })
})

describe('parseClickHouseCode', () => {
  it('extracts the leading Code: <n> prefix', () => {
    expect(parseClickHouseCode('Code: 62. DB::Exception: Syntax error')).toBe(62)
    expect(parseClickHouseCode('Code: 57. DB::Exception: table exists')).toBe(57)
  })

  it('returns undefined when there is no code prefix', () => {
    expect(parseClickHouseCode('some random failure')).toBeUndefined()
    expect(parseClickHouseCode('')).toBeUndefined()
  })
})

describe('mapNativeError routing', () => {
  it('routes syntax-class code 62 to ChdbSyntaxError', () => {
    const e = mapNativeError('Code: 62. DB::Exception: Syntax error: foo')
    expect(e).toBeInstanceOf(ChdbSyntaxError)
    expect(e.clickhouseCode).toBe(62)
  })

  it('falls back to ChdbQueryError for unrecognised codes but keeps the code', () => {
    const e = mapNativeError('Code: 57. DB::Exception: table already exists')
    expect(e).toBeInstanceOf(ChdbQueryError)
    expect(e).not.toBeInstanceOf(ChdbSyntaxError)
    expect(e.clickhouseCode).toBe(57)
  })

  it('still produces a typed ChdbQueryError when no code is present', () => {
    const e = mapNativeError('mysterious native failure')
    expect(e).toBeInstanceOf(ChdbQueryError)
    expect(e.clickhouseCode).toBeUndefined()
  })

  it('honours an explicit code over the parsed message', () => {
    const e = mapNativeError('no prefix here', 62)
    expect(e).toBeInstanceOf(ChdbSyntaxError)
    expect(e.clickhouseCode).toBe(62)
  })

  it('preserves .cause through the factory', () => {
    const root = new Error('native')
    const e = mapNativeError('Code: 999. boom', undefined, root)
    expect(e.cause).toBe(root)
  })
})
