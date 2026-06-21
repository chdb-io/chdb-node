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
        // The CJS entrypoint owns the process-wide session / pending-op registry.
        // Test files and setup.ts import it (`../../index.js`), while the compiled
        // Layer 2 code reaches it through Node's `require('../../index.js')`. If
        // vitest transforms the import copy, the entrypoint is evaluated TWICE and
        // the global afterEach safety net (setup.ts) drains a DIFFERENT instance
        // than the one Layer 2 creates sessions on — leaking sessions across files
        // ("only one active data directory per process"). Externalizing it routes
        // every importer through Node's require cache → one shared instance.
        external: [/\/index\.js$/],
      },
    },
  },
})
