# TODO

This file is the working checklist for v0.3 real-world validation. Keep it aligned with `AGENTS.md`.

When an item is completed:

1. Remove it from the active section.
2. Add a short note under `Completed Notes` explaining what changed and why.
3. Keep the note factual and brief so project tracking stays readable.

## Active v0.3 Validation

No active v0.3 validation items remain. Add new items here only when a concrete gap is found during real repository use.

## Completed Notes

- v0.3 validation started with `bugfix_investigation_narrowing`, a task-shaped benchmark that combines compact symbol search, conversation history, and project decisions.
- Reconciliation scans supported source files and compares blob hashes so clean branch checkout or rewrite states can update same-path symbol bodies even when `git diff HEAD` is empty.
- Integration tests cover same-path content changes after branch checkout to prevent stale symbol bodies during real agent work.
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
- Task-success benchmarks now cover bug-fix root symbol selection, refactor impact analysis, regression narrowing, PR risk summaries, and discovery workload comparison so v0.3 measures useful task outcomes, not just smaller text output.
- CI now runs on Windows, Ubuntu, and macOS with `npm ci`, `npm test`, `npm run benchmark`, `npm run build`, and `npm pack --dry-run`; release smoke also packages the tarball and runs the setup helper through `npx -p`.
- NPX runtime smoke is now covered by `npm run smoke:npx`, which packs the project, launches `codex-mcp-memory-server` through `npx -p`, waits for the stdio server ready log, and shuts it down.
- Performance and scale validation now runs as `performance_scale_10k_symbols`, covering cold indexing for 1k files/10k symbols, search latency, caller latency, incremental reindex, database growth, and broad changed-symbol risk latency.
- Dogfooding findings were recorded in `docs/dogfooding.md`, and release steps were moved into `docs/release.md` so v0.3 validation tracking stays complete but readable.
