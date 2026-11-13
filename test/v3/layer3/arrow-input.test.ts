import { describe, it, expect } from 'vitest'
import { registerArrowTable, registerArrowSource, selectFrom, chTable, ChdbCompileError, Session, drainPending } from '../../../index.js'
import { Table, Schema, Field, List, Int32, Int64, Uint64, Float32, Float64, Bool, Utf8, Binary, TimestampMillisecond, Decimal, vectorFromArray } from 'apache-arrow'

// Arrow C Data Interface input — register a JS columnar dataset as
// `arrowstream('<name>')` and read it through the regular builder. Single-pass
// semantics: each query consumes the stream, so `refresh()` must run between
// repeated reads against the same table.

describe('registerArrowTable — round-trips JS data through the engine', () => {
  it('registers a schema-bearing Table with no batches as a zero-row source', async () => {
    const session = new Session()
    const input = new Table(new Schema([new Field('x', new Int32())]))
    expect(input.batches).toHaveLength(0)
    const source = registerArrowSource(input, { session })
    try {
      const sql = `SELECT count() FROM arrowstream('${source.name}')`
      expect((await session.queryAsync(sql, { format: 'CSV' })).text().trim()).toBe('0')
      source.refresh()
      expect((await session.queryAsync(sql, { format: 'CSV' })).text().trim()).toBe('0')
    } finally { source.close(); session.close() }
  })

  it('generates distinct opaque names for independent Arrow sources', async () => {
    const session = new Session()
    const batch = new Table({ v: vectorFromArray([7], new Int32()) }).batches[0]!
    const one = registerArrowSource(batch, { session })
    const two = registerArrowSource(batch, { session })
    try {
      expect(one.name).toMatch(/^__chdb_arrow_[0-9a-f]{32}$/)
      expect(two.name).not.toBe(one.name)
      const result = await session.queryAsync(
        `SELECT a.v + b.v AS total FROM arrowstream('${one.name}') AS a CROSS JOIN arrowstream('${two.name}') AS b`,
        { format: 'CSV' },
      )
      expect(result.text().trim()).toBe('14')
    } finally {
      one.close()
      two.close()
      session.close()
    }
  })

  it('accepts a one-batch apache-arrow Table with nullable primitive buffers', async () => {
    const input = new Table({
      v: vectorFromArray([1, null, 3], new Int32()),
      s: vectorFromArray(['é', null, '東京'], new Utf8()),
    })
    expect(input.batches).toHaveLength(1)
    const t = registerArrowTable('arr_js_table', input)
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_js_table').as('t'))
        .select(['v', 's']).execute()) as { v: number | null; s: string | null }[]
      expect(rows).toEqual([{ v: 1, s: 'é' }, { v: null, s: null }, { v: 3, s: '東京' }])
    } finally {
      t.close()
    }
  })

  it('accepts Int64, Float64, and bit-packed Bool from a RecordBatch', async () => {
    const input = new Table({
      big: vectorFromArray([9_223_372_036_854_775_807n, 2n], new Int64()),
      score: vectorFromArray([1.25, 2.5], new Float64()),
      flag: vectorFromArray([true, false], new Bool()),
    })
    const t = registerArrowTable('arr_js_primitives', input.batches[0]!)
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_js_primitives').as('t'))
        .select(['big', 'score', 'flag']).execute()) as { big: string; score: number; flag: boolean }[]
      expect(rows).toEqual([
        { big: '9223372036854775807', score: 1.25, flag: true },
        { big: '2', score: 2.5, flag: false },
      ])
    } finally {
      t.close()
    }
  })

  it('accepts unsigned integers, Float32, and Binary from a RecordBatch', async () => {
    const input = new Table({
      u: vectorFromArray([18_446_744_073_709_551_615n, 2n], new Uint64()),
      f: vectorFromArray([1.5, 2.5], new Float32()),
      b: vectorFromArray([new Uint8Array([0, 255]), new Uint8Array([65])], new Binary()),
    })
    const session = new Session()
    const t = registerArrowTable('arr_js_more_primitives', input.batches[0]!, { session })
    try {
      const result = await session.queryAsync(
        "SELECT toString(u) AS u, f, hex(b) AS encoded FROM arrowstream('arr_js_more_primitives')",
        { format: 'JSONEachRow' },
      )
      expect(result.text().trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        { u: '18446744073709551615', f: 1.5, encoded: '00FF' },
        { u: '2', f: 2.5, encoded: '41' },
      ])
    } finally {
      t.close()
      session.close()
    }
  })

  it('preserves a timezone-tagged Arrow timestamp as DateTime64', async () => {
    const session = new Session()
    const input = new Table({ ts: vectorFromArray([1577836800123], new TimestampMillisecond('UTC')) })
    const t = registerArrowSource(input, { session })
    try {
      const result = await session.queryAsync(
        `SELECT toUnixTimestamp64Milli(ts) FROM arrowstream('${t.name}')`, { format: 'CSV' },
      )
      expect(result.text().trim()).toBe('1577836800123')
    } finally {
      t.close()
      session.close()
    }
  })

  it('imports a Decimal128 source without a JS numeric conversion', async () => {
    const session = new Session()
    const input = new Table({ d: vectorFromArray([new Uint32Array([123, 0, 0, 0])], new Decimal(2, 18, 128)) })
    const t = registerArrowSource(input, { session })
    try {
      const result = await session.queryAsync(
        `SELECT toString(d) FROM arrowstream('${t.name}')`, { format: 'CSV' },
      )
      expect(result.text().trim()).toBe('"1.23"')
      const wide = new Table({ d: vectorFromArray(
        [new Uint32Array([123, 0, 0, 0, 0, 0, 0, 0])], new Decimal(2, 76, 256),
      ) })
      const wideHandle = registerArrowSource(wide, { session })
      try {
        const value = await session.queryAsync(
          `SELECT toString(d) FROM arrowstream('${wideHandle.name}')`, { format: 'CSV' },
        )
        expect(value.text().trim()).toBe('"1.23"')
      } finally {
        wideHandle.close()
      }
    } finally {
      t.close()
      session.close()
    }
  })

  it('reads a materialized multi-batch Table and refreshes its one-shot C Stream', async () => {
    const single = new Table({ v: vectorFromArray([1, 2], new Int32()) })
    const chunks = new Table([single.batches[0]!, single.batches[0]!])
    expect(chunks.batches.length).toBeGreaterThan(1)
    const t = registerArrowTable('arr_multi_batch', chunks)
    try {
      const read = async () => (await selectFrom(chTable.arrowstream('arr_multi_batch').as('t'))
        .select('v').orderBy('v').execute()) as { v: number }[]
      expect(await read()).toEqual([{ v: 1 }, { v: 1 }, { v: 2 }, { v: 2 }])
      t.refresh()
      expect(await read()).toEqual([{ v: 1 }, { v: 1 }, { v: 2 }, { v: 2 }])
    } finally {
      t.close()
    }
  })

  it('reads the default dictionary-encoded JS string Table', async () => {
    const dictionary = new Table({ s: vectorFromArray(['x', null, 'z']) })
    const t = registerArrowTable('arr_dictionary', dictionary)
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_dictionary').as('t'))
        .select('s').execute()) as { s: string | null }[]
      expect(rows).toEqual([{ s: 'x' }, { s: null }, { s: 'z' }])
    } finally {
      t.close()
    }
  })

  it('reads a sliced dictionary-index column with nulls', async () => {
    const dictionary = new Table({ s: vectorFromArray(['a', null, 'c', 'd']) }).slice(1, 4)
    const t = registerArrowTable('arr_dictionary_slice', dictionary)
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_dictionary_slice').as('t'))
        .select('s').execute()) as { s: string | null }[]
      expect(rows).toEqual([{ s: null }, { s: 'c' }, { s: 'd' }])
    } finally {
      t.close()
    }
  })

  it('rejects unsupported nested input explicitly instead of flattening rows', () => {
    const input = new Table({ items: vectorFromArray([[1, 2]], new List(new Field('item', new Int32(), true))) })
    expect(() => registerArrowSource(input)).toThrow(/unsupported Arrow type/)
  })

  it('rebases sliced validity and bit-packed Bool without materializing rows', async () => {
    const table = new Table({
      v: vectorFromArray([1, null, 3], new Int32()),
      s: vectorFromArray(['a', null, 'c'], new Utf8()),
      b: vectorFromArray([true, false, true], new Bool()),
    })
    const t = registerArrowTable('arr_slice', table.slice(1))
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_slice').as('t'))
        .select(['v', 's', 'b']).execute()) as { v: number | null; s: string | null; b: boolean }[]
      expect(rows).toEqual([{ v: null, s: null, b: false }, { v: 3, s: 'c', b: true }])
    } finally {
      t.close()
    }
  })

  it('rebases a slice starting past the first bitmap byte', async () => {
    const values = Array.from({ length: 20 }, (_, i) => i === 10 ? null : i)
    const table = new Table({
      v: vectorFromArray(values, new Int32()),
      b: vectorFromArray(values.map((_, i) => i % 2 === 0), new Bool()),
    })
    const t = registerArrowTable('arr_slice_bits', table.slice(9, 13))
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_slice_bits').as('t'))
        .select(['v', 'b']).execute()) as { v: number | null; b: boolean }[]
      expect(rows).toEqual([
        { v: 9, b: false }, { v: null, b: true }, { v: 11, b: false }, { v: 12, b: true },
      ])
    } finally {
      t.close()
    }
  })

  it('keeps the original registration after a duplicate Arrow batch fails', async () => {
    const input = new Table({ v: vectorFromArray([7], new Int32()) })
    const t = registerArrowTable('arr_duplicate_batch', input.batches[0]!)
    try {
      expect(() => registerArrowTable('arr_duplicate_batch', input.batches[0]!)).toThrow(/failed/)
      const rows = (await selectFrom(chTable.arrowstream('arr_duplicate_batch').as('t'))
        .select('v').execute()) as { v: number }[]
      expect(rows).toEqual([{ v: 7 }])
    } finally {
      t.close()
    }
  })

  it('keeps the schema for an empty RecordBatch', async () => {
    const empty = new Table({ v: vectorFromArray([], new Int32()) })
    const session = new Session()
    try {
      const t = registerArrowTable('arr_empty_batch', empty.batches[0]!, { session })
      try {
        const result = await session.queryAsync(
          "SELECT v FROM arrowstream('arr_empty_batch')", { format: 'arrow' },
        )
        const output = result.toArrow() as Table
        expect(output.numRows).toBe(0)
        expect(output.schema.fields.map((f) => [f.name, f.type.toString()])).toEqual([['v', 'Int32']])
      } finally {
        t.close()
      }
    } finally {
      session.close()
    }
  })

  it('registers and unregisters on the supplied Session connection', async () => {
    const session = new Session()
    try {
      const t = registerArrowTable('arr_session', [
        { name: 'x', type: 'Int32', data: new Int32Array([7, 8]) },
      ], { session })
      try {
        const result = await session.queryAsync(
          "SELECT x FROM arrowstream('arr_session') ORDER BY x",
          { format: 'JSONEachRow' },
        )
        expect(result.text().trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ x: 7 }, { x: 8 }])
      } finally {
        t.close()
      }
      await expect(session.queryAsync(
        "SELECT x FROM arrowstream('arr_session')",
        { format: 'JSONEachRow' },
      )).rejects.toThrow(/arr_session|not found/i)
    } finally {
      session.close()
    }
  })

  it('rejects a closed Session instead of registering on the default connection', () => {
    const session = new Session()
    session.close()
    expect(() => registerArrowTable('arr_closed_session', [
      { name: 'x', type: 'Int32', data: new Int32Array([1]) },
    ], { session })).toThrow(/session has no active connection/)
  })

  it('does not unregister through a Session connection after the Session closes', () => {
    const session = new Session()
    const t = registerArrowTable('arr_session_closed_first', [
      { name: 'x', type: 'Int32', data: new Int32Array([1]) },
    ], { session })
    session.close()
    expect(() => t.refresh()).toThrow(/session has no active connection/)
    expect(() => t.close()).not.toThrow()
    expect(() => t.close()).not.toThrow()
  })

  it('defers close during an async scan and rejects refresh until it drains', async () => {
    const session = new Session()
    const t = registerArrowTable('arr_close_during_scan', [
      { name: 'x', type: 'Int32', data: new Int32Array([7, 8, 9]) },
    ], { session })
    try {
      const query = session.queryAsync(
        "SELECT x, sleepEachRow(0.05) FROM arrowstream('arr_close_during_scan') ORDER BY x",
        { format: 'JSONEachRow' },
      )
      expect(() => t.refresh()).toThrow(/active/)
      t.close()
      const result = await query
      expect(result.text().trim().split('\n').map((line) => JSON.parse(line).x)).toEqual([7, 8, 9])
      await drainPending()
      await expect(session.queryAsync(
        "SELECT x FROM arrowstream('arr_close_during_scan')", { format: 'JSONEachRow' },
      )).rejects.toThrow(/arr_close_during_scan|not found/i)
    } finally {
      t.close()
      session.close()
    }
  })

  it('keeps a source registered until an idle lazy stream is cancelled', async () => {
    const session = new Session()
    const t = registerArrowTable('arr_lazy_close', [
      { name: 'x', type: 'Int32', data: new Int32Array([1]) },
    ], { session })
    try {
      const stream = session.queryStream("SELECT x FROM arrowstream('arr_lazy_close')")
      t.close()
      stream.cancel()
      await drainPending()
      await expect(session.queryAsync(
        "SELECT x FROM arrowstream('arr_lazy_close')", { format: 'JSONEachRow' },
      )).rejects.toThrow(/arr_lazy_close|not found/i)
    } finally {
      t.close()
      session.close()
    }
  })

  it('waits for an in-flight Arrow fetch and its cancellation cleanup', async () => {
    const session = new Session()
    const t = registerArrowTable('arr_fetch_close', [
      { name: 'x', type: 'Int32', data: new Int32Array([1, 2, 3]) },
    ], { session })
    try {
      const stream = session.queryStream(
        "SELECT x, sleepEachRow(0.05) FROM arrowstream('arr_fetch_close') SETTINGS max_block_size=1",
      )
      const reader = stream[Symbol.asyncIterator]()
      const next = reader.next()
      t.close()
      stream.cancel()
      await next
      await reader.return?.()
      await drainPending()
      await expect(session.queryAsync(
        "SELECT x FROM arrowstream('arr_fetch_close')", { format: 'JSONEachRow' },
      )).rejects.toThrow(/arr_fetch_close|not found/i)
    } finally {
      t.close()
      session.close()
      await drainPending()
    }
  })

  it('does not let a stale default-connection handle remove a later registration', async () => {
    const stale = registerArrowTable('arr_default_reused', [
      { name: 'x', type: 'Int32', data: new Int32Array([1]) },
    ])
    const session = new Session() // evicts the previous default connection
    session.close()
    const current = registerArrowTable('arr_default_reused', [
      { name: 'x', type: 'Int32', data: new Int32Array([2]) },
    ])
    try {
      stale.close()
      const rows = (await selectFrom(chTable.arrowstream('arr_default_reused').as('t'))
        .select('x').execute()) as { x: number }[]
      expect(rows).toEqual([{ x: 2 }])
    } finally {
      stale.close()
      current.close()
    }
  })

  it('keeps a default Arrow registration when Session construction fails', async () => {
    const source = registerArrowSource(new Table({ x: vectorFromArray([7], new Int32()) }))
    try {
      expect(() => new Session('', { connectionArgs: ['--path=/invalid'] }))
        .toThrow(/--path/)
      const result = await selectFrom(chTable.arrowstream(source.name)).select('x').execute()
      expect(result).toEqual([{ x: 7 }])
      source.close()
      const replacement = registerArrowTable(source.name,
        new Table({ x: vectorFromArray([8], new Int32()) }))
      replacement.close()
    } finally { source.close(); await drainPending() }
  })

  it('waits for another Session\'s lazy stream before closing a source connection', async () => {
    const source = new Session()
    const reader = new Session(source.path)
    const t = registerArrowTable('arr_cross_session', [
      { name: 'x', type: 'Int32', data: new Int32Array([1, 2]) },
    ], { session: source })
    try {
      const stream = reader.queryStream("SELECT x FROM arrowstream('arr_cross_session')")
      source.close()
      t.close()
      // A stream is an open cursor even before its first fetch. Native source
      // teardown must wait for cancellation rather than dangling its buffers.
      let drained = false
      const draining = drainPending().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      stream.cancel()
      await draining
      await expect(reader.queryAsync(
        "SELECT x FROM arrowstream('arr_cross_session')", { format: 'JSONEachRow' },
      )).rejects.toThrow(/arr_cross_session|not found/i)
    } finally {
      t.close()
      source.close()
      reader.close()
      await drainPending()
    }
  })

  it('reads Int32, Float64, and Utf8 columns in row order', async () => {
    const t = registerArrowTable('arr_basics', [
      { name: 'id', type: 'Int32', data: new Int32Array([10, 20, 30]) },
      { name: 'score', type: 'Float64', data: new Float64Array([9.5, 3.0, 1.2]) },
      { name: 'country', type: 'String', data: ['US', 'FR', 'US'] },
    ])
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_basics').as('e'))
        .select(['id', 'country', 'score'])
        .orderBy('id')
        .execute()) as { id: number; country: string; score: number }[]
      expect(rows).toEqual([
        { id: 10, country: 'US', score: 9.5 },
        { id: 20, country: 'FR', score: 3.0 },
        { id: 30, country: 'US', score: 1.2 },
      ])
    } finally {
      t.close()
    }
  })

  it('Int64 columns come back as strings (precision-safe)', async () => {
    const t = registerArrowTable('arr_int64', [
      // Mix safe and unsafe-for-Number values; both round-trip as strings.
      { name: 'big', type: 'Int64', data: new BigInt64Array([1n, 1_000_000_000_000_000n, 9_223_372_036_854_775_807n]) },
    ])
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_int64').as('t'))
        .select('big')
        .orderBy('big')
        .execute()) as { big: string }[]
      expect(rows).toEqual([{ big: '1' }, { big: '1000000000000000' }, { big: '9223372036854775807' }])
    } finally {
      t.close()
    }
  })

  it('Bool columns round-trip through the bit-packed bitmap', async () => {
    const t = registerArrowTable('arr_bool', [
      { name: 'flag', type: 'Bool', data: [true, false, true, true, false, true, false] },
    ])
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_bool').as('t'))
        .select('flag')
        .execute()) as { flag: boolean | number }[]
      // chdb returns Bool as 0/1 in JSONEachRow; either is fine.
      expect(rows.map((r) => Boolean(r.flag))).toEqual([true, false, true, true, false, true, false])
    } finally {
      t.close()
    }
  })

  it('preserves nullable Int32 and UTF-8 values without a cast', async () => {
    const t = registerArrowTable('arr_nulls', [
      { name: 'v', type: 'Int32', data: new Int32Array([1, 0, 3]), nulls: [true, false, true] },
      { name: 's', type: 'String', data: ['é', '', '東京'], nulls: [true, false, true] },
    ])
    try {
      const rows = (await selectFrom(chTable.arrowstream('arr_nulls').as('t'))
        .select(['v', 's'])
        .execute()) as { v: number | null; s: string | null }[]
      expect(rows).toEqual([
        { v: 1, s: 'é' },
        { v: null, s: null },
        { v: 3, s: '東京' },
      ])
    } finally {
      t.close()
    }
  })

  it('refresh() lets the same handle serve multiple queries', async () => {
    const t = registerArrowTable('arr_refresh', [
      { name: 'x', type: 'Int32', data: new Int32Array([1, 2, 3, 4, 5]) },
    ])
    try {
      const first = (await selectFrom(chTable.arrowstream('arr_refresh').as('t'))
        .select('x').orderBy('x').execute()) as { x: number }[]
      expect(first).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }, { x: 5 }])

      // Without refresh, the engine sees an empty stream on the second pass.
      t.refresh()
      const second = (await selectFrom(chTable.arrowstream('arr_refresh').as('t'))
        .select('x').where('x', '>', 3).execute()) as { x: number }[]
      expect(second.sort((a, b) => a.x - b.x)).toEqual([{ x: 4 }, { x: 5 }])
    } finally {
      t.close()
    }
  })

  it('close() removes the table from the engine', async () => {
    const t = registerArrowTable('arr_close', [
      { name: 'x', type: 'Int32', data: new Int32Array([42]) },
    ])
    t.close()
    await expect(
      selectFrom(chTable.arrowstream('arr_close').as('t')).select('x').execute(),
    ).rejects.toThrow(/arr_close|not found/i)
  })

  it('rejects mismatched column lengths at build time', () => {
    expect(() =>
      registerArrowTable('bad', [
        { name: 'a', type: 'Int32', data: new Int32Array([1, 2, 3]) },
        { name: 'b', type: 'String', data: ['x', 'y'] },
      ]),
    ).toThrow(ChdbCompileError)
  })

  it('rejects an empty column list', () => {
    expect(() => registerArrowTable('bad', [])).toThrow(/at least one column/)
  })

  it('close() is idempotent (a second close is a no-op)', () => {
    const t = registerArrowTable('arr_double_close', [
      { name: 'x', type: 'Int32', data: new Int32Array([1]) },
    ])
    t.close()
    expect(() => t.close()).not.toThrow()
  })
})

// Best-effort GC safety net: when a handle is dropped without close(), the
// FinalizationRegistry should unregister the table so native stops pinning its
// buffers. Timing is non-deterministic by spec, so we nudge GC a few times and
// poll. Requires --expose-gc (wired via vitest.config.ts execArgv).
describe('registerArrowTable — GC fallback unregisters a leaked handle', () => {
  // Register inside a helper that returns nothing, so no reference to the handle
  // survives in the caller's scope and it becomes collectable.
  function leak(name: string): void {
    registerArrowTable(name, [{ name: 'x', type: 'Int32', data: new Int32Array([7]) }])
  }

  it.skipIf(typeof global.gc !== 'function')(
    'unregisters the table after the handle is collected',
    async () => {
      const name = 'arr_gc_leak'
      leak(name)

      // The table is registered right now: a query consumes it (single-pass)
      // but leaves it registered.
      const before = (await selectFrom(chTable.arrowstream(name).as('t'))
        .select('x')
        .execute()) as { x: number }[]
      expect(before).toEqual([{ x: 7 }])

      // Drive collection. Once the finalizer runs, the table is gone and the
      // query rejects.
      let collected = false
      for (let i = 0; i < 50 && !collected; i++) {
        global.gc!()
        await new Promise((r) => setTimeout(r, 10))
        try {
          await selectFrom(chTable.arrowstream(name).as('t')).select('x').execute()
        } catch {
          collected = true
        }
      }
      expect(collected).toBe(true)
    },
  )
})
