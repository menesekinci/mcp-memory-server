# TODO

This file is the working checklist for v0.3 real-world validation. Keep it aligned with `AGENTS.md`.

When an item is completed:

1. Remove it from the active section.
2. Add a short note under `Completed Notes` explaining what changed and why.
3. Keep the note factual and brief so project tracking stays readable.

## Active v0.3 Validation

### Git Edge-Case Tests

- [ ] Merge scenario where the same file changes on both branches.
- [ ] Rebase or history rewrite reconciliation.
- [ ] Large branch switch does not leave stale active symbols.

### Task-Success Benchmarks

- [ ] Bug fix task success: correct root symbol is selected, not just fewer tokens.
- [ ] Refactor impact analysis: public function callers are found with low false positives.
- [ ] Regression narrowing: changed symbols and prior decisions identify likely candidates.
- [ ] PR risk summary: changed symbols and decision conflicts are surfaced compactly.
- [ ] Compare MCP-assisted discovery against classic shell search by files read, bodies read, token size, and false positives.

### Tool Contract Tests

- [ ] Compact outputs never leak full symbol bodies.
- [ ] Compact `ref` values resolve reliably through `get_symbol_body`.
- [ ] Invalid `ref` and missing `symbol_id` cases return useful errors.
- [ ] Every tool preserves `project_id` isolation.
- [ ] Deleted symbols are hidden unless a tool explicitly opts into deleted results.
- [ ] `include_tests=false` filters AST and fuzzy callers consistently.
- [ ] `min_confidence` filtering works for definite and probable callers.

### Database Compatibility

- [ ] A v0.1.0-style SQLite database opens and migrates under the current runtime.
- [ ] Schema creation remains idempotent across repeated launches.
- [ ] Existing symbol, message, and decision records survive new migrations.
- [ ] Future schema changes include explicit migration tests.

### Performance And Scale

- [ ] Cold index timing for a synthetic 1k-file project.
- [ ] Search/caller latency for roughly 10k symbols.
- [ ] Incremental reindex timing after a small file change in a larger project.
- [ ] Database size growth for repeated indexing and history records.
- [ ] `changed_symbols_risk` latency on a broad working-tree diff.

### Cross-Platform And Release

- [ ] CI matrix for Windows, Ubuntu, and macOS.
- [ ] CI runs `npm ci`, `npm test`, `npm run benchmark`, `npm run build`, and `npm pack --dry-run`.
- [ ] `npx -y codex-mcp-memory-server` smoke test.
- [ ] `setup-codex-mcp-memory` smoke test.
- [ ] Release checklist covers version bump, changelog/release notes, tag, GitHub release, npm publish, and post-publish install verification.

### Dogfooding

- [ ] Use this MCP on this repository for at least three real maintenance tasks.
- [ ] Record which MCP tools were used, how many files/bodies were read, and what was missing.
- [ ] Convert repeated dogfooding pain points into tool contract tests or benchmark scenarios.

## Completed Notes

- v0.3 validation started with `bugfix_investigation_narrowing`, a task-shaped benchmark that combines compact symbol search, conversation history, and project decisions.
- Reconciliation scans supported source files and compares blob hashes so clean branch checkout or rewrite states can update same-path symbol bodies even when `git diff HEAD` is empty.
- Integration tests cover same-path content changes after branch checkout to prevent stale symbol bodies during real agent work.
- Git edge-case tests now cover branch checkout deletion/restoration so symbols are marked deleted on one branch and reactivated when restored by checkout.
- Git rename tests now cover move plus content change so decision links survive while the moved symbol body is refreshed.
- Rename fallback tests now cover delete-and-add behavior when Git does not report a rename, ensuring the old symbol is deleted and the replacement path is indexed.
- Generated output under `build`, `dist`, `coverage`, `node_modules`, and `.git` is ignored by changed-file and reconciliation scans to avoid indexing build artifacts.
