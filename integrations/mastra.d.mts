import type { Session } from '../index.js'
import type { ChDBTool, ChDBToolOptions, ToolEnvelope } from './agents/tool.mjs'

export { ChDBTool } from './agents/tool.mjs'
export {
  ChDBError,
  ChDBReadOnlyError,
  ChDBSyntaxError,
  ChDBUnknownObjectError,
} from './agents/errors.mjs'

export interface ChdbToolsOptions extends ChDBToolOptions {
  /** Inverse of `readOnly`, accepted for convenience (allowWrite:true === readOnly:false). */
  allowWrite?: boolean
  /** Use a prebuilt ChDBTool instead of constructing one from these options. */
  tool?: ChDBTool
}

/** A Mastra tool (createTool) whose `execute` resolves to the dispatch envelope. */
export interface ChdbAgentTool {
  id: string
  description: string
  execute(input: Record<string, unknown>): Promise<ToolEnvelope>
  [key: string]: unknown
}

/** The canonical CONTRACT.md tool set, keyed by contract tool name. */
export type ChdbToolset = Record<
  | 'run_select_query'
  | 'list_databases'
  | 'list_tables'
  | 'describe_table'
  | 'get_sample_data'
  | 'list_functions'
  | 'attach_file',
  ChdbAgentTool
>

/** The canonical chDB agent toolset for Mastra agents (thin over ChDBTool). */
export function chdbTools(opts?: ChdbToolsOptions): ChdbToolset
/** Just the read-only run_select_query tool. */
export function chdbQueryTool(opts?: ChdbToolsOptions): ChdbAgentTool
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
