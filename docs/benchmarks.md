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
| `incremental_changed_file_reindex` | Git changed-file reindexing with blob hashes. |
| `language_depth_js_python_callers` | JavaScript symbol extraction and Python AST caller extraction. |
| `bugfix_investigation_narrowing` | Noisy bug-fix discovery using compact symbols, conversation history, and decisions instead of broad text output. |

## Latest Result

The current measured discovery task is: find the `callTool` symbol in this repository.

```text
classic_tokens=1936
mcp_tokens=45
savings=97.7%
smaller_output=43.0x
```

Token counts are practical estimates using `characters / 4`. The benchmark measures discovery output size, not final answer quality.

## v0.3 Direction

The suite is moving from pure output-size checks toward task-shaped validation:

- Bug fix investigation narrowing.
- Refactor impact analysis through `find_callers`.
- Regression candidate narrowing through recent symbol and decision context.
- Git edge cases such as checkout, merge, rename, delete, staged, and untracked states.
