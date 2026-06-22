/**
 * `createClient` — URL gate, config arbitration, and the embedded connection
 * model (design §2/§4.2/§5).
 *
 * Connection model (multi-connection):
 *  - Each client owns its OWN Layer 1 Session — i.e. its own native connection.
 *    Layer 1's registry allows N independent connections to the same bound path
 *    (they share the one process-wide EmbeddedServer and its data, but each
 *    carries its own query state), so clients on the same target run queries in
 *    PARALLEL instead of serializing through one shared connection.
 *  - `chdb://memory` clients all point their Session at ONE shared, refcounted
 *    temp directory, so they keep shared in-memory state (a `CREATE TABLE` in one
 *    memory client is visible to another) while still getting independent
 *    connections. The temp dir is created on the first memory client and removed
 *    when the last one closes.
 *  - `chdb:///path` clients each open a Session on that absolute path — same
 *    EmbeddedServer, independent connections, shared on-disk data.
 *  - A *different* on-disk data directory while one is live is still rejected by
 *    Layer 1 (one EmbeddedServer path per process) and surfaces a
 *    `ChdbConnectionError` on first op — see design §8.
 *
 * Connection creation is LAZY (on first operation), so `createClient` itself
 * never throws on a connection condition — byte-compat with clickhouse-js, whose
 * `createClient` does not connect eagerly.
 */

import { resolve as resolvePath, join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { parseChdbUrl } from './url'
import type { ChdbClientConfigOptions, ClickHouseSettings } from './types'
import type { Layer1Session } from './layer1'
import { layer1 } from './layer1'
import { ChdbClickHouseClient } from './client'

// Shared temp directory backing every `chdb://memory` client. Created lazily on
// the first memory client and removed when the last one releases, so memory
// clients share one EmbeddedServer (and thus state) while each holds its own
// connection. (clickhouse-js has no per-client isolated "memory" either — a
// shared in-process database is the closest faithful embedded analogue.)
let memoryDir: string | null = null
let memoryRefs = 0

function acquireMemoryDir(): string {
  if (memoryDir === null) {
    memoryDir = mkdtempSync(join(tmpdir(), 'chdb-node-l2mem-'))
    memoryRefs = 0
  }
  memoryRefs++
  return memoryDir
}

function releaseMemoryDir(): void {
  if (memoryDir === null) return
  if (--memoryRefs <= 0) {
    const dir = memoryDir
    memoryDir = null
    memoryRefs = 0
    // All memory connections are closed before this runs (each client closes its
    // Session in release() prior to calling here), so the dir is safe to remove.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

// Count of live client Sessions, for leak assertions in tests.
let liveSessions = 0

/** Internal config handed to {@link ChdbClickHouseClient}. */
export interface InternalClientConfig {
  /** Lazily create the client's own Session (memoized for the client's life). */
  acquire: () => Layer1Session
  /** Release this client's Session (idempotent). */
  release: () => void
  database?: string
  clientSettings?: ClickHouseSettings
  requestTimeout?: number
}

/**
 * Create an embedded chDB client that mirrors `@clickhouse/client`'s
 * `createClient`. Config is optional; the default URL is `chdb://memory`.
 *
 * @throws ChdbEmbeddedOnlyError if `url` is not a `chdb://` URL.
 */
export function createClient(config: ChdbClientConfigOptions = {}): ChdbClickHouseClient {
  const urlInput = config.url ?? config.host
  const parsed = parseChdbUrl(urlInput) // throws ChdbEmbeddedOnlyError on bad scheme

  const isMemory = parsed.kind === 'memory'
  const absPath = isMemory ? null : resolvePath(parsed.path)

  // database from the URL is overridden by an explicit config.database.
  const database = config.database ?? parsed.database

  let session: Layer1Session | undefined
  let released = false
  let usedMemoryDir = false

  const internal: InternalClientConfig = {
    acquire() {
      if (session === undefined) {
        const path = isMemory ? acquireMemoryDir() : (absPath as string)
        usedMemoryDir = isMemory
        session = new (layer1().Session)(path)
        liveSessions++
      }
      return session
    },
    release() {
      if (released) return
      released = true
      if (session !== undefined) {
        try {
          session.close()
        } catch {
          /* close is idempotent / best-effort */
        }
        liveSessions--
        if (usedMemoryDir) releaseMemoryDir()
      }
    },
    database,
    clientSettings: config.clickhouse_settings,
    requestTimeout: config.request_timeout,
  }

  return new ChdbClickHouseClient(internal)
}

/** Test-only: number of live client Sessions (for leak assertions). */
export function __registrySize(): number {
  return liveSessions
}
