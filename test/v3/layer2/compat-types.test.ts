import { describe, it, expect } from 'vitest'
import type {
  DataFormat as ChFormat,
  PingResult as ChPing,
  QueryParams as ChQueryParams,
  InsertParams as ChInsertParams,
  CommandResult as ChCommandResult,
  InsertResult as ChInsertResult,
} from '@clickhouse/client'
import type {
  DataFormat as OurFormat,
  PingResult as OurPing,
  QueryParams as OurQueryParams,
  CommandResult as OurCommandResult,
  InsertResult as OurInsertResult,
} from '../../../dist/layer2/types.js'

// Compile-time byte-compat assertions. These are validated by `tsc -p
// tsconfig.json` (which includes test/); a drift in clickhouse-js's types breaks
// the build here. The runtime body is a trivial sanity check.

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type AssertAssignable<A, B> = [A] extends [B] ? true : false

// DataFormat unions must be identical.
const _fmt: AssertEqual<ChFormat, OurFormat> = true
// PingResult must be identical.
const _ping: AssertEqual<ChPing, OurPing> = true

// A clickhouse-js QueryParams must be accepted by our query for the migration
// fields (query / format / query_params / abort_signal / query_id / session_id /
// role / auth / http_headers). `clickhouse_settings` is excluded only because
// upstream types it as an interface (no index signature) while we keep it as an
// ergonomic Record — a TS index-signature technicality, not a runtime gap; the
// literal-acceptance check below covers real usage.
const _q: AssertAssignable<Omit<ChQueryParams, 'clickhouse_settings'>, OurQueryParams> = true

// Real-world usage: a settings record literal is accepted by our param type.
const _qLiteral: OurQueryParams = {
  query: 'SELECT 1',
  format: 'JSONEachRow',
  clickhouse_settings: { max_threads: 4, max_block_size: 1000 },
  query_params: { a: 1 },
  query_id: 'x',
  session_id: 's',
}
void _qLiteral

// Our result objects must satisfy the byte-compat result shapes that callers
// destructure (query_id / executed / response_headers / summary?).
const _cmd: AssertAssignable<OurCommandResult, ChCommandResult> = true
const _ins: AssertAssignable<OurInsertResult, ChInsertResult> = true

// Touch the bindings so they are not "unused" and the assertions are retained.
void _fmt
void _ping
void _q
void _cmd
void _ins
// Reference the upstream insert-params type to keep the import meaningful.
type _InsertParamsRef = ChInsertParams<unknown, unknown>

describe('compile-time byte-compat with @clickhouse/client', () => {
  it('type assertions hold (validated by tsc)', () => {
    expect(_fmt && _ping && _q && _cmd && _ins).toBe(true)
  })
})
