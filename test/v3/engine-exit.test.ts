import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

describe('engine process teardown (chdb-node#97)', () => {
  it('exits after an async query on the published engine', () => {
    const entry = join(process.cwd(), 'index.js')
    const script = `
      const { queryBindAsync } = require(${JSON.stringify(entry)});
      queryBindAsync('SELECT 42', {}, { format: 'CSV' }).then(
        result => { process.stdout.write(result.text()); process.exit(0); },
        error => { console.error(error); process.exit(1); }
      );
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout.trim()).toBe('42')
    expect(child.stderr).toBe('')
  }, 20_000)
})
