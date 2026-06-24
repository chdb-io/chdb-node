/**
 * `chTable` — typed helpers for the ClickHouse table functions used most often
 * as federation / file sources. Each returns an expression you alias and pass to
 * `selectFrom`:
 *
 *   selectFrom(chTable.s3({ url, format: 'Parquet' }).as('t')).selectAll()
 *
 * Every argument is bound server-side (`{pN:Type}`) exactly like a value in a
 * WHERE clause — a URL or path is data, never spliced into the SQL — and chDB
 * accepts bound parameters in table-function argument position, so this keeps
 * the zero-interpolation rule intact for sources too. The 8 most-used functions
 * are here; the long tail stays reachable via `sql.raw(...)`.
 */

import { ChExpression } from './expression'
import type { Expr } from '../compiler/nodes'

/** Build a table-function expression with bound arguments. */
function tableFn(name: string, args: ReadonlyArray<{ value: unknown; type?: string }>): ChExpression {
  const argNodes: Expr[] = args.map((a) => ({ kind: 'Value', value: a.value, chType: a.type }))
  return new ChExpression({ kind: 'Function', name, args: argNodes })
}

/** Drop trailing undefined optional args (ClickHouse positional signatures). */
function compact(
  args: ReadonlyArray<{ value: unknown; type?: string } | undefined>,
): { value: unknown; type?: string }[] {
  const out: { value: unknown; type?: string }[] = []
  for (const a of args) {
    if (a === undefined) break
    out.push(a)
  }
  return out
}

const str = (value: string) => ({ value, type: 'String' })

export interface S3Options {
  url: string
  format?: string
  structure?: string
  accessKeyId?: string
  secretAccessKey?: string
}

export interface FileOptions {
  path: string
  format?: string
  structure?: string
}

export interface UrlOptions {
  url: string
  format?: string
  structure?: string
}

export interface PgOptions {
  /** `host:port`. */
  host: string
  database: string
  table: string
  user?: string
  password?: string
  schema?: string
}

export interface MySqlOptions {
  host: string
  database: string
  table: string
  user?: string
  password?: string
}

export interface LakeOptions {
  url: string
  accessKeyId?: string
  secretAccessKey?: string
}

export const chTable = {
  /** `numbers(count)` or `numbers(start, count)` — generated integer source. */
  numbers(countOrStart: number | bigint, count?: number | bigint): ChExpression {
    const args =
      count === undefined
        ? [{ value: countOrStart, type: 'UInt64' }]
        : [
            { value: countOrStart, type: 'UInt64' },
            { value: count, type: 'UInt64' },
          ]
    return tableFn('numbers', args)
  },

  /** `s3(url[, access_key, secret], [format], [structure])`. */
  s3(opts: S3Options): ChExpression {
    const creds =
      opts.accessKeyId !== undefined && opts.secretAccessKey !== undefined
        ? [str(opts.accessKeyId), str(opts.secretAccessKey)]
        : []
    return tableFn(
      's3',
      compact([
        str(opts.url),
        ...creds.map((c) => c as { value: unknown; type?: string }),
        opts.format !== undefined ? str(opts.format) : undefined,
        opts.structure !== undefined ? str(opts.structure) : undefined,
      ]),
    )
  },

  /** `file(path[, format][, structure])`. */
  file(opts: FileOptions): ChExpression {
    return tableFn(
      'file',
      compact([
        str(opts.path),
        opts.format !== undefined ? str(opts.format) : undefined,
        opts.structure !== undefined ? str(opts.structure) : undefined,
      ]),
    )
  },

  /** `url(url[, format][, structure])`. */
  url(opts: UrlOptions): ChExpression {
    return tableFn(
      'url',
      compact([
        str(opts.url),
        opts.format !== undefined ? str(opts.format) : undefined,
        opts.structure !== undefined ? str(opts.structure) : undefined,
      ]),
    )
  },

  /** `postgresql(host:port, database, table[, user, password][, schema])`. */
  postgresql(opts: PgOptions): ChExpression {
    const auth =
      opts.user !== undefined && opts.password !== undefined
        ? [str(opts.user), str(opts.password)]
        : []
    return tableFn(
      'postgresql',
      compact([
        str(opts.host),
        str(opts.database),
        str(opts.table),
        ...auth,
        opts.schema !== undefined ? str(opts.schema) : undefined,
      ]),
    )
  },

  /** `mysql(host:port, database, table, user, password)`. */
  mysql(opts: MySqlOptions): ChExpression {
    const auth =
      opts.user !== undefined && opts.password !== undefined
        ? [str(opts.user), str(opts.password)]
        : []
    return tableFn('mysql', compact([str(opts.host), str(opts.database), str(opts.table), ...auth]))
  },

  /** `iceberg(url[, access_key, secret])`. */
  iceberg(opts: LakeOptions): ChExpression {
    const creds =
      opts.accessKeyId !== undefined && opts.secretAccessKey !== undefined
        ? [str(opts.accessKeyId), str(opts.secretAccessKey)]
        : []
    return tableFn('iceberg', compact([str(opts.url), ...creds]))
  },

  /** `deltaLake(url[, access_key, secret])`. */
  deltaLake(opts: LakeOptions): ChExpression {
    const creds =
      opts.accessKeyId !== undefined && opts.secretAccessKey !== undefined
        ? [str(opts.accessKeyId), str(opts.secretAccessKey)]
        : []
    return tableFn('deltaLake', compact([str(opts.url), ...creds]))
  },
}
