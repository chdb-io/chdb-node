import type { Session } from '../index.js'

export interface ChdbToolOptions {
  /** A chdb Session whose data to query. Defaults to the in-process default connection. */
  session?: Session
  /** Allow writes/DDL. Default false: reads run on an engine-level read-only session. */
  allowWrite?: boolean
  /** Cap on rows returned to the model (default 1000); `truncated` flags when hit. */
  maxRows?: number
}

/** A schema-aware chDB toolset for Mastra: { chdbQuery, chdbListTables, chdbDescribeSource }. */
export function chdbTools(opts?: ChdbToolOptions): Record<string, unknown>
/** Just the read-only query tool. */
export function chdbQueryTool(opts?: ChdbToolOptions): unknown
export default chdbTools

export interface ChDBVectorOptions {
  /** Reuse a chdb Session, or omit to bind a fresh one. */
  session?: Session
  /** On-disk path for a new Session (':memory:' default) when `session` is omitted. */
  path?: string
  /** Store id (Mastra base id). */
  id?: string
}

export interface ChDBQueryResult {
  id: string
  score: number
  metadata?: Record<string, unknown>
  vector?: number[]
}

/**
 * A Mastra vector store backed by chDB's `vector_similarity` (HNSW) index — similarity
 * search is index-accelerated ANN, not a brute-force distance scan. Implements the
 * Mastra `MastraVector` contract (createIndex / upsert / query / describeIndex /
 * listIndexes / deleteIndex / updateVector / deleteVector / deleteVectors).
 * Metrics: 'cosine' (default) and 'euclidean'.
 */
export class ChDBVector {
  constructor(opts?: ChDBVectorOptions)
  createIndex(params: { indexName: string; dimension: number; metric?: 'cosine' | 'euclidean' }): Promise<void>
  upsert(params: { indexName: string; vectors: number[][]; metadata?: Record<string, unknown>[]; ids?: string[] }): Promise<string[]>
  query(params: { indexName: string; queryVector: number[]; topK?: number; filter?: Record<string, unknown>; includeVector?: boolean }): Promise<ChDBQueryResult[]>
  listIndexes(): Promise<string[]>
  describeIndex(params: { indexName: string }): Promise<{ dimension: number; count: number; metric?: string }>
  deleteIndex(params: { indexName: string }): Promise<void>
  updateVector(params: { indexName: string; id: string; update: { vector?: number[]; metadata?: Record<string, unknown> } }): Promise<void>
  deleteVector(params: { indexName: string; id: string }): Promise<void>
  deleteVectors(params: { indexName: string; filter: Record<string, unknown> }): Promise<void>
}

export interface ChDBStoreOptions {
  /** Reuse a chdb Session, or omit to bind a fresh one. */
  session?: Session
  /** On-disk path for a new Session (':memory:' default) when `session` is omitted. */
  path?: string
  /** Storage id (Mastra base id). */
  id?: string
}

/**
 * A Mastra storage adapter backed by chDB, scoped to the memory (threads/messages)
 * and observability (AI tracing spans) domains — the columnar-friendly ones; AI
 * trace/span data becomes analytically queryable with SQL. Records are stored as
 * JSON in ReplacingMergeTree tables (upsert by id / (traceId,spanId)). Other Mastra
 * domains are not implemented — compose another backend for them.
 */
export class ChDBStore {
  constructor(opts?: ChDBStoreOptions)
}
