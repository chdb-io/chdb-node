import { describe, it, expect } from 'vitest'
import * as fmt from '../../../dist/layer2/formats.js'

// Drift guard: these literal lists are byte-compat with @clickhouse/client-common.
// If upstream changes them, this test (and the type-compat test) should fail so we
// notice. The lists below are copied from client-common@1.x data_formatter.
const UP_STREAMABLE_JSON = [
  'JSONEachRow',
  'JSONStringsEachRow',
  'JSONCompactEachRow',
  'JSONCompactStringsEachRow',
  'JSONCompactEachRowWithNames',
  'JSONCompactEachRowWithNamesAndTypes',
  'JSONCompactStringsEachRowWithNames',
  'JSONCompactStringsEachRowWithNamesAndTypes',
  'JSONEachRowWithProgress',
]
const UP_RECORDS = ['JSONObjectEachRow']
const UP_SINGLE_DOC = ['JSON', 'JSONStrings', 'JSONCompact', 'JSONCompactStrings', 'JSONColumnsWithMetadata']
const UP_RAW = [
  'CSV',
  'CSVWithNames',
  'CSVWithNamesAndTypes',
  'TabSeparated',
  'TabSeparatedRaw',
  'TabSeparatedWithNames',
  'TabSeparatedWithNamesAndTypes',
  'CustomSeparated',
  'CustomSeparatedWithNames',
  'CustomSeparatedWithNamesAndTypes',
  'Parquet',
]

describe('Layer 2 format classification (byte-compat with clickhouse-js)', () => {
  it('streamable JSON family matches upstream', () => {
    expect([...fmt.StreamableJSONFormats]).toEqual(UP_STREAMABLE_JSON)
    for (const f of UP_STREAMABLE_JSON) expect(fmt.isStreamableJSONFamily(f)).toBe(true)
  })

  it('records / single-document / raw families match upstream', () => {
    expect([...fmt.RecordsJSONFormats]).toEqual(UP_RECORDS)
    expect([...fmt.SingleDocumentJSONFormats]).toEqual(UP_SINGLE_DOC)
    expect([...fmt.SupportedRawFormats]).toEqual(UP_RAW)
  })

  it('streamable = streamable-JSON ∪ raw', () => {
    for (const f of [...UP_STREAMABLE_JSON, ...UP_RAW]) expect(fmt.isStreamableFormat(f)).toBe(true)
    for (const f of [...UP_SINGLE_DOC, ...UP_RECORDS]) expect(fmt.isStreamableFormat(f)).toBe(false)
  })

  it('classifies disjointly', () => {
    expect(fmt.isSingleDocumentJSONFamily('JSON')).toBe(true)
    expect(fmt.isRecordsJSONFamily('JSONObjectEachRow')).toBe(true)
    expect(fmt.isRawFormat('CSV')).toBe(true)
    expect(fmt.isJSONFamily('CSV')).toBe(false)
    expect(fmt.isJSONFamily('JSONEachRow')).toBe(true)
  })
})
