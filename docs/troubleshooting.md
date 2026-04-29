# Troubleshooting

## `index_status` Returns Zero Symbols

Check:

- `PROJECT_PATH` points to the repository root.
- The project has supported files: `.ts`, `.tsx`, `.js`, `.jsx`, or `.py`.
- Files are not under ignored directories such as `.git`, `node_modules`, or `dist`.
- Files are not excluded by secret detection.

## MCP Tool Is Not Available In Codex

Verify local setup first:

```powershell
npx -y -p codex-mcp-memory-server setup-codex-mcp-memory `
  --project-path "C:\path\to\your\repo" `
  --verify
```

Re-add the server:

```powershell
codex mcp add codex-mcp-memory-server `
  --env PROJECT_PATH="C:\path\to\your\repo" `
  --env PROJECT_ID="your-project-id" `
  -- npx -y codex-mcp-memory-server
```

Then restart the MCP client.

## Stale Results After Branch Change

Run:

```text
reconcile_index
reindex_changed_files
```

`reconcile_index` handles missing files and Git renames. `reindex_changed_files` updates changed, staged, and untracked source files.

## Too Much Output

Use compact tools first:

```text
search_symbols
lookup_symbol
changed_symbols_risk
```

Avoid `include_body=true` until you know the exact symbol.

## Caller Results Look Too Broad

`find_callers` returns:

- `definite_callers`: AST-based edges.
- `probable_callers`: fuzzy fallback matches.

Use `min_confidence` to filter lower-confidence fuzzy matches.

## SQLite DB Location

Default:

```text
~/.mcp-memory-server/memory.db
```

Override:

```powershell
$env:MCP_MEMORY_DB_PATH="C:\Users\you\.mcp-memory-server\memory.db"
```
