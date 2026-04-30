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

## Real Repository Dogfooding

`npm run dogfood:real` clones shallow copies of real open-source repositories into the system temp directory, indexes supported source files into an isolated temporary SQLite database, then runs the high-level agent flow. The current set covers Express, Zod, Typer, Click, Requests, Flask, Axios, and p-limit:

```text
code_search -> read_context -> impact_analysis -> index_status
```

Latest run:

| Repo | Source Files | Symbols | Query | Classic Tokens | MCP Tokens | Freshness |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| expressjs/express | 141 | 86 | `test` | 21105 | 368 | fresh |
| colinhacks/zod | 400 | 1384 | `ZodObject` | 6748 | 428 | fresh |
| fastapi/typer | 603 | 1568 | `Typer` | 18240 | 379 | fresh |
| pallets/click | 63 | 1313 | `Command` | 6994 | 354 | fresh |
| psf/requests | 36 | 734 | `Session` | 2574 | 381 | fresh |
| pallets/flask | 83 | 1361 | `Flask` | 13549 | 375 | fresh |
| axios/axios | 194 | 532 | `Axios` | 29611 | 375 | fresh |
| sindresorhus/p-limit | 6 | 37 | `pLimit` | 1359 | 113 | fresh |

Artifacts are written to:

```text
dogfood/results/latest.json
dogfood/results/latest.md
```

Findings converted from this pass:

- `code_search` no longer ranks symbols by matching the absolute project root path. Real Typer dogfooding showed that querying `Typer` could match every file under a `typer` checkout and select an unrelated docs JavaScript symbol. Ranking now uses project-relative paths for path matching.
- TypeScript checker resolution now forces `traceResolution: false` so real repositories with verbose tsconfig settings do not flood dogfooding output.
- Real dogfooding now uses an isolated temporary SQLite database so validation does not pollute a user's local MCP memory.
