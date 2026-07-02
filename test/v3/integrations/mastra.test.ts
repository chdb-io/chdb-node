import { describe, it, expect, beforeEach } from 'vitest'
import { Session } from '../../../index.js'
// @ts-ignore - .mjs adapter has a sibling .d.mts; vitest resolves the runtime file
import { chdbTools, chdbQueryTool, ChDBVector, ChDBStore } from '../../../integrations/mastra.mjs'

// The Mastra adapter exposes the canonical CONTRACT.md toolset via createTool,
// thin over ChDBTool.call(), and re-exports ChDBVector / ChDBStore.

const CANON = [
  'attach_file',
  'describe_table',
  'get_sample_data',
  'list_databases',
  'list_functions',
  'list_tables',
  'run_select_query',
]
let db: Session

beforeEach(() => {
  db = new Session()
  db.query(`CREATE TABLE t (id UInt64, name String) ENGINE = MergeTree ORDER BY id`)
  db.query(`INSERT INTO t VALUES (1, 'Alice')`)
})

describe('chdb/mastra', () => {
  it('builds the canonical toolset with createTool ids', () => {
    const tools = chdbTools({ session: db }) as any
    expect(Object.keys(tools).sort()).toEqual(CANON)
    expect(tools.run_select_query.id).toBe('chdb-run-select-query')
  })

  it('run_select_query executes and returns an ok envelope', async () => {
    const { run_select_query } = chdbTools({ session: db }) as any
    const out = await run_select_query.execute({ sql: 'SELECT id, name FROM t' })
    expect(out.ok).toBe(true)
    expect(out.result.rows).toEqual([{ id: '1', name: 'Alice' }])
  })

  it('re-exports ChDBVector (a working vector store)', async () => {
    expect(typeof ChDBVector).toBe('function')
    const store = new ChDBVector({ session: db })
    await store.createIndex({ indexName: 'v', dimension: 2 })
    await store.upsert({ indexName: 'v', vectors: [[1, 0]], ids: ['a'] })
    const res = await store.query({ indexName: 'v', queryVector: [1, 0], topK: 1 })
    expect(res[0]!.id).toBe('a')
  })

  it('chdbQueryTool returns a single tool', () => {
    expect(chdbQueryTool({ session: db }).id).toBe('chdb-run-select-query')
  })

  it('re-exports ChDBStore (memory + observability)', async () => {
    expect(typeof ChDBStore).toBe('function')
    const store = new ChDBStore({ session: db }) as any
    await store.stores.memory.saveThread({
      thread: { id: 't', resourceId: 'r', title: 'x', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    })
    expect((await store.stores.memory.getThreadById({ threadId: 't' })).id).toBe('t')
  })
})
