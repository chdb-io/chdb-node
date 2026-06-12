import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { Session } from '../../index.js'

// Streaming insert: the backpressure contract, end to end.
//   Backpressure is flow-control, not an error; every backpressure-adjacent
//   failure is a typed error that settles the promise — never a silent hang
//   (the vitest timeout is the hang detector). Every failure carries a
//   progress snapshot. Already-flushed chunks are not rolled back
//   (at-least-once; failedAtRow/rowsSent are observability, NOT resume).

const line = (i: number, pad = 24) => JSON.stringify({ id: i, msg: 'x'.repeat(pad) })

function* ndjsonChunks(n: number, chunkBytes: number, pad = 24): Generator<Buffer> {
  let buf = ''
  for (let i = 0; i < n; i++) {
    buf += line(i, pad) + '\n'
    while (buf.length >= chunkBytes) {
      yield Buffer.from(buf.slice(0, chunkBytes))
      buf = buf.slice(chunkBytes)
    }
  }
  if (buf.length) yield Buffer.from(buf)
}

describe('insert: streaming (Readable / AsyncIterable + format)', () => {
  let session: Session
  beforeEach(() => {
    session = new Session()
    session.query('CREATE TABLE s (id UInt32, msg String) ENGINE = MergeTree ORDER BY id')
  })
  afterEach(() => session?.close())

  it('multi-chunk stream: both ledgers exact, rows conserved, progress monotonic', async () => {
    const N = 2000
    const seen: number[] = []
    const sum = await session.insert({
      table: 's',
      values: Readable.from(ndjsonChunks(N, 1024)),
      format: 'JSONEachRow',
      maxChunkBytes: 16 * 1024,
      onProgress: (p) => seen.push(p.rowsSent),
    })
    expect(sum.rowsSent).toBe(N)
    expect(sum.rowsWritten).toBe(N)
    expect(sum.chunks).toBeGreaterThan(1)
    expect(seen.length).toBe(sum.chunks)
    expect([...seen]).toEqual([...seen].sort((a, b) => a - b)) // monotonic
    expect(session.query('SELECT count(), min(id), max(id) FROM s', 'CSV').trim()).toBe(`${N},0,${N - 1}`)
  })

  it('cuts only at row boundaries: straddling lines, blank lines, missing trailing newline', async () => {
    async function* src() {
      yield Buffer.from('{"id":1,"msg":"a"}\n\n{"id":2,"ms') // row 2 straddles chunks; blank line in between
      yield Buffer.from('g":"b"}\n   \n')
      yield Buffer.from('{"id":3,"msg":"c"}') // no trailing newline
    }
    const sum = await session.insert({
      table: 's', values: src(), format: 'JSONEachRow', maxChunkBytes: 24,
    })
    expect(sum.rowsSent).toBe(3) // blank/whitespace-only lines are not rows
    expect(sum.rowsWritten).toBe(3)
    expect(session.query('SELECT count() FROM s', 'CSV').trim()).toBe('3')
  })

  it('multi-byte UTF-8 across the chunk cut round-trips byte-exact', async () => {
    const msg = '🚀🙂émoji🎯'.repeat(40)
    const payload = Buffer.from(JSON.stringify({ id: 1, msg }) + '\n' + JSON.stringify({ id: 2, msg }) + '\n')
    async function* drip() {
      for (let o = 0; o < payload.length; o += 7) yield payload.subarray(o, o + 7)
    }
    await session.insert({ table: 's', values: drip(), format: 'JSONEachRow', maxChunkBytes: 64 })
    expect(session.query('SELECT countIf(msg = ' + `'${msg}'` + ') FROM s', 'CSV').trim()).toBe('2')
  })

  it('accepts mixed Buffer / string / Uint8Array chunks', async () => {
    async function* mixed() {
      yield '{"id":1,"msg":"str"}\n'
      yield Buffer.from('{"id":2,"msg":"buf"}\n')
      yield new Uint8Array(Buffer.from('{"id":3,"msg":"u8"}\n'))
    }
    const sum = await session.insert({ table: 's', values: mixed(), format: 'JSONEachRow' })
    expect(sum.rowsSent).toBe(3)
  })

  it('backpressure is pull-based: the producer never runs ahead by more than the bounded buffer', async () => {
    const maxChunkBytes = 8 * 1024
    let yielded = 0
    let maxLead = 0
    let flushedBytes = 0
    async function* paced() {
      for (const chunk of ndjsonChunks(3000, 512)) {
        yielded += chunk.length
        maxLead = Math.max(maxLead, yielded - flushedBytes)
        yield chunk
      }
    }
    await session.insert({
      table: 's', values: paced(), format: 'JSONEachRow', maxChunkBytes,
      onProgress: (p) => { flushedBytes = p.bytesSent },
    })
    // At most one in-flight accumulation (≤ maxChunkBytes) plus one source chunk.
    expect(maxLead).toBeLessThanOrEqual(maxChunkBytes + 1024)
  })
})

describe('insert: streaming failure taxonomy (six reasons, all typed, all settle)', () => {
  let session: Session
  beforeEach(() => {
    session = new Session()
    session.query('CREATE TABLE q (n UInt32) ENGINE = Memory')
  })
  afterEach(() => session?.close())

  it("source 'error' → reason source-error, cause preserved, progress attached", async () => {
    const src = new Readable({ read() {} })
    src.push('{"n":1}\n')
    setTimeout(() => src.destroy(new Error('upstream exploded')), 20)
    let err: { code?: string; reason?: string; cause?: unknown; progress?: object } | undefined
    try {
      await session.insert({ table: 'q', values: src, format: 'JSONEachRow' })
    } catch (e: unknown) {
      err = e as never
    }
    expect(err?.code).toBe('CHDB_INSERT')
    expect(err?.reason).toBe('source-error')
    expect(String((err?.cause as Error)?.message ?? err?.cause)).toContain('upstream exploded')
    expect(err?.progress).toBeDefined()
  })

  it('premature close (destroy without error) → source-error too', async () => {
    const src = new Readable({ read() {} })
    src.push('{"n":1}\n')
    setTimeout(() => src.destroy(), 20)
    await expect(
      session.insert({ table: 'q', values: src, format: 'JSONEachRow' }),
    ).rejects.toMatchObject({ code: 'CHDB_INSERT', reason: 'source-error' })
  })

  it("stalled producer + stallTimeout → ChdbTimeoutError{reason:'stall'}", async () => {
    async function* stalls() {
      yield Buffer.from('{"n":1}\n')
      await new Promise(() => {}) // never yields again, never ends
    }
    await expect(
      session.insert({ table: 'q', values: stalls(), format: 'JSONEachRow', stallTimeout: 200 }),
    ).rejects.toMatchObject({ code: 'CHDB_TIMEOUT', reason: 'stall' })
  })

  it('no stallTimeout → long quiet periods are legal (negative case)', async () => {
    async function* quiet() {
      yield Buffer.from('{"n":1}\n')
      await new Promise((r) => setTimeout(r, 300))
      yield Buffer.from('{"n":2}\n')
    }
    const sum = await session.insert({ table: 'q', values: quiet(), format: 'JSONEachRow' })
    expect(sum.rowsSent).toBe(2)
  })

  it('un-pausable source past the bounded buffer → backpressure-overflow, not OOM', async () => {
    const src = new Readable({ read() {} })
    for (let i = 0; i < 64; i++) src.push(Buffer.alloc(4096, 0x61)) // stuff 256KB before any pull
    await expect(
      session.insert({ table: 'q', values: src, format: 'JSONEachRow', maxBufferedBytes: 64 * 1024 }),
    ).rejects.toMatchObject({ code: 'CHDB_INSERT', reason: 'backpressure-overflow' })
    src.destroy()
  })

  it('chunk write failure → write-failure with ABSOLUTE failedAtRow; remaining source not pulled', async () => {
    // 6 good rows (flushed in earlier chunks), one bad row, then a long good
    // tail. Chunking has a one-row lookahead (rows pack into the failing
    // chunk until the size threshold), so "pull stopped" is asserted on the
    // tail well past the failing chunk, not on the bad row's neighbour.
    const rows = [
      '{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}', '{"n":5}', '{"n":6}',
      '{boom',
      ...Array.from({ length: 12 }, (_, i) => `{"n":${8 + i}}`),
    ]
    let pulledPastFailure = false
    async function* src() {
      for (const [i, r] of rows.entries()) {
        if (i >= 11) pulledPastFailure = true // only reachable if iteration survives the failing chunk
        yield Buffer.from(r + '\n')
      }
    }
    let err: { reason?: string; failedAtRow?: number; progress?: { rowsSent: number } } | undefined
    try {
      await session.insert({ table: 'q', values: src(), format: 'JSONEachRow', maxChunkBytes: 16 })
    } catch (e: unknown) {
      err = e as never
    }
    expect(err?.reason).toBe('write-failure')
    expect(err?.failedAtRow).toBe(7) // absolute: rows flushed in earlier chunks + engine's "(at row N)"
    expect(err?.progress?.rowsSent).toBe(6) // the six good rows before the bad chunk were flushed
    expect(pulledPastFailure).toBe(false) // pull stopped at the failure
    expect(session.query('SELECT count() FROM q', 'CSV').trim()).toBe('6') // flushed chunks stay (at-least-once)
  })

  it('abort mid-stream → AbortError; flushed chunks remain; source torn down', async () => {
    const ctl = new AbortController()
    const src = Readable.from(ndjsonChunks(5000, 512))
    let err: { code?: string; progress?: { chunks: number } } | undefined
    try {
      await session.insert({
        table: 'q',
        values: src,
        format: 'JSONEachRow',
        maxChunkBytes: 4 * 1024,
        columns: ['n'],
        settings: { input_format_skip_unknown_fields: 1 },
        onProgress: (p) => { if (p.chunks === 2) ctl.abort() },
        signal: ctl.signal,
      })
    } catch (e: unknown) {
      err = e as never
    }
    expect(err?.code).toBe('CHDB_ABORT')
    expect(err?.progress?.chunks).toBeGreaterThanOrEqual(2)
    expect(src.destroyed).toBe(true)
    expect(Number(session.query('SELECT count() FROM q', 'CSV').trim())).toBeGreaterThan(0)
  })

  it('pre-aborted signal rejects before pulling anything', async () => {
    const ctl = new AbortController()
    ctl.abort()
    let pulled = false
    async function* src() {
      pulled = true
      yield Buffer.from('{"n":1}\n')
    }
    await expect(
      session.insert({ table: 'q', values: src(), format: 'JSONEachRow', signal: ctl.signal }),
    ).rejects.toMatchObject({ code: 'CHDB_ABORT' })
    expect(pulled).toBe(false)
  })

  it('a single row past maxRowBytes (no boundary) → row-too-large, refusing unbounded buffering', async () => {
    async function* endless() {
      while (true) yield Buffer.alloc(64 * 1024, 0x61) // 'a' forever, never a newline
    }
    await expect(
      session.insert({
        table: 'q', values: endless(), format: 'JSONEachRow',
        maxChunkBytes: 64 * 1024, maxRowBytes: 256 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'CHDB_INSERT', reason: 'row-too-large' })
  })

  it('object rows are rejected at the first chunk with the NDJSON-mapping recipe', async () => {
    async function* objs() {
      yield { n: 1 } as never
    }
    let msg = ''
    try {
      await session.insert({ table: 'q', values: objs(), format: 'JSONEachRow' })
    } catch (e: unknown) {
      msg = (e as Error).message
    }
    expect(msg).toContain('JSON.stringify')
  })

  it('format gate: CSV and WithNames variants are rejected for streams with the workaround', async () => {
    for (const format of ['CSV', 'CSVWithNames', 'TSVWithNames'] as const) {
      let err: { code?: string; message?: string } | undefined
      try {
        await session.insert({ table: 'q', values: Readable.from([Buffer.from('1\n')]), format: format as never })
      } catch (e: unknown) {
        err = e as never
      }
      expect(err?.code).toBe('CHDB_INSERT')
      expect(err?.message).toMatch(/single-shot/)
    }
  })
})
