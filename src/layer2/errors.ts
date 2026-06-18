/**
 * Layer 2 error model.
 *
 * Two families, deliberately kept distinct (design §4.4):
 *
 *  1. `ClickHouseError` — the **byte-compat** error that `@clickhouse/client`
 *     throws for an engine error. Same public shape (`code: string`, `type?:
 *     string`, `message`) so existing `catch (e) { if (e instanceof
 *     ClickHouseError && e.code === '...') }` code keeps working unchanged after
 *     swapping the import. It ALSO extends Layer 1's {@link ChdbError} so the
 *     whole chdb hierarchy stays catchable as one thing (double instanceof), and
 *     it preserves the originating Layer 1 error on `.cause`.
 *
 *  2. Boundary errors (`ChdbEmbeddedOnlyError`, `ChdbEmbeddedNotSupportedError`)
 *     — raised by Layer 2 itself for things that are *not* engine errors: a
 *     non-`chdb://` URL, or cluster-topology SQL that embedded chDB has no
 *     concept of. These do NOT masquerade as `ClickHouseError` (it would be
 *     dishonest — the engine never produced them); they are their own typed
 *     ChdbError subclasses with actionable, multi-part guidance.
 */

import { ChdbError, type ChdbErrorOptions } from '../errors'

/**
 * byte-compat with `@clickhouse/client`'s `ClickHouseError`:
 *   class ClickHouseError extends Error { readonly code: string; readonly type: string | undefined }
 *
 * We additionally extend Layer 1's {@link ChdbError} (so it is catchable by the
 * whole hierarchy) and surface `clickhouseCode` (numeric) for callers who want
 * the raw code as a number rather than the string `code`.
 *
 * NOTE on `code`: clickhouse-js's `code` is the **numeric ClickHouse exception
 * code rendered as a string** (e.g. `"62"`), NOT the `'CHDB_*'` discriminator
 * that the rest of the Layer 1 hierarchy uses. We honour the upstream contract
 * here: `code` is `String(clickhouseCode)`. The `'CHDB_*'` discriminator is not
 * exposed on this class (it would diverge from clickhouse-js); use `instanceof`
 * to discriminate the chdb-specific subclasses.
 */
export class ClickHouseError extends ChdbError {
  /** Numeric ClickHouse exception code as a string (e.g. `"62"`), byte-compat. */
  readonly code: string
  /** ClickHouse exception type token (e.g. `"UNKNOWN_TABLE"`), when parseable. */
  readonly type: string | undefined

  constructor(
    parsed: { message: string; code: string; type?: string },
    options?: ChdbErrorOptions,
  ) {
    super(parsed.message, options)
    this.code = parsed.code
    this.type = parsed.type
    // Restore the prototype so `instanceof ClickHouseError` holds even after the
    // ChdbError constructor reset it to `new.target` (which would be
    // ClickHouseError here anyway, but be explicit and match upstream).
    Object.setPrototypeOf(this, ClickHouseError.prototype)
    // ChdbError sets `name = new.target.name`; keep it as 'ClickHouseError'.
    this.name = 'ClickHouseError'
  }
}

/**
 * Raised when `createClient` is given a URL whose scheme is not `chdb://`
 * (i.e. an attempt to point Layer 2 at a remote ClickHouse server). Layer 2 is
 * embedded-only and ships no HTTP transport.
 */
export class ChdbEmbeddedOnlyError extends ChdbError {
  readonly code = 'CHDB_EMBEDDED_ONLY'
  constructor(url: string, options?: ChdbErrorOptions) {
    super(
      `chdb (embedded) cannot connect to ${JSON.stringify(url)}: only chdb:// URLs are supported.\n` +
        `  • For an in-memory store, use createClient({ url: 'chdb://memory' }) (the default).\n` +
        `  • For an on-disk store, use createClient({ url: 'chdb:///absolute/path' }).\n` +
        `  • To talk to a remote ClickHouse server, keep using @clickhouse/client directly ` +
        `(this package does not bundle an HTTP transport).`,
      options,
    )
  }
}

/**
 * Raised when a statement uses cluster topology that embedded chDB has no
 * concept of (no `system.clusters`, no replica coordination): `ON CLUSTER`,
 * `Distributed` engine, `cluster(...)`, `clusterAllReplicas(...)`.
 *
 * Federated table functions (`remote()`/`s3()`/`postgresql()`/`url()`) are NOT
 * rejected — they are native engine I/O and work in embedded mode.
 */
export class ChdbEmbeddedNotSupportedError extends ChdbError {
  readonly code = 'CHDB_NOT_SUPPORTED'
  constructor(feature: string, options?: ChdbErrorOptions) {
    super(
      `${feature} is not supported in embedded chDB: there is no cluster topology ` +
        `(no system.clusters, no replica coordination) in a single in-process engine.\n` +
        `  • Drop the cluster clause and run the statement locally (single node).\n` +
        `  • For a local replacement of a Distributed/Replicated table, use a plain MergeTree.\n` +
        `  • Cross-source reads still work via table functions: remote(), s3(), postgresql(), url().`,
      options,
    )
  }
}
