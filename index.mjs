// ESM entry: re-export the CommonJS implementation so `import { query } from
// 'chdb'` works alongside `require('chdb')`. Load index.js through
// createRequire rather than a default `import` of the .js: Node synthesizes a
// default export from module.exports, but Deno does not, so the bare default
// import fails under Deno. createRequire is the portable CJS bridge (Node /
// Deno / Bun all support node:module).
import { createRequire } from 'node:module'

const mod = createRequire(import.meta.url)('./index.js')

export const query = mod.query
export const queryBind = mod.queryBind
export const queryAsync = mod.queryAsync
export const queryBindAsync = mod.queryBindAsync
export const insert = mod.insert
export const Session = mod.Session
export const version = mod.version

// Layer 2: @clickhouse/client byte-compat surface (embedded-only).
export const createClient = mod.createClient
export const ChdbClickHouseClient = mod.ChdbClickHouseClient
export const ChdbResultSet = mod.ChdbResultSet
export const TupleParam = mod.TupleParam
export const ClickHouseError = mod.ClickHouseError
export const ChdbEmbeddedOnlyError = mod.ChdbEmbeddedOnlyError
export const ChdbEmbeddedNotSupportedError = mod.ChdbEmbeddedNotSupportedError

// Typed error hierarchy (shared by Layer 1 + Layer 2).
export const ChdbError = mod.ChdbError
export const ChdbQueryError = mod.ChdbQueryError
export const ChdbSyntaxError = mod.ChdbSyntaxError
export const ChdbConnectionError = mod.ChdbConnectionError
export const ChdbClosedError = mod.ChdbClosedError
export const ChdbStreamError = mod.ChdbStreamError
export const ChdbArrowError = mod.ChdbArrowError
export const ChdbBindError = mod.ChdbBindError
export const ChdbInsertError = mod.ChdbInsertError
export const ChdbAbortError = mod.ChdbAbortError
export const ChdbTimeoutError = mod.ChdbTimeoutError
export const ChdbPlatformUnsupportedError = mod.ChdbPlatformUnsupportedError
export const ChdbBinaryVersionMismatchError = mod.ChdbBinaryVersionMismatchError
export const ChdbInternalError = mod.ChdbInternalError
export const isChdbError = mod.isChdbError

export default mod
