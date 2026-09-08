import { defineConfig } from 'vitest/config'

// The durable control plane is pure TypeScript with no native dependency, so it
// gets its own project rather than joining the v3 suite. Two reasons, and the
// second is the important one:
//
//  1. It needs no engine, so it can run in parallel and in any environment.
//  2. The v3 suite's setup file imports the CJS entrypoint, which loads the
//     native addon. Running these tests there would make the "importing
//     chdb/durable loads nothing native" assertion vacuous — the addon would
//     already be in the process.
//
// Two suites are excluded because they would break both properties. The Bun
// end-to-end suite (*.bun.test.ts) runs under `bun test`, since it reaches
// libchdb through bun:ffi; the addon suite (node-engine.test.ts) loads the
// native addon, and has its own config for the same reason.
export default defineConfig({
  test: {
    include: ['test/durable/**/*.test.ts'],
    exclude: ['test/durable/**/*.bun.test.ts', 'test/durable/node-engine.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
})
