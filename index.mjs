// ESM entry: re-export the CommonJS implementation so `import { query } from
// 'chdb'` works alongside `require('chdb')`. Relative import bypasses the
// package "exports" map and loads index.js directly.
import mod from './index.js'

export const query = mod.query
export const queryBind = mod.queryBind
export const queryAsync = mod.queryAsync
export const queryBindAsync = mod.queryBindAsync
export const insert = mod.insert
export const Session = mod.Session
export const version = mod.version

export default mod
