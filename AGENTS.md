# Agent Guidance

## Memory MCP Usage

When working in this repository, prefer the local MCP memory server for the first pass of project discovery.

Recommended flow:

1. Use MCP tools such as `search_symbols`, `lookup_symbol`, `index_status`, `search_history`, and `get_decisions` to narrow the relevant area first.
2. Use compact MCP results for orientation. They intentionally omit full bodies and long absolute paths.
3. Only call `get_symbol_body` or read files with shell commands after the relevant symbol, file, or line range is identified.
4. Use normal shell search/read commands for non-symbol content such as docs, config, JSON, CSS, fixtures, package metadata, or broad text searches.
5. Use `save_message` and `save_decision` for durable context when a decision or important symbol-level discussion should be available to future agents.

The goal is not to replace normal code inspection. The goal is to reduce token use during discovery, then inspect the exact source when detail is needed.

## Verification

Before reporting changes as complete, run:

```powershell
npm test
```

Run `npm run build` after changes that affect the MCP server runtime, because Codex is configured to launch the compiled `dist/src/index.js`.
