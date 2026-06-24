/**
 * Static conversion: a Prisma `schema.prisma` file → an `IntrospectedDatabase`
 * shaped exactly like a runtime introspection result. The Prisma schema syntax
 * is small enough to handle with a hand-rolled tokenizer; no `@prisma/internals`
 * dependency, so the CLI stays light and the conversion is hermetic.
 *
 * Mapping (applied per field):
 *
 *   Int            -> 'Int32'
 *   BigInt         -> 'Int64'
 *   Float          -> 'Float64'
 *   Decimal        -> 'Decimal(P, S)' (P/S come from @db.Decimal(P,S)); falls back to Decimal(38, 9)
 *   String         -> 'String'        (or 'FixedString(N)' for @db.Char(N))
 *   Boolean        -> 'Bool'
 *   DateTime       -> "DateTime('UTC')"   (or 'Date' / 'Date32' for @db.Date)
 *   Json           -> 'String'        (CH JSON is still experimental — widen to String)
 *   Bytes          -> 'String'
 *   <enum>         -> 'String'
 *   <relation>     -> skipped
 *   <field>?       -> wrap with Nullable(T)  (Prisma is opposite of CH default)
 *   <field>[]      -> wrap with Array(T) (Prisma list = repeated values, all non-null)
 *
 * Unknown scalar types degrade with a `// note: unknown ...` comment rather
 * than failing the whole conversion — same honest-degradation stance as
 * `CHTypeOf`'s `unknown` fallback.
 */

import type { ColumnSchema } from '../types/infer'
import type { IntrospectedDatabase } from './introspect'

/** Parse a Prisma schema source into a `{ model name → column-schema }` map. */
export function parsePrismaSchema(source: string): IntrospectedDatabase {
  const noComments = stripComments(source)
  const enums = collectEnumNames(noComments)
  const models = collectModels(noComments)
  const out: IntrospectedDatabase = {}
  for (const [name, body] of models) {
    out[name] = modelToColumns(body, enums)
  }
  return out
}

function stripComments(src: string): string {
  // Prisma uses `//` line comments and `///` doc comments. No block comments.
  return src
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//')
      return i === -1 ? line : line.slice(0, i)
    })
    .join('\n')
}

function collectEnumNames(src: string): ReadonlySet<string> {
  const re = /\benum\s+(\w+)\s*\{/g
  const names = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) names.add(m[1]!)
  return names
}

function collectModels(src: string): ReadonlyArray<[string, string]> {
  const out: Array<[string, string]> = []
  const re = /\bmodel\s+(\w+)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const name = m[1]!
    const start = m.index + m[0].length
    const end = findMatchingBrace(src, start - 1)
    if (end === -1) continue
    out.push([name, src.slice(start, end)])
  }
  return out
}

/** Given the index of an opening `{`, return the matching `}`'s index. */
function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function modelToColumns(body: string, enums: ReadonlySet<string>): ColumnSchema {
  const cols: ColumnSchema = {}
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('@@')) continue
    const parsed = parseField(line)
    if (parsed === null) continue
    const { name, type, optional, list, attrs } = parsed
    const ch = mapType(type, attrs, optional, list, enums)
    if (ch !== null) cols[name] = ch
  }
  return cols
}

interface ParsedField {
  name: string
  type: string
  optional: boolean
  list: boolean
  attrs: ReadonlyArray<string>
}

/**
 * Parse a single Prisma field line:
 *   `name Type[]? @attr @attr(arg)`
 * Attributes are returned as raw fragments so the mapping layer can pattern-match.
 */
function parseField(line: string): ParsedField | null {
  // Field name: an identifier, possibly with surrounding whitespace.
  const m = /^(\w+)\s+([A-Za-z_]\w*)(\[\])?(\?)?\s*(.*)$/.exec(line)
  if (m === null) return null
  const name = m[1]!
  const type = m[2]!
  const list = m[3] === '[]'
  const optional = m[4] === '?'
  const tail = m[5]!.trim()
  const attrs: string[] = []
  // Split tail on `@` boundaries while respecting parentheses.
  let depth = 0
  let cur = ''
  for (const c of tail) {
    if (c === '@' && depth === 0) {
      if (cur.trim() !== '') attrs.push(cur.trim())
      cur = '@'
    } else {
      if (c === '(') depth++
      else if (c === ')') depth--
      cur += c
    }
  }
  if (cur.trim() !== '') attrs.push(cur.trim())
  return { name, type, optional, list, attrs }
}

function mapType(
  type: string,
  attrs: ReadonlyArray<string>,
  optional: boolean,
  list: boolean,
  enums: ReadonlySet<string>,
): string | null {
  // Relations: a field whose type is one of the model names. We don't have that
  // set here, but a relation field always has an `@relation(...)` attribute or
  // points to a list of another model. Skip when an explicit relation is seen.
  if (attrs.some((a) => a.startsWith('@relation'))) return null

  let base: string | null
  if (enums.has(type)) {
    base = 'String'
  } else {
    base = mapScalar(type, attrs)
  }
  if (base === null) return null

  if (list) base = `Array(${base})`
  if (optional && !list) base = `Nullable(${base})`
  return base
}

function mapScalar(type: string, attrs: ReadonlyArray<string>): string | null {
  const db = attrs.find((a) => a.startsWith('@db.'))
  switch (type) {
    case 'Int':
      return db === '@db.SmallInt' ? 'Int16' : db === '@db.UnsignedInt' ? 'UInt32' : 'Int32'
    case 'BigInt':
      return db === '@db.UnsignedBigInt' ? 'UInt64' : 'Int64'
    case 'Float':
      return db === '@db.Real' ? 'Float32' : 'Float64'
    case 'Decimal': {
      const m = db !== undefined ? /@db\.Decimal\((\d+)\s*,\s*(\d+)\)/.exec(db) : null
      return m !== null ? `Decimal(${m[1]}, ${m[2]})` : 'Decimal(38, 9)'
    }
    case 'String': {
      if (db === undefined) return 'String'
      const fs = /@db\.Char\((\d+)\)/.exec(db)
      return fs !== null ? `FixedString(${fs[1]})` : 'String'
    }
    case 'Boolean':
      return 'Bool'
    case 'DateTime':
      if (db === '@db.Date') return 'Date'
      return "DateTime('UTC')"
    case 'Json':
      return 'String'
    case 'Bytes':
      return 'String'
    default:
      // Custom / Unsupported / Relation pointing to another model: skip.
      return null
  }
}
