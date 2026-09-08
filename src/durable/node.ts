/**
 * `chdb/durable/node` — the durable control plane, plus the engine that drives
 * it on Node.
 *
 * One import instead of two:
 *
 * ```ts
 * import { DurableNamespace, nodeEngineFactory } from 'chdb/durable/node'
 *
 * const ns = new DurableNamespace('s3://bucket/durable?region=us-east-2', {
 *   engineFactory: nodeEngineFactory(),
 * })
 * ```
 *
 * ### This module loads no native code either
 *
 * Importing it is as inert as importing `chdb/durable`: the addon is loaded
 * when an engine is first *constructed*, which happens inside
 * `namespace.open()`. `nodeEngineFactory()` only closes over its options. So
 * the load is deferred to the point where it can also be useful — that is
 * where the ABI is checked and the engine version read, so an addon that
 * predates the durable ABI fails at `open()` with a message naming what is
 * missing, rather than at import time from a module the caller may not even
 * reach.
 *
 * The separate subpath is therefore about **layering, not load side effects**.
 * `chdb/durable` is the protocol and knows nothing about how the engine is
 * reached; this module is one specific answer to that question, and a Bun
 * downstream owning its own `dlopen` uses the former without ever touching the
 * latter. Keeping them apart is what makes the engine seam real rather than
 * decorative.
 */

export * from './index'
export * from './adapters/chdb-node'
