import { describe, it, expect, beforeEach } from 'vitest'
import { Session } from '../../../index.js'
// @ts-expect-error - .mjs adapter has a sibling .d.mts; vitest resolves the runtime file
import { chdbTools, chdbQueryTool } from '../../../integrations/ai-sdk.mjs'

// The Vercel AI SDK adapter wraps the shared executors: a schema-aware toolset
// (query / listTables / describeSource) with engine-level read-only by default.

const callOpts = { toolCallId: 't', messages: [] }
let db: Session

beforeEach(() => {
  db = new Session()
  db.query(`CREATE TABLE t (id UInt64, name String) ENGINE = MergeTree ORDER BY id`)
  db.query(`INSERT INTO t VALUES (1, 'Alice'), (2, 'Bob')`)
})

describe('chdb/ai-sdk', () => {
  it('exposes a three-tool toolset', () => {
    const tools = chdbTools({ session: db })
    expect(Object.keys(tools).sort()).toEqual(['chdbDescribeSource', 'chdbListTables', 'chdbQuery'])
    for (const t of Object.values(tools) as any[]) expect(typeof t.execute).toBe('function')
  })

  it('chdbQuery runs SQL and returns rows', async () => {
    const { chdbQuery } = chdbTools({ session: db }) as any
    const out = await chdbQuery.execute({ sql: 'SELECT id, name FROM t ORDER BY id' }, callOpts)
    expect(out.error).toBeUndefined()
    expect(out.rowCount).toBe(2)
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ])
  })

  it('chdbListTables and chdbDescribeSource expose the schema', async () => {
    const { chdbListTables, chdbDescribeSource } = chdbTools({ session: db }) as any
    const tables = await chdbListTables.execute({}, callOpts)
    expect(tables.tables).toContain('t')
    const desc = await chdbDescribeSource.execute({ source: 't' }, callOpts)
    expect(desc.columns).toEqual([
      { name: 'id', type: 'UInt64' },
      { name: 'name', type: 'String' },
    ])
  })

  it('is read-only by default — a write is rejected by the engine', async () => {
    const { chdbQuery } = chdbTools({ session: db }) as any
    const out = await chdbQuery.execute({ sql: "INSERT INTO t VALUES (3, 'Eve')" }, callOpts)
    expect(out.rows).toEqual([])
    expect(out.error).toMatch(/readonly|read-only|Cannot/i)
  })

  it('returns the engine error instead of throwing', async () => {
    const tool = chdbQueryTool({ session: db }) as any
    const out = await tool.execute({ sql: 'SELECT * FROM does_not_exist' }, callOpts)
    expect(out.rows).toEqual([])
    expect(typeof out.error).toBe('string')
  })
})
