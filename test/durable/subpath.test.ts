/**
 * Packaging guarantees for the two new subpaths.
 *
 * The assertion that matters is the first one: importing `chdb/durable` must
 * not load native code. It is checked in a child process with `process.dlopen`
 * replaced by a throw, because that is the only check that cannot pass by
 * accident — a spy on the loader module would miss a transitive require, and
 * an assertion inside this process would already be running alongside whatever
 * the rest of the suite loaded.
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { resolveLibchdb, tryResolveLibchdb } from '../../src/libchdb/index'

const DIST = resolve(__dirname, '..', '..', 'dist')
const built = existsSync(join(DIST, 'durable', 'index.js'))

function runNode(source: string): string {
  return execFileSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    cwd: resolve(__dirname, '..', '..'),
  }).trim()
}

describe.skipIf(!built)('subpath imports', () => {
  it('loads chdb/durable without loading any native addon', () => {
    const out = runNode(`
      process.dlopen = () => { throw new Error('durable subpath loaded native code') }
      const d = require('./dist/durable/index.js')
      if (typeof d.DurableNamespace !== 'function') throw new Error('missing DurableNamespace')
      const native = Object.keys(require.cache).filter(p => p.endsWith('.node'))
      if (native.length) throw new Error('native modules loaded: ' + native.join(','))
      console.log('clean')
    `)
    expect(out).toBe('clean')
  })

  it('loads chdb/libchdb without loading any native addon', () => {
    const out = runNode(`
      process.dlopen = () => { throw new Error('libchdb subpath loaded native code') }
      const l = require('./dist/libchdb/index.js')
      if (typeof l.resolveLibchdb !== 'function') throw new Error('missing resolveLibchdb')
      const native = Object.keys(require.cache).filter(p => p.endsWith('.node'))
      if (native.length) throw new Error('native modules loaded: ' + native.join(','))
      console.log('clean')
    `)
    expect(out).toBe('clean')
  })

  it('exposes named exports to ESM importers', () => {
    const out = runNode(`
      import('./dist/durable/index.js').then(m => {
        if (typeof m.DurableNamespace !== 'function') throw new Error('no named export')
        if (m.QueryClass.MutatingGlobal !== 2) throw new Error('enum mismatch')
        console.log('clean')
      }).catch(e => { console.error(e); process.exit(1) })
    `)
    expect(out).toBe('clean')
  })

  it('declares both subpaths in package.json exports', () => {
    const pkg = require('../../package.json') as { exports: Record<string, unknown> }
    expect(pkg.exports['./durable']).toBeDefined()
    expect(pkg.exports['./libchdb']).toBeDefined()
  })
})

describe('libchdb resolution', () => {
  it('honours an explicit CHDB_LIBCHDB_PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'libchdb-'))
    const file = join(dir, 'libchdb.so')
    await writeFile(file, 'not really a library')
    const found = resolveLibchdb({ env: { CHDB_LIBCHDB_PATH: file } })
    expect(found).toEqual({ path: file, source: 'env-file' })
  })

  it('fails loudly when the explicit override is wrong, rather than falling through', () => {
    // Silently using a different library than the operator named is how a
    // process ends up running an engine nobody chose.
    expect(() => resolveLibchdb({ env: { CHDB_LIBCHDB_PATH: '/nope/libchdb.so' } })).toThrow(
      /CHDB_LIBCHDB_PATH/,
    )
  })

  it('searches a directory given by CHDB_LIBCHDB_DIR', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'libchdb-'))
    await writeFile(join(dir, 'libchdb.dylib'), 'x')
    expect(resolveLibchdb({ env: { CHDB_LIBCHDB_DIR: dir } }).source).toBe('env-dir')
  })

  it('searches caller-supplied directories before the built-in candidates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'libchdb-'))
    await mkdir(join(dir, 'nested'))
    await writeFile(join(dir, 'nested', 'libchdb.so'), 'x')
    const found = resolveLibchdb({ env: {}, extraDirs: [join(dir, 'nested')] })
    expect(found.source).toBe('extra-dir')
  })

  it('reports nothing rather than throwing from the try variant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'libchdb-'))
    writeFileSync(join(dir, 'unrelated'), 'x')
    expect(tryResolveLibchdb({ env: { CHDB_LIBCHDB_DIR: dir } })).toBeUndefined()
  })
})
