import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import db from "./db";
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { resolveSymbolReferences } from "./symbol-resolver";
import { CountRow, DecisionRow, MessageRow, SessionRow, SymbolReference, SymbolRow } from "./types";
import { listChangedSourceFiles, reindexChangedFiles, reconcileProjectFiles } from "./indexer";

const server = new Server(
  {
    name: "mcp-memory-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

export async function listTools() {
  return {
    tools: [
      {
        name: "lookup_symbol",
        description: "Find symbols by exact name. Returns compact results by default; pass verbose=true for metadata or include_body=true for full bodies.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            project_id: { type: "string", default: "default" },
            include_body: { type: "boolean", default: false },
            verbose: { type: "boolean", default: false }
          },
          required: ["name"],
        },
      },
      {
        name: "search_symbols",
        description: "Search symbols by partial name, kind, or file path and return compact results",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            project_id: { type: "string", default: "default" },
            kind: { type: "string" },
            limit: { type: "number", default: 20 },
            verbose: { type: "boolean", default: false }
          },
          required: ["query"],
        },
      },
      {
        name: "get_symbol_body",
        description: "Get the full body for a symbol by symbol_id",
        inputSchema: {
          type: "object",
          properties: {
            symbol_id: { type: "string" },
            ref: { type: "string" },
            project_id: { type: "string", default: "default" }
          },
        },
      },
      {
        name: "get_symbol_history",
        description: "Get the version history of a symbol",
        inputSchema: {
          type: "object",
          properties: {
            symbol_id: { type: "string" },
            limit: { type: "number", default: 10 },
            include_body: { type: "boolean", default: false }
          },
          required: ["symbol_id"],
        },
      },
      {
        name: "changed_since",
        description: "List symbols changed since a certain timestamp",
        inputSchema: {
          type: "object",
          properties: {
            since: { type: "number" },
            project_id: { type: "string", default: "default" }
          },
          required: ["since"],
        },
      },
      {
        name: "find_callers",
        description: "Find all symbols that call a specific symbol",
        inputSchema: {
          type: "object",
          properties: {
            symbol_id: { type: "string" },
            include_tests: { type: "boolean", default: true },
            min_confidence: { type: "number", default: 0.0 }
          },
          required: ["symbol_id"],
        },
      },
      {
        name: "index_status",
        description: "Get the current indexing status",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" }
          },
          required: ["project_id"],
        },
      },
      {
        name: "reindex_changed_files",
        description: "Re-index only Git changed, staged, and untracked source files for a project",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" },
            project_path: { type: "string" },
            force: { type: "boolean", default: false }
          },
        },
      },
      {
        name: "reconcile_index",
        description: "Reconcile indexed files against the working tree after checkout, merge, or rewrite",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" },
            project_path: { type: "string" }
          },
        },
      },
      {
        name: "changed_symbols_risk",
        description: "Summarize symbols in Git changed files and decisions linked to those symbols",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" },
            project_path: { type: "string" },
            include_deleted: { type: "boolean", default: false }
          },
        },
      },
      {
        name: "save_message",
        description: "Save a conversation message and link it to mentioned symbols",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            role: { type: "string", enum: ["user", "agent"] },
            content: { type: "string" },
            explicit_symbols: { type: "array", items: { type: "string" } }
          },
          required: ["session_id", "role", "content"],
        },
      },
      {
        name: "search_history",
        description: "Search through past messages using full-text search",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            project_id: { type: "string", default: "default" },
            limit: { type: "number", default: 20 }
          },
          required: ["query"],
        },
      },
      {
        name: "save_decision",
        description: "Save a project-level decision and link it to symbols",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" },
            summary: { type: "string" },
            rationale: { type: "string" },
            source_session: { type: "string" },
            related_symbols: { type: "array", items: { type: "string" } }
          },
          required: ["project_id", "summary"],
        },
      },
      {
        name: "get_decisions",
        description: "Retrieve project decisions, optionally filtered by symbol",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" },
            symbol: { type: "string" },
            status: { type: "string", enum: ["active", "superseded", "all"], default: "active" }
          },
          required: ["project_id"],
        },
      },
      {
        name: "symbols_discussed_and_changed",
        description: "Find symbols that were discussed in messages and subsequently changed in code",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" },
          },
        },
      },
      {
        name: "find_regression_candidates",
        description: "Find symbols changed on a specific date that were previously discussed",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" },
            changed_on: { type: "number" }, // Unix timestamp
            min_confidence: { type: "number", default: 0.7 }
          },
          required: ["changed_on"],
        },
      },
      {
        name: "context_since_last_session",
        description: "Get context summary since the last active session",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" }
          },
          required: ["project_id"],
        },
      },
      {
        name: "forget_session",
        description: "Delete session data from memory",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            mode: { type: "string", enum: ["raw_only", "raw_and_derived"], default: "raw_only" }
          },
          required: ["session_id"],
        },
      },
    ],
  };
}

server.setRequestHandler(ListToolsRequestSchema, listTools);

export async function callTool(name: string, rawArgs: Record<string, any> = {}) {
  const args = rawArgs;

  if (name === "lookup_symbol") {
    const projectName = args.project_id || 'default';
    const symbolName = args.name;
    const symbols = db.prepare("SELECT * FROM symbols WHERE name = ? AND project_id = ? AND is_deleted = 0").all(symbolName, projectName) as SymbolRow[];
    return {
      content: [{ type: "text", text: JSON.stringify(symbols.map(symbol => formatSymbol(symbol, {
        includeBody: Boolean(args.include_body),
        verbose: Boolean(args.verbose || args.include_body)
      }))) }],
    };
  }

  if (name === "search_symbols") {
    const projectName = args.project_id || 'default';
    const query = `%${args.query || ''}%`;
    const limit = args.limit || 20;
    const kind = args.kind;
    const sql = kind
      ? `SELECT * FROM symbols WHERE project_id = ? AND is_deleted = 0 AND kind = ? AND (name LIKE ? OR qualified_name LIKE ? OR file_path LIKE ?) ORDER BY name LIMIT ?`
      : `SELECT * FROM symbols WHERE project_id = ? AND is_deleted = 0 AND (name LIKE ? OR qualified_name LIKE ? OR file_path LIKE ?) ORDER BY name LIMIT ?`;
    const params = kind
      ? [projectName, kind, query, query, query, limit]
      : [projectName, query, query, query, limit];
    const symbols = db.prepare(sql).all(...params) as SymbolRow[];
    return {
      content: [{ type: "text", text: JSON.stringify(symbols.map(symbol => formatSymbol(symbol, {
        includeBody: false,
        verbose: Boolean(args.verbose)
      }))) }],
    };
  }

  if (name === "get_symbol_body") {
    const symbolId = args.symbol_id || resolveSymbolIdFromRef(args.ref, args.project_id || 'default');
    const symbol = db.prepare("SELECT id, name, qualified_name, file_path, start_line, end_line, language, body FROM symbols WHERE id = ? AND is_deleted = 0")
      .get(symbolId) as Pick<SymbolRow, 'id' | 'name' | 'qualified_name' | 'file_path' | 'start_line' | 'end_line' | 'language' | 'body'> | undefined;
    if (!symbol) {
      return { content: [{ type: "text", text: "Symbol not found." }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(symbol) }],
    };
  }

  if (name === "get_symbol_history") {
    const symbolId = args.symbol_id;
    const history = db.prepare("SELECT * FROM symbol_history WHERE symbol_id = ? ORDER BY version DESC LIMIT ?").all(symbolId, args.limit || 10) as any[];
    const response = history.map(row => ({
      id: row.id,
      symbol_id: row.symbol_id,
      version: row.version,
      signature: row.signature,
      start_line: row.start_line,
      end_line: row.end_line,
      commit_sha: row.commit_sha,
      commit_message: row.commit_message,
      commit_author: row.commit_author,
      commit_at: row.commit_at,
      change_type: row.change_type,
      branch: row.branch,
      pr_reference: row.pr_reference,
      ...(args.include_body ? { body: row.body } : {})
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(response) }],
    };
  }

  if (name === "changed_since") {
    const projectName = args.project_id || 'default';
    const since = args.since;
    const symbols = db.prepare("SELECT * FROM symbols WHERE project_id = ? AND updated_at > ?").all(projectName, since);
    return {
      content: [{ type: "text", text: JSON.stringify(symbols) }],
    };
  }

  if (name === "find_callers") {
    const symbolId = args.symbol_id;
    const includeTests = args.include_tests ?? true;
    const minConfidence = args.min_confidence ?? 0.0;
    const symbol = db.prepare("SELECT * FROM symbols WHERE id = ? AND is_deleted = 0").get(symbolId) as SymbolRow | undefined;
    if (!symbol) {
        return { content: [{ type: "text", text: "Symbol not found." }] };
    }
    let astCallers = db.prepare(`
      SELECT s.id, s.qualified_name, s.file_path, sc.confidence, sc.resolution_method, sc.line
      FROM symbol_calls sc
      JOIN symbols s ON sc.caller_symbol_id = s.id
      WHERE sc.project_id = ?
      AND (
        sc.target_symbol_id = ?
        OR (
          sc.target_name = ?
          AND (sc.target_file_path IS NULL OR sc.target_file_path = ?)
        )
      )
      AND s.is_deleted = 0
    `).all(symbol.project_id, symbolId, symbol.name, symbol.file_path) as Array<{
      id: string;
      qualified_name: string;
      file_path: string;
      confidence: number;
      resolution_method: string;
      line: number;
    }>;

    if (!includeTests) {
      astCallers = astCallers.filter(c => !/[._-](test|spec)\.[^.]+$/.test(c.file_path));
    }

    const astCallerIds = new Set(astCallers.map(c => c.id));
    let fuzzyCallers = db.prepare("SELECT * FROM symbols WHERE project_id = ? AND body LIKE ? AND id != ? AND is_deleted = 0")
      .all(symbol.project_id, `%${symbol.name}%`, symbolId) as SymbolRow[];
    if (!includeTests) {
      fuzzyCallers = fuzzyCallers.filter(c => !/[._-](test|spec)\.[^.]+$/.test(c.file_path));
    }
    fuzzyCallers = fuzzyCallers.filter(c => !astCallerIds.has(c.id));

    const definiteCallers = astCallers.map(c => ({
      symbol_id: c.id,
      qualified_name: c.qualified_name,
      file_path: c.file_path,
      line: c.line,
      confidence: c.confidence,
      resolution_method: c.resolution_method
    })).filter(c => c.confidence >= minConfidence);

    const probableCallers = fuzzyCallers.map(c => ({
      symbol_id: c.id,
      qualified_name: c.qualified_name,
      file_path: c.file_path,
      confidence: 0.5,
      resolution_method: 'fuzzy_name_match'
    })).filter(c => c.confidence >= minConfidence);
    return {
      content: [{ type: "text", text: JSON.stringify({
          definite_callers: definiteCallers,
          probable_callers: probableCallers
      }) }],
    };
  }

  if (name === "index_status") {
    const projectName = args.project_id || 'default';
    const total = (db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND is_deleted = 0").get(projectName) as CountRow | undefined)?.count || 0;
    const deleted = (db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND is_deleted = 1").get(projectName) as CountRow | undefined)?.count || 0;
    const excluded = (db.prepare("SELECT count(*) as count FROM files WHERE project_id = ? AND is_excluded = 1").get(projectName) as CountRow | undefined)?.count || 0;
    const files = (db.prepare("SELECT count(*) as count FROM files WHERE project_id = ?").get(projectName) as CountRow | undefined)?.count || 0;
    const hashed = (db.prepare("SELECT count(*) as count FROM files WHERE project_id = ? AND git_blob_sha IS NOT NULL").get(projectName) as CountRow | undefined)?.count || 0;
    return {
      content: [{ type: "text", text: JSON.stringify({ status: 'ready', total_symbols: total, deleted_symbols: deleted, indexed_files: files, hashed_files: hashed, excluded_files: excluded }) }],
    };
  }

  if (name === "reindex_changed_files") {
    const projectName = args.project_id || process.env.PROJECT_ID || 'default';
    const projectPath = args.project_path || process.env.PROJECT_PATH || process.cwd();
    const result = await reindexChangedFiles(projectPath, projectName, { force: Boolean(args.force) });
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  if (name === "reconcile_index") {
    const projectName = args.project_id || process.env.PROJECT_ID || 'default';
    const projectPath = args.project_path || process.env.PROJECT_PATH || process.cwd();
    const result = reconcileProjectFiles(projectPath, projectName);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  if (name === "changed_symbols_risk") {
    const projectName = args.project_id || process.env.PROJECT_ID || 'default';
    const projectPath = args.project_path || process.env.PROJECT_PATH || process.cwd();
    const changedFiles = listChangedSourceFiles(projectPath);
    const includeDeleted = Boolean(args.include_deleted);
    const changedSymbols = changedFiles.flatMap(filePath => {
      const sql = includeDeleted
        ? "SELECT * FROM symbols WHERE project_id = ? AND file_path = ? ORDER BY name"
        : "SELECT * FROM symbols WHERE project_id = ? AND file_path = ? AND is_deleted = 0 ORDER BY name";
      return (db.prepare(sql).all(projectName, filePath) as SymbolRow[])
        .map(symbol => formatSymbol(symbol, { includeBody: false, verbose: false }));
    });
    const changedSymbolIds = changedSymbols.map((symbol: any) => resolveSymbolIdFromRef(symbol.ref, projectName)).filter(Boolean);
    const decisions = changedSymbolIds.length === 0 ? [] : db.prepare(`
      SELECT DISTINCT d.id, d.summary, d.status, d.confidence, d.decided_at
      FROM project_decisions d
      JOIN decision_symbol_references dsr ON d.id = dsr.decision_id
      WHERE d.project_id = ?
      AND dsr.symbol_id IN (${changedSymbolIds.map(() => '?').join(',')})
      ORDER BY d.decided_at DESC
    `).all(projectName, ...changedSymbolIds);

    return {
      content: [{ type: "text", text: JSON.stringify({
        changed_files: changedFiles,
        changed_symbols: changedSymbols,
        related_decisions: decisions
      }) }],
    };
  }

  if (name === "save_message") {
    const { session_id, role, content, explicit_symbols = [] } = args;
    const messageId = uuidv4();
    const now = Date.now();
    const session = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(session_id) as { project_id: string } | undefined;
    const projectId = args.project_id || session?.project_id || 'default';

    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(messageId, session_id, role, content, now);

    const references = await resolveSymbolReferences(content, explicit_symbols, projectId) as SymbolReference[];
    
    const insertRef = db.prepare("INSERT INTO message_symbol_references (message_id, symbol_id, confidence, reference_type, extraction_source) VALUES (?, ?, ?, ?, ?)");
    const transaction = db.transaction((refs: SymbolReference[]) => {
        for (const ref of refs) {
            insertRef.run(messageId, ref.symbol_id, ref.confidence, ref.reference_type, ref.extraction_source);
        }
    });
    transaction(references);

    const messageRow = db.prepare("SELECT rowid FROM messages WHERE id = ?").get(messageId) as MessageRow;
    db.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)").run(messageRow.rowid, content);

    return {
      content: [{ type: "text", text: `Message saved. Extracted ${references.length} symbol references.` }],
    };
  }

  if (name === "search_history") {
    const query = args.query;
    const results = db.prepare(`
        SELECT m.id, m.content, m.created_at 
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        JOIN messages_fts fts ON m.rowid = fts.rowid
        WHERE messages_fts MATCH ?
        AND s.project_id = ?
        ORDER BY rank
        LIMIT ?
    `).all(query, args.project_id || 'default', args.limit || 20);

    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }

  if (name === "save_decision") {
    const { project_id, summary, rationale, source_session, related_symbols = [] } = args;
    const decisionId = uuidv4();
    const now = Date.now();

    db.prepare("INSERT INTO project_decisions (id, project_id, summary, rationale, decided_at, source_session, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(decisionId, project_id, summary, rationale, now, source_session, 'active');

    const insertSymbolRef = db.prepare("INSERT INTO decision_symbol_references (decision_id, symbol_id) VALUES (?, ?)");
    const transaction = db.transaction((symbols: string[]) => {
        for (const symName of symbols) {
            const symbol = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0 LIMIT 1")
              .get(project_id, symName) as Pick<SymbolRow, 'id'> | undefined;
            if (symbol) {
                insertSymbolRef.run(decisionId, symbol.id);
            }
        }
    });
    transaction(related_symbols);

    return {
      content: [{ type: "text", text: `Decision saved with ID: ${decisionId}` }],
    };
  }

  if (name === "get_decisions") {
    const { project_id, symbol, status = 'active' } = args;
    let query = "SELECT * FROM project_decisions WHERE project_id = ?";
    const params: any[] = [project_id];

    if (status !== 'all') {
      query += " AND status = ?";
      params.push(status);
    }

    if (symbol) {
        query = `
            SELECT d.* FROM project_decisions d
            JOIN decision_symbol_references dsr ON d.id = dsr.decision_id
            JOIN symbols s ON dsr.symbol_id = s.id
            WHERE d.project_id = ? ${status !== 'all' ? 'AND d.status = ?' : ''} AND s.name = ?
        `;
        params.push(symbol);
    }

    const decisions = db.prepare(query).all(...params);
    return {
      content: [{ type: "text", text: JSON.stringify(decisions) }],
    };
  }

  if (name === "symbols_discussed_and_changed") {
    const results = db.prepare(`
      SELECT s.name, s.file_path, s.updated_at, m.content as discussed_in
      FROM symbols s
      JOIN message_symbol_references msr ON s.id = msr.symbol_id
      JOIN messages m ON msr.message_id = m.id
      JOIN sessions sess ON m.session_id = sess.id
      WHERE s.updated_at > m.created_at
      AND s.project_id = ?
      AND sess.project_id = ?
    `).all(args.project_id || 'default', args.project_id || 'default');
    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }

  if (name === "find_regression_candidates") {
    const { project_id = 'default', changed_on, min_confidence = 0.7 } = args;
    const dayStart = changed_on; 
    const dayEnd = changed_on + 86400000;

    const results = db.prepare(`
      SELECT s.name, s.file_path, s.updated_at, m.content as discussed_in, msr.confidence
      FROM symbols s
      JOIN message_symbol_references msr ON s.id = msr.symbol_id
      JOIN messages m ON msr.message_id = m.id
      JOIN sessions sess ON m.session_id = sess.id
      WHERE s.updated_at BETWEEN ? AND ? 
      AND msr.confidence >= ?
      AND s.project_id = ?
      AND sess.project_id = ?
    `).all(dayStart, dayEnd, min_confidence, project_id, project_id);

    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }

  if (name === "context_since_last_session") {
    const project_id = args.project_id || 'default';
    const lastSession = db.prepare("SELECT ended_at FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 1").get(project_id) as SessionRow | undefined;
    
    if (!lastSession) {
        return { content: [{ type: "text", text: "No previous sessions found for this project." }] };
    }

    const lastEndedAt = lastSession.ended_at || Date.now();
    const changedSymbols = db.prepare("SELECT id, name, updated_at FROM symbols WHERE project_id = ? AND updated_at > ?").all(project_id, lastEndedAt) as SymbolRow[];
    
    const activeDecisions = db.prepare("SELECT id, summary FROM project_decisions WHERE project_id = ? AND status = 'active'").all(project_id) as DecisionRow[];

    return {
      content: [{ type: "text", text: JSON.stringify({
          last_session_at: lastEndedAt,
          changed_symbols: changedSymbols.map(s => ({
              symbol_id: s.id,
              qualified_name: s.name,
              updated_at: s.updated_at
          })),
          active_decisions: activeDecisions.map(d => ({
              decision_id: d.id,
              summary: d.summary
          }))
      }) }],
    };
  }

  if (name === "forget_session") {
    const { session_id, mode = 'raw_only' } = args;

    const transaction = db.transaction(() => {
        if (mode === 'raw_and_derived') {
            db.prepare("UPDATE project_decisions SET status = 'superseded', source_session = NULL WHERE source_session = ?").run(session_id);
        } else {
            db.prepare("UPDATE project_decisions SET source_session = NULL WHERE source_session = ?").run(session_id);
        }

        db.prepare("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE session_id = ?)").run(session_id);
        db.prepare("DELETE FROM message_symbol_references WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)").run(session_id);
        db.prepare("DELETE FROM messages WHERE session_id = ?").run(session_id);
        db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(session_id);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(session_id);
    });

    transaction();
    return {
      content: [{ type: "text", text: `Session ${session_id} forgotten in ${mode} mode.` }],
    };
  }

  throw new Error(`Tool not found: ${name}`);
}

function formatSymbol(symbol: SymbolRow, options: { includeBody: boolean; verbose: boolean }) {
  if (!options.verbose) {
    return {
      ref: symbolRef(symbol.id),
      name: symbol.name,
      kind: symbol.kind,
      file: relativeDisplayPath(symbol.file_path),
      lines: `${symbol.start_line}-${symbol.end_line}`,
      sig: compactSignature(symbol.signature)
    };
  }

  return {
    ref: symbolRef(symbol.id),
    id: symbol.id,
    project_id: symbol.project_id,
    name: symbol.name,
    qualified_name: symbol.qualified_name,
    kind: symbol.kind,
    file_path: symbol.file_path,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    signature: symbol.signature,
    language: symbol.language,
    updated_at: symbol.updated_at,
    ...(options.includeBody ? { body: symbol.body } : {})
  };
}

function symbolRef(symbolId: string) {
  return crypto.createHash('sha1').update(symbolId).digest('hex').slice(0, 10);
}

function resolveSymbolIdFromRef(ref: string | undefined, projectId: string) {
  if (!ref) return undefined;
  const symbols = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND is_deleted = 0").all(projectId) as Pick<SymbolRow, 'id'>[];
  return symbols.find(symbol => symbolRef(symbol.id) === ref)?.id;
}

function relativeDisplayPath(filePath: string) {
  const projectPath = process.env.PROJECT_PATH;
  if (!projectPath) return filePath;
  const relative = pathRelative(projectPath, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

function pathRelative(from: string, to: string) {
  return require('path').relative(from, to).replace(/\\/g, '/');
}

function compactSignature(signature: string | null) {
  if (!signature) return null;
  const normalized = signature.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  return callTool(name, (rawArgs ?? {}) as Record<string, any>);
});

export async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Memory Server running on stdio");
}
