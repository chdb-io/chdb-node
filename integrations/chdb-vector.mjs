// ChDBVector — a Mastra vector store backed by chDB's ClickHouse vector engine.
//
// Similarity search uses chDB-core's HNSW vector index (`vector_similarity`), so a
// query is index-accelerated ANN, not a brute-force distance scan over every row:
//   INDEX vec_idx vector TYPE vector_similarity('hnsw', '<distFn>', <dim>)
//   ... ORDER BY <distFn>(vector, [q]) LIMIT k   -- the index prunes granules
// (verified via EXPLAIN indexes=1: the vec_idx skip-index is used).
//
// `@mastra/core` and `zod` are optional peer dependencies of chdb.

import { randomUUID } from 'node:crypto'
import { MastraVector } from '@mastra/core/vector'
import { Session } from '../index.mjs'

// Mastra metric -> ClickHouse distance function used by the vector_similarity index.
// The index supports cosineDistance and L2Distance; dotproduct has no index form.
const METRIC_FN = { cosine: 'cosineDistance', euclidean: 'L2Distance' }
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const META_TABLE = '__chdb_vector_meta'

function assertIdent(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`ChDBVector: invalid indexName ${JSON.stringify(name)} (must match ${IDENT})`)
  }
  return name
}

export class ChDBVector extends MastraVector {
  #session

  /** @param {{ session?: any, path?: string, id?: string }} [opts] reuse a chdb Session, or bind a path (':memory:' default). */
  constructor(opts = {}) {
    super({ id: opts.id ?? 'chdb' })
    this.#session = opts.session ?? new Session(opts.path ?? '')
    this.#session.query('SET allow_experimental_vector_similarity_index = 1', 'CSV')
    this.#session.query(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (name String, dimension UInt32, metric String, _updated Int64)` +
        ` ENGINE = ReplacingMergeTree(_updated) ORDER BY name`,
      'CSV',
    )
  }

  async createIndex({ indexName, dimension, metric = 'cosine' }) {
    assertIdent(indexName)
    const fn = METRIC_FN[metric]
    if (!fn) {
      throw new Error(
        `ChDBVector: metric '${metric}' is not supported by chDB's vector index; use 'cosine' or 'euclidean'`,
      )
    }
    const dim = Number(dimension)
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`ChDBVector: dimension must be a positive integer`)
    this.#session.query(
      `CREATE TABLE IF NOT EXISTS \`${indexName}\` (` +
        `id String, vector Array(Float32), metadata String DEFAULT '{}', _v Int64, ` +
        `INDEX vec_idx vector TYPE vector_similarity('hnsw', '${fn}', ${dim}) GRANULARITY 1` +
        `) ENGINE = ReplacingMergeTree(_v) ORDER BY id`,
      'CSV',
    )
    await this.#session.queryBindAsync(
      `INSERT INTO ${META_TABLE} (name, dimension, metric, _updated) VALUES ({n:String}, {d:UInt32}, {m:String}, {u:Int64})`,
      { n: indexName, d: dim, m: metric, u: Date.now() },
      { format: 'CSV' },
    )
  }

  async upsert({ indexName, vectors, metadata, ids }) {
    assertIdent(indexName)
    if (!Array.isArray(vectors) || vectors.length === 0) return []
    const outIds = vectors.map((_, i) => (ids && ids[i] != null ? String(ids[i]) : randomUUID()))
    // Idempotent upsert without a separate DELETE: ReplacingMergeTree(_v) keeps the
    // highest _v per id, and reads use FINAL — so a re-inserted id resolves to the
    // latest row (no async-DELETE race, no transient duplicates).
    const v = Date.now()
    const rows = vectors.map((vec, i) => ({
      id: outIds[i],
      vector: Array.from(vec, Number),
      metadata: JSON.stringify(metadata && metadata[i] ? metadata[i] : {}),
      _v: v,
    }))
    await this.#session.insert({ table: indexName, values: rows })
    return outIds
  }

  async query({ indexName, queryVector, topK = 10, filter, includeVector = false }) {
    assertIdent(indexName)
    const fn = await this.#metricFn(indexName)
    const where = filterToSql(filter)
    const cols = includeVector ? 'id, metadata, vector' : 'id, metadata'
    const sql =
      `SELECT ${cols}, ${fn}(vector, {q:Array(Float32)}) AS _dist FROM \`${indexName}\` FINAL` +
      `${where} ORDER BY _dist ASC LIMIT {k:UInt32}`
    const res = await this.#session.queryBindAsync(
      sql,
      { q: Array.from(queryVector, Number), k: Math.max(1, Math.floor(Number(topK) || 10)) },
      { format: 'JSON' },
    )
    const data = res.json()?.data ?? []
    return data.map((r) => ({
      id: r.id,
      score: fn === 'cosineDistance' ? 1 - Number(r._dist) : 1 / (1 + Number(r._dist)),
      metadata: safeJson(r.metadata),
      ...(includeVector ? { vector: (r.vector ?? []).map(Number) } : {}),
    }))
  }

  async listIndexes() {
    const res = await this.#session.queryAsync(`SELECT name FROM ${META_TABLE} FINAL ORDER BY name`, {
      format: 'JSON',
    })
    return (res.json()?.data ?? []).map((r) => r.name)
  }

  async describeIndex({ indexName }) {
    assertIdent(indexName)
    const m = await this.#session.queryBindAsync(
      `SELECT dimension, metric FROM ${META_TABLE} FINAL WHERE name = {n:String} LIMIT 1`,
      { n: indexName },
      { format: 'JSON' },
    )
    const meta = m.json()?.data?.[0]
    if (!meta) throw new Error(`ChDBVector: index '${indexName}' does not exist`)
    const c = await this.#session.queryAsync(`SELECT count() AS c FROM \`${indexName}\` FINAL`, { format: 'JSON' })
    return { dimension: Number(meta.dimension), count: Number(c.json()?.data?.[0]?.c ?? 0), metric: meta.metric }
  }

  async deleteIndex({ indexName }) {
    assertIdent(indexName)
    this.#session.query(`DROP TABLE IF EXISTS \`${indexName}\``, 'CSV')
    await this.#session.queryBindAsync(`DELETE FROM ${META_TABLE} WHERE name = {n:String}`, { n: indexName }, { format: 'CSV' })
  }

  async deleteVector({ indexName, id }) {
    assertIdent(indexName)
    await this.#session.queryBindAsync(`DELETE FROM \`${indexName}\` WHERE id = {id:String}`, { id: String(id) }, { format: 'CSV' })
  }

  async deleteVectors({ indexName, filter }) {
    assertIdent(indexName)
    const where = filterToSql(filter)
    if (!where) throw new Error('ChDBVector: deleteVectors requires a filter')
    this.#session.query(`DELETE FROM \`${indexName}\`${where.replace(/^ WHERE/, ' WHERE')}`, 'CSV')
  }

  async updateVector({ indexName, id, update }) {
    assertIdent(indexName)
    if (id == null) throw new Error('ChDBVector: updateVector requires an id')
    // Read the existing row so a metadata-only or vector-only update preserves the other field.
    const res = await this.#session.queryBindAsync(
      `SELECT vector, metadata FROM \`${indexName}\` FINAL WHERE id = {id:String} LIMIT 1`,
      { id: String(id) },
      { format: 'JSON' },
    )
    const existing = res.json()?.data?.[0]
    if (!existing) throw new Error(`ChDBVector: id '${id}' not found in '${indexName}'`)
    const vector = update?.vector ? Array.from(update.vector, Number) : (existing.vector ?? []).map(Number)
    const metadata = update?.metadata ?? safeJson(existing.metadata)
    await this.upsert({ indexName, vectors: [vector], metadata: [metadata], ids: [String(id)] })
  }

  async #metricFn(indexName) {
    const m = await this.#session.queryBindAsync(
      `SELECT metric FROM ${META_TABLE} FINAL WHERE name = {n:String} LIMIT 1`,
      { n: indexName },
      { format: 'JSON' },
    )
    const metric = m.json()?.data?.[0]?.metric ?? 'cosine'
    return METRIC_FN[metric] ?? 'cosineDistance'
  }
}

function safeJson(s) {
  try {
    return s ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

// Translate a flat equality metadata filter ({ key: value }) to a WHERE clause over
// the JSON metadata column. Operator filters ($gt, $in, …) are not supported yet.
function filterToSql(filter) {
  if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) return ''
  const parts = []
  for (const [k, v] of Object.entries(filter)) {
    if (v !== null && typeof v === 'object') {
      throw new Error(`ChDBVector: operator filters are not supported yet (key ${JSON.stringify(k)})`)
    }
    if (!IDENT.test(k)) throw new Error(`ChDBVector: invalid filter key ${JSON.stringify(k)}`)
    const lit =
      typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
    parts.push(`JSONExtractString(metadata, '${k}') = ${lit}`)
  }
  return ` WHERE ${parts.join(' AND ')}`
}
