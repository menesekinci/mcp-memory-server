# Benchmark Results

| Benchmark | Status | Classic Tokens | MCP Tokens | Savings % | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| symbol_discovery_callTool | pass | 4495 | 45 | 99 | Find the callTool symbol with broad text search versus compact MCP symbol search. |
| ast_callers_vs_fuzzy_fallback | pass | - | - | - | Definite callers: checkout; probable fuzzy callers: mentionOnly. |
| ast_import_resolver_precision | pass | - | - | - | Definite callers for barrel import: checkout; false positives: none. |
| tsx_component_and_instance_graph | pass | - | - | - | Instance method callers: App:ts_checker_symbol; component callers: App:ts_checker_jsx_component. |
| incremental_changed_file_reindex | pass | - | - | - | Changed files: 1; indexed: 1; skipped: 0; deleted: 0. |
| language_depth_js_python_callers | pass | - | - | - | JavaScript callers: checkout; Python same-file: checkout_py; Python from/re-export: checkout_external_py, checkout_reexport_py; Python module-import: checkout_module_py; Python instance-method: checkout_instance_py. |
| bugfix_investigation_narrowing | pass | 1573 | 327 | 79.2 | Narrow a noisy discount regression from broad text matches to compact symbol, history, and decision context. |
| task_success_bugfix_root_symbol | pass | 654 | 85 | 87 | Root symbol selected: true; classic files read: 16; MCP bodies read: 0. |
| task_success_refactor_impact | pass | - | - | - | Production callers: checkoutPrice, invoicePreview; false positives: none. |
| task_success_regression_narrowing | pass | - | - | - | Changed symbols: calculateCheckoutTax, stableCheckoutLabel; linked decisions: calculateCheckoutTax owns regional tax behavior; discussed changed: calculateCheckoutTax. |
| task_success_pr_risk_summary | pass | - | - | - | Changed symbols: publicCheckoutApi, internalAuditMarker; related decisions: publicCheckoutApi is an external contract. |
| task_success_discovery_workload | pass | 718 | 152 | 78.8 | Classic files read: 20; MCP bodies read: 1; classic false-positive files: 19. |
| performance_scale_10k_symbols | pass | - | - | - | Cold index: 5346ms for 1000 files/10001 symbols; search: 5ms; caller: 2.3ms; incremental: 143.1ms for 1 changed file; risk: 1512.6ms for 26 changed files; db: 7.3MB. |
| performance_monorepo_workspace | pass | - | - | - | Cold index: 4164ms for 20 packages/800 files/4801 symbols; search: 1.9ms; caller: 1ms; incremental: 220.3ms for 1 changed file; risk: 515.8ms for 6 changed files; db: 11.1MB. |
