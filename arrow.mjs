// ESM bridge for the optional typed Arrow subpath. Its runtime only delegates
// to Session; apache-arrow is loaded when the result is converted.
import { createRequire } from 'node:module'
const mod = createRequire(import.meta.url)('./dist/arrow-entry.js')
export const queryArrow = mod.queryArrow
export const queryArrowBind = mod.queryArrowBind
export const queryArrowStream = mod.queryArrowStream
export const queryArrowStreamBind = mod.queryArrowStreamBind
export const registerArrowSource = mod.registerArrowSource
export const registerArrowReader = mod.registerArrowReader
export const insertArrow = mod.insertArrow
export const insertArrowReader = mod.insertArrowReader
