/**
 * ChdbConnection — concrete implementation of `@clickhouse/client-common`'s
 * `Connection<Stream.Readable>` contract on top of chdb-node's Layer 1
 * native session.
 *
 *   import { createClient }         from '@clickhouse/client'
 *   import { createChdbConnection } from 'chdb/connection'
 *   const client = createClient({
 *     connection: createChdbConnection({ path: ':memory:' }),
 *   })
 *
 * Method shapes (parameters, return types, error contract) match
 * `@clickhouse/client-common` exactly; we do NOT define our own types.
 *
 * - `query` / `exec` MATERIALIZE the result via Session.queryAsync and
 *   surface it as a one-shot Readable. clickhouse-js's Client expects
 *   errors at `await connection.query(...)`, not mid-stream — eager
 *   buffering preserves that. A future native record-batch streaming
 *   path lands behind `supportsZeroCopyStreaming` (false today).
 * - `insert` reconstructs `${params.query}\n${body}` and runs it as a
 *   single statement; chDB's parser accepts the inline `INSERT … FORMAT
 *   X\n<body>` shape the clickhouse-js client emits.
 * - `ping({ select: true|false })` runs `SELECT 1`; the HTTP `/ping`
 *   endpoint has no embedded analogue, so a successful SELECT is the
 *   strongest liveness signal we have.
 * - `query_id` is synthesized as a UUIDv4 (chDB has no server-side
 *   query_id concept).
 * - `response_headers` is `{}` and `http_status_code` is `200` (synthetic
 *   for the no-wire embedded path).
 */

import { Readable } from "stream";
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { parseError } from "@clickhouse/client-common";
import type {
  ChdbConnectionOptions,
  ClickHouseSummary,
  ConnBaseQueryParams,
  ConnBaseResult,
  ConnCommandResult,
  ConnExecParams,
  ConnExecResult,
  ConnInsertParams,
  ConnInsertResult,
  ConnPingParams,
  ConnPingResult,
  ConnQueryResult,
  Connection,
} from "./connection";
import { makeChdbExtension, type ChdbExtension } from "./extension";

/**
 * Wrap a chdb-node native Session call so any thrown error is reshaped
 * into clickhouse-js's `ClickHouseError` (with the expected `.code` /
 * `.type` / `.message` fields parsed out of chDB's `Code: N.
 * DB::Exception: ... (TYPE)` format). Tests that assert on
 * `{ code, type }` work uniformly across the HTTP and chdb backends.
 */
async function withClickHouseError<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    const msg =
      err instanceof Error && err.message ? err.message : String(err);
    // parseError returns either ClickHouseError (when the input matches
    // `Code: N. DB::Exception: ... (TYPE)`) or an Error wrapping the
    // input verbatim. Either way we throw a typed value with the
    // clickhouse-js public shape.
    const mapped = parseError(msg);
    // Preserve the chdb-side cause chain for debuggers that want it.
    if (mapped !== err) (mapped as Error & { cause?: unknown }).cause = err;
    throw mapped;
  }
}

// ---------------------------------------------------------------------------
// Layer 1 shape — pulled in via require so the same module instance is shared
// with the rest of chdb-node's runtime (see the createRequire note in
// index.mjs about the portable CJS bridge across Node/Deno/Bun).

interface NativeChdbResult {
  elapsed: number;
  rowsRead: number;
  bytesRead: number;
  bytes(): Uint8Array;
  text(): string;
  json<T = unknown>(): T;
  toArrow?(): unknown;
}

interface NativeSession {
  path: string;
  isTemp: boolean;
  connection: unknown;
  readonly open: boolean;
  query(query: string, format?: string): string;
  queryAsync(
    query: string,
    opts?: { format?: string; signal?: AbortSignal; timeout?: number },
  ): Promise<NativeChdbResult>;
  queryBindAsync(
    query: string,
    params: object,
    opts?: { format?: string; signal?: AbortSignal; timeout?: number },
  ): Promise<NativeChdbResult>;
  queryStream(
    query: string,
    opts?: { format?: string; signal?: AbortSignal },
  ): unknown;
  insert(params: object): Promise<{
    rowsWritten: number;
    bytesRead?: number;
    bytesWritten?: number;
    bytesSent?: number;
    elapsed: number;
  }>;
  close(): void;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rootRequire = require("../../index.js") as {
  Session: new (
    path?: string,
    opts?: { installSignalHandlers?: boolean },
  ) => NativeSession;
  version(): {
    chdb: string;
    libchdb: string;
    platform: string;
    arch: string;
    napi?: number;
  };
};

const { Session: SessionCtor, version } = rootRequire;

// ---------------------------------------------------------------------------
// :memory: refcounted shared dir — libchdb binds exactly one data dir per
// process; every `:memory:` ChdbConnection grabs this single shared dir, and
// the multi-connection model lets N connections coexist on the same bound
// path. The dir is materialized on the first memory connection and removed
// when the last one closes — matching clickhouse-js's `chdb://memory`
// shared-state semantics.

let memoryDir: string | null = null;
let memoryRefs = 0;

function acquireMemoryDir(): string {
  if (memoryDir === null) {
    memoryDir = mkdtempSync(join(tmpdir(), "chdb-node-mem-"));
    memoryRefs = 0;
  }
  memoryRefs++;
  return memoryDir;
}

function releaseMemoryDir(): void {
  if (memoryDir === null) return;
  if (--memoryRefs <= 0) {
    const dir = memoryDir;
    memoryDir = null;
    memoryRefs = 0;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Result-shape builders matching the @clickhouse/client-common Connection
// contract.

function nsFromSeconds(elapsedSeconds: number | undefined): string {
  return String(Math.max(0, Math.round((elapsedSeconds ?? 0) * 1e9)));
}

function readSummary(opts: {
  rowsRead: number;
  bytesRead: number;
  elapsed: number;
}): ClickHouseSummary {
  const rr = String(opts.rowsRead || 0);
  const rb = String(opts.bytesRead || 0);
  return {
    read_rows: rr,
    read_bytes: rb,
    written_rows: "0",
    written_bytes: "0",
    result_rows: rr,
    result_bytes: rb,
    total_rows_to_read: "0",
    elapsed_ns: nsFromSeconds(opts.elapsed),
  };
}

function writeSummary(opts: {
  rowsWritten: number;
  bytesWritten?: number;
  bytesSent?: number;
  elapsed: number;
}): ClickHouseSummary {
  const rw = String(opts.rowsWritten || 0);
  const wb = String(opts.bytesWritten ?? opts.bytesSent ?? 0);
  return {
    read_rows: rw,
    read_bytes: wb,
    written_rows: rw,
    written_bytes: wb,
    result_rows: "0",
    result_bytes: "0",
    total_rows_to_read: "0",
    elapsed_ns: nsFromSeconds(opts.elapsed),
  };
}

function baseResult(query_id: string): ConnBaseResult {
  return { query_id, response_headers: {}, http_status_code: 200 };
}

/**
 * Settings that exist only in the ClickHouse HTTP-server layer and have
 * no counterpart in the embedded engine. clickhouse-js sets some of these
 * by default (notably `wait_end_of_query`, which it uses to ensure the
 * HTTP response body is fully written before the request settles); when
 * the same Connection contract is satisfied by an in-process backend,
 * those settings have no effect and emitting them as `SET` would raise
 * an UNKNOWN_SETTING error. Drop them silently.
 *
 * Keep this set tight: only settings we know clickhouse-js emits and chdb
 * provably rejects. Anything else should pass through so a real typo in
 * caller-supplied `clickhouse_settings` still surfaces.
 */
const HTTP_ONLY_SETTINGS = new Set([
  "wait_end_of_query",
  "send_progress_in_http_headers",
  "http_response_buffer_size",
  "http_headers_progress_interval_ms",
  "http_send_progress_interval_ms",
  "enable_http_compression",
  "http_zlib_compression_level",
  "http_response_compression_method",
  "http_native_compression_disable_checksumming_on_decompress",
]);

/**
 * Settings clickhouse-js routes through `clickhouse_settings` for the HTTP
 * backend that map onto chdb-side options instead of being SET on the
 * engine. `default_format` is the canonical one: in HTTP it's a URL
 * parameter telling the server which format to use when the SQL has no
 * explicit FORMAT clause; in chdb the queryAsync `format` option does the
 * same job. Drop it from the SET list and forward as the chdb format opt.
 */
const SETTING_TO_CHDB_OPTION: Record<string, "format"> = {
  default_format: "format",
};

/** Result of splitting a clickhouse_settings map into "SET-prefix" SQL and
 *  chdb-option overrides (currently just `format`). */
interface SettingsSplit {
  sql: string;
  chdbOpts: { format?: string };
}

function applySettings(
  sql: string,
  settings?: Record<string, unknown>,
): SettingsSplit {
  const chdbOpts: { format?: string } = {};
  if (!settings) return { sql, chdbOpts };
  const stmts: string[] = [];
  for (const [k, v] of Object.entries(settings)) {
    if (v === undefined) continue;
    if (HTTP_ONLY_SETTINGS.has(k)) continue;
    if (SETTING_TO_CHDB_OPTION[k] === "format") {
      chdbOpts.format = String(v);
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`Invalid setting name: ${JSON.stringify(k)}`);
    }
    if (typeof v === "number") stmts.push(`SET ${k} = ${v}`);
    else if (typeof v === "boolean") stmts.push(`SET ${k} = ${v ? 1 : 0}`);
    // ClickHouse SQL string literals escape `'` by DOUBLING it (`''`), not
    // with a backslash (`\'`). Using backslash here would either silently
    // truncate the value or produce malformed SQL on engines that don't
    // accept backslash escapes — drift between adapter and engine.
    else stmts.push(`SET ${k} = '${String(v).replace(/'/g, "''")}'`);
  }
  return {
    sql: stmts.length === 0 ? sql : `${stmts.join("; ")}; ${sql}`,
    chdbOpts,
  };
}

function readableFromBuffer(buf: Buffer | Uint8Array): Readable {
  const b = Buffer.isBuffer(buf)
    ? buf
    : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = new Readable({
    read() {
      this.push(b);
      this.push(null);
    },
  });
  // clickhouse-js's `ResultSet.close()` tears the result down by calling
  // `this._stream.destroy(new Error("ResultSet has been closed"))`. When the
  // ResultSet was never consumed (e.g. a non-streamable-format query whose
  // `stream()` threw, closed in a `finally`), nothing has attached an
  // `'error'` listener to this Readable, so Node escalates that synthetic
  // teardown error into an `uncaughtException` — failing the whole parity run
  // even though every assertion passed. This in-memory buffer has no genuine
  // async error source of its own (`read()` only ever pushes), so the only
  // `'error'` it can receive is exactly that external teardown signal. A
  // benign listener absorbs it, making close idempotent/no-op as the upstream
  // contract expects. Real consumers (`Stream.pipeline` in `ResultSet.stream`)
  // attach their OWN error handler, which still fires for genuine propagation.
  r.on("error", () => {});
  return r;
}

async function streamToString(
  values: string | Readable | AsyncIterable<unknown>,
): Promise<string> {
  if (typeof values === "string") return values;
  let body = "";
  for await (const chunk of values as AsyncIterable<unknown>) {
    if (typeof chunk === "string") body += chunk;
    else if (Buffer.isBuffer(chunk)) body += chunk.toString("utf8");
    else if (chunk instanceof Uint8Array) body += Buffer.from(chunk).toString("utf8");
    else throw new Error(`Unsupported insert chunk type: ${typeof chunk}`);
  }
  return body;
}

// ---------------------------------------------------------------------------

/**
 * Concrete `Connection<Stream.Readable>` backed by an in-process chDB Layer 1
 * Session. Created via {@link createChdbConnection}.
 */
export class ChdbConnection implements Connection<Readable> {
  /** Routing hint for callers that key off the in-process backend identity.
   *  Not part of the Connection contract — a ChdbConnection-only property. */
  readonly connectionName = "chdb";

  /** False today: chdb-node copies each result chunk into a JS Buffer.
   *  Will flip to true once the N-API external-ArrayBuffer Arrow path
   *  lands and downstream code can plumb its streaming/DataFrame path
   *  directly to chDB's record-batch reader. */
  readonly supportsZeroCopyStreaming = false;

  readonly #session: NativeSession;
  readonly #chdb: ChdbExtension;
  readonly #ownsMemoryRef: boolean;
  #closed = false;

  #serverVersion?: Promise<string>;
  #serverTimezone?: Promise<string>;

  constructor(opts: ChdbConnectionOptions = {}) {
    const isMemory = opts.path === ":memory:" || opts.path === undefined;
    if (isMemory) {
      const sharedDir = acquireMemoryDir();
      this.#ownsMemoryRef = true;
      try {
        this.#session = new SessionCtor(sharedDir);
      } catch (e) {
        releaseMemoryDir();
        throw e;
      }
    } else {
      this.#ownsMemoryRef = false;
      this.#session = new SessionCtor(opts.path);
    }
    this.#chdb = makeChdbExtension(
      this.#session as Parameters<typeof makeChdbExtension>[0],
    );
  }

  /** chDB-specific raw escape hatches. See {@link ChdbExtension}. */
  get chdb(): ChdbExtension {
    return this.#chdb;
  }

  // -------------------------------------------------------------------------
  // Connection<Readable> implementation

  /**
   * Run the SQL via chdb's parameterized bind path when `query_params` is
   * non-empty (mirrors clickhouse-js's `param_*` URL-binding HTTP path),
   * otherwise the plain `queryAsync`. chdb-node's queryBindAsync handles the
   * JS-to-engine value formatting; for top-level strings clickhouse-js's
   * unquoted convention is honored by chdb's parameter binder.
   */
  async #runSql(
    sql: string,
    params: ConnBaseQueryParams,
    chdbOpts: { format?: string } = {},
  ): Promise<NativeChdbResult> {
    const opts = { ...chdbOpts, signal: params.abort_signal } as const;
    if (params.query_params && Object.keys(params.query_params).length > 0) {
      return withClickHouseError(
        this.#session.queryBindAsync(sql, params.query_params, opts),
      );
    }
    return withClickHouseError(this.#session.queryAsync(sql, opts));
  }

  async query(
    params: ConnBaseQueryParams,
  ): Promise<ConnQueryResult<Readable>> {
    this.#assertOpen();
    const query_id = params.query_id ?? randomUUID();
    const { sql, chdbOpts } = applySettings(
      params.query,
      params.clickhouse_settings,
    );
    const result = await this.#runSql(sql, params, chdbOpts);
    return {
      stream: readableFromBuffer(result.bytes()),
      ...baseResult(query_id),
    };
  }

  async exec(
    params: ConnExecParams<Readable>,
  ): Promise<ConnExecResult<Readable>> {
    this.#assertOpen();
    const query_id = params.query_id ?? randomUUID();
    const applied = applySettings(params.query, params.clickhouse_settings);
    let sql = applied.sql;
    const chdbOpts = applied.chdbOpts;
    if (params.values !== undefined) {
      const body = await streamToString(params.values);
      // Empty exec-with-values body short-circuit. clickhouse-js's exec
      // callers may pass an empty / already-closed stream; chdb's parser
      // rejects an INSERT without rows with "No data to insert", which
      // contradicts the no-op-success semantics every caller expects.
      if (body.trim().length === 0) {
        return {
          stream: readableFromBuffer(Buffer.alloc(0)),
          ...baseResult(query_id),
          summary: writeSummary({
            rowsWritten: 0,
            bytesWritten: 0,
            elapsed: 0,
          }),
        };
      }
      sql = `${sql}\n${body}`;
    }
    const result = await this.#runSql(sql, params, chdbOpts);
    return {
      stream: readableFromBuffer(result.bytes()),
      ...baseResult(query_id),
      summary: readSummary(result),
    };
  }

  async command(params: ConnBaseQueryParams): Promise<ConnCommandResult> {
    this.#assertOpen();
    const query_id = params.query_id ?? randomUUID();
    const { sql, chdbOpts } = applySettings(
      params.query,
      params.clickhouse_settings,
    );
    const result = await this.#runSql(sql, params, chdbOpts);
    return { ...baseResult(query_id), summary: readSummary(result) };
  }

  async insert(
    params: ConnInsertParams<Readable>,
  ): Promise<ConnInsertResult> {
    this.#assertOpen();
    const query_id = params.query_id ?? randomUUID();
    // clickhouse-js sends `INSERT INTO t (...) FORMAT X` with the body as a
    // SEPARATE `values` parameter. chDB accepts the body inline after the
    // statement, so we materialize the stream/string and concatenate. The
    // .chdb extension's rawInsert remains available for callers that want
    // chdb-node's Buffer-passthrough zero-copy insert.
    const body = await streamToString(params.values);
    // Empty body short-circuit. clickhouse-js's exec/insert callers may
    // pass an empty / already-closed stream when there's nothing to send;
    // running `INSERT INTO t FORMAT X\n` against chdb raises
    // "No data to insert", whereas a no-op success is the expected
    // semantics.
    if (body.trim().length === 0) {
      return {
        ...baseResult(query_id),
        summary: writeSummary({
          rowsWritten: 0,
          bytesWritten: 0,
          elapsed: 0,
        }),
      };
    }
    const { sql, chdbOpts } = applySettings(
      `${params.query}\n${body}`,
      params.clickhouse_settings,
    );
    const result = await this.#runSql(sql, params, chdbOpts);
    return {
      ...baseResult(query_id),
      summary: writeSummary({
        rowsWritten: result.rowsRead || 0,
        bytesWritten: result.bytesRead,
        elapsed: result.elapsed,
      }),
    };
  }

  async ping(_params: ConnPingParams): Promise<ConnPingResult> {
    if (this.#closed) {
      return { success: false, error: new Error("ChdbConnection is closed") };
    }
    try {
      // Both `{ select: true }` and `{ select: false }` execute SELECT 1.
      // The HTTP `/ping` endpoint has no embedded analogue, so a successful
      // SELECT against the engine is the strongest liveness signal we have.
      await withClickHouseError(this.#session.queryAsync("SELECT 1", { format: "CSV" }));
      return { success: true };
    } catch (e) {
      return { success: false, error: this.mapError(e) };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#session.close();
    if (this.#ownsMemoryRef) releaseMemoryDir();
  }

  // -------------------------------------------------------------------------
  // Diagnostic helpers (not part of the Connection contract).

  get serverVersion(): Promise<string> {
    if (!this.#serverVersion) {
      this.#serverVersion = Promise.resolve(version().libchdb);
    }
    return this.#serverVersion;
  }

  get serverTimezone(): Promise<string> {
    if (!this.#serverTimezone) {
      this.#serverTimezone = Promise.resolve("UTC");
    }
    return this.#serverTimezone;
  }

  // -------------------------------------------------------------------------

  /**
   * Coerce any thrown value into an `Error` instance. Mirrors
   * `NodeBaseConnection.mapError` from clickhouse-js — useful for callers
   * that catch from this connection and want a uniform Error shape.
   * Not part of the cross-backend `Connection` interface.
   */
  mapError(err: unknown): Error {
    if (err instanceof Error) return err;
    return new Error(String(err));
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("ChdbConnection is closed");
  }
}

/**
 * Factory for {@link ChdbConnection}. Use `path: ':memory:'` (the default)
 * for an ephemeral session whose temp dir is reference-counted across
 * other `:memory:` connections in the same process; pass an absolute
 * path to bind a persistent session.
 */
export function createChdbConnection(
  opts: ChdbConnectionOptions = {},
): ChdbConnection {
  return new ChdbConnection(opts);
}
