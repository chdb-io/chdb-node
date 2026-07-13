// Model-visible tool descriptors and the contract version/capability surface.
//
// descriptors.json (vendored byte-identical from the Python reference,
// chdb/agents/descriptors.json) is the single source of truth for the
// agent-tool names, descriptions, and argument schemas the model sees. This
// module turns it into framework-consumable specs, so adapters generate their
// schemas instead of hand-copying text that then drifts between languages:
//
// - toolSpecs(dialect) — JSON-schema tool definitions in the shape each
//   runtime family expects ('anthropic' | 'openai' | 'mcp').
// - capabilities() — { contract_version, tools, features }: what this binding
//   implements, for downstream feature-probing (a consumer checks
//   features.dataframe_query instead of guessing from the package version).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ChDBError } from './errors.mjs'

// The agent-tool contract version (semver). Bumped whenever descriptors.json,
// conformance/cases.jsonl, or normative CONTRACT.md text changes. Tests assert
// it equals the contract_version field of both data files.
export const CONTRACT_VERSION = '0.2.0'

const DESCRIPTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'descriptors.json')
let cache = null

/**
 * Return the parsed descriptors.json (the file is read once and cached; each
 * call returns a deep copy, so a caller mutating the result cannot corrupt
 * what toolSpecs()/capabilities()/AGENT_TOOL_DESCRIPTORS generate for everyone
 * else in-process).
 */
export function loadDescriptors() {
  if (cache == null) {
    try {
      cache = JSON.parse(readFileSync(DESCRIPTORS_PATH, 'utf8'))
    } catch (e) {
      // A missing/broken descriptors.json takes down every toolSpecs()/
      // capabilities()/adapter path — surface it as a diagnosable typed error
      // instead of a raw fs error or SyntaxError.
      throw new ChDBError(
        `cannot load agent tool descriptors from ${DESCRIPTORS_PATH}: ${(e && e.message) || e}`,
      )
    }
  }
  return structuredClone(cache)
}

// The param types descriptors.json may declare. An unknown type must fail
// loudly: silently rendering it as a permissive schema would degrade the
// model-visible argument contract without any signal.
const PARAM_TYPES = new Set(['string', 'integer', 'object'])

function jsonSchema(params) {
  const properties = {}
  const required = []
  for (const p of params) {
    if (!PARAM_TYPES.has(p.type)) {
      throw new ChDBError(
        `unknown descriptor param type ${JSON.stringify(p.type)} for ${JSON.stringify(p.name)} (expected one of ${[...PARAM_TYPES].join(', ')})`,
      )
    }
    const prop = { type: p.type }
    if (p.description) prop.description = p.description
    properties[p.name] = prop
    if (p.required) required.push(p.name)
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

/**
 * Tool definitions generated from descriptors.json.
 * 'anthropic': {name, description, input_schema} (also the historical
 * ChDBTool#toolSpecs() shape); 'openai': {type: 'function', function: {...}};
 * 'mcp': {name, description, inputSchema}.
 * @param {'anthropic'|'openai'|'mcp'} [dialect]
 */
export function toolSpecs(dialect = 'anthropic') {
  const tools = loadDescriptors().tools
  if (dialect === 'anthropic') {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: jsonSchema(t.params),
    }))
  }
  if (dialect === 'openai') {
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: jsonSchema(t.params) },
    }))
  }
  if (dialect === 'mcp') {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: jsonSchema(t.params),
    }))
  }
  throw new ChDBError(
    `unknown toolSpecs dialect: ${JSON.stringify(dialect)} (expected 'anthropic', 'openai', or 'mcp')`,
    { type: 'INVALID_ARGUMENT' },
  )
}

/**
 * What this binding implements, keyed for downstream feature-probing.
 *
 * `features` marks the capability-gated parts of the contract: conformance
 * cases carrying `"requires": "<feature>"` run only where that feature is true
 * (dataframe_query is Python-only — the agent runtime and the engine share a
 * process there; this binding's async is native, no worker thread needed).
 */
export function capabilities() {
  return {
    contract_version: CONTRACT_VERSION,
    tools: loadDescriptors().tools.map((t) => t.name),
    features: {
      dataframe_query: false,
      attachments: true,
      file_allowlist: true,
      max_execution_time: true,
      async: true,
      streaming: false,
    },
  }
}
