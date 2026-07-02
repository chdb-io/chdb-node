# Cross-language conformance fixture (vendored)

`cases.jsonl` is a language-neutral list of behaviors every chDB agent-tool
binding must satisfy. It is the executable half of `../CONTRACT.md`.

This is a **vendored mirror** of `chdb-io/chdb`'s
`chdb/agents/conformance/`. The chdb-node runner loads *this* copy so the
TypeScript binding verifies the **same** behaviors as the Python reference. When
the upstream fixture changes, re-sync this directory.

Each line is one case:

```json
{"id": "...", "pillar": "P1|P2|P3|P4|introspection|safety|catalog", "method": "query|call|list_databases|list_tables|describe|get_sample_data|list_functions", "args": {...}, "expect": {...}}
```

`args` for `method: "call"` are `{name, arguments}` (the tool-dispatch path);
for every other method they are the method's keyword arguments.

A case may include an optional `tool` object with constructor-level config
(`max_execution_time`, `file_allowlist`, `attachments`, `read_only`, ...). When
present, the runner builds a dedicated tool from it for that case; otherwise it
uses a read-only tool. `{{fixtures}}` is substituted inside `tool` too.

`expect` is one of:

| key | meaning |
|---|---|
| `rows` | exact row list equality |
| `error_type` | the method must fail with this error `type` (rejecting path) |
| `truncated` + `row_count` | truncation flag and returned row count |
| `row_count` | returned row count |
| `contains_all` | every listed value present in the returned list |
| `min_len` | returned list length ≥ N |
| `describe_column` | describe result contains a column with this name |
| `envelope_ok` (+ `error_type`) | `call()` envelope `ok` flag (and error type) |

`{{fixtures}}` in any SQL is replaced by the runner with the absolute path to
`./fixtures`.

## Running it

- **Python** (reference, upstream): `python -m unittest tests.test_agents_conformance`.
- **TypeScript** (`chdb-node`): `npx vitest run test/v3/integrations/agents-conformance.test.ts`
  — a thin runner that loads this same `cases.jsonl`, maps each `method` to
  `ChDBTool`, and asserts identically.

Constructor keys in a case's `tool` object use the contract's snake_case
(`read_only`, `max_execution_time`, `file_allowlist`); the TS runner maps them to
the binding's camelCase options. A binding is **contract-conformant** when every
case passes.
