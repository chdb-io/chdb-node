import { describe, it, expect, beforeEach } from 'vitest'
import { Session } from '../../../index.js'
// @ts-ignore - .mjs adapter has a sibling .d.mts; vitest resolves the runtime file
import { chdbTools, chdbQueryTool } from '../../../integrations/ai-sdk.mjs'

// The Vercel AI SDK adapter exposes the canonical CONTRACT.md toolset as thin
// wrappers over ChDBTool.call() — each execute() resolves to the dispatch
// envelope ({ ok, result } | { ok, error }).

const callOpts = { toolCallId: 't', messages: [] }
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
  db.query(`INSERT INTO t VALUES (1, 'Alice'), (2, 'Bob')`)
  // A caller-provided session must already match the declared mode: the tool
  // probes readonly instead of mutating the shared session (CONTRACT.md P1).
  db.query('SET readonly=2')
})

describe('chdb/ai-sdk', () => {
  it('exposes the canonical contract toolset', () => {
    const tools = chdbTools({ session: db })
    expect(Object.keys(tools).sort()).toEqual(CANON)
    for (const t of Object.values(tools) as any[]) expect(typeof t.execute).toBe('function')
  })

  it('run_select_query binds params and returns an ok envelope', async () => {
    const { run_select_query } = chdbTools({ session: db }) as any
    const out = await run_select_query.execute(
      { sql: 'SELECT id, name FROM t WHERE id >= {min:UInt64} ORDER BY id', params: { min: 1 } },
      callOpts,
    )
    expect(out.ok).toBe(true)
    expect(out.result.rowCount).toBe(2)
    // 64-bit ints come back exact (quoted), per the contract's silent-conversion policy.
    expect(out.result.rows).toEqual([
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ])
  })

  it('list_tables and describe_table expose the schema', async () => {
    const { list_tables, describe_table } = chdbTools({ session: db }) as any
    const tables = await list_tables.execute({}, callOpts)
    expect(tables.ok).toBe(true)
    expect(tables.result).toContain('t')
    const desc = await describe_table.execute({ target: 't' }, callOpts)
    expect(desc.ok).toBe(true)
    expect(desc.result.map((c: any) => c.name)).toEqual(['id', 'name'])
  })

  it('is read-only by default — a write returns a READONLY error envelope', async () => {
    const { run_select_query } = chdbTools({ session: db }) as any
    const out = await run_select_query.execute({ sql: "INSERT INTO t VALUES (3, 'Eve')" }, callOpts)
    expect(out.ok).toBe(false)
    expect(out.error.type).toBe('READONLY')
  })

  it('surfaces the engine error in the envelope instead of throwing', async () => {
    const tool = chdbQueryTool({ session: db }) as any
    const out = await tool.execute({ sql: 'SELECT * FROM does_not_exist' }, callOpts)
    expect(out.ok).toBe(false)
    expect(typeof out.error.message).toBe('string')
  })
})
