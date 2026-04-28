# Tools

Discovery tools return compact results by default. Use `get_symbol_body` only after a compact result identifies the relevant symbol.

## Compact Symbol Shape

```json
{
  "ref": "eef296263a",
  "name": "callTool",
  "kind": "function",
  "file": "src/server.ts",
  "lines": "225-530",
  "sig": "async function callTool(...)"
}
```

## Index Tools

| Tool | Purpose |
| --- | --- |
| `index_status` | Count active, deleted, indexed, hashed, and excluded records. |
| `reindex_changed_files` | Re-index Git changed, staged, and untracked source files. |
| `reconcile_index` | Mark missing files as deleted and preserve symbol links across Git renames. |
| `changed_symbols_risk` | Summarize symbols in Git changed files and linked decisions. |

## Symbol Tools

| Tool | Purpose |
| --- | --- |
| `search_symbols` | Search compact symbol metadata by partial name, kind, or file. |
| `lookup_symbol` | Exact-name symbol lookup. Compact by default. |
| `get_symbol_body` | Read full body by `symbol_id` or compact `ref`. |
| `find_callers` | Return AST definite callers and fuzzy probable callers. |
| `changed_since` | List symbols changed since a timestamp. |
| `get_symbol_history` | Read git-derived symbol history. |

## Memory Tools

| Tool | Purpose |
| --- | --- |
| `save_message` | Store a conversation message and link mentioned symbols. |
| `search_history` | Full-text search saved messages. |
| `save_decision` | Store a project decision and link symbols. |
| `get_decisions` | Read saved decisions, optionally filtered by symbol/status. |
| `symbols_discussed_and_changed` | Find discussed symbols that changed later. |
| `find_regression_candidates` | Find changed symbols that were previously discussed. |
| `context_since_last_session` | Summarize changes and active decisions since the last session. |
| `forget_session` | Delete raw session data and optionally supersede derived decisions. |

## Recommended Discovery Pattern

```text
search_symbols -> get_symbol_body -> find_callers -> get_decisions
```

Use normal shell commands for docs, config, JSON, CSS, fixtures, and broad non-symbol text.

