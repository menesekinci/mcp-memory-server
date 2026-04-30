# Tools

Discovery tools return compact results by default. Use `get_symbol_body` only after a compact result identifies the relevant symbol.

Discovery and body-read tools expose freshness metadata. `fresh` means the indexed file hash matches the current working tree. `stale` means the working tree differs from the indexed hash or the file is missing. `excluded` means the file was intentionally skipped, and `unknown` means the server does not have enough path/hash information to prove freshness.

## Compact Symbol Shape

```json
{
  "ref": "eef296263a",
  "name": "callTool",
  "kind": "function",
  "file": "src/server.ts",
  "lines": "225-530",
  "sig": "async function callTool(...)",
  "freshness": "fresh"
}
```

## Index Tools

| Tool | Purpose |
| --- | --- |
| `index_status` | Count active, deleted, indexed, hashed, and excluded records, and report project freshness when `project_path` or `PROJECT_PATH` is available. |
| `reindex_changed_files` | Re-index Git changed, staged, and untracked source files. |
| `reconcile_index` | Mark missing files as deleted and preserve symbol links across Git renames. |
| `changed_symbols_risk` | Summarize symbols in Git changed files and linked decisions. |

## Agent Context Tools

| Tool | Purpose |
| --- | --- |
| `code_search` | Ranked compact discovery across symbols, matching decisions, and matching history. Each result includes `why_this_matched` and omits bodies. |
| `read_context` | One focused symbol packet with target metadata, optional body, callers, decisions, recent history, and freshness. |
| `impact_analysis` | Risk-oriented impact summary for a target symbol or current Git changes, including callers, linked decisions, freshness, and `why`. |

## Symbol Tools

| Tool | Purpose |
| --- | --- |
| `search_symbols` | Search compact symbol metadata by partial name, kind, or file. |
| `lookup_symbol` | Exact-name symbol lookup. Compact by default. |
| `get_symbol_body` | Read full body by `symbol_id` or compact `ref`, including file freshness metadata. |
| `find_callers` | Return AST definite callers and fuzzy probable callers. |
| `changed_since` | List symbols changed since a timestamp. |
| `get_symbol_history` | Read git-derived symbol history. |

## Memory Tools

| Tool | Purpose |
| --- | --- |
| `save_message` | Store a conversation message and link mentioned symbols. Auto-creates a project session when `session_id` is omitted or unknown. |
| `search_history` | Full-text search saved messages. |
| `save_decision` | Store a project decision and link symbols. |
| `get_decisions` | Read saved decisions, optionally filtered by symbol/status. |
| `symbols_discussed_and_changed` | Find discussed symbols that changed later. |
| `find_regression_candidates` | Find changed symbols that were previously discussed. |
| `context_since_last_session` | Summarize changes and active decisions since the last session. |
| `forget_session` | Delete raw session data and optionally supersede derived decisions. |

## Recommended Discovery Pattern

```text
code_search -> read_context -> impact_analysis -> get_symbol_body when full source is needed
```

Use normal shell commands for docs, config, JSON, CSS, fixtures, and broad non-symbol text.
