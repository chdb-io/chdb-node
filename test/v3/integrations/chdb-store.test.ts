import { describe, it, expect, beforeEach } from 'vitest'
import { Session } from '../../../index.js'
// @ts-ignore - .mjs adapter resolved at runtime
import { ChDBStore } from '../../../integrations/chdb-store.mjs'

// ChDBStore (Mastra storage) — memory (threads/messages) + observability (AI spans),
// ReplacingMergeTree-backed. Round-trips records and proves the analytical value
// (aggregate over spans with SQL).

let db: Session
let store: any

beforeEach(() => {
  db = new Session()
  store = new ChDBStore({ session: db })
})

const thread = (id: string, resourceId = 'r1') => ({
  id,
  resourceId,
  title: `t-${id}`,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  metadata: { tag: 'x' },
})
const msg = (id: string, threadId: string, n: number) => ({
  id,
  threadId,
  resourceId: 'r1',
  role: 'user',
  content: { format: 2, parts: [{ type: 'text', text: `m${n}` }] },
  createdAt: new Date(Date.parse('2026-01-01T00:00:00Z') + n * 1000),
})
const span = (traceId: string, spanId: string, parentSpanId: string | null, name: string) => ({
  traceId,
  spanId,
  parentSpanId,
  name,
  spanType: 'agent_run',
  isEvent: false,
  startedAt: new Date(),
})

describe('ChDBStore — memory', () => {
  it('saves and reads back a thread', async () => {
    await store.stores.memory.saveThread({ thread: thread('th1') })
    const got = await store.stores.memory.getThreadById({ threadId: 'th1' })
    expect(got.id).toBe('th1')
    expect(got.title).toBe('t-th1')
    expect(got.createdAt).toBeInstanceOf(Date)
  })

  it('updateThread merges title + metadata', async () => {
    await store.stores.memory.saveThread({ thread: thread('th1') })
    const up = await store.stores.memory.updateThread({ id: 'th1', title: 'new', metadata: { extra: 1 } })
    expect(up.title).toBe('new')
    expect(up.metadata).toEqual({ tag: 'x', extra: 1 })
  })

  it('saves messages and lists them in order', async () => {
    await store.stores.memory.saveThread({ thread: thread('th1') })
    await store.stores.memory.saveMessages({ messages: [msg('m2', 'th1', 2), msg('m1', 'th1', 1)] })
    const { messages, total } = await store.stores.memory.listMessages({ threadId: 'th1' })
    expect(total).toBe(2)
    expect(messages.map((m: any) => m.id)).toEqual(['m1', 'm2']) // by createdAt asc
  })

  it('lists threads filtered by resourceId, and deletes', async () => {
    await store.stores.memory.saveThread({ thread: thread('a', 'r1') })
    await store.stores.memory.saveThread({ thread: thread('b', 'r2') })
    const { threads } = await store.stores.memory.listThreads({ filter: { resourceId: 'r1' } })
    expect(threads.map((t: any) => t.id)).toEqual(['a'])
    await store.stores.memory.deleteThread({ threadId: 'a' })
    expect(await store.stores.memory.getThreadById({ threadId: 'a' })).toBeNull()
  })
})

describe('ChDBStore — observability', () => {
  it('stores spans and reads a trace', async () => {
    await store.stores.observability.createSpan({ span: span('tr1', 's0', null, 'root') })
    await store.stores.observability.batchCreateSpans({
      records: [span('tr1', 's1', 's0', 'child-a'), span('tr1', 's2', 's0', 'child-b')],
    })
    const trace = await store.stores.observability.getTrace({ traceId: 'tr1' })
    expect(trace.spans).toHaveLength(3)
    const root = await store.stores.observability.getRootSpan({ traceId: 'tr1' })
    expect(root.span.spanId).toBe('s0')
  })

  it('updateSpan merges and listTraces returns roots with status', async () => {
    await store.stores.observability.createSpan({ span: span('tr1', 's0', null, 'root') })
    await store.stores.observability.updateSpan({ traceId: 'tr1', spanId: 's0', updates: { endedAt: new Date() } })
    const got = await store.stores.observability.getSpan({ traceId: 'tr1', spanId: 's0' })
    expect(got.span.endedAt).toBeInstanceOf(Date)
    const list = await store.stores.observability.listTraces({})
    expect(list.spans).toHaveLength(1)
    expect(list.spans[0].status).toBe('success') // endedAt set, no error
    expect(list.pagination.total).toBe(1)
  })

  it('spans are analytically queryable with SQL (the value prop)', async () => {
    await store.stores.observability.batchCreateSpans({
      records: [span('tr1', 's0', null, 'a'), span('tr1', 's1', 's0', 'b'), span('tr2', 's0', null, 'c')],
    })
    const out = db.query(
      `SELECT spanType, count() AS n FROM mastra_ai_spans FINAL GROUP BY spanType`,
      'CSV',
    )
    expect(out.trim()).toBe('"agent_run",3')
  })
})
