/**
 * `new Session(path, { connectionArgs })`.
 *
 * Some of what an embedder needs cannot be a `SET`. `--config-file` is not a
 * setting at all, and the arguments governing how a data directory loads
 * (`--async_load_databases`, `--restore_threads`) have already taken effect
 * before the first query could run. Downstreams moving off their own FFI
 * bindings depend on these, so the option exists to keep their semantics
 * unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { Session } = require('../../index.js')

const open: any[] = []

function session(args?: readonly string[]): any {
  const s = new Session(mkdtempSync(join(tmpdir(), 'chdb-args-')), args ? { connectionArgs: args } : {})
  open.push(s)
  return s
}

function cell(csv: string): string {
  return csv.trim().replace(/^"|"$/g, '')
}

afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close()
    } catch {
      /* a test may have closed it already */
    }
  }
})

describe('Session connectionArgs', () => {
  it('applies settings that have to be given at connect', () => {
    const s = session([
      '--session_timezone=UTC',
      '--max_query_size=67108864',
      '--async_load_databases=0',
    ])
    expect(cell(s.query("SELECT getSetting('session_timezone')", 'CSV'))).toBe('UTC')
    expect(cell(s.query("SELECT getSetting('max_query_size')", 'CSV'))).toBe('67108864')
  })

  it('leaves a session without the option exactly as it was', () => {
    // The option is additive: absent, the addon is called with one argument,
    // the way every existing caller calls it.
    const s = session()
    expect(cell(s.query('SELECT 1', 'CSV'))).toBe('1')
    expect(cell(s.query("SELECT getSetting('session_timezone')", 'CSV'))).toBe('')
  })

  it('refuses to let a setting move the data directory', () => {
    // The path is the connection registry's key, and the registry is what
    // enforces one bound directory per process. A setting that moved it would
    // leave the registry and the engine describing different places.
    expect(() => session(['--path=/tmp/elsewhere'])).toThrow(/--path/)
  })

  it('applies the arguments a data directory has to be loaded with', () => {
    // The reason the option exists. These decide how the directory loads, so
    // by the time a query could run they have already taken effect — there is
    // no later moment at which setting them would mean anything.
    const s = session([
      '--async_load_databases=0',
      '--async_load_system_database=0',
      '--tables_loader_foreground_pool_size=4',
      '--restore_threads=1',
    ])
    expect(
      s.query(
        `SELECT name, value FROM system.server_settings WHERE name IN ` +
          `('async_load_databases','async_load_system_database',` +
          `'tables_loader_foreground_pool_size','restore_threads') ORDER BY name`,
        'CSV',
      ),
    ).toBe('"async_load_databases","0"\n"async_load_system_database","0"\n"restore_threads","1"\n"tables_loader_foreground_pool_size","4"\n')
  })

  it('honours a config file, which is not a setting at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chdb-conf-'))
    writeFileSync(
      join(dir, 'conf.xml'),
      '<clickhouse><restore_threads>7</restore_threads></clickhouse>',
    )
    const s = session([`--config-file=${join(dir, 'conf.xml')}`])
    expect(cell(s.query("SELECT value FROM system.server_settings WHERE name = 'restore_threads'", 'CSV'))).toBe('7')
  })

  it('quotes 64-bit integers in JSON when asked at connect', () => {
    // The value survives the round trip exactly, which is the point: past
    // 2^53 a JSON number does not.
    const s = session(['--output_format_json_quote_64bit_integers=1'])
    expect(s.query('SELECT toInt64(9007199254740993) AS big', 'JSONEachRow').trim()).toBe(
      '{"big":"9007199254740993"}',
    )
  })

  it('refuses an argument carrying a NUL byte', () => {
    // Built rather than written literally so this file holds no control
    // character. A NUL truncates the argument at the C boundary, and the
    // truncated prefix can be an option that takes the next entry as its
    // value — which is how '--path' evades the check above.
    const nul = String.fromCharCode(0)
    expect(() => session([`--path${nul}x`, '/tmp/elsewhere'])).toThrow(/NUL/)
    expect(() => session([`--max_threads${nul}x`])).toThrow(/NUL/)
  })

  it('refuses anything that is not an array of strings', () => {
    expect(() => new Session('', { connectionArgs: 'nope' as any })).toThrow(TypeError)
    expect(() => new Session('', { connectionArgs: [1] as any })).toThrow(TypeError)
  })
})
