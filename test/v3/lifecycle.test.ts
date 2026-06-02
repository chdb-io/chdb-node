import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Session } from '../../index.js'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const indexPath = join(repoRoot, 'index.js')

describe('temp dir + close()/open/cleanup (D4, §10)', () => {
  it('uses the chdb-node- temp prefix (D4) and removes it on close', () => {
    const s = new Session()
    const p = s.path
    expect(basename(p).startsWith('chdb-node-')).toBe(true)
    expect(existsSync(p)).toBe(true)
    expect(s.open).toBe(true)
    s.close()
    expect(s.open).toBe(false)
    expect(existsSync(p)).toBe(false)
  })

  it('close() is idempotent and never throws; cleanup() is an alias', () => {
    const s = new Session()
    s.close()
    expect(() => s.close()).not.toThrow()
    expect(() => s.cleanup()).not.toThrow()
    expect(s.open).toBe(false)
  })

  it('supports [Symbol.dispose] (using)', () => {
    const s = new Session()
    const p = s.path
    s[Symbol.dispose]()
    expect(existsSync(p)).toBe(false)
  })
})

describe('cleanup safety gates (#30)', () => {
  it('NEVER deletes a user-provided (non-temp) directory', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'user-data-'))
    writeFileSync(join(userDir, 'keep.txt'), 'precious')
    try {
      const s = new Session(userDir)
      expect(s.isTemp).toBe(false)
      s.cleanup()
      // gate 1: the user's directory and its contents survive.
      expect(existsSync(userDir)).toBe(true)
      expect(existsSync(join(userDir, 'keep.txt'))).toBe(true)
    } finally {
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  it('refuses to delete a temp-flagged path that is not a chdb-node temp dir', () => {
    const s = new Session() // real temp session
    const orig = s.path
    const foreign = mkdtempSync(join(tmpdir(), 'foreign-'))
    try {
      // Tamper the path to something not matching the chdb-node- prefix.
      ;(s as any).path = foreign
      s.close()
      // gate 2: refused -> the foreign dir is untouched.
      expect(existsSync(foreign)).toBe(true)
    } finally {
      rmSync(foreign, { recursive: true, force: true })
      rmSync(orig, { recursive: true, force: true }) // orphaned original
    }
  })
})

describe('signal handlers (D3: default OFF, opt-in only)', () => {
  function listenerSnapshot() {
    return {
      SIGINT: process.listeners('SIGINT').slice(),
      SIGTERM: process.listeners('SIGTERM').slice(),
    }
  }
  function restore(snap: ReturnType<typeof listenerSnapshot>) {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      for (const l of process.listeners(sig)) {
        if (!snap[sig].includes(l)) process.removeListener(sig, l as never)
      }
    }
  }

  it('does NOT install signal handlers by default', () => {
    const snap = listenerSnapshot()
    const s = new Session()
    try {
      expect(process.listeners('SIGINT').length).toBe(snap.SIGINT.length)
      expect(process.listeners('SIGTERM').length).toBe(snap.SIGTERM.length)
    } finally {
      s.close()
    }
  })

  it('installs handlers only when opted in', () => {
    const snap = listenerSnapshot()
    const s = new Session('', { installSignalHandlers: true })
    try {
      expect(process.listeners('SIGINT').length).toBe(snap.SIGINT.length + 1)
      expect(process.listeners('SIGTERM').length).toBe(snap.SIGTERM.length + 1)
    } finally {
      s.close()
      restore(snap)
    }
  })
})

describe('repeated start/stop stability (#17)', () => {
  it('survives 1000 create/query/close cycles without crashing', () => {
    for (let i = 0; i < 1000; i++) {
      const s = new Session()
      expect(s.query('SELECT 1', 'CSV').trim()).toBe('1')
      s.close()
    }
    // standalone query still works afterwards
    const { query } = require('../../index.js')
    expect(query('SELECT 42', 'CSV').trim()).toBe('42')
  })
})

describe('process-exit cleanup sweep (§10)', () => {
  it('removes a temp dir even if the user never closed the session', () => {
    // Child creates a temp session and exits WITHOUT close(); the exit sweep
    // must release the connection and remove the temp dir.
    const code = `const { Session } = require(${JSON.stringify(indexPath)});
const s = new Session();
process.stdout.write(s.path);`
    const childPath = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }).trim()
    expect(basename(childPath).startsWith('chdb-node-')).toBe(true)
    expect(existsSync(childPath)).toBe(false)
  })
})
