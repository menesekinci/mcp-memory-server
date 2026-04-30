import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import db from "./db";
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { resolveSymbolReferences } from "./symbol-resolver";
import { CountRow, DecisionRow, MessageRow, SessionRow, SymbolReference, SymbolRow } from "./types";
import { getFileFreshness, getProjectIndexHealth, listChangedSourceFiles, reindexChangedFiles, reconcileProjectFiles } from "./indexer";
import { symbolRef } from "./refs";

const server = new Server(
  {
    name: "mcp-memory-server",
    version: packageVersion(),
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
        name: "code_search",
        description: "Rank compact code context across symbols, decisions, and recent history. Use this as the first discovery tool for code tasks.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            project_id: { type: "string", default: "default" },
            project_path: { type: "string" },
            kind: { type: "string" },
            limit: { type: "number", default: 10 },
            max_tokens: { type: "number", default: 1200 },
            include_history: { type: "boolean", default: true },
            include_decisions: { type: "boolean", default: true }
          },
          required: ["query"],
        },
      },
      {
        name: "read_context",
        description: "Read one focused context packet for a symbol: target metadata, optional body, callers, decisions, history, and freshness.",
        inputSchema: {
          type: "object",
          properties: {
            symbol_id: { type: "string" },
            ref: { type: "string" },
            project_id: { type: "string", default: "default" },
            include_body: { type: "boolean", default: false },
            include_tests: { type: "boolean", default: false },
            max_callers: { type: "number", default: 8 },
            max_history: { type: "number", default: 5 },
            max_tokens: { type: "number", default: 1600 }
          },
        },
      },
      {
        name: "impact_analysis",
        description: "Summarize likely impact for a target symbol or current Git changes using callers, freshness, and linked decisions.",
        inputSchema: {
          type: "object",
          properties: {
            symbol_id: { type: "string" },
            ref: { type: "string" },
            project_id: { type: "string", default: "default" },
            project_path: { type: "string" },
            include_tests: { type: "boolean", default: false },
            max_callers: { type: "number", default: 12 },
            max_tokens: { type: "number", default: 1400 }
          },
        },
      },
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
        description: "Get the current indexing status and freshness health when project_path is available",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", default: "default" },
            project_path: { type: "string" }
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
        description: "Save a conversation message and link it to mentioned symbols. Creates a session automatically when session_id is omitted or unknown.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            project_id: { type: "string", default: "default" },
            role: { type: "string", enum: ["user", "agent"] },
            content: { type: "string" },
            explicit_symbols: { type: "array", items: { type: "string" } }
          },
          required: ["role", "content"],
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
            supersedes_decision_id: { type: "string" },
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
            status: { type: "string", enum: ["active", "under_review", "superseded", "all"], default: "active" }
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

  if (name === "code_search") {
    const projectName = args.project_id || 'default';
    const results = rankedCodeSearch({
      projectId: projectName,
      query: args.query || '',
      kind: args.kind,
      limit: args.limit || 10
    });
    const decisions = args.include_decisions === false ? [] : findDecisionMatches(projectName, args.query || '', 5);
    const history = args.include_history === false ? [] : findHistoryMatches(projectName, args.query || '', 5);
    const projectPath = args.project_path || process.env.PROJECT_PATH;
    const health = getProjectIndexHealth(projectPath, projectName);
    return {
      content: [{ type: "text", text: budgetedJson({
        query: args.query || '',
        project_id: projectName,
        freshness: health.freshness,
        results,
        related_decisions: decisions,
        history_matches: history
      }, args.max_tokens || 1200) }],
    };
  }

  if (name === "read_context") {
    const projectName = args.project_id || 'default';
    const symbol = resolveActiveSymbol(args.symbol_id, args.ref, projectName);
    if (!symbol) {
      return { content: [{ type: "text", text: "Symbol not found." }] };
    }
    return {
      content: [{ type: "text", text: budgetedJson(buildReadContext(symbol, {
        includeBody: Boolean(args.include_body),
        includeTests: Boolean(args.include_tests),
        maxCallers: args.max_callers || 8,
        maxHistory: args.max_history || 5
      }), args.max_tokens || 1600) }],
    };
  }

  if (name === "impact_analysis") {
    const projectName = args.project_id || process.env.PROJECT_ID || 'default';
    const symbol = resolveActiveSymbol(args.symbol_id, args.ref, projectName);
    if (symbol) {
      return {
        content: [{ type: "text", text: budgetedJson(buildSymbolImpact(symbol, {
          includeTests: Boolean(args.include_tests),
          maxCallers: args.max_callers || 12
        }), args.max_tokens || 1400) }],
      };
    }

    const projectPath = args.project_path || process.env.PROJECT_PATH || process.cwd();
    const changedFiles = listChangedSourceFiles(projectPath);
    const changedSymbols = changedFiles.flatMap(filePath => {
      return (db.prepare("SELECT * FROM symbols WHERE project_id = ? AND file_path = ? AND is_deleted = 0 ORDER BY name")
        .all(projectName, filePath) as SymbolRow[])
        .map(symbolRow => formatSymbol(symbolRow, { includeBody: false, verbose: false }));
    });
    const changedSymbolIds = changedSymbols.map((symbolRow: any) => resolveSymbolIdFromRef(symbolRow.ref, projectName)).filter(Boolean);
    const decisions = decisionsForSymbolIds(projectName, changedSymbolIds);
    const health = getProjectIndexHealth(projectPath, projectName);
    return {
      content: [{ type: "text", text: budgetedJson({
        mode: "changed_files",
        project_id: projectName,
        freshness: health.freshness,
        changed_files: changedFiles,
        changed_symbols: changedSymbols,
        related_decisions: decisions,
        risk_level: riskLevel(changedSymbols.length, decisions.length, health.freshness),
        why: impactWhy(changedSymbols.length, decisions.length, health.freshness)
      }, args.max_tokens || 1400) }],
    };
  }

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
    const symbol = db.prepare("SELECT id, project_id, name, qualified_name, file_path, start_line, end_line, language, body FROM symbols WHERE id = ? AND is_deleted = 0")
      .get(symbolId) as Pick<SymbolRow, 'id' | 'project_id' | 'name' | 'qualified_name' | 'file_path' | 'start_line' | 'end_line' | 'language' | 'body'> | undefined;
    if (!symbol) {
      return { content: [{ type: "text", text: "Symbol not found." }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({
        ...symbol,
        freshness: getFileFreshness(symbol.file_path, symbol.project_id)
      }) }],
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
    const projectPath = args.project_path || process.env.PROJECT_PATH;
    const total = (db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND is_deleted = 0").get(projectName) as CountRow | undefined)?.count || 0;
    const deleted = (db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND is_deleted = 1").get(projectName) as CountRow | undefined)?.count || 0;
    const excluded = (db.prepare("SELECT count(*) as count FROM files WHERE project_id = ? AND is_excluded = 1").get(projectName) as CountRow | undefined)?.count || 0;
    const files = (db.prepare("SELECT count(*) as count FROM files WHERE project_id = ?").get(projectName) as CountRow | undefined)?.count || 0;
    const hashed = (db.prepare("SELECT count(*) as count FROM files WHERE project_id = ? AND git_blob_sha IS NOT NULL").get(projectName) as CountRow | undefined)?.count || 0;
    const health = getProjectIndexHealth(projectPath, projectName);
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: 'ready',
        freshness: health.freshness,
        total_symbols: total,
        deleted_symbols: deleted,
        indexed_files: files,
        hashed_files: hashed,
        excluded_files: excluded,
        health
      }) }],
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
    const result = await reconcileProjectFiles(projectPath, projectName);
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
    if (changedSymbolIds.length > 0) {
      markDecisionsForReview(projectName, changedSymbolIds, 'linked_symbol_changed_in_working_tree');
    }
    const decisions = changedSymbolIds.length === 0 ? [] : decorateDecisions(db.prepare(`
      SELECT DISTINCT d.id, d.summary, d.status, d.confidence, d.decided_at
      FROM project_decisions d
      JOIN decision_symbol_references dsr ON d.id = dsr.decision_id
      WHERE d.project_id = ?
      AND dsr.symbol_id IN (${changedSymbolIds.map(() => '?').join(',')})
      ORDER BY d.decided_at DESC
    `).all(projectName, ...changedSymbolIds), projectName);

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
    const requestedSessionId = typeof session_id === 'string' && session_id.length > 0 ? session_id : undefined;
    const session = requestedSessionId
      ? db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(requestedSessionId) as { project_id: string } | undefined
      : undefined;
    const projectId = args.project_id || session?.project_id || 'default';
    const resolvedSessionId = requestedSessionId || uuidv4();

    if (!session) {
      db.prepare("INSERT INTO sessions (id, project_id, started_at, ended_at, title, tags) VALUES (?, ?, ?, NULL, ?, ?)")
        .run(resolvedSessionId, projectId, now, 'auto-created', 'auto');
    }

    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(messageId, resolvedSessionId, role, content, now);

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
      content: [{ type: "text", text: `Message saved in session ${resolvedSessionId}. Extracted ${references.length} symbol references.` }],
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

    const transaction = db.transaction((symbols: string[]) => {
        db.prepare("INSERT INTO project_decisions (id, project_id, summary, rationale, decided_at, source_session, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(decisionId, project_id, summary, rationale, now, source_session, 'active');

        if (args.supersedes_decision_id) {
            db.prepare("UPDATE project_decisions SET status = 'superseded', superseded_by = ? WHERE id = ? AND project_id = ?")
              .run(decisionId, args.supersedes_decision_id, project_id);
        }

        for (const symName of symbols) {
            const symbol = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0 LIMIT 1")
              .get(project_id, symName) as Pick<SymbolRow, 'id'> | undefined;
            if (symbol) {
                insertSymbolRef.run(decisionId, symbol.id);
            }
        }
    });

    const insertSymbolRef = db.prepare("INSERT INTO decision_symbol_references (decision_id, symbol_id) VALUES (?, ?)");
    transaction(related_symbols);

    return {
      content: [{ type: "text", text: `Decision saved with ID: ${decisionId}` }],
    };
  }

  if (name === "get_decisions") {
    const { project_id, symbol, status = 'active' } = args;
    let query = "SELECT * FROM project_decisions WHERE project_id = ?";
    const params: any[] = [project_id];

    if (status === 'active') {
      query += " AND status IN ('active', 'under_review')";
    } else if (status !== 'all') {
      query += " AND status = ?";
      params.push(status);
    }

    if (symbol) {
        params.splice(1);
        query = `
            SELECT d.* FROM project_decisions d
            JOIN decision_symbol_references dsr ON d.id = dsr.decision_id
            JOIN symbols s ON dsr.symbol_id = s.id
            WHERE d.project_id = ? ${status === 'active' ? "AND d.status IN ('active', 'under_review')" : status !== 'all' ? 'AND d.status = ?' : ''} AND s.name = ?
        `;
        if (status !== 'all' && status !== 'active') params.push(status);
        params.push(symbol);
    }

    const decisions = decorateDecisions(db.prepare(query).all(...params), project_id);
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
    const changedSymbols = db.prepare("SELECT id, name, qualified_name, updated_at FROM symbols WHERE project_id = ? AND updated_at > ?").all(project_id, lastEndedAt) as SymbolRow[];
    
    const activeDecisions = db.prepare("SELECT id, summary FROM project_decisions WHERE project_id = ? AND status = 'active'").all(project_id) as DecisionRow[];

    return {
      content: [{ type: "text", text: JSON.stringify({
          last_session_at: lastEndedAt,
          changed_symbols: changedSymbols.map(s => ({
              symbol_id: s.id,
              qualified_name: s.qualified_name,
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
  const ref = symbol.ref || symbolRef(symbol.id);
  const freshness = getFileFreshness(symbol.file_path, symbol.project_id);
  if (!options.verbose) {
    return {
      ref,
      name: symbol.name,
      kind: symbol.kind,
      file: relativeDisplayPath(symbol.file_path),
      lines: `${symbol.start_line}-${symbol.end_line}`,
      sig: compactSignature(symbol.signature),
      freshness: freshness.freshness
    };
  }

  return {
    ref,
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
    freshness,
    ...(options.includeBody ? { body: symbol.body } : {})
  };
}

function rankedCodeSearch(options: { projectId: string; query: string; kind?: string; limit: number }) {
  const query = options.query.trim();
  const like = `%${query}%`;
  const sql = options.kind
    ? `SELECT * FROM symbols WHERE project_id = ? AND is_deleted = 0 AND kind = ? AND (name LIKE ? OR qualified_name LIKE ? OR file_path LIKE ? OR signature LIKE ?) LIMIT 100`
    : `SELECT * FROM symbols WHERE project_id = ? AND is_deleted = 0 AND (name LIKE ? OR qualified_name LIKE ? OR file_path LIKE ? OR signature LIKE ?) LIMIT 100`;
  const params = options.kind
    ? [options.projectId, options.kind, like, like, like, like]
    : [options.projectId, like, like, like, like];
  const symbols = db.prepare(sql).all(...params) as SymbolRow[];
  const decisionRefs = symbolIdsForDecisionMatches(options.projectId, query);
  const historyRefs = symbolIdsForHistoryMatches(options.projectId, query);
  const lowerQuery = query.toLowerCase();

  return symbols
    .map(symbol => {
      const why: string[] = [];
      let score = 0;
      const name = symbol.name.toLowerCase();
      const qualified = symbol.qualified_name.toLowerCase();
      const file = symbol.file_path.toLowerCase();
      const signature = (symbol.signature || '').toLowerCase();

      if (name === lowerQuery || qualified === lowerQuery) {
        score += 100;
        why.push('exact_symbol_match');
      } else if (name.startsWith(lowerQuery) || qualified.startsWith(lowerQuery)) {
        score += 70;
        why.push('prefix_symbol_match');
      } else if (name.includes(lowerQuery) || qualified.includes(lowerQuery)) {
        score += 50;
        why.push('symbol_name_match');
      }
      if (file.includes(lowerQuery)) {
        score += 25;
        why.push('file_path_match');
      }
      if (signature.includes(lowerQuery)) {
        score += 15;
        why.push('signature_match');
      }
      if (decisionRefs.has(symbol.id)) {
        score += 20;
        why.push('linked_decision_match');
      }
      if (historyRefs.has(symbol.id)) {
        score += 10;
        why.push('linked_history_match');
      }

      return {
        score,
        why_this_matched: why.length > 0 ? why : ['broad_metadata_match'],
        symbol: formatSymbol(symbol, { includeBody: false, verbose: false })
      };
    })
    .sort((a, b) => b.score - a.score || String((a.symbol as any).name).localeCompare(String((b.symbol as any).name)))
    .slice(0, options.limit)
    .map((result, index) => ({ rank: index + 1, ...result }));
}

function buildReadContext(symbol: SymbolRow, options: { includeBody: boolean; includeTests: boolean; maxCallers: number; maxHistory: number }) {
  const callers = findCallersForSymbol(symbol, options.includeTests, 0.0);
  const decisions = decisionsForSymbolIds(symbol.project_id, [symbol.id]);
  const history = db.prepare(`
    SELECT sh.version, sh.commit_sha, sh.commit_message, sh.commit_author, sh.commit_at, sh.change_type, sh.branch, sh.pr_reference
    FROM symbol_history sh
    WHERE sh.symbol_id = ?
    ORDER BY sh.version DESC
    LIMIT ?
  `).all(symbol.id, options.maxHistory);

  return {
    target: formatSymbol(symbol, { includeBody: options.includeBody, verbose: true }),
    freshness: getFileFreshness(symbol.file_path, symbol.project_id),
    callers: {
      definite: callers.definite_callers.slice(0, options.maxCallers),
      probable: callers.probable_callers.slice(0, options.maxCallers)
    },
    decisions,
    history,
    notes: contextNotes(symbol, callers.definite_callers.length, decisions.length)
  };
}

function buildSymbolImpact(symbol: SymbolRow, options: { includeTests: boolean; maxCallers: number }) {
  const callers = findCallersForSymbol(symbol, options.includeTests, 0.0);
  const definite = callers.definite_callers.slice(0, options.maxCallers);
  const probable = callers.probable_callers.slice(0, options.maxCallers);
  const decisions = decisionsForSymbolIds(symbol.project_id, [symbol.id]);
  const freshness = getFileFreshness(symbol.file_path, symbol.project_id);
  const impactCount = definite.length + probable.length;
  return {
    mode: "target_symbol",
    target: formatSymbol(symbol, { includeBody: false, verbose: false }),
    freshness,
    callers: { definite, probable },
    related_decisions: decisions,
    risk_level: riskLevel(impactCount, decisions.length, freshness.freshness),
    why: impactWhy(impactCount, decisions.length, freshness.freshness)
  };
}

function findCallersForSymbol(symbol: SymbolRow, includeTests: boolean, minConfidence: number) {
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
  `).all(symbol.project_id, symbol.id, symbol.name, symbol.file_path) as Array<{
    id: string;
    qualified_name: string;
    file_path: string;
    confidence: number;
    resolution_method: string;
    line: number;
  }>;

  if (!includeTests) {
    astCallers = astCallers.filter(c => !isTestFile(c.file_path));
  }

  const astCallerIds = new Set(astCallers.map(c => c.id));
  let fuzzyCallers = db.prepare("SELECT * FROM symbols WHERE project_id = ? AND body LIKE ? AND id != ? AND is_deleted = 0")
    .all(symbol.project_id, `%${symbol.name}%`, symbol.id) as SymbolRow[];
  if (!includeTests) {
    fuzzyCallers = fuzzyCallers.filter(c => !isTestFile(c.file_path));
  }
  fuzzyCallers = fuzzyCallers.filter(c => !astCallerIds.has(c.id));

  const definiteCallers = astCallers.map(c => ({
    symbol_id: c.id,
    ref: symbolRef(c.id),
    qualified_name: c.qualified_name,
    file_path: relativeDisplayPath(c.file_path),
    line: c.line,
    confidence: c.confidence,
    resolution_method: c.resolution_method
  })).filter(c => c.confidence >= minConfidence);

  const probableCallers = fuzzyCallers.map(c => ({
    symbol_id: c.id,
    ref: c.ref || symbolRef(c.id),
    qualified_name: c.qualified_name,
    file_path: relativeDisplayPath(c.file_path),
    confidence: 0.5,
    resolution_method: 'fuzzy_name_match'
  })).filter(c => c.confidence >= minConfidence);

  return {
    definite_callers: definiteCallers,
    probable_callers: probableCallers
  };
}

function resolveActiveSymbol(symbolId: string | undefined, ref: string | undefined, projectId: string) {
  const resolvedId = symbolId || (ref ? resolveSymbolIdFromRef(ref, projectId) : undefined);
  if (!resolvedId) return undefined;
  return db.prepare("SELECT * FROM symbols WHERE id = ? AND project_id = ? AND is_deleted = 0")
    .get(resolvedId, projectId) as SymbolRow | undefined;
}

function decisionsForSymbolIds(projectId: string, symbolIds: string[]) {
  if (symbolIds.length === 0) return [];
  return decorateDecisions(db.prepare(`
    SELECT DISTINCT d.id, d.summary, d.rationale, d.status, d.confidence, d.decided_at
    FROM project_decisions d
    JOIN decision_symbol_references dsr ON d.id = dsr.decision_id
    WHERE d.project_id = ?
    AND dsr.symbol_id IN (${symbolIds.map(() => '?').join(',')})
    ORDER BY d.status = 'active' DESC, d.decided_at DESC
    LIMIT 20
  `).all(projectId, ...symbolIds), projectId);
}

function findDecisionMatches(projectId: string, query: string, limit: number) {
  const like = `%${query}%`;
  return decorateDecisions(db.prepare(`
    SELECT id, summary, status, confidence, decided_at, review_required_at, review_reason, superseded_by
    FROM project_decisions
    WHERE project_id = ?
    AND (summary LIKE ? OR rationale LIKE ?)
    ORDER BY decided_at DESC
    LIMIT ?
  `).all(projectId, like, like, limit), projectId);
}

function decorateDecisions(decisions: any[], projectId: string) {
  return decisions.map(decision => {
    const linkedSymbols = db.prepare(`
      SELECT s.id, s.name, s.qualified_name, s.updated_at
      FROM symbols s
      JOIN decision_symbol_references dsr ON s.id = dsr.symbol_id
      WHERE dsr.decision_id = ?
      AND s.project_id = ?
      ORDER BY s.qualified_name
    `).all(decision.id, projectId) as Array<{ id: string; name: string; qualified_name: string; updated_at: number }>;
    const changedAfterDecision = linkedSymbols.filter(symbol => symbol.updated_at > decision.decided_at);
    const needsReview = decision.review_required_at || changedAfterDecision.length > 0 || decision.status === 'under_review';
    return {
      ...decision,
      memory_state: decision.status === 'superseded' ? 'superseded' : needsReview ? 'needs_review' : 'current',
      review_required_at: decision.review_required_at || (changedAfterDecision.length > 0 ? Math.max(...changedAfterDecision.map(symbol => symbol.updated_at)) : null),
      review_reason: decision.review_reason || (changedAfterDecision.length > 0 ? 'linked_symbol_changed_after_decision' : null),
      stale_symbols: changedAfterDecision.map(symbol => ({
        symbol_id: symbol.id,
        name: symbol.name,
        qualified_name: symbol.qualified_name,
        updated_at: symbol.updated_at
      }))
    };
  });
}

function markDecisionsForReview(projectId: string, symbolIds: string[], reason: string) {
  if (symbolIds.length === 0) return 0;
  const now = Date.now();
  const result = db.prepare(`
    UPDATE project_decisions
    SET status = CASE WHEN status = 'active' THEN 'under_review' ELSE status END,
        review_required_at = COALESCE(review_required_at, ?),
        review_reason = COALESCE(review_reason, ?)
    WHERE project_id = ?
    AND status = 'active'
    AND id IN (
      SELECT decision_id
      FROM decision_symbol_references
      WHERE symbol_id IN (${symbolIds.map(() => '?').join(',')})
    )
  `).run(now, reason, projectId, ...symbolIds);
  return result.changes;
}

function findHistoryMatches(projectId: string, query: string, limit: number) {
  if (!query.trim()) return [];
  try {
    return db.prepare(`
      SELECT m.id, m.content, m.created_at
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      JOIN messages_fts fts ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ?
      AND s.project_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query, projectId, limit);
  } catch {
    return [];
  }
}

function symbolIdsForDecisionMatches(projectId: string, query: string) {
  const like = `%${query}%`;
  const rows = db.prepare(`
    SELECT DISTINCT dsr.symbol_id
    FROM project_decisions d
    JOIN decision_symbol_references dsr ON d.id = dsr.decision_id
    WHERE d.project_id = ?
    AND (d.summary LIKE ? OR d.rationale LIKE ?)
  `).all(projectId, like, like) as Array<{ symbol_id: string }>;
  return new Set(rows.map(row => row.symbol_id));
}

function symbolIdsForHistoryMatches(projectId: string, query: string) {
  if (!query.trim()) return new Set<string>();
  try {
    const rows = db.prepare(`
      SELECT DISTINCT msr.symbol_id
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      JOIN messages_fts fts ON m.rowid = fts.rowid
      JOIN message_symbol_references msr ON m.id = msr.message_id
      WHERE messages_fts MATCH ?
      AND s.project_id = ?
    `).all(query, projectId) as Array<{ symbol_id: string }>;
    return new Set(rows.map(row => row.symbol_id));
  } catch {
    return new Set<string>();
  }
}

function riskLevel(impactCount: number, decisionCount: number, freshness: string) {
  if (freshness === 'stale') return 'high';
  if (impactCount >= 5 || decisionCount >= 2) return 'high';
  if (impactCount > 0 || decisionCount > 0 || freshness === 'unknown') return 'medium';
  return 'low';
}

function impactWhy(impactCount: number, decisionCount: number, freshness: string) {
  const why: string[] = [];
  if (freshness !== 'fresh') why.push(`freshness_${freshness}`);
  if (impactCount > 0) why.push(`${impactCount}_caller_or_changed_symbol_links`);
  if (decisionCount > 0) why.push(`${decisionCount}_linked_decisions`);
  return why.length > 0 ? why : ['no_linked_callers_or_decisions_found'];
}

function contextNotes(symbol: SymbolRow, definiteCallerCount: number, decisionCount: number) {
  const notes = [`target=${symbol.qualified_name}`];
  if (definiteCallerCount > 0) notes.push(`${definiteCallerCount}_definite_callers`);
  if (decisionCount > 0) notes.push(`${decisionCount}_linked_decisions`);
  return notes;
}

function isTestFile(filePath: string) {
  return /[._-](test|spec)\.[^.]+$/.test(filePath);
}

function budgetedJson(payload: any, maxTokens?: number) {
  const budget = normalizeTokenBudget(maxTokens);
  if (!budget) return JSON.stringify(payload);

  const maxChars = budget * 4;
  const result = JSON.parse(JSON.stringify(payload));
  result.budget = {
    max_tokens: budget,
    estimated_tokens: estimateTokens(result),
    truncated: false
  };

  if (JSON.stringify(result).length <= maxChars) {
    result.budget.estimated_tokens = estimateTokens(result);
    return JSON.stringify(result);
  }

  result.budget.truncated = true;
  result.budget.omitted = [];

  const shrinkers = [
    () => popArray(result.history_matches, 0, result.budget.omitted, 'history_matches'),
    () => popArray(result.history, 0, result.budget.omitted, 'history'),
    () => popArray(result.callers?.probable, 0, result.budget.omitted, 'probable_callers'),
    () => popArray(result.callers?.definite, 0, result.budget.omitted, 'definite_callers'),
    () => popArray(result.decisions, 0, result.budget.omitted, 'decisions'),
    () => popArray(result.related_decisions, 0, result.budget.omitted, 'related_decisions'),
    () => popArray(result.changed_symbols, 0, result.budget.omitted, 'changed_symbols'),
    () => popArray(result.results, 1, result.budget.omitted, 'results'),
    () => truncateBody(result)
  ];

  let changed = true;
  while (JSON.stringify(result).length > maxChars && changed) {
    changed = false;
    for (const shrink of shrinkers) {
      if (JSON.stringify(result).length <= maxChars) break;
      changed = shrink() || changed;
    }
  }

  result.budget.estimated_tokens = estimateTokens(result);
  return JSON.stringify(result);
}

function normalizeTokenBudget(maxTokens?: number) {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) return undefined;
  return Math.max(120, Math.floor(maxTokens));
}

function estimateTokens(value: any) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function popArray(value: any, minLength = 0, omitted?: string[], label?: string) {
  if (!Array.isArray(value) || value.length <= minLength) return false;
  value.pop();
  if (omitted && label && !omitted.includes(label)) omitted.push(label);
  return true;
}

function truncateBody(result: any) {
  const target = result.target;
  if (!target || typeof target.body !== 'string') return false;
  if (target.body.length <= 240) {
    delete target.body;
    target.body_omitted_by_budget = true;
    return true;
  }
  target.body = `${target.body.slice(0, Math.max(120, Math.floor(target.body.length / 2)))}\n/* body truncated by max_tokens */`;
  target.body_truncated_by_budget = true;
  return true;
}

function resolveSymbolIdFromRef(ref: string | undefined, projectId: string) {
  if (!ref) return undefined;
  const indexed = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND ref = ? AND is_deleted = 0 LIMIT 1")
    .get(projectId, ref) as Pick<SymbolRow, 'id'> | undefined;
  if (indexed) return indexed.id;

  const symbols = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND is_deleted = 0").all(projectId) as Pick<SymbolRow, 'id'>[];
  const legacy = symbols.find(symbol => symbolRef(symbol.id) === ref);
  if (legacy) {
    db.prepare("UPDATE symbols SET ref = ? WHERE id = ? AND (ref IS NULL OR ref = '')").run(ref, legacy.id);
  }
  return legacy?.id;
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

function packageVersion() {
  const candidates = [
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package.json')
  ];
  for (const candidate of candidates) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (packageJson.version) return packageJson.version;
    } catch {
      // Runtime can be launched from source or dist; try the next likely package path.
    }
  }
  return process.env.npm_package_version || '0.0.0';
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
