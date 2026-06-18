/**
 * Layer 2 public surface — the `@clickhouse/client` byte-compat, embedded-only
 * façade. Re-exported from the package root (`chdb`) so that
 * `import { createClient } from '@clickhouse/client'` becomes
 * `import { createClient } from 'chdb'` with zero other changes (embedded mode).
 */

export { createClient } from './create_client'
export { ChdbClickHouseClient } from './client'
export { ChdbResultSet } from './result_set'
export { TupleParam } from './params'
export { ClickHouseError, ChdbEmbeddedOnlyError, ChdbEmbeddedNotSupportedError } from './errors'

// Type-only surface (params, results, config, format unions, Row, …).
export type * from './types'
