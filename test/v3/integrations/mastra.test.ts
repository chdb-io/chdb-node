import { describe, it, expect, beforeEach } from 'vitest'
import { Session } from '../../../index.js'
// @ts-expect-error - .mjs adapter has a sibling .d.mts; vitest resolves the runtime file
import { chdbTools, chdbQueryTool, ChDBVector } from '../../../integrations/mastra.mjs'

// The Mastra adapter wraps the same executors via createTool, and re-exports ChDBVector.

let db: Session

beforeEach(() => {
  db = new Session()
  db.query(`CREATE TABLE t (id UInt64, name String) ENGINE = MergeTree ORDER BY id`)
  db.query(`INSERT INTO t VALUES (1, 'Alice')`)
})

describe('chdb/mastra', () => {
  it('builds a three-tool toolset with createTool ids', () => {
    const tools = chdbTools({ session: db }) as any
    expect(Object.keys(tools).sort()).toEqual(['chdbDescribeSource', 'chdbListTables', 'chdbQuery'])
    expect(tools.chdbQuery.id).toBe('chdb-query')
  })

  it('chdbQuery executes and returns rows', async () => {
    const { chdbQuery } = chdbTools({ session: db }) as any
    const out = await chdbQuery.execute({ sql: 'SELECT id, name FROM t' })
    expect(out.error).toBeUndefined()
    expect(out.rows).toEqual([{ id: 1, name: 'Alice' }])
  })

  it('re-exports ChDBVector (a working vector store)', async () => {
    expect(typeof ChDBVector).toBe('function')
    const store = new ChDBVector({ session: db })
    await store.createIndex({ indexName: 'v', dimension: 2 })
    await store.upsert({ indexName: 'v', vectors: [[1, 0]], ids: ['a'] })
    const res = await store.query({ indexName: 'v', queryVector: [1, 0], topK: 1 })
    expect(res[0].id).toBe('a')
  })

  it('chdbQueryTool returns a single tool', () => {
    expect(chdbQueryTool({ session: db }).id).toBe('chdb-query')
  })
})
