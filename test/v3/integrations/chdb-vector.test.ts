import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-ignore - .mjs adapter resolved at runtime; types via the package subpath
import { ChDBVector } from '../../../integrations/chdb-vector.mjs'

// ChDBVector backed by chDB's vector_similarity (HNSW) index — verifies the store
// contract end to end (create / upsert / ANN query / metadata / update / describe /
// list / delete) against the real engine.

let store: any

beforeEach(() => {
  store = new ChDBVector()
})
afterEach(() => {
  // the underlying Session is force-closed by the global afterEach
})

describe('ChDBVector', () => {
  it('creates an index and returns the nearest vectors by similarity', async () => {
    await store.createIndex({ indexName: 'docs', dimension: 3, metric: 'cosine' })
    await store.upsert({
      indexName: 'docs',
      vectors: [
        [0.1, 0.2, 0.3],
        [0.9, 0.1, 0.0],
        [0.2, 0.2, 0.25],
        [0.0, 0.9, 0.1],
      ],
      metadata: [{ tag: 'a' }, { tag: 'b' }, { tag: 'a' }, { tag: 'c' }],
      ids: ['v1', 'v2', 'v3', 'v4'],
    })

    const res = await store.query({ indexName: 'docs', queryVector: [0.1, 0.2, 0.3], topK: 2 })
    expect(res.map((r: any) => r.id)).toEqual(['v1', 'v3'])
    expect(res[0].score).toBeGreaterThan(res[1].score) // higher score = nearer
    expect(res[0].metadata).toEqual({ tag: 'a' })
  })

  it('filters by metadata equality', async () => {
    await store.createIndex({ indexName: 'docs', dimension: 3 })
    await store.upsert({
      indexName: 'docs',
      vectors: [
        [0.1, 0.2, 0.3],
        [0.11, 0.21, 0.31],
      ],
      metadata: [{ tag: 'keep' }, { tag: 'skip' }],
      ids: ['a', 'b'],
    })
    const res = await store.query({ indexName: 'docs', queryVector: [0.1, 0.2, 0.3], topK: 5, filter: { tag: 'keep' } })
    expect(res.map((r: any) => r.id)).toEqual(['a'])
  })

  it('upsert replaces an existing id (true upsert)', async () => {
    await store.createIndex({ indexName: 'docs', dimension: 3 })
    await store.upsert({ indexName: 'docs', vectors: [[1, 0, 0]], metadata: [{ v: 1 }], ids: ['x'] })
    await store.upsert({ indexName: 'docs', vectors: [[0, 1, 0]], metadata: [{ v: 2 }], ids: ['x'] })
    const stats = await store.describeIndex({ indexName: 'docs' })
    expect(stats).toEqual({ dimension: 3, count: 1, metric: 'cosine' })
    const res = await store.query({ indexName: 'docs', queryVector: [0, 1, 0], topK: 1, includeVector: true })
    expect(res[0].metadata).toEqual({ v: 2 })
    expect(res[0].vector).toEqual([0, 1, 0])
  })

  it('lists and deletes indexes', async () => {
    await store.createIndex({ indexName: 'docs', dimension: 3 })
    await store.createIndex({ indexName: 'more', dimension: 4 })
    expect((await store.listIndexes()).sort()).toEqual(['docs', 'more'])
    await store.deleteIndex({ indexName: 'more' })
    expect(await store.listIndexes()).toEqual(['docs'])
  })

  it('rejects metrics with no index form', async () => {
    await expect(store.createIndex({ indexName: 'd', dimension: 3, metric: 'dotproduct' })).rejects.toThrow(/not supported/)
  })

  it('generates ids when none are provided (randomUUID, ESM-safe)', async () => {
    await store.createIndex({ indexName: 'docs', dimension: 2 })
    const ids = await store.upsert({ indexName: 'docs', vectors: [[1, 0], [0, 1]] })
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect((await store.describeIndex({ indexName: 'docs' })).count).toBe(2)
  })
})
