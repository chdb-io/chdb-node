import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { Session } from '../../index.js'

// Heavy acceptance gates (CHDB_TEST_HUGE=1; run locally / nightly, not on the
// default CI lane):
//   A1  256MB single-shot insert keeps the event loop responsive (p99 < 10ms)
//   A3  a 1GB Buffer inserts successfully (past the V8 string ceiling)
//   B5  a multi-GB stream completes with bounded RSS
const HUGE = !!process.env.CHDB_TEST_HUGE

function ndjsonBuffer(totalBytes: number): Buffer {
  // Pre-build with Buffer.concat so the test itself never creates a giant V8 string.
  const row = Buffer.from(JSON.stringify({ id: 1, msg: 'm'.repeat(990) }) + '\n') // ~1KB
  const reps = Math.ceil(totalBytes / row.length)
  return Buffer.concat(Array.from({ length: reps }, () => row))
}

describe.skipIf(!HUGE)('insert: heavy acceptance gates (CHDB_TEST_HUGE)', () => {
  let session: Session
  beforeEach(() => {
    session = new Session()
    session.query('CREATE TABLE h (id UInt32, msg String) ENGINE = MergeTree ORDER BY id')
  })
  afterEach(() => session?.close())

  it('A1: a 256MB insert keeps event-loop jitter p99 under 10ms', async () => {
    const payload = ndjsonBuffer(256 * 1024 * 1024)
    const jitters: number[] = []
    let last = process.hrtime.bigint()
    const timer = setInterval(() => {
      const now = process.hrtime.bigint()
      jitters.push(Number(now - last) / 1e6 - 5) // delay beyond the 5ms interval
      last = now
    }, 5)
    try {
      const sum = await session.insert({ table: 'h', values: payload, format: 'JSONEachRow' })
      expect(sum.bytesSent).toBe(payload.length)
    } finally {
      clearInterval(timer)
    }
    const sorted = jitters.slice(2).sort((a, b) => a - b) // drop warmup ticks
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0
    expect(p99).toBeLessThan(10)
  }, 300_000)

  it('A3: a 1GB Buffer inserts (payload past the V8 string ceiling)', async () => {
    const payload = ndjsonBuffer(1024 * 1024 * 1024)
    expect(payload.length).toBeGreaterThan(2 ** 29) // > the ~512MB V8 string limit
    const sum = await session.insert({ table: 'h', values: payload, format: 'JSONEachRow' })
    expect(sum.rowsWritten).toBeGreaterThan(1_000_000)
  }, 600_000)

  it('B5: a 4GB stream completes with bounded memory (O(chunk), not O(total))', async () => {
    const row = Buffer.from(JSON.stringify({ id: 7, msg: 'm'.repeat(990) }) + '\n')
    const total = 4 * 1024 * 1024 * 1024
    async function* synth() {
      for (let sent = 0; sent < total; sent += row.length) yield row
    }
    const rssBefore = process.memoryUsage().rss
    let rssPeak = rssBefore
    const sum = await session.insert({
      table: 'h', values: synth(), format: 'JSONEachRow',
      maxChunkBytes: 8 * 1024 * 1024,
      onProgress: () => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss) },
    })
    expect(sum.bytesSent).toBeGreaterThanOrEqual(total)
    // JS-side overhead stays O(chunk); the generous bound absorbs engine-side buffers.
    expect(rssPeak - rssBefore).toBeLessThan(1.5 * 1024 * 1024 * 1024)
  }, 1_800_000)

  it('leak gate: 50 x 32MB inserts hold a flat RSS in the second half', async () => {
    const payload = ndjsonBuffer(32 * 1024 * 1024)
    const samples: number[] = []
    for (let i = 0; i < 50; i++) {
      await session.insert({ table: 'h', values: payload, format: 'JSONEachRow' })
      if (i >= 25) samples.push(process.memoryUsage().rss)
    }
    const first = samples.slice(0, 5).reduce((a, b) => a + b, 0) / 5
    const last = samples.slice(-5).reduce((a, b) => a + b, 0) / 5
    expect(last - first).toBeLessThan(256 * 1024 * 1024) // flat within noise
  }, 1_800_000)
})

// Always-on lightweight stand-in for the jitter gate: proves the dispatch path
// itself never serializes on the main thread (a 16MB payload through the raw
// path must not produce a single >250ms stall, which the old VALUES path
// reliably would at this size).
describe('insert: event-loop responsiveness (light, always on)', () => {
  it('16MB raw insert produces no quarter-second main-thread stall', async () => {
    const session = new Session()
    try {
      session.query('CREATE TABLE l (id UInt32, msg String) ENGINE = Memory')
      const payload = ndjsonBuffer(16 * 1024 * 1024)
      let maxGap = 0
      let last = Date.now()
      const timer = setInterval(() => {
        maxGap = Math.max(maxGap, Date.now() - last - 5)
        last = Date.now()
      }, 5)
      try {
        await session.insert({ table: 'l', values: payload, format: 'JSONEachRow' })
      } finally {
        clearInterval(timer)
      }
      expect(maxGap).toBeLessThan(250)
    } finally {
      session.close()
    }
  }, 60_000)
})
