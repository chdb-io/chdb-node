import { defineConfig } from 'vitest/config'

// v3 (Layer 1) test harness. The legacy v2 byte-compat tests stay on mocha
// (test_basic.js / test_connection.js) as the untouched regression anchor;
// new TypeScript tests for the v3 surface live under test/v3/.
export default defineConfig({
  test: {
    include: ['test/v3/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // libchdb allows ONE active connection per process, so all test files must
    // share a single process and run serially (no parallelism).
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
