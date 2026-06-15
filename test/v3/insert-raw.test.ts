import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Session } from '../../index.js'

// Raw-format passthrough insert. The payload is handed to the native
// side as bytes; the engine parses (JS never builds an object tree). Every
// failure must be a typed error — never a hang (test timeout would catch it).
//
// Two row ledgers, asserted throughout:
//  - rowsSent     payload view: non-empty payload lines (line formats only)
//  - rowsWritten  engine view (chdb-io/chdb-core#88): includes MV-cascade writes

const NDJSON = '{"id":1,"msg":"a"}\n{"id":2,"msg":"b c"}\n{"id":3,"msg":"🚀🙂"}\n'

describe('insert: raw passthrough (Buffer/string + format)', () => {
  let session: Session
  beforeEach(() => {
    session = new Session()
    session.query('CREATE TABLE t (id UInt64, msg String) ENGINE = MergeTree ORDER BY id')
  })
  afterEach(() => session?.close())

  it('inserts a Buffer payload and reports both ledgers', async () => {
    const buf = Buffer.from(NDJSON)
    const sum = await session.insert({ table: 't', values: buf, format: 'JSONEachRow' })
    expect(sum.rowsWritten).toBe(3) // engine-reported write progress
    expect(sum.rowsSent).toBe(3) // payload ledger (native line scan)
    expect(sum.bytesSent).toBe(buf.length)
    expect(sum.bytesWritten).toBeGreaterThan(0)
    expect(session.query('SELECT count(), sum(id) FROM t', 'CSV').trim()).toBe('3,6')
  })

  it('round-trips UTF-8/emoji and uint64 ns timestamps exactly', async () => {
    session.query('CREATE TABLE ns (id UInt64, ts UInt64, msg String) ENGINE = Memory')
    const line = '{"id":1,"ts":"1780000000000000001","msg":"émoji 🚀"}\n'
    await session.insert({ table: 'ns', values: Buffer.from(line), format: 'JSONEachRow' })
    expect(session.query('SELECT ts, msg FROM ns', 'TSVRaw').trim()).toBe('1780000000000000001\témoji 🚀')
  })

  it('accepts string and Uint8Array payloads (documented conveniences)', async () => {
    const s1 = await session.insert({ table: 't', values: NDJSON, format: 'JSONEachRow' })
    expect(s1.rowsWritten).toBe(3)
    const u8 = new Uint8Array(Buffer.from('{"id":9,"msg":"u8"}\n'))
    const s2 = await session.insert({ table: 't', values: u8, format: 'JSONEachRow' })
    expect(s2.rowsWritten).toBe(1)
    expect(session.query('SELECT count() FROM t', 'CSV').trim()).toBe('4')
  })

  it('NUL bytes survive the length-aware path (no gate, no truncation)', async () => {
    const nul = String.fromCharCode(0)
    await session.insert({
      table: 't',
      values: Buffer.from(`{"id":7,"msg":"a${nul}b"}\n`),
      format: 'JSONEachRow',
    })
    expect(session.query('SELECT length(msg) FROM t WHERE id=7', 'CSV').trim()).toBe('3')
  })

  it('handles a missing trailing newline (last line still counted and inserted)', async () => {
    const sum = await session.insert({
      table: 't',
      values: Buffer.from('{"id":1,"msg":"x"}\n{"id":2,"msg":"y"}'),
      format: 'JSONEachRow',
    })
    expect(sum.rowsSent).toBe(2)
    expect(sum.rowsWritten).toBe(2)
  })

  it('empty payloads short-circuit to a zero summary without touching the engine', async () => {
    for (const empty of [Buffer.alloc(0), '', new Uint8Array(0)]) {
      const sum = await session.insert({ table: 't', values: empty as never, format: 'JSONEachRow' })
      expect(sum.rowsWritten).toBe(0)
      expect(sum.bytesSent).toBe(0)
    }
  })
})

describe('insert: raw formats matrix', () => {
  let session: Session
  beforeEach(() => {
    session = new Session()
    session.query('CREATE TABLE m (a UInt32, b String) ENGINE = Memory')
  })
  afterEach(() => session?.close())

  it('CSV inserts; rowsSent is undefined (quoted newlines make line counts unreliable)', async () => {
    const sum = await session.insert({ table: 'm', values: '1,"x"\n2,"y"\n', format: 'CSV' })
    expect(sum.rowsWritten).toBe(2) // engine ledger still exact for CSV
    expect(sum.rowsSent).toBeUndefined()
  })

  it('CSVWithNames consumes the header; engine ledger counts data rows only', async () => {
    const sum = await session.insert({ table: 'm', values: 'a,b\n1,"x"\n2,"y"\n', format: 'CSVWithNames' })
    expect(sum.rowsWritten).toBe(2)
    expect(session.query('SELECT count() FROM m', 'CSV').trim()).toBe('2')
  })

  it('TSV / TSVWithNames: rowsSent excludes the header line', async () => {
    const s1 = await session.insert({ table: 'm', values: '1\tx\n2\ty\n', format: 'TSV' })
    expect(s1.rowsSent).toBe(2)
    const s2 = await session.insert({ table: 'm', values: 'a\tb\n3\tz\n', format: 'TSVWithNames' })
    expect(s2.rowsSent).toBe(1)
    expect(s2.rowsWritten).toBe(1)
  })

  it('type parity: JSONEachRow passthrough matches the VALUES object path column-for-column', async () => {
    const ddl = `(i Int64, u UInt64, f Float64, d DateTime64(9), arr Array(Int32),
                  n Nullable(String), s String) ENGINE = Memory`
    session.query(`CREATE TABLE via_values ${ddl}`)
    session.query(`CREATE TABLE via_raw ${ddl}`)
    const logical = {
      i: -(2n ** 62n), u: 1780000000000000001n, f: 1.5,
      d: new Date('2026-06-12T10:20:30.000Z'), arr: [1, -2, 3], n: null, s: "quote ' back \\ tab\t🚀",
    }
    await session.insert({ table: 'via_values', values: [logical] })
    const rawLine = JSON.stringify({
      i: String(logical.i), u: String(logical.u), f: logical.f,
      d: '2026-06-12 10:20:30.000000000', arr: logical.arr, n: null, s: logical.s,
    })
    await session.insert({ table: 'via_raw', values: rawLine + '\n', format: 'JSONEachRow' })
    const a = session.query('SELECT * FROM via_values', 'TSVRaw')
    const b = session.query('SELECT * FROM via_raw', 'TSVRaw')
    expect(b).toBe(a)
  })

  it('rowsWritten includes materialized-view cascade writes (engine write-progress semantics)', async () => {
    session.query('CREATE TABLE src (k UInt64) ENGINE = Null')
    session.query('CREATE TABLE dst (k UInt64) ENGINE = MergeTree ORDER BY k')
    session.query('CREATE MATERIALIZED VIEW mv TO dst AS SELECT k FROM src')
    const sum = await session.insert({ table: 'src', values: '{"k":1}\n{"k":2}\n', format: 'JSONEachRow' })
    expect(sum.rowsSent).toBe(2) // payload ledger: what was sent
    expect(sum.rowsWritten).toBe(4) // engine ledger: Null sink (2) + MV target (2)
    expect(session.query('SELECT count() FROM dst', 'CSV').trim()).toBe('2')
  })

  it('settings channel: per-insert SETTINGS reach the engine', async () => {
    const line = '{"a":5,"b":"ok","extra":42}\n'
    // skip_unknown_fields defaults ON in current engines — force it OFF to
    // prove the per-insert settings clause actually takes effect…
    await expect(
      session.insert({
        table: 'm', values: line, format: 'JSONEachRow',
        settings: { input_format_skip_unknown_fields: 0 },
      }),
    ).rejects.toMatchObject({ code: 'CHDB_INSERT' })
    // …and back ON explicitly: accepted.
    const sum = await session.insert({
      table: 'm', values: line, format: 'JSONEachRow',
      settings: { input_format_skip_unknown_fields: 1 },
    })
    expect(sum.rowsWritten).toBe(1)
  })

  it('columns option targets a subset (others take defaults)', async () => {
    const sum = await session.insert({ table: 'm', values: '7\n', format: 'CSV', columns: ['a'] })
    expect(sum.rowsWritten).toBe(1)
    expect(session.query("SELECT a, b FROM m WHERE a=7", 'CSV').trim()).toBe('7,""')
  })
})

describe('insert: raw failure paths (typed, never a hang)', () => {
  let session: Session
  beforeEach(() => {
    session = new Session()
    session.query('CREATE TABLE f (n UInt32, s String) ENGINE = Memory')
  })
  afterEach(() => session?.close())

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p
      return ''
    } catch (e: unknown) {
      return (e as { code?: string })?.code ?? ''
    }
  }

  it('a bad JSON line is a typed error with failedAtRow, and the batch lands zero rows', async () => {
    let err: { code?: string; failedAtRow?: number } | undefined
    try {
      await session.insert({
        table: 'f',
        values: '{"n":1,"s":"ok"}\n{broken json\n{"n":3,"s":"ok"}\n',
        format: 'JSONEachRow',
      })
    } catch (e: unknown) {
      err = e as never
    }
    expect(err?.code).toBe('CHDB_INSERT')
    expect(err?.failedAtRow).toBe(2) // parsed from the engine's "(at row 2)"
    expect(session.query('SELECT count() FROM f', 'CSV').trim()).toBe('0') // block-atomic
  })

  it('dispatch matrix: every rejected branch is typed and carries its workaround', async () => {
    // raw bytes without format
    expect(await codeOf(session.insert({ table: 'f', values: Buffer.from('x') } as never))).toBe('CHDB_INSERT')
    // row array WITH format (reserved for chunked object inserts)
    expect(await codeOf(session.insert({ table: 'f', values: [{ n: 1, s: 'x' }], format: 'JSONEachRow' } as never))).toBe('CHDB_INSERT')
    // non-whitelisted format
    expect(await codeOf(session.insert({ table: 'f', values: 'x', format: 'Parquet' } as never))).toBe('CHDB_INSERT')
    // hostile table / setting names never reach SQL
    expect(await codeOf(session.insert({ table: 'f; DROP TABLE f', values: 'x\n', format: 'CSV' } as never))).toBe('CHDB_INSERT')
    expect(await codeOf(session.insert({ table: 'f', values: '1,"x"\n', format: 'CSV', settings: { 'a=1, b': 1 } } as never))).toBe('CHDB_INSERT')
  })

  it('format/data mismatch surfaces the engine error (re-wrapped, typed)', async () => {
    const code = await codeOf(session.insert({ table: 'f', values: '{"n":1,"s":"x"}\n', format: 'CSV' }))
    expect(code).toMatch(/^CHDB_/)
  })

  it('#26 regression: complex types via passthrough neither hang nor corrupt', async () => {
    session.query('CREATE TABLE cx (a Array(String), m Map(String, UInt32)) ENGINE = Memory')
    const sum = await session.insert({
      table: 'cx',
      values: '{"a":["x","y"],"m":{"k1":1,"k2":2}}\n',
      format: 'JSONEachRow',
    })
    expect(sum.rowsWritten).toBe(1)
    expect(session.query('SELECT a[2], m[\'k2\'] FROM cx', 'CSV').trim()).toBe('"y",2')
  }, 10_000)

  it('a pre-aborted signal rejects immediately with AbortError', async () => {
    const ctl = new AbortController()
    ctl.abort()
    await expect(
      session.insert({ table: 'f', values: '1,"x"\n', format: 'CSV', signal: ctl.signal }),
    ).rejects.toMatchObject({ code: 'CHDB_ABORT' })
  })

  it('timeout settles early with ChdbTimeoutError (the write may still complete)', async () => {
    // A payload big enough that the engine cannot finish within 1ms.
    const big = Buffer.from(
      Array.from({ length: 200_000 }, (_, i) => `{"n":${i},"s":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}`).join('\n') + '\n',
    )
    await expect(
      session.insert({ table: 'f', values: big, format: 'JSONEachRow', timeout: 1 }),
    ).rejects.toMatchObject({ code: 'CHDB_TIMEOUT' })
  })
})

describe('insert: worker_threads recipe (serialize off-thread, transfer, passthrough)', () => {
  it('worker stringifies rows, transfers the ArrayBuffer, main thread inserts raw', async () => {
    const session = new Session()
    try {
      session.query('CREATE TABLE w (id UInt32, msg String) ENGINE = Memory')
      const { Worker } = await import('node:worker_threads')
      const worker = new Worker(
        `const { parentPort } = require('node:worker_threads')
         parentPort.on('message', (rows) => {
           const buf = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\\n') + '\\n')
           const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
           parentPort.postMessage(ab, [ab])
         })`,
        { eval: true },
      )
      try {
        const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, msg: `row-${i}` }))
        const ab: ArrayBuffer = await new Promise((resolve) => {
          worker.once('message', resolve)
          worker.postMessage(rows)
        })
        const sum = await session.insert({ table: 'w', values: Buffer.from(ab), format: 'JSONEachRow' })
        expect(sum.rowsWritten).toBe(100)
        expect(session.query('SELECT count() FROM w', 'CSV').trim()).toBe('100')
      } finally {
        await worker.terminate()
      }
    } finally {
      session.close()
    }
  })
})
