# Codex MCP Memory Server Docs

Codex MCP Memory Server is a symbol-aware MCP server for coding agents. It indexes TypeScript, TSX, JavaScript, JSX, and Python project symbols, stores memory in SQLite, and returns compact discovery results before an agent reads full source.

## Start Here

- [Quickstart](quickstart.md)
- [Tools](tools.md)
- [Benchmarks](benchmarks.md)
- [Agent Flows](agent-flows.md)
- [Architecture](architecture.md)
- [Troubleshooting](troubleshooting.md)
- [Demo Transcript](demo.md)
- [Plugin Polish](plugin.md)
- [Roadmap](ROADMAP.md)

## Core Idea

Use MCP for the first pass:

1. Search compact symbol metadata.
2. Pick a `ref`, file, and line range.
3. Read full code only after the relevant symbol is identified.
4. Save durable decisions and conversation context for later agents.
