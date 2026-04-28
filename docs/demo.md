# Demo Transcript

This is a text demo of the intended agent workflow. No source body is read until the compact MCP result identifies the symbol.

## Task

Find the `callTool` implementation.

## Classic Search

```text
search for "callTool"
-> many matches across server, tests, benchmark scripts, docs, and examples
-> approx 1514 discovery tokens in the current benchmark
```

## MCP Search

```text
search_symbols({ "project_id": "mcp-memory-server", "query": "callTool", "limit": 5 })
```

Result:

```json
[
  {
    "ref": "eef296263a",
    "name": "callTool",
    "kind": "function",
    "file": "src/server.ts",
    "lines": "225-530",
    "sig": "async function callTool(name: string, rawArgs: Record<string, any> = {})"
  }
]
```

Then read only the selected symbol:

```text
get_symbol_body({ "project_id": "mcp-memory-server", "ref": "eef296263a" })
```

## Outcome

```text
classic discovery: ~1514 tokens
MCP discovery: ~45 tokens
savings: 97.0%
```

