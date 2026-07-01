import type { ReadableStream } from 'node:stream/web'
import type { Session } from '../index.js'

export interface ChdbAdapterOptions {
  /**
   * A chdb Session to run queries against (recommended; required for stream()).
   * When omitted, queries use the in-process default connection — fine for
   * stateless reads over file()/s3()/url() table functions.
   */
  session?: Session
}

/**
 * A hypequery `DatabaseAdapter` (structural) backed by embedded chDB. The shape
 * matches `@hypequery/clickhouse`'s exported `DatabaseAdapter`; it is returned
 * structurally so this type resolves without `@hypequery/clickhouse` installed.
 */
export interface ChdbHypequeryAdapter {
  readonly name: 'chdb'
  query<T>(sql: string, params?: unknown[], options?: unknown): Promise<T[]>
  stream<T>(sql: string, params?: unknown[], options?: unknown): Promise<ReadableStream<T[]>>
  render(sql: string, params?: unknown[]): string
}

/**
 * Build a hypequery `DatabaseAdapter` that executes on embedded chDB:
 *
 * ```ts
 * import { createQueryBuilder } from '@hypequery/clickhouse'
 * import { Session } from 'chdb'
 * import { chdbAdapter } from 'chdb/hypequery'
 * const db = createQueryBuilder<Schema>({ adapter: chdbAdapter({ session: new Session('./db') }) })
 * ```
 */
export function chdbAdapter(opts?: ChdbAdapterOptions): ChdbHypequeryAdapter
export default chdbAdapter
