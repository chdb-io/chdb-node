/**
 * `chdb/connection` — pluggable Connection surface for `@clickhouse/client`.
 *
 *   import { createClient }         from '@clickhouse/client'
 *   import { createChdbConnection } from 'chdb/connection'
 *   const client = createClient({
 *     connection: createChdbConnection({ path: ':memory:' }),
 *   })
 *
 * Public surface:
 *   - `createChdbConnection`, `ChdbConnection` — factory + class
 *   - `ChdbExtension`, `ChdbSessionInfo` — the `.chdb` raw escape hatches
 *   - `ChdbConnectionOptions` — constructor options
 *   - The `Connection<Stream.Readable>` interface and its result types are
 *     RE-EXPORTED VERBATIM from `@clickhouse/client-common` (chdb-node
 *     does not define its own); see ./connection.ts.
 */

export { createChdbConnection, ChdbConnection } from "./chdb-connection";

export type { ChdbConnectionOptions } from "./connection";

export type {
  Connection,
  ConnBaseQueryParams,
  ConnBaseResult,
  ConnCommandResult,
  ConnExecParams,
  ConnExecResult,
  ConnInsertParams,
  ConnInsertResult,
  ConnOperation,
  ConnPingParams,
  ConnPingResult,
  ConnQueryResult,
  ClickHouseSummary,
  WithClickHouseSummary,
} from "./connection";

export type { ChdbExtension, ChdbSessionInfo } from "./extension";
