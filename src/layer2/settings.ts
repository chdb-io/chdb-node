/**
 * `clickhouse_settings` → engine `SET` prefix (design §4.2 ③/④).
 *
 * Embedded chDB has no HTTP layer, so settings that only steer HTTP transport
 * are meaningless. We forward engine-level settings by prepending a `SET k=v,…;`
 * statement to the query (the same multi-statement trick Layer 1 uses for the
 * Arrow compression toggle), and drop HTTP-only keys silently (they would be
 * no-ops on a server too). The honest boundary is documented, not enforced by
 * throwing — dropping an HTTP-only setting never changes a result.
 */

import type { ClickHouseSettings } from './types'

/**
 * Settings that only affect HTTP transport / response framing. Ignored in
 * embedded mode (no HTTP). Kept as a small, explicit denylist; everything else
 * is forwarded to the engine verbatim.
 */
const HTTP_ONLY_SETTINGS: ReadonlySet<string> = new Set([
  'enable_http_compression',
  'http_zlib_compression_level',
  'http_native_compression_disable_checksumming_on_decompress',
  'wait_end_of_query',
  'send_progress_in_http_headers',
  'http_headers_progress_interval_ms',
  'add_http_cors_header',
  'http_response_buffer_size',
  'http_wait_end_of_query',
  'http_make_head_request',
  'send_timeout',
  'receive_timeout',
])

function serializeSettingValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Cannot serialize non-finite clickhouse_setting value ${value}`)
    }
    return String(value)
  }
  // string — single-quote and escape backslash/quote (engine SET string literal)
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * Merge any number of settings layers (later sources win) and render the
 * `SET ...;` prefix, or `''` if there is nothing to apply. Call as
 * `buildSettingsPrefix(defaults, clientSettings, callSettings)` — precedence is
 * left → right. Identifiers (setting names) are validated against a strict
 * whitelist so the prefix can never become an injection vector.
 */
export function buildSettingsPrefix(
  ...sources: Array<ClickHouseSettings | undefined>
): string {
  if (!sources.some(Boolean)) return ''
  const merged: Record<string, string | number | boolean> = {}
  for (const src of sources) {
    if (!src) continue
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue
      if (HTTP_ONLY_SETTINGS.has(k)) continue
      merged[k] = v
    }
  }
  const parts: string[] = []
  for (const [k, v] of Object.entries(merged)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`Invalid clickhouse_setting name ${JSON.stringify(k)}`)
    }
    parts.push(`${k} = ${serializeSettingValue(v)}`)
  }
  return parts.length ? `SET ${parts.join(', ')}; ` : ''
}
