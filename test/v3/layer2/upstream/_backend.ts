/**
 * The single "import rewrite" point for the upstream-shaped conformance suite.
 *
 * The spec files in this directory are written exactly as a `@clickhouse/client`
 * user writes them — only this factory decides the backend:
 *
 *   - default (embedded): `createClient` from `chdb` on `chdb://memory`.
 *   - `CHDB_UPSTREAM_BACKEND=server`: the real `@clickhouse/client` against
 *     `CHDB_PARITY_URL` (a docker clickhouse-server in CI).
 *
 * Same files, swapped import → the suite proves byte-compat: whatever passes
 * against a real server must pass against embedded chDB. This realizes design
 * §6① ("run the clickhouse-js pipeline with the import rewritten") as a
 * deterministic, runnable harness. The unsupported families (auth / role /
 * compression / query_log / cluster / multiple on-disk paths) are intentionally
 * excluded — see README.md for the skip-list.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export type Backend = 'embedded' | 'server'

export const BACKEND: Backend =
  process.env.CHDB_UPSTREAM_BACKEND === 'server' ? 'server' : 'embedded'

export async function makeClient(): Promise<AnyClient> {
  if (BACKEND === 'server') {
    const { createClient } = await import('@clickhouse/client')
    // output_format_json_quote_64bit_integers=1 mirrors both the embedded
    // backend (Layer 2 injects it for JSON) and clickhouse-js's own integration
    // suite default, so 64-bit ints decode to lossless strings on both backends
    // ("clickhouse by default returns UInt64 as string to be safe"). Without it
    // the bare server client emits lossy JS numbers and the data-type assertions
    // would diverge purely on test-client config, not real semantics.
    return createClient({
      url: process.env.CHDB_PARITY_URL ?? 'http://localhost:8123',
      clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
    })
  }
  const { createClient } = await import('../../../../index.js')
  return createClient({ url: 'chdb://memory' })
}

/** Unique-ish table name so server runs (shared DB) don't collide across files. */
export function tableName(base: string): string {
  return `l2_${base}`
}
