import net from 'node:net'
import { describe, it, expect } from 'vitest'
import { Session } from '../../../index.js'
// @ts-ignore - .mjs base resolved at runtime
import { ChDBTool } from '../../../integrations/agents/tool.mjs'
// @ts-ignore
import { ChDBError, ChDBResourceError, RESOURCE_HINT } from '../../../integrations/agents/errors.mjs'
// @ts-ignore
import { TRUNCATION_HINT } from '../../../integrations/agents/tool.mjs'
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
    // A bad attachment under a fileAllowlist throws ALLOWLIST_DENIED during setup;
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
    // a fresh session is readonly=0, so the matching declaration is readOnly:false
    const t = new ChDBTool({ session: s, readOnly: false })
    t.close() // must be a no-op on a session we do not own
    // the caller's session is still usable
    expect((await s.queryAsync('SELECT 1 AS x', { format: 'JSON' })).json().data).toEqual([{ x: 1 }])
    s.close()
  })

  it('refuses a caller-provided session whose readonly conflicts with the declared mode', () => {
    const s = new Session('')
    try {
      // fresh session readonly=0 vs default readOnly:true — must NOT silently
      // SET readonly=2 on the caller's session (irreversible); must refuse
      let err: any
      try {
        new ChDBTool({ session: s })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ChDBError)
      expect(err.type).toBe('CONFIG_MISMATCH')
      // the probe did not lock the session: it is still writable
      expect(() => s.query('CREATE TABLE probe_check (a Int32) ENGINE = Memory')).not.toThrow()
    } finally {
      s.close()
    }
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

  it('loadDescriptors returns a defensive copy', () => {
    // a caller mutating the result must not corrupt what toolSpecs()/
    // capabilities()/AGENT_TOOL_DESCRIPTORS generate for everyone else
    const d = loadDescriptors() as any
    d.contract_version = '9.9.9'
    d.tools[0].name = 'mutated'
    d.tools[0].params.length = 0
    const fresh = loadDescriptors() as any
    expect(fresh.contract_version).toBe(CONTRACT_VERSION)
    expect(fresh.tools[0].name).toBe('run_select_query')
    expect((toolSpecs('anthropic') as any)[0].input_schema.required).toEqual(['sql'])
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

  it('call() returns an envelope for a non-object arguments payload', async () => {
    // the dispatch path never throws for caller mistakes: without this guard a
    // string would spread into {0: 'S', 1: 'E', ...} garbage and run anyway
    const t = new ChDBTool({ readOnly: true })
    try {
      for (const bad of ['SELECT 1', 42, ['sql']]) {
        const out: any = await t.call('run_select_query', bad as any)
        expect(out.ok).toBe(false)
        expect(out.error.type).toBe('INVALID_ARGUMENT')
      }
    } finally {
      t.close()
    }
  })
})

describe('resource caps and hints (CONTRACT.md P3/P5, contract 0.3.0)', () => {
  it('classifies an engine resource limit as ChDBResourceError carrying the recovery hint', async () => {
    // DEDICATED tool: a query-level SETTINGS clause persists for the session on
    // a chdb session (engine quirk documented in CONTRACT.md), so this must
    // never run on a shared tool instance.
    const t = new ChDBTool({ readOnly: true })
    try {
      let err: any
      try {
        await t.query(
          "SELECT number FROM numbers(100) SETTINGS max_result_rows = 10, result_overflow_mode = 'throw'",
        )
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ChDBResourceError)
      expect(err.type).toBe('TOO_MANY_ROWS_OR_BYTES')
      expect(err.hint).toBe(RESOURCE_HINT)
      expect(err.toObject().hint).toBe(RESOURCE_HINT)
    } finally {
      t.close()
    }
  })

  it('clamps a per-call maxRows above the constructor cap (engine bound fixed at construction)', async () => {
    const t = new ChDBTool({ readOnly: true, maxRows: 5 })
    try {
      const r = await t.query('SELECT toInt32(number) AS n FROM numbers(10)', { maxRows: 50 })
      expect(r.rowCount).toBe(5)
      expect(r.truncated).toBe(true)
    } finally {
      t.close()
    }
  })

  it('adds the truncation hint to a truncated envelope result (and only then)', async () => {
    const t = new ChDBTool({ readOnly: true, maxRows: 3 })
    try {
      const truncated = (await t.query('SELECT toInt32(number) AS n FROM numbers(10)')).toObject()
      expect(truncated.truncated).toBe(true)
      expect(truncated.hint).toBe(TRUNCATION_HINT)
      const full = (await t.query('SELECT 1 AS x')).toObject()
      expect(full.truncated).toBe(false)
      expect('hint' in full).toBe(false)
    } finally {
      t.close()
    }
  })

  it('validates maxMemoryUsage / maxResultBytes as typed INVALID_ARGUMENT', () => {
    for (const opts of [{ maxMemoryUsage: 'lots' }, { maxResultBytes: 'lots' }]) {
      let err: any
      try {
        new ChDBTool(opts as any)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ChDBError)
      expect(err.type).toBe('INVALID_ARGUMENT')
    }
  })
})

describe('network watchdog (CONTRACT.md P5, contract 0.3.0)', () => {
  // Stands in for an engine call blocked on a firewalled endpoint (the real
  // black hole is not portable); sync query() serves the constructor probe/SETs.
  function slowSession() {
    return {
      query(sql: string) {
        return sql.includes("getSetting('readonly')") ? '0' : ''
      },
      queryAsync() {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ json: () => ({ data: [] }) }), 2500),
        )
      },
    }
  }

  it('deadline fires with NETWORK_TIMEOUT + hint, poisons the tool, close() stays safe', async () => {
    const tool = new ChDBTool({ session: slowSession() as any, readOnly: false, networkTimeout: 1 })
    const t0 = Date.now()
    let err: any
    try {
      await tool.query("SELECT count() FROM url('https://example.invalid/x.csv', 'CSV')")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ChDBError)
    expect(err.type).toBe('NETWORK_TIMEOUT')
    expect(err.hint).toBeTruthy()
    expect(Date.now() - t0).toBeLessThan(2000)
    // poisoned: even a local query must fail with TOOL_ERROR
    let err2: any
    try {
      await tool.query('SELECT 1')
    } catch (e) {
      err2 = e
    }
    expect(err2).toBeInstanceOf(ChDBError)
    expect(err2.type).toBe('TOOL_ERROR')
    // close() must drop the reference without freeing the parked session
    expect(() => tool.close()).not.toThrow()
  })

  it('envelope path carries NETWORK_TIMEOUT type + hint', async () => {
    const tool = new ChDBTool({ session: slowSession() as any, readOnly: false, networkTimeout: 1 })
    const out: any = await tool.call('run_select_query', {
      sql: "SELECT 1 FROM s3('https://example.invalid/x.parquet')",
    })
    expect(out.ok).toBe(false)
    expect(out.error.type).toBe('NETWORK_TIMEOUT')
    expect(out.error.hint).toBeTruthy()
    tool.close()
  })

  it('local queries bypass the watchdog', async () => {
    const tool = new ChDBTool({ networkTimeout: 1 })
    try {
      const r = await tool.query('SELECT toInt32(1) AS x')
      expect(r.rows).toEqual([{ x: 1 }])
    } finally {
      tool.close()
    }
  })

  it('networkTimeout: null disables the watchdog', () => {
    const tool = new ChDBTool({ networkTimeout: null })
    try {
      expect(tool.networkTimeout).toBeNull()
    } finally {
      tool.close()
    }
  })

  it('attaches the network hint to an engine-side Poco timeout (code 1001)', async () => {
    // the engine rejects on its own (baseline socket timeouts fired) before the
    // watchdog: the parsed error must carry the same recovery hint
    const session = {
      query(sql: string) {
        return sql.includes("getSetting('readonly')") ? '0' : ''
      },
      queryAsync() {
        return Promise.reject(
          new Error('Code: 1001. DB::Exception: Poco::TimeoutException: Timeout. (STD_EXCEPTION)'),
        )
      },
    }
    const tool = new ChDBTool({ session: session as any, readOnly: false, networkTimeout: 30 })
    try {
      let err: any
      try {
        await tool.query("SELECT 1 FROM url('https://example.invalid/x.csv', 'CSV')")
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ChDBError)
      expect(err.code).toBe(1001)
      expect(err.hint).toBeTruthy()
    } finally {
      tool.close()
    }
  })

  it('real black-holed endpoint: watchdog fires, a fresh tool works after the abandoned call settles', async () => {
    // Real url() against a local server that accepts and never answers: the TLS
    // handshake blocks inside the engine until its socket timeouts fire (~4-7x
    // the 2s baseline), so the 2s watchdog must win the race.
    const held: net.Socket[] = []
    const srv = net.createServer((sock) => {
      held.push(sock) // keep referenced: a GC'd socket sends RST and errors fast
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as net.AddressInfo).port
    try {
      const tool = new ChDBTool({ networkTimeout: 2 })
      const t0 = Date.now()
      let err: any
      try {
        await tool.query(`SELECT count() FROM url('https://127.0.0.1:${port}/x.csv', 'LineAsString')`)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ChDBError)
      expect(err.type).toBe('NETWORK_TIMEOUT')
      expect(err.hint).toBeTruthy()
      expect(Date.now() - t0).toBeLessThan(10_000)
      tool.close()

      // One data directory per process: a fresh tool becomes constructible only
      // once the abandoned native call settles and its parked session is closed.
      let fresh: any = null
      const deadline = Date.now() + 40_000
      while (fresh == null && Date.now() < deadline) {
        try {
          fresh = new ChDBTool({ networkTimeout: 2 })
        } catch {
          await new Promise((r) => setTimeout(r, 250))
        }
      }
      expect(fresh, 'fresh tool once the abandoned call settled').toBeTruthy()
      try {
        const r = await fresh.query('SELECT toInt32(42) AS x')
        expect(r.rows).toEqual([{ x: 42 }])
      } finally {
        fresh.close()
      }
    } finally {
      srv.close()
      for (const c of held) c.destroy()
    }
  }, 60_000)
})

describe('adapter toolset close()', () => {
  it('exposes a non-enumerable close() that is not treated as a tool', () => {
    const s = new Session('')
    const tools = chdbTools({ session: s, allowWrite: true }) as any
    // close must not show up among the enumerated tools
    expect(Object.keys(tools)).toHaveLength(7)
    expect(Object.prototype.propertyIsEnumerable.call(tools, 'close')).toBe(false)
    expect(typeof tools.close).toBe('function')
    expect(() => tools.close()).not.toThrow() // no-op: session was provided
    s.close()
  })
})
