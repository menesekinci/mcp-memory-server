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

The indexer parses TypeScript, TSX, JavaScript, JSX, and Python files. It computes a Git-compatible blob SHA for each indexed file and skips unchanged files. Git changed-file indexing uses:

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
- Relative `from .module import symbol` calls, including aliases.
- Package `__init__.py` re-export chains for relative imports.
- Module imports such as `import package.module as alias` followed by `alias.function()`.
- Same-file `self.method()` calls.
- Simple constructor-assigned instance method calls such as `service = Service()` followed by `service.run()`.

Fuzzy matching remains available for string-only mentions and broader probable caller fallback.
