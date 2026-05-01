# Quickstart

## Add To Codex

Use the setup helper:

```powershell
npx -y -p codex-mcp-memory-server setup-codex-mcp-memory `
  --project-path "C:\path\to\your\repo" `
  --project-id "your-project-id"
```

Verify the setup inputs before registering the MCP server:

```powershell
npx -y -p codex-mcp-memory-server setup-codex-mcp-memory `
  --project-path "C:\path\to\your\repo" `
  --project-id "your-project-id" `
  --verify
```

The verification checks the project path, database directory, `npx`, `codex`, and prints the exact install command.

Run a standalone readiness check any time:

```powershell
npx -y -p codex-mcp-memory-server mcp-memory-doctor `
  --project-path "C:\path\to\your\repo" `
  --db-path "C:\Users\you\.mcp-memory-server\memory.db"
```

For CI or scripted setup checks, use JSON output:

```powershell
npx -y -p codex-mcp-memory-server mcp-memory-doctor --project-path "." --json
```

Or add the MCP server manually:

```powershell
codex mcp add codex-mcp-memory-server `
  --env PROJECT_PATH="C:\path\to\your\repo" `
  --env PROJECT_ID="your-project-id" `
  --env MCP_MEMORY_DB_PATH="C:\Users\you\.mcp-memory-server\memory.db" `
  -- npx -y codex-mcp-memory-server
```

Minimal form:

```powershell
codex mcp add codex-mcp-memory-server -- npx -y codex-mcp-memory-server
```

The minimal form indexes the process working directory and uses:

```text
~/.mcp-memory-server/memory.db
```

## Run With NPX

```powershell
npx -y codex-mcp-memory-server
```

With explicit project settings:

```powershell
$env:PROJECT_PATH="C:\path\to\your\repo"
$env:PROJECT_ID="your-project-id"
$env:MCP_MEMORY_DB_PATH="C:\Users\you\.mcp-memory-server\memory.db"
npx -y codex-mcp-memory-server
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PROJECT_PATH` | Current working directory | Project to index and watch. |
| `PROJECT_ID` | Basename of `PROJECT_PATH` | Logical project key used in SQLite records. |
| `MCP_MEMORY_DB_PATH` | `~/.mcp-memory-server/memory.db` | SQLite database path. |
| `MCP_MEMORY_DISABLE_BODY_STORAGE` | unset | Set to `1` to store symbol metadata/signatures without persisting source bodies. |
| `MCP_MEMORY_GO_BUILD_TAGS` | unset | Extra comma/space-separated Go build tags used when deciding which Go files are active. |
| `GOOS` / `GOARCH` / `CGO_ENABLED` | host platform | Optional Go build context overrides for Go file suffixes and build constraints. |
| `INSTALL_GIT_HOOKS` | unset | Set to `1` to install local git hooks. Disabled by default. |

## Verify

Before adding the server, use setup verification:

```powershell
npx -y -p codex-mcp-memory-server setup-codex-mcp-memory --verify
```

After adding or upgrading the package, run:

```powershell
npx -y -p codex-mcp-memory-server mcp-memory-doctor --project-path "C:\path\to\your\repo"
```

Ask the MCP client to run:

```text
index_status
```

Expected result shape:

```json
{
  "status": "ready",
  "total_symbols": 123,
  "deleted_symbols": 0,
  "indexed_files": 18,
  "hashed_files": 18,
  "excluded_files": 0
}
```
