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

## Latest Result

The current measured discovery task is: find the `callTool` symbol in this repository.

```text
classic_tokens=1794
mcp_tokens=45
savings=97.5%
smaller_output=39.9x
```

Token counts are practical estimates using `characters / 4`. The benchmark measures discovery output size, not final answer quality.
