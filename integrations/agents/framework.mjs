// Shared glue for framework adapters (Vercel AI SDK, Mastra). Both adapters build
// their native tools from the SAME descriptor list and delegate execution to
// ChDBTool.call(), so every framework exposes the identical canonical contract
// surface (CONTRACT.md) with identical behavior — the adapters are thin shims,
// not parallel implementations. `zod` is an optional peer of the adapters that
// pull this in.

import { z } from 'zod'
import { loadDescriptors } from './descriptors.mjs'
import { ChDBTool } from './tool.mjs'

/**
 * Resolve a ChDBTool from adapter options. Pass a prebuilt `tool`, or the
 * construction options; `allowWrite` is accepted as the inverse of `readOnly`
 * for convenience.
 * @param {{ tool?: ChDBTool, session?: any, path?: string, readOnly?: boolean,
 *   allowWrite?: boolean, maxRows?: number, maxBytes?: number,
 *   maxExecutionTime?: number|null, fileAllowlist?: string[]|null,
 *   attachments?: object|null }} [opts]
 */
export function resolveTool(opts = {}) {
  if (opts.tool instanceof ChDBTool) return opts.tool
  const readOnly = opts.readOnly ?? (opts.allowWrite != null ? !opts.allowWrite : true)
  return new ChDBTool({
    session: opts.session ?? null,
    path: opts.path,
    readOnly,
    maxRows: opts.maxRows,
    maxBytes: opts.maxBytes,
    maxExecutionTime: opts.maxExecutionTime ?? null,
    fileAllowlist: opts.fileAllowlist ?? null,
    attachments: opts.attachments ?? null,
  })
}

// The canonical tool set, GENERATED from descriptors.json (the cross-language
// single source of the model-visible surface — names, descriptions, argument
// schemas). `name` is the contract name the model sees; `id` is the kebab form
// Mastra requires. The zod schema is a mechanical rendering of the declared
// params, so the input shape is exactly the arguments ChDBTool.call() expects
// and an adapter is `execute → tool.call(name, input)`. Hand-editing the list
// here (instead of descriptors.json) is a contract violation.

function zodParam(p) {
  let t
  if (p.type === 'string') t = z.string()
  else if (p.type === 'integer') t = z.number().int()
  else t = z.record(z.string(), z.any())
  if (p.description) t = t.describe(p.description)
  return p.required ? t : t.optional()
}

export const AGENT_TOOL_DESCRIPTORS = loadDescriptors().tools.map((t) => ({
  name: t.name,
  id: t.id,
  description: t.description,
  schema: z.object(Object.fromEntries(t.params.map((p) => [p.name, zodParam(p)]))),
}))

