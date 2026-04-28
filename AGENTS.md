# Agent Guidance

## Project Identity

Codex MCP Memory Server is a symbol-aware MCP server for Codex and coding agents. Its purpose is to reduce token-heavy project discovery by indexing code symbols, call relationships, conversation history, and durable project decisions, then exposing compact MCP tools that help agents find the right source area before reading full code.

The project is not meant to replace source inspection. It is meant to make the discovery phase cheaper and more accurate, then let the agent inspect exact source only after the relevant symbol, file, or line range is known.

## Technology Stack

- Runtime: Node.js with TypeScript.
- Protocol: Model Context Protocol over stdio.
- Indexing: tree-sitter for TypeScript, TSX, JavaScript, JSX, and Python.
- Storage: SQLite through `better-sqlite3`.
- Watch mode: `chokidar`.
- Git intelligence: changed-file indexing, blob hashes, rename reconciliation, history parsing, and risk summaries.
- Distribution: npm package `codex-mcp-memory-server` with `npx` support.
- Plugin/adoption: repo-local Codex plugin metadata, MCP-first skill guidance, and setup helper.

## Current Product Positioning

- The package is at v0.2.0.
- Phase 0-6 are complete: published core, benchmarks, TS/JS call graph, Git-aware incremental indexing, docs/adoption, language depth, and plugin polish.
- The active direction is v0.3 real-world validation.
- TS/JS caller precision is the strongest path. Python is supported but shallower and currently focuses on same-file AST call references.

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

## Active v0.3 Validation Backlog

Keep this section aligned with `TODO.md` as the live task list for hardening the project. When an item is completed, remove it from this backlog and add a short note under `Completed Validation Notes` explaining what changed and why.

Recommended remaining order:

1. NPX runtime smoke tests.
2. Performance and scale tests.
3. Dogfooding report.

### Performance And Scale

- [ ] Cold index timing for a synthetic 1k-file project.
- [ ] Search/caller latency for roughly 10k symbols.
- [ ] Incremental reindex timing after a small file change in a larger project.
- [ ] Database size growth for repeated indexing and history records.
- [ ] `changed_symbols_risk` latency on a broad working-tree diff.

### Cross-Platform And Release

- [ ] `npx -y codex-mcp-memory-server` smoke test.
- [ ] Release checklist covers version bump, changelog/release notes, tag, GitHub release, npm publish, and post-publish install verification.

### Dogfooding

- [ ] Use this MCP on this repository for at least three real maintenance tasks.
- [ ] Record which MCP tools were used, how many files/bodies were read, and what was missing.
- [ ] Convert repeated dogfooding pain points into tool contract tests or benchmark scenarios.

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
- Tool contract tests now cover compact body omission, compact ref resolution, invalid or missing symbol body identifiers, deleted-symbol hiding, test caller filtering, and confidence filtering.
- Project isolation contract tests now cover core symbol, history, decision, caller, context, changed-symbol, discussion, and regression tools across two project IDs with same-name symbols.
- Database compatibility tests now create a v0.1-style SQLite database in a subprocess, run current `initDb()` twice, verify new columns/tables exist, and confirm legacy symbol, message, and decision records survive migration.
- Task-success benchmarks now cover bug-fix root symbol selection, refactor impact analysis, regression narrowing, PR risk summaries, and discovery workload comparison. This keeps v0.3 validation focused on useful task outcomes, not only smaller discovery output.
- CI now runs on Windows, Ubuntu, and macOS with `npm ci`, `npm test`, `npm run benchmark`, `npm run build`, and `npm pack --dry-run`; release smoke also packages the tarball and runs the setup helper through `npx -p`.

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
