# Roadmap

This roadmap keeps the project focused. Each phase should improve either measured usefulness, caller accuracy, or agent adoption.

See also [Product Vision](VISION.md) and [v1.0 Criteria](V1_CRITERIA.md). The current strategic direction is to turn the working MCP server into a freshness-aware, low-noise, high-trust context layer for agents.

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

## Phase 7 - Real-World Validation

- [x] Add a task-shaped bug investigation benchmark that combines symbol search, history, and decisions.
- [x] Reconcile same-path content changes after clean branch checkout by scanning source files and comparing hashes.
- [x] Add checkout reconciliation coverage to integration tests.
- [x] Add merge/rebase/rewrite integration fixtures with conflicting branch histories.
- [x] Add agent task-success benchmarks for bug fix, refactor impact, regression narrowing, and PR risk summary.
- [x] Dogfood the MCP on this repository and record missing tool affordances before widening the feature surface.

## Phase 8 - Language Depth

- [x] Deepen Python caller extraction with relative from-import aliases.
- [x] Deepen Python caller extraction with module import aliases.
- [x] Add Python `self.method()` caller extraction.
- [x] Add Python package `__init__.py` re-export handling.
- [x] Add Python simple constructor-assigned instance method resolution beyond `self`.
- [x] Add lightweight TypeScript constructor/type-annotation instance method resolution.
- [x] Add TSX/JSX component usage graph.
- [x] Add TypeScript compiler API based type-aware resolution.

## Phase 9 - Freshness And Trust Contract

- [x] Add project-level freshness reporting to `index_status`.
- [x] Add per-symbol freshness metadata to discovery and body reads.
- [x] Surface stale, missing, unindexed, and excluded files in machine-readable output.
- [x] Add stale detection tests before and after reindex/reconcile.
- [x] Document freshness semantics in tools and architecture docs.

## Phase 10 - Agent-Facing Context Layer

- [x] Design a small high-level tool surface over existing low-level tools.
- [x] Add ranked `code_search` with `why_this_matched`.
- [x] Add `read_context` packets for body, callers, tests, decisions, history, and freshness.
- [x] Add `impact_analysis` for target-symbol and changed-file flows.
- [x] Keep compact token budgets as first-class inputs.

## Phase 11 - Memory Quality

- [x] Add stale/needs-review decision semantics tied to changed symbols.
- [x] Distinguish current decisions from historical context in memory reads.
- [x] Add memory conflict and supersession tests.

## Phase 12 - Real Repository Proof

- [ ] Dogfood on at least five real repositories.
- [ ] Record token savings, files read, body reads, stale result rate, false positives, and task success.
- [ ] Convert dogfooding findings into tests, docs, or tool contract changes.
