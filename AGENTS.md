# Agent Guidance

## Memory MCP Usage

When working in this repository, prefer the local MCP memory server for the first pass of project discovery.

Recommended flow:

1. Use MCP tools such as `search_symbols`, `lookup_symbol`, `index_status`, `search_history`, and `get_decisions` to narrow the relevant area first.
2. Use compact MCP results for orientation. They intentionally omit full bodies and long absolute paths.
3. Only call `get_symbol_body` or read files with shell commands after the relevant symbol, file, or line range is identified.
4. Use normal shell search/read commands for non-symbol content such as docs, config, JSON, CSS, fixtures, package metadata, or broad text searches.
5. Use `save_message` and `save_decision` for durable context when a decision or important symbol-level discussion should be available to future agents.

The goal is not to replace normal code inspection. The goal is to reduce token use during discovery, then inspect the exact source when detail is needed.

## Task Flows

### Bug Fix Flow

1. Run `index_status` for the current project.
2. Search prior context with `search_history` using the error, function name, or module name.
3. Use `search_symbols` or `lookup_symbol` to identify candidate symbols.
4. Check `get_decisions` for relevant project decisions.
5. Call `get_symbol_body` only for the selected symbol.
6. Use shell file reads only after the relevant file and line range are known.

### Code Review Flow

1. Use normal git commands to inspect changed files.
2. Use `reindex_changed_files` when the working tree changed and the MCP index may be stale.
3. Use `changed_symbols_risk` to map Git changes to symbols and linked decisions.
4. Use `changed_since` or `search_symbols` to map changed files to symbols.
5. Use `find_callers` for changed public functions or methods.
6. Use `get_decisions` to check whether changes conflict with prior decisions.
7. Read exact source only for changed symbols and their likely callers.

### Refactor Flow

1. Use `lookup_symbol` for the target symbol.
2. Use `find_callers` before editing.
3. Read bodies with `get_symbol_body` for the target and definite callers.
4. After editing, run tests and save important architectural decisions with `save_decision`.

### Regression Investigation Flow

1. Use `reconcile_index` after branch checkout, merge, rebase, or rewrite.
2. Use `changed_symbols_risk` to surface changed symbols with linked decisions.
3. Use `context_since_last_session` to find recent symbol changes.
4. Use `symbols_discussed_and_changed` to connect prior discussion to later edits.
5. Use `find_regression_candidates` when a date or timestamp is known.
6. Inspect exact source only after MCP narrows the candidate symbols.

## Verification

Before reporting changes as complete, run:

```powershell
npm test
```

For benchmark-impacting changes, also run:

```powershell
npm run benchmark
```

Run `npm run build` after changes that affect the MCP server runtime, because Codex is configured to launch the compiled `dist/src/index.js`.
