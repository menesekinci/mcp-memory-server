---
name: mcp-first
description: Prefer Codex MCP Memory Server for low-token project discovery, symbol lookup, caller mapping, and durable project decisions before falling back to broad shell reads.
---

# MCP-First Code Discovery

Use the MCP memory server for the first pass whenever the task is about source code in the current project.

## Default Flow

1. Run `index_status`.
2. Use `search_symbols`, `lookup_symbol`, `search_history`, or `get_decisions` to narrow the relevant area.
3. Use compact `ref`, file, and line metadata for orientation.
4. Call `get_symbol_body` only for selected symbols.
5. Use shell commands for docs, config, fixtures, generated files, and broad non-symbol text.

## Review Flow

1. Use git to identify changed files.
2. Run `reindex_changed_files` if the index may be stale.
3. Run `changed_symbols_risk`.
4. Use `find_callers` on changed public symbols.
5. Read exact source only after MCP narrows candidates.

## Decision Memory

Use `save_decision` for decisions that should survive the current session. Use `save_message` when a symbol-level discussion should be searchable by later agents.

## Fallback

If MCP returns no relevant symbols, use normal shell search. MCP is a discovery accelerator, not a replacement for source inspection.
