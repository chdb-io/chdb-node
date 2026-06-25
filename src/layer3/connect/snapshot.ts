/**
 * One-shot materialization: copy a remote table into a local table once. This
 * compiles to `INSERT INTO <destination> SELECT * FROM <source-table-function>`
 * — there is no change-data-capture or ongoing sync, just a single read.
 *
 * The destination is a local table name (quote-escaped by the compiler); the
 * source is the bound table-function read produced by the connection's plan.
 */

import type { InsertSelectNode, SelectQueryNode } from '../compiler/nodes'
import type { SourcePlan } from './url-scheme'

/** Build the `INSERT … SELECT` node that materializes `table` into `destination`. */
export function buildSnapshotNode(
  plan: SourcePlan,
  table: string,
  destination: string,
  settings?: Readonly<Record<string, string | number | boolean>>,
): InsertSelectNode {
  const select: SelectQueryNode = {
    kind: 'SelectQuery',
    from: plan.table(table),
    selections: [{ kind: 'Star' }],
    settings: settings && Object.keys(settings).length > 0 ? settings : undefined,
  }
  return { kind: 'InsertSelect', table: destination, select }
}
