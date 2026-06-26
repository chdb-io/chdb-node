import { describe, it, expect, beforeEach } from 'vitest'
import { session, selectFrom } from '../../../index.js'

// .stream() — the large-result path: rows arrive lazily through Layer 1's
// streaming cursor (chdb_stream_query_with_params_n) instead of buffering the
// whole result. Values are still bound server-side, so a streamed read is as
// injection-safe as .execute(). The global afterEach (setup.ts) force-closes
// every session, so the fixture is rebuilt per test.

let db: ReturnType<typeof session>

beforeEach(async () => {
  db = session()
  await db.session!.queryAsync(
    `CREATE TABLE t (id UInt64, name String) ENGINE = MergeTree ORDER BY id`,
    { format: 'CSV' },
  )
  await db
    .insertInto('t')
    .values([
      { id: 1, name: "O'Brien" },
      { id: 2, name: 'Bob' },
      { id: 18446744073709551615n as unknown as number, name: 'Max' },
    ])
    .execute()
})

async function collect<T>(it: AsyncIterableIterator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const row of it) out.push(row)
  return out
}

describe('.stream()', () => {
  it('streams the same rows .execute() returns, in order', async () => {
    const q = () => db.selectFrom('t').select(['id', 'name']).orderBy('id')
    const streamed = await collect(q().stream())
    const executed = await q().execute()
    expect(streamed).toEqual(executed)
  })

  it('binds a value server-side (no interpolation) and filters', async () => {
    const rows = await collect(
      db.selectFrom('t').select(['id', 'name']).where('name', '=', "O'Brien").stream(),
    )
    expect(rows).toEqual([{ id: '1', name: "O'Brien" }])
  })

  it('keeps 64-bit ids as strings (row precision setting injected)', async () => {
    const rows = (await collect(
      db.selectFrom('t').select('id').orderBy('id').stream(),
    )) as { id: string }[]
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '18446744073709551615'])
  })

  it('throws synchronously without a bound session', () => {
    expect(() => selectFrom('t').selectAll().stream()).toThrow(/bound session/)
  })

  it('aborts an in-flight stream via AbortSignal', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      collect(db.selectFrom('t').selectAll().stream({ signal: ac.signal })),
    ).rejects.toThrow()
  })
})
