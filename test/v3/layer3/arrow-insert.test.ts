import { describe, expect, it } from 'vitest'
import { Field, Int32, Schema, Table, Utf8, vectorFromArray } from 'apache-arrow'
import { insertArrow, insertArrowReader, Session } from '../../../index.js'

describe('insertArrow — engine-side INSERT SELECT from Arrow input', () => {
  it('accepts an empty schema-bearing Table as a zero-row insert', async () => {
    const session = new Session()
    try {
      await session.queryAsync('CREATE TABLE arrow_insert_empty (id Int32) ENGINE=Memory')
      const input = new Table(new Schema([new Field('id', new Int32())]))
      expect(await insertArrow('arrow_insert_empty', input, { session })).toMatchObject({ rowsSubmitted: 0 })
      const result = await session.queryAsync('SELECT count() FROM arrow_insert_empty', { format: 'CSV' })
      expect(result.text().trim()).toBe('0')
    } finally { session.close() }
  })

  it('maps source fields by name, preserves nulls, and reports submitted rows', async () => {
    const session = new Session()
    try {
      await session.queryAsync('CREATE TABLE arrow_insert_test (id Int32, s Nullable(String)) ENGINE=Memory')
      const input = new Table({
        s: vectorFromArray(['é', null, '東京'], new Utf8()),
        id: vectorFromArray([3, 1, 2], new Int32()),
      })
      const summary = await insertArrow('arrow_insert_test', input, { session })
      expect(summary.rowsSubmitted).toBe(3)
      const result = await session.queryAsync('SELECT id, s FROM arrow_insert_test ORDER BY id', { format: 'JSONEachRow' })
      expect(result.text().trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        { id: 1, s: null }, { id: 2, s: '東京' }, { id: 3, s: 'é' },
      ])
    } finally {
      session.close()
    }
  })

  it('releases the registration after an INSERT error and keeps the Session usable', async () => {
    const session = new Session()
    try {
      const input = new Table({ id: vectorFromArray([1], new Int32()) }).batches[0]!
      await expect(insertArrow('missing_arrow_insert_target', input, { session })).rejects.toThrow()
      await session.queryAsync('CREATE TABLE arrow_insert_recovery (id Int32) ENGINE=Memory')
      await expect(insertArrow('arrow_insert_recovery', input, { session })).resolves.toMatchObject({ rowsSubmitted: 1 })
    } finally {
      session.close()
    }
  })

  it('inserts all batches of a materialized Table', async () => {
    const session = new Session()
    try {
      await session.queryAsync('CREATE TABLE arrow_insert_batches (id Int32) ENGINE=Memory')
      const one = new Table({ id: vectorFromArray([1, 2], new Int32()) })
      const input = new Table([one.batches[0]!, one.batches[0]!])
      expect(await insertArrow('arrow_insert_batches', input, { session })).toMatchObject({ rowsSubmitted: 4 })
      const rows = await session.queryAsync('SELECT count() FROM arrow_insert_batches', { format: 'CSV' })
      expect(rows.text().trim()).toBe('4')
    } finally {
      session.close()
    }
  })

  it('treats dots in Arrow field names as literal names, not SQL qualifiers', async () => {
    const session = new Session()
    try {
      await session.queryAsync('CREATE TABLE arrow_insert_quoted (`a.b` Int32) ENGINE=Memory')
      const input = new Table({ 'a.b': vectorFromArray([9], new Int32()) })
      await insertArrow('arrow_insert_quoted', input, { session })
      const result = await session.queryAsync('SELECT `a.b` FROM arrow_insert_quoted', { format: 'CSV' })
      expect(result.text().trim()).toBe('9')
    } finally {
      session.close()
    }
  })

  it('inserts a RecordBatch reader incrementally with bounded native input', async () => {
    const session = new Session()
    try {
      await session.queryAsync('CREATE TABLE arrow_insert_reader (id Int32) ENGINE=Memory')
      async function* batches() {
        for (let i = 0; i < 20; i++) {
          yield new Table({ id: vectorFromArray([i], new Int32()) }).batches[0]!
        }
      }
      const summary = await insertArrowReader('arrow_insert_reader', batches(), { session })
      expect(summary.rowsSubmitted).toBe(20)
      const result = await session.queryAsync('SELECT count(), sum(id) FROM arrow_insert_reader', { format: 'CSV' })
      expect(result.text().trim()).toBe('20,190')
    } finally {
      session.close()
    }
  })

  it('aborts a live reader insert and keeps the Session usable', async () => {
    const session = new Session()
    const controller = new AbortController()
    let reachedSecondBatch!: () => void
    const waitingForSecondBatch = new Promise<void>((resolve) => { reachedSecondBatch = resolve })
    try {
      await session.queryAsync('CREATE TABLE arrow_insert_aborted (id Int32) ENGINE=Memory')
      async function* batches() {
        yield new Table({ id: vectorFromArray([1], new Int32()) }).batches[0]!
        reachedSecondBatch()
        await new Promise<void>(() => {}) // an uncooperative upstream source
      }
      const pending = insertArrowReader('arrow_insert_aborted', batches(),
        { session, signal: controller.signal })
      await waitingForSecondBatch
      await new Promise<void>((resolve) => setImmediate(resolve)) // let INSERT start consuming the first batch
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'CHDB_ABORT' })
      const result = await session.queryAsync('SELECT 7', { format: 'CSV' })
      expect(result.text().trim()).toBe('7')
    } finally { session.close() }
  })

  it('requires a live Session and unique source field names', async () => {
    await expect(insertArrow('dest', [{ name: 'id', type: 'Int32', data: new Int32Array([1]) }],
      { session: null as unknown as Session })).rejects.toThrow(/active Session/)
    const session = new Session()
    try {
      await expect(insertArrow('dest', [
        { name: 'id', type: 'Int32', data: new Int32Array([1]) },
        { name: 'id', type: 'Int32', data: new Int32Array([2]) },
      ], { session })).rejects.toThrow(/unique column names/)
    } finally {
      session.close()
    }
  })
})
