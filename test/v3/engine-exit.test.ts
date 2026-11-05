import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  // The standalone functions' default connection had no 'exit' hook, so a
  // process.exit() left it to the addon's atexit backstop, inside C exit(),
  // after statics the server teardown still uses were destroyed. With merges
  // in flight that crashed: SIGSEGV, or "mutex lock failed: Invalid argument",
  // each after chDB's crash handler waited about 30 s.
  it('exits cleanly from process.exit() with merges in flight on the default connection', () => {
    const entry = join(process.cwd(), 'index.js')
    const script = `
      const { query } = require(${JSON.stringify(entry)});
      query('CREATE TABLE t (id UInt64, s String) ENGINE = MergeTree ORDER BY id');
      let merging = 0;
      for (let i = 0; i < 200 && merging === 0; i++) {
        query('INSERT INTO t SELECT number, toString(number) FROM numbers(' + i * 20000 + ', 20000)');
        merging = Number(query('SELECT count() FROM system.merges', 'CSV').trim());
      }
      process.stdout.write(String(merging));
      process.exit(0);
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 20_000,
      killSignal: 'SIGKILL',
    })
    expect(child.error, child.stderr).toBeUndefined()
    expect(child.signal, child.stderr).toBeNull()
    expect(child.status, child.stderr).toBe(0)
    // Only meaningful if a merge was running when the exit began.
    expect(Number(child.stdout)).toBeGreaterThan(0)
    expect(child.stderr).toBe('')
  }, 30_000)

  // The same with a query still running on the default connection, which the
  // 'exit' hook must not close under it. It is closed in exit() instead, by
  // the backstop registered again from the hook so that it runs before the
  // destroyed statics. Without that this crashed or hung in exit().
  it('exits cleanly from process.exit() with an insert still running on the default connection', () => {
    const entry = join(process.cwd(), 'index.js')
    const script = `
      const { query, queryAsync } = require(${JSON.stringify(entry)});
      query('CREATE TABLE t (id UInt64, s String) ENGINE = MergeTree ORDER BY id');
      let merging = 0;
      for (let i = 0; i < 200 && merging === 0; i++) {
        query('INSERT INTO t SELECT number, toString(number) FROM numbers(' + i * 20000 + ', 20000)');
        merging = Number(query('SELECT count() FROM system.merges', 'CSV').trim());
      }
      let done = false;
      queryAsync('INSERT INTO t SELECT number, toString(number) FROM numbers(10000000)', { format: 'CSV' })
        .then(() => { done = true; }, () => { done = true; });
      setTimeout(() => {
        process.stdout.write(merging + ' ' + (done ? 'done' : 'running'));
        process.exit(0);
      }, 20);
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    })
    expect(child.error, child.stderr).toBeUndefined()
    expect(child.signal, child.stderr).toBeNull()
    expect(child.status, child.stderr).toBe(0)
    // Only meaningful if merges ran and the insert had not finished at exit.
    const [merging, insert] = child.stdout.split(' ')
    expect(Number(merging)).toBeGreaterThan(0)
    expect(insert).toBe('running')
    expect(child.stderr).toBe('')
  }, 70_000)

  // A worker_threads Worker holds connections of its own, and Node stops it
  // only after the main thread's 'exit' event. Closing them from that event
  // freed the worker's Session under its next synchronous query (SIGSEGV).
  it('exits cleanly from process.exit() while a worker runs synchronous Session queries', () => {
    const entry = join(process.cwd(), 'index.js')
    const dir = mkdtempSync(join(tmpdir(), 'chdb-exit-worker-'))
    try {
      const workerCode = `
        const { Session } = require(${JSON.stringify(entry)});
        const s = new Session(${JSON.stringify(join(dir, 'data'))});
        s.query('SELECT 1');
        require('node:worker_threads').parentPort.postMessage('started');
        for (;;) s.query('SELECT sum(number) FROM numbers(100000000)');
      `
      const script = `
        const { Worker } = require('node:worker_threads');
        require(${JSON.stringify(entry)});
        const w = new Worker(${JSON.stringify(workerCode)}, { eval: true });
        w.on('message', () => setTimeout(() => process.exit(0), 100));
      `
      const child = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        timeout: 20_000,
        killSignal: 'SIGKILL',
      })
      expect(child.error, child.stderr).toBeUndefined()
      expect(child.signal, child.stderr).toBeNull()
      expect(child.status, child.stderr).toBe(0)
      expect(child.stderr).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
