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

  // Up to chdb-core v26.11.0-rc.1, chdb_shutdown() refused once a MergeTree
  // table had been used: the background executors outlived the last
  // connection, and rc.1 printed "chDB global pool shutdown refused" and
  // "chDB shutdown failed" on every such exit. rc.2 destroys them on shutdown
  // (chdb-core#312). The session stays open, so the exit hook closes it.
  it('exits silently after using a MergeTree table', () => {
    const entry = join(process.cwd(), 'index.js')
    const script = `
      const { Session } = require(${JSON.stringify(entry)});
      const s = new Session();
      s.query('CREATE TABLE t (id UInt64) ENGINE = MergeTree ORDER BY id');
      s.query('INSERT INTO t SELECT number FROM numbers(1000)');
      process.stdout.write(s.query('SELECT count() FROM t', 'CSV'));
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout.trim()).toBe('1000')
    expect(child.stderr).toBe('')
  }, 20_000)
})
