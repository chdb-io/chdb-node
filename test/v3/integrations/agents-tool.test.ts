import { describe, it, expect } from 'vitest'
import { Session } from '../../../index.js'
// @ts-ignore - .mjs base resolved at runtime
import { ChDBTool } from '../../../integrations/agents/tool.mjs'
// @ts-ignore
import { ChDBError } from '../../../integrations/agents/errors.mjs'
// @ts-ignore
import { chdbTools } from '../../../integrations/ai-sdk.mjs'

// Resource-lifetime behavior of the agents base + adapters (the non-conformance
// concerns raised in review: owned-session cleanup, constructor error path,
// caller-provided sessions, and the non-enumerable toolset close()).

describe('ChDBTool resource lifetime', () => {
  it('closes an owned session when constructor setup throws (no leak)', () => {
    // A bad attachment under a fileAllowlist throws ACCESS_DENIED during setup;
    // the Session the tool just created must be closed before the rethrow.
    expect(
      () =>
        new ChDBTool({
          fileAllowlist: ['/allowed-prefix/'],
          attachments: { rep: '/somewhere-else/data.csv' },
        }),
    ).toThrowError(ChDBError)
  })

  it('close() is idempotent and safe', () => {
    const t = new ChDBTool({ readOnly: true })
    expect(() => {
      t.close()
      t.close()
    }).not.toThrow()
  })

  it('does not close a caller-provided session', async () => {
    const s = new Session('')
    const t = new ChDBTool({ session: s })
    t.close() // must be a no-op on a session we do not own
    // the caller's session is still usable
    expect((await s.queryAsync('SELECT 1 AS x', { format: 'JSON' })).json().data).toEqual([{ x: 1 }])
    s.close()
  })
})

describe('adapter toolset close()', () => {
  it('exposes a non-enumerable close() that is not treated as a tool', () => {
    const s = new Session('')
    const tools = chdbTools({ session: s }) as any
    // close must not show up among the enumerated tools
    expect(Object.keys(tools)).toHaveLength(7)
    expect(Object.prototype.propertyIsEnumerable.call(tools, 'close')).toBe(false)
    expect(typeof tools.close).toBe('function')
    expect(() => tools.close()).not.toThrow() // no-op: session was provided
    s.close()
  })
})
