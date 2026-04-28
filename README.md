![Codex MCP Memory Server hero](docs/assets/codex-mcp-memory-server-hero.png)

# Codex MCP Memory Server

Symbol-aware MCP memory server for Codex and coding agents.

It indexes TypeScript, TSX, and Python projects with tree-sitter, stores symbol metadata in SQLite, and exposes compact MCP tools for low-token project discovery.

## Why

Agents often spend a lot of tokens finding the right file or function before reading the code that matters. This server makes the first pass cheaper:

1. Search compact symbol metadata.
2. Pick the relevant symbol by `ref`, file, and line range.
3. Read the full symbol body only when needed.
4. Save durable messages and decisions for future agents.

## Measured Token Savings

![Token savings test infographic](docs/assets/token-savings-test.png)

We measured a simple discovery task in this repository: find the `callTool` symbol.

Classic text search returned every matching import, test call, helper reference, and the actual function:

```text
chars=4874
approx_tokens=1219
```

The MCP symbol search returned one compact symbol result:

```json
[{"ref":"eef296263a","name":"callTool","kind":"function","file":"src/server.ts","lines":"225-530","sig":"async function callTool(name: string, rawArgs: Record<string, any> = {})"}]
```

```text
chars=180
approx_tokens=45
```

That is roughly **96.3% fewer tokens** and a **27.1x smaller discovery output** before reading any source body. Token counts are practical estimates based on `characters / 4`; the important point is the relative size difference during the discovery phase.

## Quick Start With Codex

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

The minimal form indexes the process working directory and uses the default DB path:

```text
~/.mcp-memory-server/memory.db
```

## NPX

Run directly:

```powershell
npx -y codex-mcp-memory-server
```

Or with explicit project settings:

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
| `INSTALL_GIT_HOOKS` | unset | Set to `1` to install local git hooks. Disabled by default. |

## Tools

Discovery tools return compact results by default.

Example compact symbol result:

```json
{
  "ref": "eef296263a",
  "name": "callTool",
  "kind": "function",
  "file": "src/server.ts",
  "lines": "221-519",
  "sig": "async function callTool(...)"
}
```

Available tools:

- `index_status`: Count active, deleted, and excluded symbols.
- `search_symbols`: Search compact symbol metadata by partial name, kind, or file.
- `lookup_symbol`: Exact-name symbol lookup. Compact by default; supports `verbose` and `include_body`.
- `get_symbol_body`: Read full body by `symbol_id` or compact `ref`.
- `get_symbol_history`: Read git-derived symbol history. Body omitted unless `include_body` is true.
- `changed_since`: List symbols changed since a timestamp.
- `find_callers`: Find probable callers by symbol body match.
- `save_message`: Store a conversation message and link mentioned symbols.
- `search_history`: Full-text search saved messages.
- `save_decision`: Store a project decision and link symbols.
- `get_decisions`: Read saved decisions, optionally filtered by symbol/status.
- `symbols_discussed_and_changed`: Find discussed symbols that changed later.
- `find_regression_candidates`: Find changed symbols that were previously discussed.
- `context_since_last_session`: Summarize changes and active decisions since the last session.
- `forget_session`: Delete raw session data and optionally supersede derived decisions.

## Recommended Agent Flow

1. Start with `search_symbols`, `lookup_symbol`, `index_status`, `search_history`, or `get_decisions`.
2. Use compact output to identify a symbol, file, and line range.
3. Call `get_symbol_body` only for the selected symbol.
4. Fall back to shell search/read commands for docs, config, CSS, JSON, fixtures, and broad text searches.
5. Save important project decisions with `save_decision` so future agents can recover context.

See [AGENTS.md](AGENTS.md) for bug fix, review, refactor, and regression investigation flows.

## Benchmarks

Run the benchmark suite:

```powershell
npm run benchmark
```

It writes:

```text
benchmark/results/latest.json
benchmark/results/latest.md
```

Current benchmark coverage:

- Classic broad text search versus compact MCP symbol discovery.
- AST definite caller detection versus fuzzy probable caller fallback.
- AST import/barrel resolver precision with same-name and local-shadowing false-positive checks.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the phased roadmap.

## Local Development

```powershell
npm install
npm test
npm run build
```

Run from source:

```powershell
$env:PROJECT_PATH="C:\path\to\your\repo"
$env:PROJECT_ID="your-project-id"
npm start
```

Run the compiled server:

```powershell
node dist/src/index.js
```

## Publishing

The npm package name is:

```text
codex-mcp-memory-server
```

Before publishing:

```powershell
npm test
npm pack --dry-run
npm publish --access public
```

`prepack` builds `dist/src`, and `prepublishOnly` runs the full test suite.

## Notes

- This is a symbol memory/indexing server, not a replacement for source inspection.
- Compact outputs intentionally omit full code bodies to reduce token use during discovery.
- Full source remains available through `get_symbol_body`.
- The current caller search is fuzzy body matching, not a full semantic call graph.
