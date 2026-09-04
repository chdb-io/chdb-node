/**
 * An {@link EngineAdapter} that reaches `libchdb` directly through Bun's FFI.
 *
 * This exists to prove the point the whole `chdb/durable` design rests on: the
 * control plane has no idea what is underneath it. The same state machine that
 * chdb-node will drive through its native addon is driven here by a `dlopen`
 * of the library a `chdb-core` build just produced, with no addon in the
 * process at all — which is exactly the shape a Bun-based downstream needs.
 *
 * It is also the only way to check the control plane against the real engine
 * without compiling anything, so the end-to-end suite runs under Bun.
 *
 * Kept in `test/` rather than shipped: the published package's default adapter
 * belongs on the addon, and a Bun-only module in the dependency graph would be
 * a trap for Node users. Downstreams that want this shape should own their
 * copy — it is fifty lines of `dlopen` plus the symbol table below.
 */

import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi'
import type {
  EngineAdapter,
  EngineStartOptions,
  QueryAnalysis,
} from '../../src/durable/engine-adapter'
import { QueryClass } from '../../src/durable/engine-adapter'
import { DurableEngineError } from '../../src/durable/errors'

const SYMBOLS = {
  chdb_version: { args: [], returns: FFIType.cstring },
  chdb_connect: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  chdb_close_conn: { args: [FFIType.ptr], returns: FFIType.void },
  chdb_query_n: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.u64_fast],
    returns: FFIType.ptr,
  },
  chdb_result_error: { args: [FFIType.ptr], returns: FFIType.cstring },
  chdb_result_buffer: { args: [FFIType.ptr], returns: FFIType.ptr },
  chdb_result_length: { args: [FFIType.ptr], returns: FFIType.u64_fast },
  chdb_destroy_query_result: { args: [FFIType.ptr], returns: FFIType.void },
  chdb_backup_database_n: {
    args: [
      FFIType.ptr,
      FFIType.ptr,
      FFIType.u64_fast,
      FFIType.ptr,
      FFIType.u64_fast,
      FFIType.ptr,
      FFIType.u64_fast,
    ],
    returns: FFIType.ptr,
  },
  chdb_restore_database_n: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.u64_fast],
    returns: FFIType.ptr,
  },
  chdb_classify_query_n: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.i32,
  },
} as const

type Lib = ReturnType<typeof dlopen<typeof SYMBOLS>>

let cached: Lib | undefined

/**
 * `dlopen` the library once per process. A second `dlopen` of the same engine
 * would be a second engine, and the engine binds one data path per process.
 */
export function loadLibchdb(path: string): Lib {
  if (cached) return cached
  try {
    cached = dlopen(path, SYMBOLS)
  } catch (e) {
    // Far and away the most likely cause is a libchdb that predates the
    // durable ABI, and `dlopen` reports that as a bare TypeError naming one
    // symbol. Since the published @chdb/lib-* packages still ship such a
    // build, and the resolver prefers them over a local one, this is the
    // error a developer meets first — so it should say what to do about it
    // rather than what the loader saw.
    const missing = /Symbol "([A-Za-z0-9_]+)" not found/.exec(
      e instanceof Error ? e.message : String(e),
    )?.[1]
    if (missing) {
      throw new DurableEngineError(
        `durable: ${path} does not export ${missing}. This libchdb predates the durable ABI ` +
          `(chdb_backup_database_n, chdb_restore_database_n, chdb_classify_query_n, chdb_version). ` +
          `Point CHDB_LIBCHDB_PATH at a chdb-core build that has it — note the published ` +
          `@chdb/lib-* packages are resolved first, so the variable is how you override them.`,
        { cause: e },
      )
    }
    throw e
  }
  return cached
}

/** NUL-terminated buffer, plus the byte length the `_n` entry points want. */
function cstr(s: string): { buf: Buffer; len: number } {
  const bytes = Buffer.from(s, 'utf8')
  const buf = Buffer.alloc(bytes.length + 1)
  bytes.copy(buf)
  return { buf, len: bytes.length }
}

/** ClickHouse identifier quoting: backticks, with inner backticks doubled. */
function quoteIdentifier(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

export interface LibchdbEngineOptions {
  /** Absolute path to `libchdb.so` / `libchdb.dylib`. */
  libraryPath: string
  /** Extra `--setting=value` arguments appended to the connection. */
  extraArgs?: readonly string[]
}

export class LibchdbFfiEngine implements EngineAdapter {
  private readonly lib: Lib
  private readonly options: LibchdbEngineOptions
  /** `chdb_connection *` returned by connect; what close wants. */
  private handle: Pointer | null = null
  /** The dereferenced `chdb_connection`; what every other call wants. */
  private conn: Pointer | null = null

  constructor(options: LibchdbEngineOptions) {
    this.options = options
    this.lib = loadLibchdb(options.libraryPath)
  }

  async version(): Promise<string> {
    return String(this.lib.symbols.chdb_version())
  }

  async start(options: EngineStartOptions): Promise<void> {
    // The settings here are the ones a durable writer cannot leave to chance.
    // Asynchronous inserts and non-synchronous mutations both mean "the
    // statement returned before its effect landed", which would put a
    // statement in the WAL whose local effect is not yet in the database the
    // next checkpoint archives. `SET` is CONTROL, so a caller cannot undo
    // them through the public surface.
    const argv = [
      'chdb',
      `--path=${options.dataPath}`,
      `--backups.allowed_path=${options.backupsAllowedPath}`,
      '--async_insert=0',
      '--wait_for_async_insert=1',
      '--mutations_sync=2',
      '--alter_sync=2',
      ...(this.options.extraArgs ?? []),
    ]
    const buffers = argv.map((a) => cstr(a).buf)
    const pointers = new BigUint64Array(buffers.length)
    for (let i = 0; i < buffers.length; i++) {
      pointers[i] = BigInt(ptr(buffers[i] as Buffer))
    }
    const handle = this.lib.symbols.chdb_connect(argv.length, ptr(pointers))
    if (!handle) throw new DurableEngineError('durable: chdb_connect returned NULL')
    this.handle = handle
    const conn = read.ptr(handle, 0)
    if (!conn) throw new DurableEngineError('durable: chdb_connect produced a NULL connection')
    this.conn = conn as unknown as Pointer
  }

  private requireConn(): Pointer {
    if (!this.conn) throw new DurableEngineError('durable: engine is not started')
    return this.conn
  }

  /** Run a statement and return its formatted output, or throw the engine error. */
  private call(sql: string, format: string): string {
    const conn = this.requireConn()
    const q = cstr(sql)
    const f = cstr(format)
    const result = this.lib.symbols.chdb_query_n(conn, ptr(q.buf), q.len, ptr(f.buf), f.len)
    if (!result) throw new DurableEngineError('durable: chdb_query_n returned NULL')
    try {
      const err = this.lib.symbols.chdb_result_error(result)
      if (err) throw new DurableEngineError(`durable: engine error: ${String(err)}`)
      const len = Number(this.lib.symbols.chdb_result_length(result))
      if (len === 0) return ''
      const buf = this.lib.symbols.chdb_result_buffer(result)
      if (!buf) return ''
      return Buffer.from(toArrayBuffer(buf, 0, len)).toString('utf8')
    } finally {
      this.lib.symbols.chdb_destroy_query_result(result)
    }
  }

  /** Shared shape for the two management entry points, which return a result too. */
  private manage(
    run: () => Pointer | null,
    what: string,
  ): void {
    const result = run()
    if (!result) throw new DurableEngineError(`durable: ${what} returned NULL`)
    try {
      const err = this.lib.symbols.chdb_result_error(result)
      if (err) throw new DurableEngineError(`durable: ${what} failed: ${String(err)}`)
    } finally {
      this.lib.symbols.chdb_destroy_query_result(result)
    }
  }

  async createDatabase(database: string): Promise<void> {
    this.call(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)}`, 'CSV')
  }

  async useDatabase(database: string): Promise<void> {
    this.call(`USE ${quoteIdentifier(database)}`, 'CSV')
  }

  async query(sql: string, format: string): Promise<string> {
    return this.call(sql, format)
  }

  async run(sql: string): Promise<void> {
    this.call(sql, 'CSV')
  }

  async backupDatabase(database: string, filePath: string): Promise<void> {
    const conn = this.requireConn()
    const db = cstr(database)
    const fp = cstr(filePath)
    this.manage(
      () =>
        // V1 always passes a NULL base: an incremental archive records the
        // absolute path of its base, which does not exist on the machine that
        // restores it.
        this.lib.symbols.chdb_backup_database_n(
          conn,
          ptr(db.buf),
          db.len,
          ptr(fp.buf),
          fp.len,
          null,
          0,
        ),
      'chdb_backup_database_n',
    )
  }

  async restoreDatabase(database: string, filePath: string): Promise<void> {
    const conn = this.requireConn()
    const db = cstr(database)
    const fp = cstr(filePath)
    this.manage(
      () =>
        this.lib.symbols.chdb_restore_database_n(conn, ptr(db.buf), db.len, ptr(fp.buf), fp.len),
      'chdb_restore_database_n',
    )
  }

  async analyze(sql: string, targetDatabase: string): Promise<QueryAnalysis> {
    const conn = this.requireConn()
    const q = cstr(sql)
    const db = cstr(targetDatabase)
    // struct chdb_query_analysis_v1 { uint32 struct_size, statement_count, flags, query_class }
    const out = new Uint32Array(4)
    out[0] = out.byteLength
    const state = this.lib.symbols.chdb_classify_query_n(
      conn,
      ptr(q.buf),
      q.len,
      ptr(db.buf),
      db.len,
      ptr(out),
    )
    if (state !== 0) {
      throw new DurableEngineError('durable: chdb_classify_query_n reported CHDBError')
    }
    const flags = out[2] as number
    return {
      statementCount: out[1] as number,
      queryClass: out[3] as QueryClass,
      hasSecrets: (flags & 0x1) !== 0,
      writesOnlyTargetDatabase: (flags & 0x2) !== 0,
      changesDatabaseLifecycle: (flags & 0x4) !== 0,
    }
  }

  async close(): Promise<void> {
    if (this.handle) {
      this.lib.symbols.chdb_close_conn(this.handle)
      this.handle = null
      this.conn = null
    }
  }
}
