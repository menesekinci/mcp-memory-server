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
| `symbols` | Current symbol metadata and bodies. |
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

Fuzzy matching remains as a lower-confidence fallback.

Python caller extraction currently supports:

- Same-file name-based calls from Python `call` AST nodes.
- Relative `from .module import symbol` calls, including aliases.
- Package `__init__.py` re-export chains for relative imports.
- Module imports such as `import package.module as alias` followed by `alias.function()`.
- Same-file `self.method()` calls.
- Simple constructor-assigned instance method calls such as `service = Service()` followed by `service.run()`.

Fuzzy matching remains available for string-only mentions and broader probable caller fallback.
