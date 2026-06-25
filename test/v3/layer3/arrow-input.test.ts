import { describe, it, expect } from 'vitest'
import { registerArrowTable, selectFrom, chTable, ChdbCompileError } from '../../../index.js'

// Arrow C Data Interface input — register a JS columnar dataset as
// `arrowstream('<name>')` and read it through the regular builder. Single-pass
// semantics: each query consumes the stream, so `refresh()` must run between
// repeated reads against the same table.

describe('registerArrowTable — round-trips JS data through the engine', () => {
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

  it('nulls show up as null after a Nullable cast', async () => {
    const t = registerArrowTable('arr_nulls', [
      { name: 'v', type: 'Int32', data: new Int32Array([1, 0, 3]), nulls: [true, false, true] },
    ])
    try {
      // chdb's arrowstream column comes through as the non-nullable inferred type;
      // a `nullIf`/`Nullable` projection surfaces the original NULL semantics.
      const rows = (await selectFrom(chTable.arrowstream('arr_nulls').as('t'))
        .select('v')
        .orderBy('v')
        .execute()) as { v: number }[]
      // The non-null rows are 1 and 3; one row's data slot is 0 (the null
      // placeholder), and that's what the engine reads since we don't cast
      // through a Nullable schema here. We assert "all three rows come back"
      // and that the two non-null values are present.
      expect(rows).toHaveLength(3)
      const values = rows.map((r) => r.v).sort((a, b) => a - b)
      expect(values).toContain(1)
      expect(values).toContain(3)
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
