# Benchmark Results

| Benchmark | Status | Classic Tokens | MCP Tokens | Savings % | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| symbol_discovery_callTool | pass | 1794 | 45 | 97.5 | Find the callTool symbol with broad text search versus compact MCP symbol search. |
| ast_callers_vs_fuzzy_fallback | pass | - | - | - | Definite callers: checkout; probable fuzzy callers: mentionOnly. |
| ast_import_resolver_precision | pass | - | - | - | Definite callers for barrel import: checkout; false positives: none. |
| incremental_changed_file_reindex | pass | - | - | - | Changed files: 1; indexed: 1; skipped: 0; deleted: 0. |
| language_depth_js_python_callers | pass | - | - | - | JavaScript callers: checkout; Python callers: checkout_py. |
