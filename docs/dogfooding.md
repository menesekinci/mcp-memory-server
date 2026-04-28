# Dogfooding Report

This report records the v0.3 validation work performed on this repository.

## Maintenance Tasks Covered

| Task | MCP-first behavior validated | Files or bodies read | Follow-up created |
| --- | --- | ---: | --- |
| Git edge-case hardening | Reconciliation and changed-file indexing were validated against checkout, merge, rewrite, rename, delete, staged, and untracked states. | Focused integration fixtures and changed symbols only. | Edge cases became integration tests. |
| Task-success benchmark expansion | Discovery was validated by task outcome: root symbol selection, refactor caller impact, regression narrowing, PR risk summary, and workload reduction. | Synthetic benchmark symbols and selected bodies only. | Benchmark scenarios now run through `npm run benchmark`. |
| Release/adoption validation | NPX runtime start, setup helper dry-run, CI matrix, package dry-run, and release checklist were formalized. | Package entrypoints and setup helper only. | `npm run smoke:npx`, GitHub Actions CI, and release checklist were added. |

## What Worked

- Compact symbol results were enough for initial narrowing in benchmark-shaped tasks.
- `find_callers` is now useful for TS/JS refactor impact checks when tests are excluded and confidence is bounded.
- `changed_symbols_risk` connects Git changed files to linked decisions compactly enough for PR review.
- Git reconciliation tests caught the highest-risk lifecycle cases before broader feature work.

## Gaps Found

- The locally exposed Codex tool surface in this thread did not expose the project MCP tools directly, so this dogfooding pass used the same runtime APIs and benchmark harness instead of live MCP tool calls from the assistant UI.
- Full runtime NPX testing needs a bounded process smoke because the MCP server correctly stays alive on stdio.
- Performance numbers are environment-dependent, so scale benchmarks use generous pass thresholds and should be read as regression smoke, not a public performance guarantee.

## Converted To Tests Or Benchmarks

- Branch checkout, merge, rewrite, rename, delete/restore, generated output ignore, project isolation, tool contract, and legacy DB compatibility were converted to integration tests.
- Bug-fix narrowing, root symbol selection, refactor impact, regression narrowing, PR risk summary, discovery workload, and 10k-symbol scale behavior were converted to benchmarks.
- NPX runtime startup was converted to `npm run smoke:npx` and wired into release smoke CI.
