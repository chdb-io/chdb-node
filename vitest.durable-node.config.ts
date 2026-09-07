import { defineConfig } from 'vitest/config'

// The durable control plane driven by this package's own native addon, which is
// the default a Node caller gets. It needs a config of its own because it is the
// one durable suite that loads native code:
//
//  1. `vitest.durable.config.ts` deliberately runs without an engine, and one of
//     its assertions is that importing `chdb/durable` loads nothing native.
//  2. The engine binds ONE data path per process and every durable object needs
//     a private one, so this cannot share a worker with the v3 suite (which owns
//     the process-wide session registry) and cannot run in parallel with itself.
//
// It also needs a built addon: `npm run build`, then `rm -rf node_modules/@chdb/lib-*`
// so the loader prefers it over a published prebuilt that may predate the durable ABI.
export default defineConfig({
  test: {
    include: ['test/durable/node-engine.test.ts'],
    environment: 'node',
    // A checkpoint is a whole-database backup plus an upload; the default five
    // seconds is a local-fake budget, not an engine one.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
