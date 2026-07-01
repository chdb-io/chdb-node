// chdb/hypequery — a hypequery DatabaseAdapter backed by embedded chDB.
//
//   import { createQueryBuilder } from '@hypequery/clickhouse'
//   import { Session } from '../index.mjs'
//   import { chdbAdapter } from 'chdb/hypequery'
//
//   const session = new Session('./analytics.chdb')   // or new Session() for in-memory
//   const db = createQueryBuilder<Schema>({ adapter: chdbAdapter({ session }) })
//   // ...the rest of your hypequery code is unchanged; it now runs in-process,
//   //    no ClickHouse server, over local files / S3 / Postgres via chDB.
//
// hypequery's createQueryBuilder already accepts a custom `adapter` (DatabaseAdapter),
// and it renders final SQL with `?`-positional params client-side, so the adapter only
// has to run a complete SQL string and return JSONEachRow rows. This is intentionally
// dependency-light: it does not import @hypequery/clickhouse at runtime (the adapter is
// duck-typed against the DatabaseAdapter shape).
//
// `@hypequery/clickhouse` is an optional peer dependency (types only).

// In the chdb-node package this imports from the package ESM entry:
import { Session, queryAsync } from '../index.mjs'

const ROW_FORMAT = 'JSONEachRow'

/**
 * Build a hypequery DatabaseAdapter that executes on embedded chDB.
 * @param {{ session?: import('../index.mjs').Session }} [opts]
 *   session: a chdb Session to run against (recommended; required for stream()).
 *   When omitted, queries use the in-process default connection — fine for
 *   stateless reads over file()/s3()/url() table functions.
 */
export function chdbAdapter(opts = {}) {
  const { session } = opts
  const runText = async (sql) => {
    const res = session ? await session.queryAsync(sql, { format: ROW_FORMAT }) : await queryAsync(sql, { format: ROW_FORMAT })
    return res.text()
  }

  return {
    name: 'chdb',

    async query(sql, params = [], _options) {
      const finalSql = substituteParameters(sql, params)
      return parseJsonEachRow(await runText(finalSql))
    },

    async stream(sql, params = [], _options) {
      if (!session) {
        throw new Error('chdbAdapter: stream() requires a bound session — pass { session } to chdbAdapter()')
      }
      const chStream = session.queryStream(substituteParameters(sql, params), { format: ROW_FORMAT })
      return chunkStreamToReadable(chStream)
    },

    // hypequery calls render() when present (else its own substituteParameters); we
    // reproduce its rendering exactly so generated SQL matches the HTTP adapter.
    render(sql, params = []) {
      return substituteParameters(sql, params)
    },
  }
}

export default chdbAdapter

// --- helpers (mirror @hypequery/clickhouse core/utils.ts exactly) ------------
// If hypequery exports substituteParameters/escapeValue (see the proposed PR),
// import them instead of duplicating, so the two stay byte-identical.

function substituteParameters(sql, params) {
  if (!params || params.length === 0) return sql
  const parts = sql.split('?')
  if (parts.length - 1 !== params.length) {
    throw new Error(
      `chdbAdapter: mismatch between placeholders and parameters — ${parts.length - 1} placeholders, ${params.length} parameters.`,
    )
  }
  let out = ''
  for (let i = 0; i < params.length; i++) out += parts[i] + escapeValue(params[i])
  return out + parts[parts.length - 1]
}

function escapeValue(value) {
  // null / undefined → SQL NULL (matches ClickHouse convention and avoids the
  // literal string 'undefined' that `JSON.stringify(undefined)` would produce).
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return value.toString()
  // BigInt is unquoted numeric to match ClickHouse's numeric literal syntax and
  // avoid `JSON.stringify(BigInt(...))` throwing "Do not know how to serialize".
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
  if (value instanceof Date) return `'${value.toISOString()}'`
  // Objects / arrays: JSON stringify, then apply the same backslash + single-quote
  // escaping the string branch uses. ClickHouse SQL doubles `'` inside string
  // literals; leaving raw single quotes from the JSON encoding produces malformed
  // SQL (e.g. `{name:"O'Reilly"}` → `'{"name":"O'Reilly"}'` which chokes the parser).
  return `'${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

function parseJsonEachRow(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    out.push(JSON.parse(line))
  }
  return out
}

// chDB streams chunks (each a block of rows); hypequery wants ReadableStream<T[]>,
// i.e. one enqueue per chunk carrying that chunk's row array.
function chunkStreamToReadable(chStream) {
  const it = chStream[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await it.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value.rows())
      } catch (e) {
        controller.error(e)
      }
    },
    cancel() {
      try {
        chStream.cancel()
      } catch {
        /* best effort */
      }
    },
  })
}
