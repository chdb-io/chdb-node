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
// has to run a complete SQL string and return JSONEachRow rows. It renders those params
// with hypequery's own substituteParameters (exported since @hypequery/clickhouse 2.1.2),
// so the SQL it produces is byte-identical to hypequery's built-in HTTP adapter — no
// copied escaping to drift out of sync.
//
// `@hypequery/clickhouse` is an optional peer dependency: it's only needed when you use
// this adapter, which by definition means hypequery is already installed.

// In the chdb-node package this imports from the package ESM entry:
import { Session, queryAsync } from '../index.mjs'
import { substituteParameters } from '@hypequery/clickhouse'

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

    // hypequery calls render() when present (else its own substituteParameters); we call
    // the very same substituteParameters, so generated SQL matches the HTTP adapter exactly.
    render(sql, params = []) {
      return substituteParameters(sql, params)
    },
  }
}

export default chdbAdapter

// --- helpers ----------------------------------------------------------------

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
