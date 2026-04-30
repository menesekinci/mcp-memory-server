# Agent Guidance

## Project Identity

Codex MCP Memory Server is a symbol-aware MCP server for Codex and coding agents. Its purpose is to reduce token-heavy project discovery by indexing code symbols, call relationships, conversation history, and durable project decisions, then exposing compact MCP tools that help agents find the right source area before reading full code.

The project is not meant to replace source inspection. It is meant to make the discovery phase cheaper and more accurate, then let the agent inspect exact source only after the relevant symbol, file, or line range is known.

## Technology Stack

- Runtime: Node.js with TypeScript.
- Protocol: Model Context Protocol over stdio.
- Indexing: tree-sitter for TypeScript, TSX, JavaScript, JSX, Python, and Go.
- Storage: SQLite through `better-sqlite3`.
- Watch mode: `chokidar`.
- Git intelligence: changed-file indexing, blob hashes, rename reconciliation, history parsing, and risk summaries.
- Distribution: npm package `codex-mcp-memory-server` with `npx` support.
- Plugin/adoption: repo-local Codex plugin metadata, MCP-first skill guidance, and setup helper.

## Current Product Positioning

- The package is at v0.4.2.
- Phase 0-6 are complete: published core, benchmarks, TS/JS call graph, Git-aware incremental indexing, docs/adoption, language depth, and plugin polish.
- v0.3 real-world validation has been completed and folded into the current hardening baseline.
- The active direction is v0.4.x / v1.0 hardening: real-repository validation, stronger tool contracts, performance stability, setup verification, and release discipline.
- TS/JS caller precision is the strongest path, including import/barrel resolution, selective TypeScript compiler API symbol resolution, simple instance method calls, and TSX/JSX component usage. Python is supported with symbol discovery, async functions, same-file calls, relative/module imports, dotted module calls, package re-exports, `self.method()`, same-file and imported-base inherited `self.method()`, `super().method()`, and local or `self.attr` constructor-assigned instance method calls. Go support has started with function/type/method indexing, same-package calls, `go.mod` and `go.work` module import calls, local constructor-assigned instance method calls, receiver method calls, embedded struct promoted method calls, and generated Go file exclusion.

## Source of Truth

- Package and release version: `package.json`.
- MCP tool contracts: `src/server.ts`.
- SQLite schema and migrations: `src/db.ts`.
- Indexing and Git reconciliation behavior: `src/indexer.ts`.
- Call graph behavior: `src/call-graph.ts`.
- Architecture overview: `docs/architecture.md`.
- Product direction: `docs/VISION.md` and `docs/V1_CRITERIA.md`.
- Release process: `docs/release.md`.

## Known Sharp Edges

- Secret filtering is best-effort. Do not index repositories containing embedded credentials unless body storage and scan behavior are acceptable for that environment. Use `.mcp-memoryignore` and `MCP_MEMORY_DISABLE_BODY_STORAGE=1` for sensitive projects.
- Compact refs are now stored and indexed in SQLite, with a legacy hash fallback for older rows.
- `save_message` auto-creates a session when none is provided, but durable project memory is still better when agents pass a stable session ID for a real work session.
- Symbol identity is class/module scoped for indexed symbols, but semantic caller disambiguation should still be treated with confidence scores when same-name methods exist in complex dynamic patterns.

## Memory MCP Usage

When working in this repository, prefer the local MCP memory server for the first pass of project discovery.

Recommended flow:

1. Use MCP tools such as `index_status`, `search_symbols`, `lookup_symbol`, `search_history`, and `get_decisions` to narrow the relevant area first.
2. Use compact MCP results for orientation. They intentionally omit full bodies and long absolute paths.
3. Only call `get_symbol_body` or read files with shell commands after the relevant symbol, file, or line range is identified.
4. Use normal shell search/read commands for docs, config, JSON, CSS, fixtures, package metadata, or broad non-symbol searches.
5. Use `save_message` and `save_decision` for durable context when a decision or important symbol-level discussion should be available to future agents.

## Task Flows

### Bug Fix Flow

1. Run `index_status` for the current project.
2. Search prior context with `search_history` using the error, function name, or module name.
3. Use `search_symbols` or `lookup_symbol` to identify candidate symbols.
4. Check `get_decisions` for relevant project decisions.
5. Call `get_symbol_body` only for the selected symbol.
6. Use shell file reads only after the relevant file and line range are known.

### Code Review Flow

1. Use normal git commands to inspect changed files.
2. Use `reindex_changed_files` when the working tree changed and the MCP index may be stale.
3. Use `changed_symbols_risk` to map Git changes to symbols and linked decisions.
4. Use `changed_since` or `search_symbols` to map changed files to symbols.
5. Use `find_callers` for changed public functions or methods.
6. Use `get_decisions` to check whether changes conflict with prior decisions.
7. Read exact source only for changed symbols and their likely callers.

### Refactor Flow

1. Use `lookup_symbol` for the target symbol.
2. Use `find_callers` before editing.
3. Read bodies with `get_symbol_body` for the target and definite callers.
4. After editing, run tests and save important architectural decisions with `save_decision`.

### Regression Investigation Flow

1. Use `reconcile_index` after branch checkout, merge, rebase, or rewrite.
2. Use `changed_symbols_risk` to surface changed symbols with linked decisions.
3. Use `context_since_last_session` to find recent symbol changes.
4. Use `symbols_discussed_and_changed` to connect prior discussion to later edits.
5. Use `find_regression_candidates` when a date or timestamp is known.
6. Inspect exact source only after MCP narrows the candidate symbols.

## Active v0.4 / v1.0 Hardening Backlog

The original low-token MCP discovery goal has been reached. The active direction is now hardening the project into a more reliable v0.4/v1.0 candidate.

- More real-repository dogfooding, with findings recorded in `docs/dogfooding.md` and converted into tests or docs updates.
- More edge-case tests for Git reconciliation, caller resolution, project isolation, database migration, and MCP tool contracts.
- Better onboarding and setup verification so users can confirm `npx`, Codex MCP registration, project path, DB path, and runtime readiness quickly.
- Deeper Python and additional language semantic resolution after TS/Python benchmarks stay stable.
- Release polish before v0.4/v1.0, including changelog, package contents review, install smoke, docs review, and version bump discipline.

When an item is completed, move its concrete result into Completed Validation Notes instead of leaving stale task text here.

## Completed Validation Notes

- v0.3 validation started by adding `bugfix_investigation_narrowing`, a task-shaped benchmark that combines compact symbol search, conversation history, and project decisions. This was added to move benchmark coverage beyond pure output-size checks.
- Reconciliation now scans supported source files and compares blob hashes so clean branch checkout or rewrite states can update same-path symbol bodies even when `git diff HEAD` is empty.
- Integration tests now cover same-path content changes after branch checkout, because stale symbol bodies after checkout would make the MCP unreliable during real agent work.
- Git edge-case tests now cover branch checkout deletion/restoration so symbols are marked deleted on one branch and reactivated when restored by checkout.
- Git rename tests now cover move plus content change so decision links survive while the moved symbol body is refreshed.
- Rename fallback tests now cover delete-and-add behavior when Git does not report a rename, ensuring the old symbol is deleted and the replacement path is indexed.
- Generated output under `build`, `dist`, `coverage`, `node_modules`, and `.git` is ignored by changed-file and reconciliation scans to avoid indexing build artifacts.
- Merge reconciliation tests now cover same-file changes on both branches, including a conflict-resolution path, so final merged symbol bodies are reindexed correctly.
- History rewrite tests now cover amended commits so same-path symbol bodies refresh after rewrite-style changes.
- Large branch switch tests now remove and replace a batch of files to ensure stale symbols are deleted and replacement symbols become active.
- Tool contract tests now cover tool listing, compact body omission, compact ref resolution, kind-filtered verbose search, symbol history body gating, invalid or missing symbol body identifiers, unknown tool errors, missing caller targets, deleted-symbol hiding, test caller filtering, and confidence filtering.
- Project isolation contract tests now cover core symbol, history, decision, caller, context, changed-symbol, discussion, and regression tools across two project IDs with same-name symbols.
- Database compatibility tests now create a v0.1-style SQLite database in a subprocess, run current `initDb()` twice, verify new columns/tables exist, and confirm legacy symbol, message, and decision records survive migration.
- Task-success benchmarks now cover bug-fix root symbol selection, refactor impact analysis, regression narrowing, PR risk summaries, and discovery workload comparison. This keeps v0.3 validation focused on useful task outcomes, not only smaller discovery output.
- CI now runs on Windows, Ubuntu, and macOS with `npm ci`, `npm test`, `npm run benchmark`, `npm run build`, and `npm pack --dry-run`; release smoke also packages the tarball and runs the setup helper through `npx -p`.
- NPX runtime smoke is now covered by `npm run smoke:npx`, which packs the project, launches `codex-mcp-memory-server` through `npx -p`, waits for the stdio server ready log, and shuts it down.
- Performance and scale validation now runs as `performance_scale_10k_symbols`, covering cold indexing for 1k files/10k symbols, search latency, caller latency, incremental reindex, database growth, and broad changed-symbol risk latency.
- Dogfooding findings were recorded in `docs/dogfooding.md`, and release steps were moved into `docs/release.md` so v0.3 validation tracking stays complete but readable.
- Python language depth now covers package `__init__.py` re-export chains and simple constructor-assigned instance method calls, with integration and benchmark coverage added so `find_callers` can resolve practical Python package call paths beyond same-file references.
- Python language depth now also covers `async def`, async call sites, dotted module imports such as `package.module.function()`, and same-file inherited `self.method()` calls, with integration and benchmark coverage.
- Python language depth now covers imported-base inherited `self.method()` calls, `super().method()` calls, and `self.attr = Service()` instance method calls, with integration and benchmark coverage before moving on to Go/Rust.
- Go language depth has started with `tree-sitter-go`, `.go` indexing, function/type/receiver-method symbols, same-package function callers, `go.mod` module import callers, local constructor-assigned instance method callers, receiver method callers, and embedded struct promoted method callers, with integration, benchmark, and real-repository dogfood coverage.
- Go language depth now covers `go.work` workspace import callers and excludes generated Go files with the standard `Code generated ... DO NOT EDIT.` marker, with integration and benchmark coverage so multi-module fixtures stay useful without generated-code noise.
- TS/TSX language depth now covers simple constructor/type-annotation instance method calls and TSX/JSX component usage graph edges, with integration and benchmark coverage added so component callers and class-method callers are visible through `find_callers`.
- TypeScript compiler API resolution now runs selectively for semantic cases such as imported symbols, JSX components, and typed/member calls. This resolves function-return-typed instance method calls while preserving the tree-sitter fast path for plain same-file code so the 10k-symbol scale benchmark remains stable.
- Monorepo performance validation now includes `performance_monorepo_workspace`, a synthetic 20-package workspace benchmark covering cold indexing, symbol search, caller lookup, incremental reindex, changed-symbol risk, database growth, and ignored generated output.
- Git risk tests now cover `changed_symbols_risk` deleted-symbol visibility, including the default hidden behavior and `include_deleted` opt-in.
- Ubuntu CI coverage now waits for every AST call-graph fixture symbol before assertions, removing a platform-specific watcher ordering race where imported targets could be checked before indexing finished.
- Benchmark CI now uses a longer symbol-index wait window so slower macOS runners do not fail benchmark scenarios before watcher-driven indexing completes.
- v0.4.2 hardening corrected AGENTS/README version drift, made MCP server metadata read from `package.json`, added auto-created sessions for `save_message`, stores compact refs in SQLite for indexed lookups, and scopes symbol identity by qualified name so same-file same-name methods do not overwrite each other.
- Product vision and v1.0 criteria were formalized around freshness, compact ranked context, small agent-facing tools, memory quality, real-repository validation, privacy controls, and setup/doctor polish.
- P0 freshness contract now exposes project-level index health, per-symbol freshness metadata, stale/missing/unindexed/excluded counts, and stale-before/reconcile-after test coverage so agents can detect stale working-tree changes before trusting compact discovery results.
- Phase 10 now has a first high-level agent context layer: `code_search` ranks compact matches with `why_this_matched`, `read_context` returns one focused symbol packet, and `impact_analysis` summarizes callers, freshness, and linked-decision risk without forcing agents through several low-level calls.
- Phase 10 token budgets are now first-class on high-level context tools through `max_tokens`; outputs include budget metadata and trim optional context before exceeding the requested budget.
- Phase 11 memory quality now marks decisions as `current`, `needs_review`, or `superseded`; linked symbol changes trigger review metadata, `changed_symbols_risk` marks affected decisions under review, and replacement decisions can set `supersedes_decision_id`.
- Phase 12 real-repository dogfooding now runs through `npm run dogfood:real` against Express, Zod, Typer, Click, Requests, Flask, Axios, p-limit, and Cobra. It records reports under `dogfood/results/` and converted real findings into project-relative path ranking, quieter TypeScript checker resolution, isolated dogfood databases, and Go real-repository smoke coverage.
- v1.0 setup/privacy polish now includes `mcp-memory-doctor` for local readiness checks and `MCP_MEMORY_DISABLE_BODY_STORAGE=1` for metadata-only indexing when source bodies should not be persisted in SQLite.
- Additional hardening tests now cover doctor failure reports, privacy-mode `read_context` and git-history body behavior, compact `changed_since`, and tiny-budget disclosure through `budget.over_budget`.
- `.mcp-memoryignore`, expanded best-effort secret detection, and malformed tool argument tests now cover sensitive/generated path exclusion and invalid-input failures without crashing the MCP server.

## Verification

Before reporting code changes as complete, run:

```powershell
npm test
```

For benchmark-impacting changes, also run:

```powershell
npm run benchmark
```

Run `npm run build` after changes that affect the MCP server runtime, because Codex is configured to launch the compiled `dist/src/index.js`.
