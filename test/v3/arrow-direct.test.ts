import { describe, expect, it } from 'vitest'
import type { RecordBatch, Schema, Table } from 'apache-arrow'
import { Session, drainPending } from '../../index.js'

describe('Session.queryArrow — direct C Data output', () => {
  it('rejects rc.2 and older native engines before calling the Arrow ABI', async () => {
    const native = require('../../build/Release/chdb_node.node') as { EngineVersion(): string }
    const original = native.EngineVersion
    const session = new Session()
    try {
      for (const version of ['26.11.0-rc.1', '26.11.0-rc.2', '26.9.0']) {
        native.EngineVersion = () => version
        await expect(session.queryArrow('SELECT 1')).rejects.toMatchObject({ code: 'CHDB_ABI' })
      }
      native.EngineVersion = () => '26.11.0-rc.3'
      const table = await session.queryArrow('SELECT toInt32(1) AS x') as Table
      expect(table.toArray()[0]!.x).toBe(1)
    } finally {
      native.EngineVersion = original
      session.close()
    }
  })

  it('returns typed values, nullable UTF-8, and precision-safe Int64', async () => {
    const session = new Session()
    try {
      const table = await session.queryArrow(`
        SELECT toInt32(number) AS x,
               if(number=1, NULL, toString(number)) AS s,
               toInt64(9223372036854775807) AS big
        FROM numbers(3)
      `) as Table
      expect(table.schema.fields.map((field) => [field.name, field.type.toString()])).toEqual([
        ['x', 'Int32'], ['s', 'Utf8'], ['big', 'Int64'],
      ])
      expect(table.toArray().map((row) => row.toJSON())).toEqual([
        { x: 0, s: '0', big: 9223372036854775807n },
        { x: 1, s: null, big: 9223372036854775807n },
        { x: 2, s: '2', big: 9223372036854775807n },
      ])
    } finally {
      session.close()
    }
  })

  it('retains schema for zero rows and propagates SQL errors', async () => {
    const session = new Session()
    try {
      const table = await session.queryArrow('SELECT toInt32(1) AS x WHERE 0') as Table
      expect(table.numRows).toBe(0)
      expect(table.schema.fields.map((field) => [field.name, field.type.toString()])).toEqual([['x', 'Int32']])
      await expect(session.queryArrow('SELECT x FROM missing_arrow_direct_output')).rejects.toThrow(/missing_arrow_direct_output/)
      await expect(session.queryArrow('SELECT [1, 2] AS items')).rejects.toThrow(/Unsupported Arrow result field/)
    } finally {
      session.close()
    }
  })

  it('binds direct Arrow query values server-side without interpolating SQL', async () => {
    const session = new Session()
    try {
      const value = "x' OR '1'='1"
      const table = await session.queryArrowBind('SELECT {v:String} AS v', { v: value }) as Table
      expect(table.toArray()[0]!.v).toBe(value)
      const reader = session.queryArrowStreamBind('SELECT toInt32({n:Int32}) AS n', { n: 7 })
      const rows: number[] = []
      for await (const batch of reader) rows.push(...(batch as RecordBatch).getChild('n')!.toArray() as Int32Array)
      expect(rows).toEqual([7])
    } finally {
      session.close()
    }
  })

  it('owns result buffers after the Session closes', async () => {
    const session = new Session()
    const table = await session.queryArrow('SELECT toInt32(number) AS x FROM numbers(7) SETTINGS max_block_size=2') as Table
    session.close()
    expect(table.toArray().map((row) => row.x)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('maps DateTime as UInt32 and honors binary String output', async () => {
    const session = new Session()
    try {
      const time = await session.queryArrow("SELECT toDateTime('2020-01-01 00:00:00', 'UTC') AS ts") as Table
      expect(time.schema.fields[0]!.type.toString()).toBe('Uint32')
      expect(time.toArray()[0]!.ts).toBe(1577836800)
      const precise = await session.queryArrow(
        "SELECT toDateTime64('2020-01-01 00:00:00.123', 3, 'UTC') AS ts",
      ) as Table
      expect(precise.schema.fields[0]!.type.toString()).toBe('Timestamp<MILLISECOND, UTC>')
      expect(precise.toArray()[0]!.ts).toBe(1577836800123)
      const decimal = await session.queryArrow('SELECT toDecimal64(1.23, 2) AS d') as Table
      expect(decimal.schema.fields[0]!.type.toString()).toBe('Decimal[18e+2]')
      expect(String(decimal.toArray()[0]!.d)).toBe('123') // Arrow's unscaled decimal words
      const wide = await session.queryArrow('SELECT toDecimal256(1.23, 2) AS d') as Table
      expect((wide.schema.fields[0]!.type as { bitWidth: number }).bitWidth).toBe(256)
      expect(Array.from(wide.batches[0]!.data.children[0]!.values as Uint32Array).slice(0, 8))
        .toEqual([123, 0, 0, 0, 0, 0, 0, 0])
      const binary = await session.queryArrow("SELECT toString('é') AS s", { stringAsString: false }) as Table
      expect(binary.schema.fields[0]!.type.toString()).toBe('Binary')
      expect(Array.from(binary.toArray()[0]!.s as Uint8Array)).toEqual([195, 169])
      const dictionary = await session.queryArrow(
        'SELECT toLowCardinality(toString(number % 2)) AS s FROM numbers(4)',
        { lowCardinalityAsDictionary: true },
      ) as Table
      expect(dictionary.schema.fields[0]!.type.toString()).toBe('Dictionary<Uint32, Utf8>')
      expect(dictionary.toArray().map((row) => row.s)).toEqual(['0', '1', '0', '1'])
      const unsupported = 'SELECT sumState(toUInt64(1)) AS state'
      await expect(session.queryArrow(unsupported)).rejects.toThrow(/not supported for conversion/)
      const fallback = await session.queryArrow(unsupported, { unsupportedAsBinary: true }) as Table
      expect(fallback.schema.fields[0]!.type.toString()).toBe('Binary')
    } finally {
      session.close()
    }
  })
})

describe('Session.queryArrowStream — incremental C Data batches', () => {
  it('fetches typed batches incrementally and keeps a stable schema', async () => {
    const session = new Session()
    try {
      const reader = session.queryArrowStream(
        'SELECT toInt32(number) AS x FROM numbers(7) SETTINGS max_block_size=2',
      )
      const lengths: number[] = []
      const values: number[] = []
      for await (const value of reader) {
        const batch = value as RecordBatch
        lengths.push(batch.numRows)
        values.push(...batch.getChild('x')!.toArray() as Int32Array)
      }
      expect(lengths).toEqual([2, 2, 2, 1])
      expect(values).toEqual([0, 1, 2, 3, 4, 5, 6])
      expect((reader.schema as Schema).fields[0]!.name).toBe('x')
      expect(reader.closed).toBe(true)
    } finally {
      session.close()
    }
  })

  it('keeps LowCardinality dictionary indices valid across batches', async () => {
    const session = new Session()
    try {
      const reader = session.queryArrowStream(
        'SELECT toLowCardinality(toString(number % 2)) AS s FROM numbers(7) SETTINGS max_block_size=2',
        { lowCardinalityAsDictionary: true },
      )
      const values: string[] = []
      for await (const value of reader) values.push(...(value as RecordBatch).toArray().map((row) => row.s))
      expect(values).toEqual(['0', '1', '0', '1', '0', '1', '0'])
      expect((reader.schema as Schema).fields[0]!.type.toString()).toBe('Dictionary<Uint32, Utf8>')
    } finally {
      session.close()
    }
  })

  it('retains an empty result schema and cancels on early break', async () => {
    const session = new Session()
    try {
      const empty = session.queryArrowStream('SELECT toInt32(1) AS x WHERE 0')
      let count = 0
      for await (const _batch of empty) count++
      expect(count).toBe(0)
      expect((empty.schema as Schema).fields[0]!.name).toBe('x')

      const reader = session.queryArrowStream('SELECT toInt32(number) AS x FROM numbers(100) SETTINGS max_block_size=2')
      for await (const _batch of reader) break
      expect(reader.closed).toBe(true)
      const healthy = await session.queryArrow('SELECT toInt32(7) AS x') as Table
      expect(healthy.toArray()[0]!.x).toBe(7)
    } finally {
      session.close()
    }
  })

  it('defers cancel and Session close behind an in-flight native fetch', async () => {
    const session = new Session()
    const reader = session.queryArrowStream(
      'SELECT toInt32(number) AS x FROM numbers(4) WHERE sleepEachRow(0.03)=0 SETTINGS max_block_size=1',
    )
    const iterator = reader[Symbol.asyncIterator]()
    const next = iterator.next()
    reader.cancel()
    session.close()
    try {
      await next
      await iterator.return?.()
      await drainPending()
      expect(reader.closed).toBe(true)
    } finally {
      reader.cancel()
      session.close()
      await drainPending()
    }
  })
})
