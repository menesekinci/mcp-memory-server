# Roadmap

This roadmap keeps the project focused. Each phase should improve either measured usefulness, caller accuracy, or agent adoption.

## Phase 0 - Published Core

- [x] SQLite-backed symbol memory.
- [x] TypeScript, TSX, JavaScript, JSX, and Python symbol indexing.
- [x] Compact discovery tools: `search_symbols`, `lookup_symbol`, `get_symbol_body`.
- [x] Conversation memory and decision memory tools.
- [x] npm package and `npx` launch path.
- [x] README hero and measured token-saving example.

## Phase 1 - Benchmarks And Agent Flows

- [x] Add a repeatable benchmark runner.
- [x] Measure classic text search versus compact MCP symbol search.
- [x] Add a first caller benchmark for AST definite callers versus fuzzy probable callers.
- [x] Emit machine-readable JSON and Markdown benchmark reports.
- [x] Strengthen `AGENTS.md` with task-specific MCP-first flows.

## Phase 2 - TypeScript AST Call Graph

- [x] Add first-pass TypeScript/TSX call extraction from `CallExpression` and `new` expressions.
- [x] Persist call edges in SQLite.
- [x] Use AST call edges in `find_callers`.
- [x] Keep fuzzy body matching as lower-confidence fallback.
- [x] Add import/export resolver for direct static imports.
- [x] Add same-file shadowing and local scope checks.
- [x] Add barrel/re-export handling.
- [x] Benchmark AST caller precision against fuzzy caller precision.

## Phase 3 - Git-Aware Incremental Indexing

- [x] Re-index only changed files when possible.
- [x] Track file blob hashes in `files.git_blob_sha`.
- [x] Reconcile symbols after checkout/merge/rewrite.
- [x] Improve rename/move handling.
- [x] Produce PR/session risk summaries from changed symbols and decisions.

## Phase 4 - Docs And Adoption

- [x] Split README details into `docs/quickstart.md`, `docs/tools.md`, `docs/benchmarks.md`, `docs/agent-flows.md`, and `docs/troubleshooting.md`.
- [x] Add a short demo transcript.
- [x] Add hosted docs workflow for GitHub Pages.
- [x] Add more before/after examples.

## Phase 5 - Language Depth Before Breadth

- [x] Strengthen TypeScript/TSX resolver quality.
- [x] Improve Python extraction and call references.
- [x] Add JavaScript support through a JavaScript parser path.
- [x] Evaluate Go only after TS/Python benchmarks are stable.

## Phase 6 - Plugin Polish

- [x] Codex plugin/skill packaging for MCP-first behavior.
- [x] Document optional VS Code UI direction for index status and symbol lookup.
- [x] One-command setup helpers for common MCP clients.
