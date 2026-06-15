import { afterEach } from 'vitest'
// @ts-expect-error — internal test helpers, not in the type surface
import { _closeAllSessions, _drainPendingOps } from '../../index.js'

// Global safety net for the single-connection-per-process constraint.
//
// libchdb allows ONE active data directory per process, and the v3 suite runs
// all files serially in a single fork (see vitest.config.ts). If any test
// creates a Session and fails to close it — most often by throwing before its
// own close() in a timing-sensitive test — that leaked connection blocks every
// subsequent `new Session()` at a different temp path with
// "only one active data directory per process", cascading failures into
// unrelated files (it surfaced as an intermittent stream.test.ts failure on the
// slowest runner). Force-closing any lingering session after every test makes a
// leak local to the test that caused it instead of poisoning the rest.
afterEach(async () => {
  // Wait for any native op a test settled early (abort/timeout) to actually
  // finish before tearing down. The C ABI has no interrupt, so the native write
  // keeps running on the libuv thread after the JS promise rejected; closing the
  // session or starting the next test while it is still in flight means two
  // operations hit libchdb's single in-process engine at once, which aborts the
  // engine for the rest of the process. Draining first keeps an early-settled op
  // local to the test that started it.
  await _drainPendingOps()
  _closeAllSessions()
})
