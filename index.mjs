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

export default mod
