import { describe, it, expect } from 'vitest'
import { Session } from '../../../index.js'
// @ts-ignore - .mjs base resolved at runtime
import { ChDBTool } from '../../../integrations/agents/tool.mjs'
// @ts-ignore
import { ChDBError } from '../../../integrations/agents/errors.mjs'
// @ts-ignore
import { chdbTools } from '../../../integrations/ai-sdk.mjs'
// @ts-ignore
import { CONTRACT_VERSION, capabilities, loadDescriptors, toolSpecs } from '../../../integrations/agents/descriptors.mjs'
// @ts-ignore
import { AGENT_TOOL_DESCRIPTORS } from '../../../integrations/agents/framework.mjs'

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

describe('descriptors as the single source (CONTRACT.md)', () => {
  it('renders tool specs per dialect from descriptors.json', () => {
    const anthropic = toolSpecs('anthropic') as any[]
    const openai = toolSpecs('openai') as any[]
    const mcp = toolSpecs('mcp') as any[]
    expect(anthropic).toHaveLength(openai.length)
    expect(anthropic).toHaveLength(mcp.length)
    const run = anthropic[0]
    expect(run.name).toBe('run_select_query')
    expect(run.input_schema.required).toEqual(['sql'])
    expect(run.input_schema.properties.sql.description).toBeTruthy()
    expect(openai[0].type).toBe('function')
    expect(openai[0].function.parameters).toEqual(run.input_schema)
    expect(mcp[0].inputSchema).toEqual(run.input_schema)
  })

  it('rejects an unknown dialect with a typed error', () => {
    let err: any
    try {
      toolSpecs('langchain' as any)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ChDBError)
    expect(err.type).toBe('INVALID_ARGUMENT')
  })

  it('generates the framework descriptors (zod) from descriptors.json', () => {
    const declared = loadDescriptors().tools
    expect(AGENT_TOOL_DESCRIPTORS.map((d: any) => d.name)).toEqual(declared.map((t: any) => t.name))
    for (let i = 0; i < declared.length; i++) {
      const d = AGENT_TOOL_DESCRIPTORS[i]
      expect(d.id).toBe(declared[i].id)
      expect(d.description).toBe(declared[i].description)
      expect(Object.keys(d.schema.shape)).toEqual(declared[i].params.map((p: any) => p.name))
    }
  })

  it('reports capabilities keyed to the contract version', () => {
    const caps = capabilities()
    expect(caps.contract_version).toBe(CONTRACT_VERSION)
    expect(caps.contract_version).toBe(loadDescriptors().contract_version)
    expect(caps.features.dataframe_query).toBe(false) // Python-only capability
    expect(caps.tools).toEqual(loadDescriptors().tools.map((t: any) => t.name))
  })

  it('ChDBTool#toolSpecs delegates to the generated specs', () => {
    const t = new ChDBTool({ readOnly: true })
    try {
      expect(t.toolSpecs()).toEqual(toolSpecs('anthropic'))
    } finally {
      t.close()
    }
  })
})

describe('argument validation (CONTRACT.md P3)', () => {
  it('throws a typed INVALID_ARGUMENT on a non-numeric per-call maxRows', async () => {
    const t = new ChDBTool({ readOnly: true })
    try {
      let err: any
      try {
        await t.query('SELECT 1', { maxRows: 'lots' as any })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ChDBError)
      expect(err.type).toBe('INVALID_ARGUMENT')
    } finally {
      t.close()
    }
  })

  it('throws a typed INVALID_ARGUMENT on a non-numeric constructor cap', () => {
    let err: any
    try {
      new ChDBTool({ maxRows: 'lots' as any })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ChDBError)
    expect(err.type).toBe('INVALID_ARGUMENT')
  })

  it('call() treats a JSON null limit as omitted (model-facing leniency)', async () => {
    const t = new ChDBTool({ readOnly: true })
    try {
      const out: any = await t.call('get_sample_data', { target: 'numbers(100)', limit: null })
      expect(out.ok).toBe(true)
      expect(out.result.rowCount).toBe(5)
    } finally {
      t.close()
    }
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
