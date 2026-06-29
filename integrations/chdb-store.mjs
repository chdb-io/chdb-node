// ChDBStore — a Mastra storage adapter backed by chDB, scoped to the two domains
// where ClickHouse's columnar engine is the right tool:
//   • memory       — agent threads + messages
//   • observability — AI tracing spans (the analytical sweet spot: aggregate over
//                     traces/spans/latencies/errors with SQL)
//
// Storage model: each record is kept as a full JSON blob alongside indexed key
// columns, in a ReplacingMergeTree keyed by the record id (threads/messages) or
// (traceId, spanId) for spans, versioned by an `_updated` epoch-ms column. This
// gives upsert-by-id semantics (point updates that ClickHouse otherwise handles
// awkwardly) and exact round-tripping of Mastra's nested record shapes, while the
// indexed columns (resourceId, threadId, spanType, startedAt, …) stay queryable.
// Reads use FINAL so a re-saved id returns its latest version without waiting for
// a background merge.
//
// Other Mastra domains (workflows, scores, …) are intentionally not implemented
// here — they are point-update/OLTP-shaped; compose another backend for them via
// Mastra's per-domain composite storage.
//
// `@mastra/core` is an optional peer dependency of chdb.

import { MastraStorage, MemoryStorage, ObservabilityStorage } from '@mastra/core/storage'
import { Session } from '../index.mjs'

const now = () => Date.now()
const ms = (d) => (d instanceof Date ? d.getTime() : d ? new Date(d).getTime() : 0)
const esc = (s) => `'${String(s).replace(/'/g, "''")}'`

function reviveDates(obj, fields) {
  if (!obj) return obj
  for (const f of fields) if (obj[f] != null && typeof obj[f] === 'string') obj[f] = new Date(obj[f])
  return obj
}

// --- memory domain -----------------------------------------------------------

class ChDBMemoryStore extends MemoryStorage {
  #s
  constructor(session) {
    super()
    this.#s = session
    this.#s.query(
      `CREATE TABLE IF NOT EXISTS mastra_threads (id String, resourceId String, _created Int64, _updated Int64, record String)` +
        ` ENGINE = ReplacingMergeTree(_updated) ORDER BY id`,
      'CSV',
    )
    this.#s.query(
      `CREATE TABLE IF NOT EXISTS mastra_messages (id String, threadId String, resourceId String, _created Int64, _updated Int64, record String)` +
        ` ENGINE = ReplacingMergeTree(_updated) ORDER BY id`,
      'CSV',
    )
  }

  async #rows(sql) {
    const r = await this.#s.queryAsync(sql, { format: 'JSON' })
    return r.json()?.data ?? []
  }

  async saveThread({ thread }) {
    await this.#s.insert({
      table: 'mastra_threads',
      values: [
        {
          id: thread.id,
          resourceId: thread.resourceId ?? '',
          _created: ms(thread.createdAt) || now(),
          _updated: ms(thread.updatedAt) || now(),
          record: JSON.stringify(thread),
        },
      ],
    })
    return thread
  }

  async getThreadById({ threadId }) {
    const rows = await this.#rows(`SELECT record FROM mastra_threads FINAL WHERE id = ${esc(threadId)} LIMIT 1`)
    return rows[0] ? reviveDates(JSON.parse(rows[0].record), ['createdAt', 'updatedAt']) : null
  }

  async updateThread({ id, title, metadata }) {
    const existing = await this.getThreadById({ threadId: id })
    if (!existing) throw new Error(`ChDBStore: thread '${id}' not found`)
    const updated = {
      ...existing,
      title: title ?? existing.title,
      metadata: { ...(existing.metadata ?? {}), ...(metadata ?? {}) },
      updatedAt: new Date(),
    }
    return this.saveThread({ thread: updated })
  }

  async deleteThread({ threadId }) {
    this.#s.query(`DELETE FROM mastra_threads WHERE id = ${esc(threadId)}`, 'CSV')
    this.#s.query(`DELETE FROM mastra_messages WHERE threadId = ${esc(threadId)}`, 'CSV')
  }

  async listThreads(args = {}) {
    const { perPage = 100, page = 0, filter } = args
    const where = ['1']
    if (filter?.resourceId) where.push(`resourceId = ${esc(filter.resourceId)}`)
    for (const [k, v] of Object.entries(filter?.metadata ?? {})) {
      where.push(`JSONExtractString(record, 'metadata', ${esc(k)}) = ${esc(v)}`)
    }
    const w = where.join(' AND ')
    const total = Number((await this.#rows(`SELECT count() c FROM mastra_threads FINAL WHERE ${w}`))[0]?.c ?? 0)
    let sql = `SELECT record FROM mastra_threads FINAL WHERE ${w} ORDER BY _created DESC`
    if (perPage !== false) sql += ` LIMIT ${perPage} OFFSET ${page * perPage}`
    const threads = (await this.#rows(sql)).map((r) => reviveDates(JSON.parse(r.record), ['createdAt', 'updatedAt']))
    return { threads, total, page, perPage, hasMore: perPage === false ? false : page * perPage + threads.length < total }
  }

  async saveMessages({ messages }) {
    if (!messages?.length) return { messages: [] }
    await this.#s.insert({
      table: 'mastra_messages',
      values: messages.map((m) => ({
        id: m.id,
        threadId: m.threadId ?? '',
        resourceId: m.resourceId ?? '',
        _created: ms(m.createdAt) || now(),
        _updated: now(),
        record: JSON.stringify(m),
      })),
    })
    return { messages }
  }

  async listMessages(args) {
    const { threadId, perPage = 40, page = 0 } = args
    const ids = Array.isArray(threadId) ? threadId : [threadId]
    const inList = ids.map(esc).join(', ')
    const total = Number(
      (await this.#rows(`SELECT count() c FROM mastra_messages FINAL WHERE threadId IN (${inList})`))[0]?.c ?? 0,
    )
    let sql = `SELECT record FROM mastra_messages FINAL WHERE threadId IN (${inList}) ORDER BY _created ASC`
    if (perPage !== false) sql += ` LIMIT ${perPage} OFFSET ${page * perPage}`
    const messages = (await this.#rows(sql)).map((r) => reviveDates(JSON.parse(r.record), ['createdAt']))
    return { messages, total, page, perPage, hasMore: perPage === false ? false : page * perPage + messages.length < total }
  }

  async listMessagesById({ messageIds }) {
    if (!messageIds?.length) return { messages: [] }
    const inList = messageIds.map(esc).join(', ')
    const messages = (await this.#rows(`SELECT record FROM mastra_messages FINAL WHERE id IN (${inList})`)).map((r) =>
      reviveDates(JSON.parse(r.record), ['createdAt']),
    )
    return { messages }
  }

  async updateMessages({ messages }) {
    const out = []
    for (const patch of messages) {
      const rows = await this.#rows(`SELECT record FROM mastra_messages FINAL WHERE id = ${esc(patch.id)} LIMIT 1`)
      if (!rows[0]) continue
      const cur = JSON.parse(rows[0].record)
      const merged = { ...cur, ...patch, content: { ...(cur.content ?? {}), ...(patch.content ?? {}) } }
      await this.saveMessages({ messages: [reviveDates(merged, ['createdAt'])] })
      out.push(reviveDates(merged, ['createdAt']))
    }
    return out
  }
}

// --- observability domain (AI tracing) ---------------------------------------

class ChDBObservabilityStore extends ObservabilityStorage {
  #s
  constructor(session) {
    super()
    this.#s = session
    this.#s.query(
      `CREATE TABLE IF NOT EXISTS mastra_ai_spans (` +
        `traceId String, spanId String, parentSpanId String, name String, spanType String, ` +
        `isRoot UInt8, startedAt Int64, endedAt Int64, _updated Int64, record String` +
        `) ENGINE = ReplacingMergeTree(_updated) ORDER BY (traceId, spanId)`,
      'CSV',
    )
  }

  async #rows(sql) {
    const r = await this.#s.queryAsync(sql, { format: 'JSON' })
    return r.json()?.data ?? []
  }

  #row(span) {
    const full = { createdAt: new Date(), updatedAt: null, ...span }
    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId ?? '',
      name: span.name ?? '',
      spanType: String(span.spanType ?? ''),
      isRoot: span.parentSpanId ? 0 : 1,
      startedAt: ms(span.startedAt),
      endedAt: ms(span.endedAt),
      _updated: now(),
      record: JSON.stringify(full),
    }
  }

  async createSpan({ span }) {
    await this.#s.insert({ table: 'mastra_ai_spans', values: [this.#row(span)] })
  }

  async batchCreateSpans({ records }) {
    if (!records?.length) return
    await this.#s.insert({ table: 'mastra_ai_spans', values: records.map((r) => this.#row(r)) })
  }

  async updateSpan(args) {
    const { traceId, spanId } = args
    const patch = args.updates ?? args.span ?? args
    const rows = await this.#rows(
      `SELECT record FROM mastra_ai_spans FINAL WHERE traceId = ${esc(traceId)} AND spanId = ${esc(spanId)} LIMIT 1`,
    )
    if (!rows[0]) throw new Error(`ChDBStore: span ${traceId}/${spanId} not found`)
    const cur = JSON.parse(rows[0].record)
    const merged = { ...cur, ...patch, traceId, spanId, updatedAt: new Date() }
    await this.#s.insert({ table: 'mastra_ai_spans', values: [this.#row(merged)] })
  }

  #parseSpan(r) {
    return reviveDates(JSON.parse(r.record), ['createdAt', 'updatedAt', 'startedAt', 'endedAt'])
  }

  async getSpan({ traceId, spanId }) {
    const rows = await this.#rows(
      `SELECT record FROM mastra_ai_spans FINAL WHERE traceId = ${esc(traceId)} AND spanId = ${esc(spanId)} LIMIT 1`,
    )
    return rows[0] ? { span: this.#parseSpan(rows[0]) } : null
  }

  async getRootSpan({ traceId }) {
    const rows = await this.#rows(
      `SELECT record FROM mastra_ai_spans FINAL WHERE traceId = ${esc(traceId)} AND isRoot = 1 LIMIT 1`,
    )
    return rows[0] ? { span: this.#parseSpan(rows[0]) } : null
  }

  async getTrace({ traceId }) {
    const rows = await this.#rows(
      `SELECT record FROM mastra_ai_spans FINAL WHERE traceId = ${esc(traceId)} ORDER BY startedAt ASC`,
    )
    return { traceId, spans: rows.map((r) => this.#parseSpan(r)) }
  }

  async getSpans({ traceId, spanIds }) {
    const inList = (spanIds ?? []).map(esc).join(', ') || `''`
    const rows = await this.#rows(
      `SELECT record FROM mastra_ai_spans FINAL WHERE traceId = ${esc(traceId)} AND spanId IN (${inList})`,
    )
    return { traceId, spans: rows.map((r) => this.#parseSpan(r)) }
  }

  async listTraces(args = {}) {
    const page = args.pagination?.page ?? 0
    const perPage = args.pagination?.perPage ?? 100
    const dir = (args.orderBy?.direction ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
    const total = Number((await this.#rows(`SELECT count() c FROM mastra_ai_spans FINAL WHERE isRoot = 1`))[0]?.c ?? 0)
    const rows = await this.#rows(
      `SELECT record FROM mastra_ai_spans FINAL WHERE isRoot = 1 ORDER BY startedAt ${dir} LIMIT ${perPage} OFFSET ${page * perPage}`,
    )
    const spans = rows.map((r) => {
      const s = this.#parseSpan(r)
      const status = s.error ? 'error' : s.endedAt ? 'success' : 'running'
      return { ...s, status }
    })
    return { spans, pagination: { total, page, perPage, hasMore: page * perPage + spans.length < total } }
  }
}

// --- composite store ---------------------------------------------------------

export class ChDBStore extends MastraStorage {
  /** @param {{ session?: any, path?: string, id?: string }} [opts] */
  constructor(opts = {}) {
    super({ id: opts.id ?? 'chdb' })
    const session = opts.session ?? new Session(opts.path ?? '')
    this.stores = {
      memory: new ChDBMemoryStore(session),
      observability: new ChDBObservabilityStore(session),
    }
  }
}
