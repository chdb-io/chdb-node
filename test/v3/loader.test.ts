import { describe, it, expect } from 'vitest'
import { loadNative, platformKey } from '../../src/loader'

describe('native loader (Item 1)', () => {
  it('platformKey reflects the current runtime', () => {
    expect(platformKey()).toBe(`${process.platform}-${process.arch}`)
  })

  it('loadNative resolves a working addon (dev fallback to build/Release here)', () => {
    const native: any = loadNative()
    expect(typeof native.Query).toBe('function')
    expect(typeof native.CreateConnection).toBe('function')
    // cached: a second call returns the same object
    expect(loadNative()).toBe(native)
  })
})
