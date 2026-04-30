# Benchmarks

Run:

```powershell
npm run benchmark
```

Outputs:

```text
benchmark/results/latest.json
benchmark/results/latest.md
```

## Current Coverage

| Benchmark | Purpose |
| --- | --- |
| `symbol_discovery_callTool` | Classic broad text search versus compact MCP symbol discovery. |
| `ast_callers_vs_fuzzy_fallback` | AST definite caller detection versus fuzzy probable caller fallback. |
| `ast_import_resolver_precision` | Import/barrel resolver precision with same-name and local-shadowing checks. |
| `tsx_component_and_instance_graph` | TypeScript compiler API resolution for TSX component usage and function-return-typed instance method caller extraction. |
| `incremental_changed_file_reindex` | Git changed-file reindexing with blob hashes. |
| `language_depth_js_python_callers` | JavaScript symbol extraction plus Python same-file, async, from-import, re-export, module-import, inheritance, `super()`, instance-method caller extraction, and early Go caller extraction. |
| `bugfix_investigation_narrowing` | Noisy bug-fix discovery using compact symbols, conversation history, and decisions instead of broad text output. |
| `task_success_bugfix_root_symbol` | Confirms bug-fix discovery selects the correct root symbol, not only a smaller output. |
| `task_success_refactor_impact` | Confirms `find_callers` returns production refactor impact with low false positives. |
| `task_success_regression_narrowing` | Confirms changed symbols, prior discussion, and decisions narrow regression candidates. |
| `task_success_pr_risk_summary` | Confirms changed-symbol risk summaries surface linked decisions for PR review. |
| `task_success_discovery_workload` | Compares classic search and MCP-assisted discovery by files read, bodies read, token size, and false positives. |
| `performance_scale_10k_symbols` | Smoke-tests cold indexing, search, caller lookup, incremental reindex, DB growth, and broad changed-symbol risk on a synthetic 10k-symbol project. |
| `performance_monorepo_workspace` | Smoke-tests a synthetic workspace with many packages, ignored build output, search, caller lookup, incremental reindex, and changed-symbol risk. |

## Latest Result

The current measured discovery task is: find the `callTool` symbol in this repository.

```text
classic_tokens=6357
mcp_tokens=50
savings=99.2%
smaller_output=127.1x
```

Token counts are practical estimates using `characters / 4`. The benchmark measures discovery output size, not final answer quality.

## Task-Shaped Validation

The suite now includes task-shaped checks beyond raw output size:

- Bug fix investigation narrowing and root symbol selection.
- Refactor impact analysis through `find_callers`.
- TypeScript compiler API checks for TSX component usage and function-return-typed instance method caller extraction.
- Regression candidate narrowing through recent symbol and decision context.
- PR risk summary through changed symbols and linked decisions.
- Discovery workload comparison by files read, bodies read, token size, and false positives.
- Performance and scale regression smoke for a synthetic 1k-file, 10k-symbol project.
- Monorepo workspace scale smoke for a synthetic 20-package workspace with ignored generated output.
- Git edge cases such as checkout, merge, rename, delete, staged, and untracked states.
- Language-depth checks for Python package re-exports, async calls, module imports, inherited `self.method()`, `super().method()`, and local or `self.attr` constructor-assigned instance method calls.
- Early Go checks for function/type/method indexing, same-package calls, module import calls, local constructor-assigned instance method calls, receiver method calls, and embedded struct promoted method calls.
