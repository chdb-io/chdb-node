import { defineConfig } from 'vitest/config'

// v3 (Layer 1) test harness. The legacy v2 byte-compat tests stay on mocha
// (test_basic.js / test_connection.js) as the untouched regression anchor;
// new TypeScript tests for the v3 surface live under test/v3/.
export default defineConfig({
  test: {
    include: ['test/v3/**/*.test.ts'],
    // Global afterEach force-closes any session a test left open, so a single
    // leak can't cascade into unrelated files (single-connection constraint).
    setupFiles: ['./test/v3/setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // libchdb allows ONE active connection per process, so all test files must
    // share a single process and run serially (no parallelism).
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    server: {
      deps: {
        // The CJS entrypoint (./index.js) owns the process-wide session and
        // pending-op registries. Test files and setup.ts import it
        // (`../../index.js`); src/connection/* reaches it via
        // `require('../../index.js')` after tsc. If vitest transforms the
        // import copy, the entrypoint evaluates TWICE — the global afterEach
        // safety net (setup.ts) then drains a DIFFERENT instance than the
        // one ChdbConnection creates sessions on, sessions leak across files,
        // and the next file fails with "only one active data directory per
        // process". Externalizing every `…/index.js` import routes it through
        // Node's require cache so every importer shares one instance.
        external: [/\/index\.js$/],
      },
    },
  },
})
