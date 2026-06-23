/**
 * Vitest setup file injected when running @clickhouse/client's integration
 * suite against chdb-node's ChdbConnection.
 *
 * Replaces the upstream `globalThis.environmentSpecificCreateClient` factory
 * with one that wraps the real `createClient` so every test client is
 * constructed with `connection: createChdbConnection({ path: ':memory:' })`.
 *
 * Loaded by `tests/clickhouse-js/runner.mjs` via vitest's `setupFiles` after
 * the upstream `vitest.node.setup.ts` has run.
 */
// @ts-nocheck
import { createClient } from "@clickhouse/client";
import { createChdbConnection } from "chdb/connection";

const originalFactory = globalThis.environmentSpecificCreateClient;

globalThis.environmentSpecificCreateClient = (config) => {
  // One ChdbConnection per createClient call. The shared `:memory:` temp dir
  // is refcounted in chdb-node, so all in-test clients see each other's
  // data (matching clickhouse-js's `chdb://memory` semantics).
  const connection = createChdbConnection({ path: ":memory:" });
  return createClient({ ...(config || {}), connection });
};

// Diagnostic line so CI logs make the wrapping obvious. Only fires once
// per vitest worker (the setup file is evaluated once).
// eslint-disable-next-line no-console
console.log(
  `[chdb-runner] wrapping createClient with ChdbConnection${
    originalFactory ? " (replacing upstream factory)" : ""
  }`,
);
