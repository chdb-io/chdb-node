/**
 * `chFn` — typed wrappers for the ClickHouse-specific functions an analyst
 * reaches for most. The 190+ other functions stay reachable through the generic
 * `fn(name, args)` (you supply the return type) or `sql\`...\``; these 8 are the
 * common ones worth a named helper.
 *
 * String args are column references, `ChExpression` args are nested expressions,
 * and any other value is bound — the same rule as `fn()`. Parametric aggregates
 * (`name(params)(args)`) are assembled so their parameters bind too.
 */

import { ChExpression, fn, val, type ExprInput } from './expression'
import { validateFunctionName } from '../compiler/identifier'
import type { Expr } from '../compiler/nodes'

function toArg(input: ExprInput | unknown): Expr {
  if (input instanceof ChExpression) return input.node
  if (typeof input === 'string') return { kind: 'Reference', name: input }
  return { kind: 'Value', value: input }
}

/**
 * Build a parametric aggregate `name(params)(args)` as a raw node whose params
 * and args are still compiled (so values among them bind). Function name is
 * validated eagerly.
 */
function parametric(
  name: string,
  params: ReadonlyArray<ExprInput | unknown>,
  args: ReadonlyArray<ExprInput | unknown>,
): ChExpression {
  validateFunctionName(name)
  const values = [...params.map(toArg), ...args.map(toArg)]
  const fragments: string[] = [`${name}(`]
  for (let i = 1; i < params.length; i++) fragments.push(', ')
  fragments.push(')(')
  for (let i = 1; i < args.length; i++) fragments.push(', ')
  fragments.push(')')
  return new ChExpression({ kind: 'Raw', fragments, values })
}

export const chFn = {
  /** `argMax(arg, val)` — the `arg` value at the row maximizing `val`. */
  argMax(arg: ExprInput, val: ExprInput): ChExpression {
    return fn('argMax', [arg, val])
  },

  /** `argMin(arg, val)` — the `arg` value at the row minimizing `val`. */
  argMin(arg: ExprInput, val: ExprInput): ChExpression {
    return fn('argMin', [arg, val])
  },

  /** `uniqExact(cols…)` — exact distinct count. */
  uniqExact(...columns: ExprInput[]): ChExpression {
    return fn('uniqExact', columns)
  },

  /** `retention(conds…)` — retention flags across the given conditions. */
  retention(...conditions: ExprInput[]): ChExpression {
    return fn('retention', conditions)
  },

  /** `topK(k)(column)` — the k most frequent values. */
  topK(k: number, column: ExprInput): ChExpression {
    return parametric('topK', [k], [column])
  },

  /** `quantileTDigest(level)(column)` — approximate quantile via t-digest. */
  quantileTDigest(level: number, column: ExprInput): ChExpression {
    return parametric('quantileTDigest', [level], [column])
  },

  /** `windowFunnel(window)(timestamp, conds…)` — funnel analysis. */
  windowFunnel(window: number, timestamp: ExprInput, ...conditions: ExprInput[]): ChExpression {
    return parametric('windowFunnel', [window], [timestamp, ...conditions])
  },

  /** `sequenceMatch(pattern)(timestamp, conds…)` — event-sequence matching. */
  sequenceMatch(pattern: string, timestamp: ExprInput, ...conditions: ExprInput[]): ChExpression {
    // The pattern is a bound value, not a column reference, so wrap it in val().
    return parametric('sequenceMatch', [val(pattern)], [timestamp, ...conditions])
  },
}
