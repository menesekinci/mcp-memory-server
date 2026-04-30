# Benchmark Results

| Benchmark | Status | Classic Tokens | MCP Tokens | Savings % | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| symbol_discovery_callTool | pass | 5488 | 50 | 99.1 | Find the callTool symbol with broad text search versus compact MCP symbol search. |
| ast_callers_vs_fuzzy_fallback | pass | - | - | - | Definite callers: checkout; probable fuzzy callers: mentionOnly. |
| ast_import_resolver_precision | pass | - | - | - | Definite callers for barrel import: checkout; false positives: none. |
| tsx_component_and_instance_graph | pass | - | - | - | Instance method callers: App:ts_checker_symbol; component callers: App:ts_checker_jsx_component. |
| incremental_changed_file_reindex | pass | - | - | - | Changed files: 1; indexed: 1; skipped: 0; deleted: 0. |
| language_depth_js_python_callers | pass | - | - | - | JavaScript callers: checkout; Python same-file: checkout_py; Python from/re-export: checkout_external_py, checkout_reexport_py; Python module-import: checkout_module_py; Python instance-method: checkout_instance_py. |
| bugfix_investigation_narrowing | pass | 1573 | 375 | 76.2 | Narrow a noisy discount regression from broad text matches to compact symbol, history, and decision context. |
| task_success_bugfix_root_symbol | pass | 654 | 90 | 86.2 | Root symbol selected: true; classic files read: 16; MCP bodies read: 0. |
| task_success_refactor_impact | pass | - | - | - | Production callers: checkoutPrice, invoicePreview; false positives: none. |
| task_success_regression_narrowing | pass | - | - | - | Changed symbols: calculateCheckoutTax, stableCheckoutLabel; linked decisions: calculateCheckoutTax owns regional tax behavior; discussed changed: calculateCheckoutTax. |
| task_success_pr_risk_summary | pass | - | - | - | Changed symbols: publicCheckoutApi, internalAuditMarker; related decisions: publicCheckoutApi is an external contract. |
| task_success_discovery_workload | pass | 718 | 217 | 69.8 | Classic files read: 20; MCP bodies read: 1; classic false-positive files: 19. |
| performance_scale_10k_symbols | pass | - | - | - | Cold index: 5107ms for 1000 files/10001 symbols; search: 3.8ms; caller: 1.9ms; incremental: 122.1ms for 1 changed file; risk: 178.6ms for 26 changed files; db: 8.2MB. |
| performance_monorepo_workspace | pass | - | - | - | Cold index: 3507ms for 20 packages/800 files/4801 symbols; search: 2.4ms; caller: 1.3ms; incremental: 175.9ms for 1 changed file; risk: 110.1ms for 6 changed files; db: 12.5MB. |
