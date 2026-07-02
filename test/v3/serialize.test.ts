import { describe, it, expect } from 'vitest'
import {
  escapeStringLiteral,
  validateIdentifier,
  serializeValue,
  formatParamValue,
} from '../../src/serialize'
import { ChdbBindError } from '../../src/errors'
// Round-trip literals through the REAL engine to prove correctness + injection safety.
import { query } from '../../index.js'

const tsv = (sql: string): string => query(sql, 'TabSeparated').replace(/\n$/, '')

describe('escapeStringLiteral', () => {
  it('quotes and escapes single quotes', () => {
    expect(escapeStringLiteral("a'b")).toBe("'a\\'b'")
  })

  it('escapes the backslash (the v2 chEscape hole)', () => {
    expect(escapeStringLiteral('a\\b')).toBe("'a\\\\b'")
  })

  it('escapes a backslash-quote injection attempt', () => {
    // input: \' OR 1=1 --   ->  backslash doubled, quote escaped
    expect(escapeStringLiteral("\\' OR 1=1 --")).toBe("'\\\\\\' OR 1=1 --'")
  })

  it('escapes control characters', () => {
    expect(escapeStringLiteral('a\tb\nc\rd')).toBe("'a\\tb\\nc\\rd'")
    expect(escapeStringLiteral('a\0b')).toBe("'a\\0b'")
    // \b is backspace U+0008 here, not a word boundary.
    expect(escapeStringLiteral('a\bb')).toBe("'a\\bb'")
    // word boundaries must NOT be touched (regression: /\b/ vs /\x08/).
    expect(escapeStringLiteral('DROP TABLE x')).toBe("'DROP TABLE x'")
  })
})

describe('validateIdentifier', () => {
  it('accepts dotted identifiers unchanged (no quote wrapping)', () => {
    expect(validateIdentifier('events')).toBe('events')
    expect(validateIdentifier('db.events')).toBe('db.events')
    expect(validateIdentifier('col_1')).toBe('col_1')
  })

  it('rejects anything outside the whitelist with ChdbBindError', () => {
    for (const bad of ['ev ents', 'a;b', 'a`b', "a'b", 'a-b', 'tbl);DROP', '']) {
      expect(() => validateIdentifier(bad)).toThrow(ChdbBindError)
    }
  })

  it('rejects empty dotted segments (leading/trailing/double dot)', () => {
    // these pass a flat [A-Za-z0-9_.] whitelist but are malformed identifiers
    for (const bad of ['.', '..', 'a..b', '.tbl', 'tbl.', 'db..t', '.db.t', 'db.t.']) {
      expect(() => validateIdentifier(bad)).toThrow(ChdbBindError)
    }
    // well-formed dotted names still pass
    expect(validateIdentifier('db.schema.events')).toBe('db.schema.events')
  })
})

describe('serializeValue (string assertions)', () => {
  it('handles primitives', () => {
    expect(serializeValue(null)).toBe('NULL')
    expect(serializeValue(undefined)).toBe('NULL')
    expect(serializeValue(true)).toBe('true')
    expect(serializeValue(false)).toBe('false')
    expect(serializeValue(42)).toBe('42')
    expect(serializeValue(3.5)).toBe('3.5')
    expect(serializeValue(-7)).toBe('-7')
    expect(serializeValue(9007199254740993n)).toBe('9007199254740993')
    expect(serializeValue('hi')).toBe("'hi'")
  })

  it('rejects unsafe-integer numbers to avoid silent precision loss', () => {
    expect(serializeValue(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
    expect(() => serializeValue(1e21)).toThrow(ChdbBindError)
    expect(() => serializeValue(Number.MAX_SAFE_INTEGER + 2)).toThrow(ChdbBindError)
  })

  it('rejects non-finite numbers and unserializable types', () => {
    expect(() => serializeValue(NaN)).toThrow(ChdbBindError)
    expect(() => serializeValue(Infinity)).toThrow(ChdbBindError)
    expect(() => serializeValue(() => 0)).toThrow(ChdbBindError)
    expect(() => serializeValue(Symbol('x'))).toThrow(ChdbBindError)
  })

  it('serializes Date as a UTC datetime literal', () => {
    expect(serializeValue(new Date(Date.UTC(2026, 4, 1, 12, 30, 45)))).toBe(
      "'2026-05-01 12:30:45'",
    )
    expect(() => serializeValue(new Date(NaN))).toThrow(ChdbBindError)
  })

  it('serializes arrays, typed arrays, maps and objects', () => {
    expect(serializeValue([1, 2, 3])).toBe('[1,2,3]')
    expect(serializeValue(['a', "b'c"])).toBe("['a','b\\'c']")
    expect(serializeValue(new Int32Array([1, 2]))).toBe('[1,2]')
    expect(serializeValue(new Map<string, unknown>([['k', 1]]))).toBe("{'k':1}")
    expect(serializeValue({ a: 1, b: 'x' })).toBe("{'a':1,'b':'x'}")
    expect(serializeValue([[1, 2], [3]])).toBe('[[1,2],[3]]')
  })
})

describe('formatParamValue (server-side {name:Type} binding)', () => {
  it('emits the TSV null marker \\N for a top-level null/undefined', () => {
    // Byte-for-byte matches @clickhouse/client-common formatQueryParams
    // (printNullAsKeyword=false at the top level) — was a ChdbBindError throw.
    expect(formatParamValue(null)).toBe('\\N')
    expect(formatParamValue(undefined)).toBe('\\N')
  })

  it('keeps the NULL keyword for a null nested inside an Array/Map', () => {
    expect(formatParamValue([1, null, 3])).toBe('[1,NULL,3]')
    expect(formatParamValue(new Map<string, unknown>([['k', null]]))).toBe("{'k':NULL}")
  })

  it('TSV-escapes a top-level string without SQL-quoting it', () => {
    expect(formatParamValue('a\tb')).toBe('a\\tb')
    expect(formatParamValue("no'quote")).toBe("no'quote")
  })

  it('still rejects non-finite / unsafe / unserializable values', () => {
    expect(() => formatParamValue(NaN)).toThrow(ChdbBindError)
    expect(() => formatParamValue(1e21)).toThrow(ChdbBindError)
    expect(() => formatParamValue(Symbol('x'))).toThrow(ChdbBindError)
  })
})

describe('serializeValue (real-engine round-trips)', () => {
  it('round-trips scalar literals exactly', () => {
    expect(tsv(`SELECT ${serializeValue(true)}`)).toBe('true')
    expect(tsv(`SELECT ${serializeValue(-7)}`)).toBe('-7')
    expect(tsv(`SELECT toInt64(${serializeValue(9007199254740993n)})`)).toBe(
      '9007199254740993',
    )
    expect(tsv(`SELECT toDateTime(${serializeValue(new Date(Date.UTC(2026, 4, 1, 12, 30, 45)))}, 'UTC')`)).toBe(
      '2026-05-01 12:30:45',
    )
    expect(tsv(`SELECT arraySum(${serializeValue([1, 2, 3])})`)).toBe('6')
  })

  it('treats injection payloads as a single inert string (length preserved, nothing executes)', () => {
    const payloads = [
      "'; DROP TABLE x; --",
      "\\' OR 1=1 --",
      'plain',
      'tab\tand\nnewline',
      "a'b'c",
      '\\\\\\\\', // four backslashes
    ]
    for (const p of payloads) {
      const got = tsv(`SELECT length(${serializeValue(p)})`)
      // length() counts bytes; payloads are ASCII so bytes === chars.
      expect(got).toBe(String(p.length))
    }
  })
})
