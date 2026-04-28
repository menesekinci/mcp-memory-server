# Benchmark Results

| Benchmark | Status | Classic Tokens | MCP Tokens | Savings % | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| symbol_discovery_callTool | pass | 1219 | 45 | 96.3 | Find the callTool symbol with broad text search versus compact MCP symbol search. |
| ast_callers_vs_fuzzy_fallback | pass | - | - | - | Definite callers: checkout; probable fuzzy callers: mentionOnly. |
| ast_import_resolver_precision | pass | - | - | - | Definite callers for barrel import: checkout; false positives: none. |
