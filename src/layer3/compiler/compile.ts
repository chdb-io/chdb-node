/**
 * The compiler: an immutable node tree → `{ sql, parameters }`. The SQL string
 * contains only keywords, quoted identifiers, and `{pN:Type}` placeholders;
 * every user value lives in `parameters` and is bound server-side by Layer 1.
 *
 * One {@link ParamCollector} is shared across the whole statement (subqueries
 * and CTEs included) so placeholder names never collide.
 */

import { ChdbCompileError } from '../../errors'
import { ParamCollector } from './param'
import { quoteIdentifier, validateFunctionName } from './identifier'
import type {
  DeleteQueryNode,
  Expr,
  InsertSelectNode,
  QueryNode,
  SelectQueryNode,
  UpdateQueryNode,
} from './nodes'

/** The compiled output handed to Layer 1 `queryBindAsync`. */
export interface CompiledQuery {
  readonly sql: string
  readonly parameters: Record<string, unknown>
}

// Comparison / arithmetic / logical operators the builder may emit, mapped to
// their canonical SQL token. The builder controls which token reaches here, but
// validating again means a stray operator can never become injected SQL.
const OPERATORS: Readonly<Record<string, string>> = {
  '=': '=',
  '!=': '!=',
  '<>': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
  like: 'LIKE',
  'not like': 'NOT LIKE',
  ilike: 'ILIKE',
  'not ilike': 'NOT ILIKE',
  in: 'IN',
  'not in': 'NOT IN',
  is: 'IS',
  'is not': 'IS NOT',
}

export function canonicalOperator(op: string): string {
  const canon = OPERATORS[op.toLowerCase()]
  if (canon === undefined) {
    throw new ChdbCompileError(`Unsupported operator ${JSON.stringify(op)}`)
  }
  return canon
}

class Compiler {
  readonly params = new ParamCollector()

  expr(node: Expr): string {
    switch (node.kind) {
      case 'Value':
        return this.params.bind(node.value, node.chType)
      case 'Reference':
        return quoteIdentifier(node.name)
      case 'Star':
        return node.table ? `${quoteIdentifier(node.table)}.*` : '*'
      case 'Raw': {
        // Interleave the literal fragments with their bound values: fragment[i]
        // is followed by values[i]. The fragments are author-controlled SQL; the
        // values are bound, never spliced.
        let out = node.fragments[0] ?? ''
        for (let i = 0; i < node.values.length; i++) {
          out += this.expr(node.values[i] as Expr) + (node.fragments[i + 1] ?? '')
        }
        return out
      }
      case 'Function': {
        const name = validateFunctionName(node.name)
        return `${name}(${node.args.map((a) => this.expr(a)).join(', ')})`
      }
      case 'Binary': {
        const op = canonicalOperator(node.op)
        return `${this.expr(node.left)} ${op} ${this.expr(node.right)}`
      }
      case 'And':
      case 'Or': {
        if (node.items.length === 0) {
          throw new ChdbCompileError(`Empty ${node.kind === 'And' ? 'AND' : 'OR'} group`)
        }
        const sep = node.kind === 'And' ? ' AND ' : ' OR '
        return `(${node.items.map((i) => this.expr(i)).join(sep)})`
      }
      case 'Alias':
        return `${this.expr(node.node)} AS ${quoteIdentifier(node.alias)}`
      case 'Subquery':
        return `(${this.select(node.query)})`
    }
  }

  /** Compile a SELECT without trailing SETTINGS / FORMAT (so set operations can wrap it). */
  private selectBody(node: SelectQueryNode): string {
    if (node.from === undefined && (node.selections === undefined || node.selections.length === 0)) {
      throw new ChdbCompileError('SELECT requires a source (selectFrom) or explicit selections')
    }
    const parts: string[] = ['SELECT']
    if (node.distinct) parts.push('DISTINCT')
    parts.push(
      node.selections && node.selections.length > 0
        ? node.selections.map((s) => this.expr(s)).join(', ')
        : '*',
    )

    if (node.from !== undefined) {
      let from = `FROM ${this.expr(node.from)}`
      if (node.final) from += ' FINAL'
      if (node.sample !== undefined) from += ` SAMPLE ${formatNumber(node.sample)}`
      parts.push(from)
    }

    for (const join of node.joins ?? []) {
      const kw =
        join.joinType === 'Inner'
          ? 'INNER JOIN'
          : join.joinType === 'Left'
            ? 'LEFT JOIN'
            : join.joinType === 'Full'
              ? 'FULL JOIN'
              : 'CROSS JOIN'
      let clause = `${kw} ${this.expr(join.source)}`
      if (join.on !== undefined) clause += ` ON ${this.expr(join.on)}`
      parts.push(clause)
    }

    if (node.prewhere !== undefined) parts.push(`PREWHERE ${this.expr(node.prewhere)}`)
    if (node.where !== undefined) parts.push(`WHERE ${this.expr(node.where)}`)
    if (node.groupBy && node.groupBy.length > 0) {
      parts.push(`GROUP BY ${node.groupBy.map((g) => this.expr(g)).join(', ')}`)
    }
    if (node.having !== undefined) parts.push(`HAVING ${this.expr(node.having)}`)
    if (node.orderBy && node.orderBy.length > 0) {
      parts.push(
        `ORDER BY ${node.orderBy
          .map((o) => `${this.expr(o.expr)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
          .join(', ')}`,
      )
    }
    if (node.limitBy) {
      parts.push(
        `LIMIT ${formatInteger(node.limitBy.count)} BY ${node.limitBy.columns
          .map((c) => this.expr(c))
          .join(', ')}`,
      )
    }
    if (node.limit !== undefined) parts.push(`LIMIT ${formatInteger(node.limit)}`)
    if (node.offset !== undefined) parts.push(`OFFSET ${formatInteger(node.offset)}`)
    return parts.join(' ')
  }

  select(node: SelectQueryNode): string {
    let sql = ''
    if (node.ctes && node.ctes.length > 0) {
      const recursive = node.ctes.some((c) => c.recursive)
      sql +=
        'WITH ' +
        (recursive ? 'RECURSIVE ' : '') +
        node.ctes
          .map((c) => `${quoteIdentifier(c.name)} AS (${this.select(c.query)})`)
          .join(', ') +
        ' '
    }
    sql += this.selectBody(node)
    for (const op of node.setOps ?? []) {
      const kw =
        op.operator === 'union'
          ? 'UNION DISTINCT'
          : op.operator === 'unionAll'
            ? 'UNION ALL'
            : op.operator === 'intersect'
              ? 'INTERSECT'
              : 'EXCEPT'
      sql += ` ${kw} ${this.selectBody(op.query)}`
    }
    if (node.settings && Object.keys(node.settings).length > 0) {
      sql += ' SETTINGS ' + formatSettings(node.settings)
    }
    if (node.format !== undefined) sql += ` FORMAT ${validateFormatName(node.format)}`
    return sql
  }

  update(node: UpdateQueryNode): string {
    if (node.assignments.length === 0) {
      throw new ChdbCompileError('updateTable requires at least one .set() assignment')
    }
    const sets = node.assignments
      .map((a) => `${quoteIdentifier(a.column)} = ${this.expr(a.value)}`)
      .join(', ')
    // ClickHouse mutations require a WHERE; a guard prevents an accidental
    // whole-table mutation from a forgotten predicate.
    if (node.where === undefined) {
      throw new ChdbCompileError(
        'updateTable requires a .where(); use .where(chdb.sql`1`) to update every row on purpose',
      )
    }
    return `ALTER TABLE ${quoteIdentifier(node.table)} UPDATE ${sets} WHERE ${this.expr(node.where)}`
  }

  delete(node: DeleteQueryNode): string {
    if (node.where === undefined) {
      throw new ChdbCompileError(
        'deleteFrom requires a .where(); use .where(chdb.sql`1`) to delete every row on purpose',
      )
    }
    return `ALTER TABLE ${quoteIdentifier(node.table)} DELETE WHERE ${this.expr(node.where)}`
  }

  insertSelect(node: InsertSelectNode): string {
    const cols =
      node.columns && node.columns.length > 0
        ? ` (${node.columns.map((c) => quoteIdentifier(c)).join(', ')})`
        : ''
    return `INSERT INTO ${quoteIdentifier(node.table)}${cols} ${this.select(node.select)}`
  }
}

/** Compile any top-level query node into `{ sql, parameters }`. */
export function compileQuery(node: QueryNode): CompiledQuery {
  const c = new Compiler()
  let sql: string
  switch (node.kind) {
    case 'SelectQuery':
      sql = c.select(node)
      break
    case 'UpdateQuery':
      sql = c.update(node)
      break
    case 'DeleteQuery':
      sql = c.delete(node)
      break
    case 'InsertSelect':
      sql = c.insertSelect(node)
      break
  }
  return { sql, parameters: c.params.parameters }
}

/** Render a `SETTINGS` clause body (`k = v, …`) with names validated and values escaped. */
export function renderSettings(settings: Readonly<Record<string, string | number | boolean>>): string {
  return formatSettings(settings)
}

/** Compile a single expression to `{ sql, parameters }` (e.g. a table-function read). */
export function compileExpr(node: Expr): CompiledQuery {
  const c = new Compiler()
  const sql = c.expr(node)
  return { sql, parameters: c.params.parameters }
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new ChdbCompileError(`Expected a finite number, got ${n}`)
  return String(n)
}

function formatInteger(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new ChdbCompileError(`Expected a non-negative integer, got ${n}`)
  }
  return String(n)
}

// A settings name is an identifier; the value is bound shape-checked here (not
// param-bound, since SETTINGS does not accept placeholders) and rendered as a
// safe literal: numbers/booleans verbatim, strings single-quoted+escaped.
const SETTING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function formatSettings(settings: Readonly<Record<string, string | number | boolean>>): string {
  return Object.keys(settings)
    .map((name) => {
      if (!SETTING_NAME_RE.test(name)) {
        throw new ChdbCompileError(`Invalid setting name ${JSON.stringify(name)}`)
      }
      const v = settings[name]
      let rendered: string
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new ChdbCompileError(`Invalid setting value for ${name}`)
        rendered = String(v)
      } else if (typeof v === 'boolean') {
        rendered = v ? '1' : '0'
      } else {
        rendered = `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
      }
      return `${name} = ${rendered}`
    })
    .join(', ')
}

const FORMAT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function validateFormatName(name: string): string {
  if (!FORMAT_NAME_RE.test(name)) {
    throw new ChdbCompileError(`Invalid FORMAT name ${JSON.stringify(name)}`)
  }
  return name
}
