import { describe, it, expect } from 'vitest'
import { createClient, ChdbEmbeddedOnlyError, ChdbTimeoutError } from '../../../index.js'
import { buildSettingsPrefix } from '../../../dist/layer2/settings.js'

describe('config arbitration §4.2 — ① report only the two unsupported things', () => {
  it('non-chdb url throws ChdbEmbeddedOnlyError at createClient', () => {
    expect(() => createClient({ url: 'http://localhost:8123' })).toThrow(ChdbEmbeddedOnlyError)
    expect(() => createClient({ url: 'https://my.clickhouse.cloud' })).toThrow(ChdbEmbeddedOnlyError)
  })
})

describe('config arbitration §4.2 — ② remote/HTTP/auth-only fields are ignored (never throw)', () => {
  it('accepts and ignores every remote/HTTP/auth-only field, query still works', async () => {
    const c = createClient({
      url: 'chdb://memory',
      // auth-only — ignored (embedded has no auth layer)
      username: 'admin',
      password: 'secret',
      access_token: 'eyJ.token.here',
      role: ['analyst', 'admin'],
      // remote/HTTP-only — ignored (embedded has no HTTP transport)
      max_open_connections: 50,
      keep_alive: { enabled: false },
      compression: { request: true, response: true },
      http_headers: { 'x-trace': '1' },
      application: 'my-app',
      pathname: '/proxy/clickhouse',
      // tls is a clickhouse-js node-only field not in our type — pass via cast
      ...({ tls: { ca_cert: Buffer.from('x') } } as object),
    } as never)
    try {
      const rs = await c.query({ query: 'SELECT 1 AS n', format: 'JSONEachRow' })
      expect(await rs.json()).toEqual([{ n: 1 }])
    } finally {
      await c.close()
    }
  })

  it('per-call auth/role/http_headers are accepted and ignored', async () => {
    const c = createClient()
    try {
      const rs = await c.query({
        query: 'SELECT 1 AS n',
        format: 'JSONEachRow',
        auth: { username: 'u', password: 'p' },
        role: 'admin',
        http_headers: { 'x-y': 'z' },
      })
      expect(await rs.json()).toEqual([{ n: 1 }])
    } finally {
      await c.close()
    }
  })
})

describe('config arbitration §4.2 — ③ retained-but-different + ④ equivalent', () => {
  it('clickhouse_settings forwarded to the engine (client + call merge, call wins)', async () => {
    // SET prefix construction (unit)
    expect(buildSettingsPrefix({ max_threads: 4 }, undefined)).toBe('SET max_threads = 4; ')
    expect(buildSettingsPrefix({ max_threads: 4 }, { max_threads: 8 })).toBe('SET max_threads = 8; ')
    // HTTP-only keys are dropped
    expect(buildSettingsPrefix({ enable_http_compression: 1 }, undefined)).toBe('')
    // engine-level setting takes effect end-to-end
    const c = createClient({ clickhouse_settings: { max_block_size: 10 } })
    try {
      const rs = await c.query({
        query: 'SELECT value FROM system.settings WHERE name = {n:String}',
        query_params: { n: 'max_block_size' },
        format: 'JSONEachRow',
      })
      expect(await rs.json()).toEqual([{ value: '10' }])
    } finally {
      await c.close()
    }
  })

  it('database from config is applied (USE) — qualifies unqualified table refs', async () => {
    const c = createClient({ url: 'chdb://memory', database: 'default' })
    try {
      const rs = await c.query({ query: 'SELECT currentDatabase() AS db', format: 'JSONEachRow' })
      expect(await rs.json()).toEqual([{ db: 'default' }])
    } finally {
      await c.close()
    }
  })

  it('request_timeout is honored as a query deadline (NOT a default 30s)', async () => {
    const c = createClient({ request_timeout: 1 })
    try {
      // a deliberately heavy aggregation that takes well over 1ms
      await expect(
        c.query({ query: 'SELECT count() FROM numbers(300000000)', format: 'JSONEachRow' }),
      ).rejects.toBeInstanceOf(ChdbTimeoutError)
    } finally {
      await c.close()
    }
  })

  it('with no request_timeout, a long query is NOT killed by a 30s default', async () => {
    const c = createClient()
    try {
      const rs = await c.query({
        query: 'SELECT count() AS c FROM numbers(20000000)',
        format: 'JSONEachRow',
      })
      const j = (await rs.json()) as Array<{ c: string }>
      expect(j).toHaveLength(1)
      expect(Number(j[0]!.c)).toBe(20000000)
    } finally {
      await c.close()
    }
  })
})
