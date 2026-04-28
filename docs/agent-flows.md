# Agent Flows

These flows make MCP usage repeatable instead of relying on an agent remembering a vague preference.

## Default Discovery

1. Run `index_status`.
2. Use `search_symbols`, `lookup_symbol`, `search_history`, or `get_decisions`.
3. Use compact results to identify the target symbol.
4. Call `get_symbol_body` only for selected symbols.
5. Fall back to shell file reads for non-symbol content.

## Bug Fix

1. Run `index_status`.
2. Search prior context with `search_history` using the error, function, or module name.
3. Use `search_symbols` or `lookup_symbol` to identify candidates.
4. Check `get_decisions`.
5. Use `find_callers` for changed public functions.
6. Read exact source only after MCP narrows the candidates.

## Code Review

1. Inspect changed files with git.
2. Run `reindex_changed_files` if the index may be stale.
3. Run `changed_symbols_risk`.
4. Use `find_callers` for changed public functions or methods.
5. Read exact source for changed symbols and likely callers.

## Refactor

1. Use `lookup_symbol` for the target.
2. Use `find_callers` before editing.
3. Read bodies with `get_symbol_body`.
4. Save architectural decisions with `save_decision`.

## Regression Investigation

1. Run `reconcile_index` after checkout, merge, rebase, or rewrite.
2. Run `changed_symbols_risk`.
3. Use `context_since_last_session`.
4. Use `symbols_discussed_and_changed`.
5. Use `find_regression_candidates` when a date is known.

