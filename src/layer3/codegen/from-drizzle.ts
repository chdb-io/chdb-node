/**
 * Static conversion: a Drizzle schema (`*.ts`) → an `IntrospectedDatabase` of
 * `{ table → column → CH-type }`. Walks the TypeScript AST to find every
 * `pgTable / mysqlTable / sqliteTable` declaration and maps each column
 * builder (e.g. `bigint('id', { mode: 'number' }).notNull()`) to a ClickHouse
 * type.
 *
 * `typescript` is an optional peer dependency — required only when this
 * conversion is used (`chdb-gen-types --from drizzle:<path>`). The CLI imports
 * it lazily and prints an actionable error when it isn't installed.
 *
 * Unrecognized column builders are skipped (with a `// note: skipped` comment
 * on the emitted CLI banner is *not* added here — we keep the result a plain
 * IntrospectedDatabase the rest of the pipeline already understands).
 */

import { readFileSync } from 'fs'
import type { ColumnSchema } from '../types/infer'
import type { IntrospectedDatabase } from './introspect'

/** Tries to load `typescript`; throws an actionable error when it isn't installed. */
function loadTs(): typeof import('typescript') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('typescript')
  } catch {
    throw new Error(
      "Reading a Drizzle schema needs the `typescript` package. Install it with: npm i -D typescript",
    )
  }
}

const TABLE_FACTORIES: ReadonlySet<string> = new Set([
  'pgTable',
  'mysqlTable',
  'sqliteTable',
])

/** Parse a Drizzle schema file and return the database it declares. */
export function parseDrizzleFile(path: string): IntrospectedDatabase {
  return parseDrizzleSource(readFileSync(path, 'utf-8'), path)
}

/** Parse a Drizzle schema source string (the file name is only used for diagnostics). */
export function parseDrizzleSource(source: string, fileName = 'schema.ts'): IntrospectedDatabase {
  const ts = loadTs()
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const out: IntrospectedDatabase = {}

  const visit = (node: import('typescript').Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && TABLE_FACTORIES.has(node.expression.text)) {
      const tableName = stringArg(ts, node.arguments[0])
      const columnsArg = node.arguments[1]
      if (tableName !== null && columnsArg !== undefined && ts.isObjectLiteralExpression(columnsArg)) {
        out[tableName] = columnsFromObject(ts, columnsArg)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function stringArg(ts: typeof import('typescript'), node: import('typescript').Node | undefined): string | null {
  if (node === undefined) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function columnsFromObject(
  ts: typeof import('typescript'),
  obj: import('typescript').ObjectLiteralExpression,
): ColumnSchema {
  const cols: ColumnSchema = {}
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const name = propertyName(ts, prop.name)
    if (name === null) continue
    const ch = analyzeFieldInitializer(ts, prop.initializer)
    if (ch !== null) cols[name] = ch
  }
  return cols
}

function propertyName(
  ts: typeof import('typescript'),
  name: import('typescript').PropertyName,
): string | null {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  return null
}

interface ColumnCall {
  builder: string
  /** Arguments to the column-builder leaf call (e.g. `bigint('id', {...})`). */
  args: ReadonlyArray<import('typescript').Expression>
  /** Method names chained on the column (e.g. `notNull`, `default`, `primaryKey`). */
  modifiers: ReadonlyArray<string>
}

/**
 * Unwrap a chained call like `bigint('id', { mode: 'number' }).notNull().default(0)`:
 *  - leaf call → builder name + args
 *  - intermediate `.method(...)` → each contributes a modifier
 */
function unwrapColumn(
  ts: typeof import('typescript'),
  expr: import('typescript').Expression,
): ColumnCall | null {
  const modifiers: string[] = []
  let cur: import('typescript').Expression = expr
  while (ts.isCallExpression(cur)) {
    if (ts.isPropertyAccessExpression(cur.expression)) {
      modifiers.push(cur.expression.name.text)
      cur = cur.expression.expression
    } else if (ts.isIdentifier(cur.expression)) {
      return { builder: cur.expression.text, args: cur.arguments, modifiers }
    } else {
      return null
    }
  }
  return null
}

function analyzeFieldInitializer(
  ts: typeof import('typescript'),
  expr: import('typescript').Expression,
): string | null {
  const col = unwrapColumn(ts, expr)
  if (col === null) return null
  const base = builderToCH(ts, col)
  if (base === null) return null
  const notNull = col.modifiers.includes('notNull') || col.modifiers.includes('primaryKey')
  return notNull ? base : `Nullable(${base})`
}

/** Map a column-builder call to a ClickHouse type. Returns null for unknown builders. */
function builderToCH(
  ts: typeof import('typescript'),
  col: ColumnCall,
): string | null {
  const opts = optionsArg(ts, col.args)
  switch (col.builder) {
    case 'bigint':
    case 'bigserial':
      return 'Int64'
    case 'integer':
    case 'int':
    case 'serial':
      return 'Int32'
    case 'smallint':
    case 'smallserial':
      return 'Int16'
    case 'tinyint':
      return 'Int8'
    case 'real':
      return 'Float32'
    case 'doublePrecision':
    case 'double':
      return 'Float64'
    case 'text':
    case 'varchar':
    case 'char':
    case 'uuid':
    case 'cidr':
    case 'inet':
      return 'String'
    case 'boolean':
    case 'bool':
      return 'Bool'
    case 'date':
      return 'Date'
    case 'timestamp':
    case 'timestamptz':
    case 'datetime':
      // Drizzle Postgres `timestamp({ withTimezone: false })` → naive DateTime;
      // anything else (including `timestamp()`) carries a UTC offset.
      return col.builder === 'timestamp' && opts.withTimezone === false ? 'DateTime' : "DateTime('UTC')"
    case 'time':
      return 'String'
    case 'decimal':
    case 'numeric': {
      if (opts.precision !== undefined && opts.scale !== undefined) {
        return `Decimal(${opts.precision}, ${opts.scale})`
      }
      return 'Decimal(38, 9)'
    }
    case 'json':
    case 'jsonb':
      return 'String'
    case 'bytea':
    case 'blob':
      return 'String'
    // `pgEnum('mood', [...])` defines an enum; `mood('mood')` then uses it as a column.
    // Without a global pass we can't always tell — but enum-shaped columns
    // usually call the user-named factory, which we won't recognize here, so
    // they fall through to `null` (skipped). Users can re-introspect after a
    // migration to capture them, or post-process the emitted file.
    default:
      return null
  }
}

/**
 * Pull the `{precision, scale, withTimezone, ...}` options bag from a column-builder
 * call's argument list. Drizzle places it at the last position; older signatures
 * also accept just the column name string first.
 */
function optionsArg(
  ts: typeof import('typescript'),
  args: ReadonlyArray<import('typescript').Expression>,
): { precision?: number; scale?: number; withTimezone?: boolean } {
  for (const a of args) {
    if (ts.isObjectLiteralExpression(a)) {
      const out: { precision?: number; scale?: number; withTimezone?: boolean } = {}
      for (const p of a.properties) {
        if (!ts.isPropertyAssignment(p)) continue
        const name = ts.isIdentifier(p.name) ? p.name.text : null
        if (name === null) continue
        if ((name === 'precision' || name === 'scale') && ts.isNumericLiteral(p.initializer)) {
          ;(out as Record<string, number>)[name] = Number(p.initializer.text)
        } else if (name === 'withTimezone' && (p.initializer.kind === ts.SyntaxKind.TrueKeyword || p.initializer.kind === ts.SyntaxKind.FalseKeyword)) {
          out.withTimezone = p.initializer.kind === ts.SyntaxKind.TrueKeyword
        }
      }
      return out
    }
  }
  return {}
}
