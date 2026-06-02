import { describe, it, expect } from 'vitest'
// Exercise the real built native addon through the existing v2 entry point,
// proving the v3 TS/vitest harness is wired to the same binary the v2 tests use.
import { query } from '../../index.js'

describe('v3 harness smoke', () => {
  it('runs a query through the built native addon', () => {
    const out = query('SELECT 1', 'CSV')
    expect(out.trim()).toBe('1')
  })

  it('round-trips a small computation', () => {
    const out = query('SELECT 2 + 3 AS n', 'CSV')
    expect(out.trim()).toBe('5')
  })
})
