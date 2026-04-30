# v1.0 Criteria

v1.0 should mean the project is reliable enough for agents to use as their first-pass code context layer on real repositories.

## Required Outcomes

- Agents can use the MCP-first flow and consistently read fewer files and fewer full bodies than broad shell search.
- Tool results expose freshness status and avoid silently returning stale context.
- Memory and decision tools return current, useful information without old decisions being treated as current truth.
- Setup can be verified quickly through `npx` and a doctor-style readiness check.
- Benchmarks include real task outcomes, not only compact output size.

## P0 - Freshness And Sync Contract

- `index_status` reports project-level freshness when a project path is known.
- Symbol discovery and body-read results expose per-symbol freshness.
- Stale, missing, unindexed, and excluded files are visible in machine-readable output.
- Reconciliation updates same-path changes, deleted files, generated output ignores, and branch switch states.
- Tests cover stale detection before and after reindex/reconcile.

## P1 - Stable Agent Tool Surface

- Introduce a small agent-facing layer over low-level tools:
  - `code_search`
  - `read_context`
  - `impact_analysis`
  - `memory`
  - `index_health`
- Keep existing tools for compatibility, but document the recommended high-level surface.
- Each high-level tool must support compact token budgets.

## P2 - Ranked Context Engine

- Search results are ranked by name, path, call graph proximity, recent changes, linked decisions, previous discussion, and stale penalties.
- Each result includes `why_this_matched`.
- Results support budget modes such as `tiny`, `small`, `medium`, and `full`.

## P3 - Memory Lifecycle

- Decisions support `active`, `superseded`, `under_review`, and stale/needs-review semantics.
- Symbol changes can mark linked decisions for review.
- Memory reads distinguish current decisions from historical context.

## P4 - Read Context Packets

- Agents can request a bug-fix, review, refactor, or regression packet without reading whole files.
- Packets can include selected symbol body, definite callers, relevant tests, linked decisions, and freshness metadata.

## P5 - Validation

- Dogfood on at least five real repositories of different shapes.
- Track token savings, tool-call count, files read, body reads, stale result rate, false-positive rate, and task success.
- Keep synthetic 10k-symbol and monorepo benchmarks as regression smoke.

## P6 - Privacy And Setup

- Provide `.mcp-memoryignore`.
- Provide metadata-only/body-storage controls.
- Strengthen best-effort secret filtering and document its limitations.
- Add `doctor`/setup verification for Node, package version, DB path, project path, MCP registration, and runtime readiness.

