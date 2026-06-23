/**
 * Pluggable Connection contract for chdb-node.
 *
 * chdb-node's `ChdbConnection` implements `@clickhouse/client-common`'s
 * published `Connection<Stream.Readable>` interface EXACTLY — same method
 * signatures, same result shapes, same error semantics. That lets a user
 * write the same `@clickhouse/client` code against either a remote
 * ClickHouse server or in-process chDB with a one-line change at
 * construction:
 *
 *   import { createClient }         from '@clickhouse/client'
 *   import { createChdbConnection } from 'chdb/connection'
 *   const client = createClient({
 *     connection: createChdbConnection({ path: ':memory:' }),
 *   })
 *
 * To keep that promise this module DOES NOT define its own Connection /
 * ConnQueryResult / ConnInsertParams / … types. Instead it re-exports
 * them verbatim from `@clickhouse/client-common`. Bumping that package
 * forces a deliberate decision in chdb-node about which version of the
 * contract we conform to.
 *
 * The chDB-specific options ({@link ChdbConnectionOptions}) and the raw
 * escape-hatch surface (`.chdb`, declared in extension.ts) stay defined
 * here in chdb-node — they have no counterpart in clickhouse-js's
 * Connection contract.
 */

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
} from "@clickhouse/client-common";

export type {
  ClickHouseSummary,
  WithClickHouseSummary,
} from "@clickhouse/client-common";

/**
 * Options accepted by {@link createChdbConnection}.
 */
export interface ChdbConnectionOptions {
  /**
   * On-disk session path. `':memory:'` (the default) uses an ephemeral
   * temp dir that is reference-counted across same-process `:memory:`
   * connections, so two ChdbConnections both on `:memory:` see the same
   * in-process data (matching the chDB single-engine-per-process model).
   * A different on-disk path while one is live is rejected by Layer 1.
   */
  path?: string;
}
