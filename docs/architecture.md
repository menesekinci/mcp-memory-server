# Architecture

## Runtime

```text
MCP client
  -> stdio server
  -> SQLite memory database
  -> tree-sitter indexer
  -> git history and incremental indexing helpers
```

## Main Modules

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Bootstraps DB, git history, reconciliation, watcher, and MCP server. |
| `src/server.ts` | Defines MCP tools and tool handlers. |
| `src/indexer.ts` | Parses source files, stores symbols, tracks blob hashes, and reconciles Git changes. |
| `src/call-graph.ts` | Extracts TypeScript, JavaScript, and Python call references. |
| `src/git-parser.ts` | Reads Git history into symbol history records. |
| `src/symbol-resolver.ts` | Links messages and decisions to symbols. |
| `src/db.ts` | Owns SQLite schema and migrations. |

## Data Model

| Table | Purpose |
| --- | --- |
| `symbols` | Current symbol metadata, compact refs, scoped qualified names, and bodies. |
| `symbol_calls` | Caller/callee edges with confidence and resolution method. |
| `symbol_history` | Git-derived symbol versions. |
| `files` | Indexed files, blob hashes, exclusion status. |
| `messages` / `messages_fts` | Saved conversation messages and FTS search. |
| `project_decisions` | Durable project decisions. |
| `message_symbol_references` / `decision_symbol_references` | Symbol-level memory links. |

## Indexing

The indexer parses TypeScript, TSX, JavaScript, JSX, Python, and Go files. It computes a Git-compatible blob SHA for each indexed file and skips unchanged files. Git changed-file indexing uses:

```text
git diff --name-only HEAD
git diff --name-only --cached
git ls-files --others --exclude-standard
```

Rename reconciliation uses Git rename detection and preserves symbol links across moved files. Full reconciliation also scans supported source files and compares blob hashes, so clean branch checkout or rewrite states can update same-path symbol bodies even when `git diff HEAD` is empty.

Indexed symbol IDs include project, file, kind, and scoped `qualified_name`. This keeps same-file same-name class methods such as `UserService.run` and `BillingService.run` distinct. Compact refs are stored in SQLite and indexed by `(project_id, ref)` so body lookup can resolve refs directly, with a legacy hash fallback for older rows.

## Freshness Contract

The `files.git_blob_sha` value is a Git-compatible blob hash of the indexed file content. When a project path is available, `index_status` compares those stored hashes against the current working tree and reports `fresh`, `stale`, or `unknown` health. Symbol discovery returns compact per-symbol freshness, and `get_symbol_body` returns full freshness metadata with the body. This is the first guardrail against silent stale context.

Freshness values:

- `fresh`: indexed hash matches the working tree.
- `stale`: file content differs from the indexed hash or the file is missing.
- `excluded`: file was intentionally skipped by path or secret filters.
- `unknown`: the server cannot prove freshness, usually because no project path or file hash is available.

## Session Memory

`save_message` writes to `messages` and `messages_fts`, then links explicit and inferred symbols through `message_symbol_references`. If callers omit `session_id`, or pass an unknown session ID, the server creates a session in the target project before inserting the message. Agents should still pass stable session IDs for long work sessions when they want future context to group cleanly.

## Caller Graph

TypeScript and JavaScript caller extraction currently supports:

- Same-file calls.
- Static named imports.
- Aliased imports.
- Namespace imports.
- Barrel/re-export resolution.
- Local shadowing checks.
- Simple constructor-assigned or type-annotated instance method calls.
- TSX/JSX component usage edges for uppercase component tags.
- Selective TypeScript compiler API resolution for imported symbols, JSX components, and typed/member calls.

The TypeScript compiler API path is gated to files that need semantic resolution, such as files with imports, TSX/JSX, or member calls. Plain same-file function-heavy files stay on the tree-sitter fast path, which keeps large synthetic indexing benchmarks practical.

Fuzzy matching remains as a lower-confidence fallback.

Python caller extraction currently supports:

- Same-file name-based calls from Python `call` AST nodes.
- `async def` symbols and async call sites.
- Relative `from .module import symbol` calls, including aliases.
- Package `__init__.py` re-export chains for relative imports.
- Module imports such as `import package.module as alias` followed by `alias.function()`.
- Dotted module calls such as `import package.module` followed by `package.module.function()`.
- Same-file `self.method()` calls.
- Same-file and imported-base inherited `self.method()` calls where a subclass calls a base class method.
- `super().method()` calls against same-file or imported base classes.
- Simple constructor-assigned instance method calls such as `service = Service()` or `self.service = Service()` followed by `service.run()` or `self.service.run()`.

Fuzzy matching remains available for string-only mentions and broader probable caller fallback.

Go caller extraction currently supports:

- `func` symbols, `type` declarations, and receiver methods such as `func (c *Calculator) Total()`.
- Same-package function calls.
- `go.mod` module import resolution for package selector calls such as `price.Round()`.
- Local `go.mod replace` targets for package selector calls.
- Local `vendor/<import-path>` package resolution.
- `go.work` workspace import resolution across local modules.
- Same-type receiver method calls such as `c.normalize()`.
- Local constructor-assigned instance method calls such as `calc := &Calculator{}` followed by `calc.normalize()`.
- Embedded struct promoted method calls such as `AdvancedCalculator` embedding `Calculator` and calling `a.normalize()`.
- Simple interface parameter dispatch such as `func Checkout(p Pricer) { p.Price() }`, emitted as lower-confidence concrete method candidates when local types implement the method.
- Generated Go files with the standard `Code generated ... DO NOT EDIT.` marker are excluded from symbol indexing to avoid noisy machine-generated callers.
- Go files with false `//go:build` expressions, false legacy `// +build` lines, unsupported GOOS/GOARCH suffixes, or explicit `ignore` constraints are excluded from symbol indexing. The active platform uses `GOOS`, `GOARCH`, `CGO_ENABLED`, and optional `MCP_MEMORY_GO_BUILD_TAGS` when present.

Go support is intentionally still early. Versioned/non-local replace targets, build tags that depend on project-specific custom tags, and more complex workspace layouts should be expanded after the core Go benchmarks and dogfooding stay stable.
