import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
// @ts-ignore - .mjs base resolved at runtime
import { ChDBTool } from '../../../integrations/agents/tool.mjs'
// @ts-ignore
import { ChDBError } from '../../../integrations/agents/errors.mjs'
// @ts-ignore
import { CONTRACT_VERSION, capabilities } from '../../../integrations/agents/descriptors.mjs'

// Runs the language-neutral agent-tool conformance fixture
// (integrations/agents/conformance/cases.jsonl) against ChDBTool. This is the
// TypeScript twin of chdb's tests/test_agents_conformance.py: it loads the SAME
// vendored fixture and asserts identically, so chdb-node and the Python
// reference verify the same behaviors. Keep it thin — the knowledge lives in the
// fixture and in ChDBTool, not here.

const HERE = dirname(fileURLToPath(import.meta.url))
const CONF = resolve(HERE, '../../../integrations/agents/conformance')
const FIXTURES = resolve(CONF, 'fixtures')

const records = readFileSync(resolve(CONF, 'cases.jsonl'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l))
// The FIRST record must be the fixture header (no "id") and every later record
// must be a case (with "id") — anything else is a malformed fixture and fails
// loudly instead of being silently reclassified (a case that lost its "id"
// must not vanish by being mistaken for a second header).
const [header, ...cases] = records
if (!header || header.id !== undefined) {
  throw new Error('cases.jsonl must start with a header record (no "id")')
}
for (const r of cases) {
  if (r.id === undefined) {
    throw new Error('cases.jsonl has a non-header record without an "id": ' + JSON.stringify(r))
  }
}

// Replace the {{fixtures}} token in any string, recursively through objects
// and arrays (tool configs carry arrays, e.g. file_allowlist).
function sub(v: any): any {
  if (typeof v === 'string') return v.replaceAll('{{fixtures}}', FIXTURES)
  if (Array.isArray(v)) return v.map(sub)
  if (v && typeof v === 'object') {
    const out: any = {}
    for (const [k, val] of Object.entries(v)) out[k] = sub(val)
    return out
  }
  return v
}

// Contract snake_case constructor keys -> the binding's camelCase options.
function toolFrom(cfg: any): any {
  const c = sub(cfg || {})
  return new ChDBTool({
    readOnly: c.read_only ?? true,
    maxRows: c.max_rows,
    maxBytes: c.max_bytes,
    maxExecutionTime: c.max_execution_time ?? null,
    fileAllowlist: c.file_allowlist ?? null,
    attachments: c.attachments ?? null,
  })
}

async function invoke(tool: any, c: any): Promise<any> {
  const a = sub(c.args || {})
  switch (c.method) {
    case 'call':
      return tool.call(a.name, a.arguments)
    case 'query':
      return tool.query(a.sql, { params: a.params, maxRows: a.max_rows })
    case 'list_databases':
      return tool.listDatabases()
    case 'list_tables':
      return tool.listTables(a.database ?? null)
    case 'describe':
      return tool.describe(a.target)
    case 'get_sample_data':
      return tool.getSampleData(a.target, { limit: a.limit ?? 5 })
    case 'list_functions':
      return tool.listFunctions({ like: a.like ?? null, limit: a.limit ?? 200 })
    default:
      throw new Error('unknown method in case: ' + c.method)
  }
}

describe('agents conformance (CONTRACT.md / cases.jsonl)', () => {
  expect(cases.length).toBeGreaterThan(0)

  it('fixture header matches this binding contract version', () => {
    expect(header, 'cases.jsonl must start with a header record').toBeDefined()
    expect(header.contract_version).toBe(CONTRACT_VERSION)
  })

  const features = capabilities().features
  for (const c of cases) {
    // capability-gated cases run only where the binding has the feature
    if (c.requires && !features[c.requires]) continue
    it(`${c.id} [${c.pillar}]`, async () => {
      // A case may declare its own tool config; otherwise use a read-only tool.
      const tool = c.tool ? toolFrom(c.tool) : new ChDBTool({ readOnly: true })
      try {
        const exp = c.expect

        // error_type on a rejecting method (no envelope)
        if (exp.error_type !== undefined && exp.envelope_ok === undefined) {
          let err: any
          try {
            await invoke(tool, c)
          } catch (e) {
            err = e
          }
          expect(err, 'expected the call to reject').toBeInstanceOf(ChDBError)
          expect(err.type).toBe(exp.error_type)
          return
        }

        const result = await invoke(tool, c)

        if (exp.envelope_ok !== undefined) {
          expect(result.ok).toBe(exp.envelope_ok)
          if (exp.error_type) expect(result.error.type).toBe(exp.error_type)
          return
        }
        if (exp.rows !== undefined) expect(result.rows).toEqual(exp.rows)
        if (exp.truncated !== undefined) expect(result.truncated).toBe(exp.truncated)
        if (exp.row_count !== undefined) {
          const rc = typeof result.rowCount === 'number' ? result.rowCount : result.length
          expect(rc).toBe(exp.row_count)
        }
        if (exp.contains_all !== undefined) {
          for (const v of exp.contains_all) expect(result).toContain(v)
        }
        if (exp.min_len !== undefined) expect(result.length).toBeGreaterThanOrEqual(exp.min_len)
        if (exp.describe_column !== undefined) {
          expect(result.map((col: any) => col.name)).toContain(exp.describe_column)
        }
      } finally {
        tool.close()
      }
    })
  }
})
