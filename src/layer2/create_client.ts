/**
 * `createClient` — URL gate, config arbitration, and the embedded connection
 * registry (design §2/§4.2/§5).
 *
 * Connection model:
 *  - `chdb://memory` clients all share ONE process-wide Layer 1 Session (a temp
 *    dir behind the scenes), reference-counted, so multiple memory clients
 *    coexist and streaming works — matching §5 ("same path / chdb://memory share
 *    one native connection").
 *  - `chdb:///path` clients share one Session per absolute path (also
 *    reference-counted). The Layer 1 native registry enforces the single
 *    active-data-directory rule; opening a *different* on-disk path while one is
 *    live surfaces a `ChdbConnectionError`.
 *
 * Connection creation is LAZY (on first operation), so `createClient` itself
 * never throws on a connection condition — byte-compat with clickhouse-js, whose
 * `createClient` does not connect eagerly.
 */

import { resolve as resolvePath } from 'path'
import { parseChdbUrl } from './url'
import type { ChdbClientConfigOptions, ClickHouseSettings } from './types'
import type { Layer1Session } from './layer1'
import { layer1 } from './layer1'
import { ChdbClickHouseClient } from './client'

interface RegistryEntry {
  session: Layer1Session
  refcount: number
}

// Keyed by 'memory' (the shared in-memory singleton) or an absolute path.
const registry = new Map<string, RegistryEntry>()
const MEMORY_KEY = '\0memory' // sentinel that cannot collide with a real path

function registryAcquire(key: string, makePath: string | null): Layer1Session {
  let entry = registry.get(key)
  if (!entry) {
    // makePath === null → temp-dir session (in-memory); else on-disk path.
    const session =
      makePath === null ? new (layer1().Session)() : new (layer1().Session)(makePath)
    entry = { session, refcount: 0 }
    registry.set(key, entry)
  }
  entry.refcount++
  return entry.session
}

function registryRelease(key: string): void {
  const entry = registry.get(key)
  if (!entry) return
  if (--entry.refcount <= 0) {
    registry.delete(key)
    try {
      entry.session.close()
    } catch {
      /* close is idempotent / best-effort */
    }
  }
}

/** Internal config handed to {@link ChdbClickHouseClient}. */
export interface InternalClientConfig {
  /** Lazily create-or-reuse the underlying Session (memoized, refcount++). */
  acquire: () => Layer1Session
  /** Release this client's reference (idempotent). */
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

  const key = parsed.kind === 'memory' ? MEMORY_KEY : resolvePath(parsed.path)
  const makePath = parsed.kind === 'memory' ? null : key

  // database from the URL is overridden by an explicit config.database.
  const database = config.database ?? parsed.database

  let session: Layer1Session | undefined
  let released = false
  const internal: InternalClientConfig = {
    acquire() {
      if (session === undefined) session = registryAcquire(key, makePath)
      return session
    },
    release() {
      if (!released && session !== undefined) {
        released = true
        registryRelease(key)
      } else {
        // never acquired (no op ever ran) or already released — both no-ops
        released = true
      }
    },
    database,
    clientSettings: config.clickhouse_settings,
    requestTimeout: config.request_timeout,
  }

  return new ChdbClickHouseClient(internal)
}

/** Test-only: number of live registry entries (for leak assertions). */
export function __registrySize(): number {
  return registry.size
}
