/**
 * The immutable node tree the fluent builder accumulates and the compiler walks.
 *
 * Every chained call returns a new builder wrapping a new, frozen node — values
 * the user supplies live in `ValueNode`s and never touch the SQL string; the
 * compiler turns each into a `{pN:Type}` placeholder bound server-side. Anything
 * that names a column/table is a `ReferenceNode` (quote-escaped, never bound).
 */

/** A user value to bind server-side. `chType` overrides the inferred type. */
export interface ValueNode {
  readonly kind: 'Value'
  readonly value: unknown
  /** Explicit ClickHouse type for the `{pN:Type}` placeholder, when known. */
  readonly chType?: string
}

/** A column / table / alias reference (quote-escaped, dotted parts split). */
export interface ReferenceNode {
  readonly kind: 'Reference'
  readonly name: string
}

/** Pre-built SQL with its own ordered bound values (chdb.sql tagged template). */
export interface RawNode {
  readonly kind: 'Raw'
  /** SQL fragments; between fragment i and i+1 sits values[i]. */
  readonly fragments: readonly string[]
  readonly values: readonly Expr[]
}

/** `name(arg, arg, …)` — a function call. */
export interface FunctionNode {
  readonly kind: 'Function'
  readonly name: string
  readonly args: readonly Expr[]
}

/** `left <op> right` (op is a fixed operator token, never user text). */
export interface BinaryNode {
  readonly kind: 'Binary'
  readonly left: Expr
  readonly op: string
  readonly right: Expr
}

/** A list of expressions joined by AND / OR. */
export interface JunctionNode {
  readonly kind: 'And' | 'Or'
  readonly items: readonly Expr[]
}

/** `expr AS alias`. */
export interface AliasNode {
  readonly kind: 'Alias'
  readonly node: Expr
  readonly alias: string
}

/** `*` (optionally table-qualified). */
export interface StarNode {
  readonly kind: 'Star'
  readonly table?: string
}

/** A parenthesized sub-select used as a source or scalar. */
export interface SubqueryNode {
  readonly kind: 'Subquery'
  readonly query: SelectQueryNode
}

export type Expr =
  | ValueNode
  | ReferenceNode
  | RawNode
  | FunctionNode
  | BinaryNode
  | JunctionNode
  | AliasNode
  | StarNode
  | SubqueryNode

export type JoinKind = 'Inner' | 'Left' | 'Full' | 'Cross'

export interface JoinNode {
  readonly kind: 'Join'
  readonly joinType: JoinKind
  readonly source: Expr
  /** `ON` predicate (absent for CROSS JOIN). */
  readonly on?: Expr
}

export interface OrderByItem {
  readonly expr: Expr
  readonly direction: 'asc' | 'desc'
}

/** `LIMIT n BY (cols)` — independent of the trailing LIMIT clause. */
export interface LimitByNode {
  readonly count: number
  readonly columns: readonly Expr[]
}

export type SetOperator = 'union' | 'unionAll' | 'intersect' | 'except'

export interface SetOperationNode {
  readonly operator: SetOperator
  readonly query: SelectQueryNode
}

export interface CteNode {
  readonly name: string
  readonly recursive: boolean
  readonly query: SelectQueryNode
}

export interface SelectQueryNode {
  readonly kind: 'SelectQuery'
  readonly from?: Expr
  readonly selections?: readonly Expr[]
  readonly distinct?: boolean
  readonly joins?: readonly JoinNode[]
  readonly where?: Expr
  readonly prewhere?: Expr
  readonly groupBy?: readonly Expr[]
  readonly having?: Expr
  readonly orderBy?: readonly OrderByItem[]
  readonly limit?: number
  readonly offset?: number
  readonly limitBy?: LimitByNode
  readonly ctes?: readonly CteNode[]
  readonly setOps?: readonly SetOperationNode[]
  // ClickHouse dialect modifiers (Layer 3 extension surface).
  readonly final?: boolean
  readonly sample?: number
  readonly settings?: Readonly<Record<string, string | number | boolean>>
  /** SQL-level `FORMAT x` (distinct from the execute() output view). */
  readonly format?: string
}

/** `ALTER TABLE t UPDATE col = expr, … WHERE pred` (ClickHouse mutation). */
export interface UpdateQueryNode {
  readonly kind: 'UpdateQuery'
  readonly table: string
  readonly assignments: readonly { readonly column: string; readonly value: Expr }[]
  readonly where?: Expr
}

/** `ALTER TABLE t DELETE WHERE pred` (ClickHouse mutation). */
export interface DeleteQueryNode {
  readonly kind: 'DeleteQuery'
  readonly table: string
  readonly where?: Expr
}

/** `INSERT INTO t (cols) SELECT …`. Row-array inserts go through Layer 1 insert. */
export interface InsertSelectNode {
  readonly kind: 'InsertSelect'
  readonly table: string
  readonly columns?: readonly string[]
  readonly select: SelectQueryNode
}

export type QueryNode =
  | SelectQueryNode
  | UpdateQueryNode
  | DeleteQueryNode
  | InsertSelectNode
