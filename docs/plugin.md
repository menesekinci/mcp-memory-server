# Plugin Polish

This repository includes a repo-local Codex plugin package:

```text
plugins/codex-mcp-memory-server
```

The plugin provides:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `mcp-first` skill guidance
- marketplace metadata under `.agents/plugins/marketplace.json`

## One-Command Codex Setup

After installing the npm package:

```powershell
npx -y -p codex-mcp-memory-server setup-codex-mcp-memory --help
```

Or run the setup helper directly:

```powershell
npx -y -p codex-mcp-memory-server setup-codex-mcp-memory `
  --project-path "C:\path\to\repo" `
  --project-id "my-project"
```

Dry-run:

```powershell
npx -y -p codex-mcp-memory-server setup-codex-mcp-memory --dry-run
```

The helper runs:

```text
codex mcp add codex-mcp-memory-server --env PROJECT_PATH=... --env PROJECT_ID=... --env MCP_MEMORY_DB_PATH=... -- npx -y codex-mcp-memory-server
```

## Plugin Files

| File | Purpose |
| --- | --- |
| `plugins/codex-mcp-memory-server/.codex-plugin/plugin.json` | Plugin metadata. |
| `plugins/codex-mcp-memory-server/.mcp.json` | MCP server definition. |
| `plugins/codex-mcp-memory-server/skills/mcp-first/SKILL.md` | Agent guidance. |
| `.agents/plugins/marketplace.json` | Repo-local marketplace entry. |

## VS Code UI

No VS Code extension is shipped yet. The intended future UI is intentionally small:

- show index status,
- run symbol lookup,
- open compact result locations,
- run `reindex_changed_files`.
