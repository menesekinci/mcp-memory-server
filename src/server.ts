import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import db from "./db.ts";
import { v4 as uuidv4 } from 'uuid';
import { resolveSymbolReferences } from "./symbol-resolver.ts";

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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "lookup_symbol",
        description: "Find a symbol by its name with detailed info",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            project_id: { type: "string", default: "default" }
          },
          required: ["name"],
        },
      },
      {
        name: "get_symbol_history",
        description: "Get the version history of a symbol",
        inputSchema: {
          type: "object",
          properties: {
            symbol_id: { type: "string" },
            limit: { type: "number", default: 10 }
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
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "lookup_symbol") {
    const projectName = args?.project_id || 'default';
    const symbolName = args?.name;
    const symbols = db.prepare("SELECT * FROM symbols WHERE name = ? AND project_id = ?").all(symbolName, projectName);
    return {
      content: [{ type: "text", text: JSON.stringify(symbols) }],
    };
  }

  if (name === "get_symbol_history") {
    const symbolId = args?.symbol_id;
    const history = db.prepare("SELECT * FROM symbol_history WHERE symbol_id = ? ORDER BY version DESC LIMIT ?").all(symbolId, args?.limit || 10);
    return {
      content: [{ type: "text", text: JSON.stringify(history) }],
    };
  }

  if (name === "changed_since") {
    const projectName = args?.project_id || 'default';
    const since = args?.since;
    const symbols = db.prepare("SELECT * FROM symbols WHERE project_id = ? AND updated_at > ?").all(projectName, since);
    return {
      content: [{ type: "text", text: JSON.stringify(symbols) }],
    };
  }

  if (name === "find_callers") {
    const symbolId = args?.symbol_id;
    const symbol = db.prepare("SELECT * FROM symbols WHERE id = ?").get(symbolId);
    if (!symbol) {
        return { content: [{ type: "text", text: "Symbol not found." }] };
    }
    const callers = db.prepare("SELECT * FROM symbols WHERE body LIKE ? AND id != ?").all(`%${symbol.name}%`, symbolId);
    return {
      content: [{ type: "text", text: JSON.stringify({
          definite_callers: callers.map(c => ({
              symbol_id: c.id,
              qualified_name: c.qualified_name,
              file_path: c.file_path,
              confidence: 0.7,
              resolution_method: 'fuzzy_name_match'
          })),
          probable_callers: []
      }) }],
    };
  }

  if (name === "index_status") {
    const projectName = args?.project_id;
    const total = db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ?").get(projectName)?.count || 0;
    const excluded = db.prepare("SELECT count(*) as count FROM files WHERE project_id = ? AND is_excluded = 1").get(projectName)?.count || 0;
    return {
      content: [{ type: "text", text: JSON.stringify({ status: 'ready', total_symbols: total, excluded_files: excluded }) }],
    };
  }

  if (name === "save_message") {
    const { session_id, role, content, explicit_symbols = [] } = args;
    const messageId = uuidv4();
    const now = Date.now();

    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(messageId, session_id, role, content, now);

    const references = await resolveSymbolReferences(content, explicit_symbols);
    
    const insertRef = db.prepare("INSERT INTO message_symbol_references (message_id, symbol_id, confidence, reference_type, extraction_source) VALUES (?, ?, ?, ?, ?)");
    const transaction = db.transaction((refs) => {
        for (const ref of refs) {
            insertRef.run(messageId, ref.symbol_id, ref.confidence, ref.reference_type, ref.extraction_source);
        }
    });
    transaction(references);

    db.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)").run(db.prepare("SELECT rowid FROM messages WHERE id = ?").get(messageId).rowid, content);

    return {
      content: [{ type: "text", text: `Message saved. Extracted ${references.length} symbol references.` }],
    };
  }

  if (name === "search_history") {
    const query = args?.query;
    const results = db.prepare(`
        SELECT m.id, m.content, m.created_at 
        FROM messages m
        JOIN messages_fts fts ON m.rowid = fts.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
    `).all(query, args?.limit || 20);

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
    const transaction = db.transaction((symbols) => {
        for (const symName of symbols) {
            const symbol = db.prepare("SELECT id FROM symbols WHERE name = ? LIMIT 1").get(symName);
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
    let query = "SELECT * FROM project_decisions WHERE project_id = ? AND status = ?";
    const params = [project_id, status];

    if (symbol) {
        query = `
            SELECT d.* FROM project_decisions d
            JOIN decision_symbol_references dsr ON d.id = dsr.decision_id
            JOIN symbols s ON dsr.symbol_id = s.id
            WHERE d.project_id = ? AND d.status = ? AND s.name = ?
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
      WHERE s.updated_at > m.created_at
    `).all();
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
      WHERE s.updated_at BETWEEN ? AND ? 
      AND msr.confidence >= ?
    `).all(dayStart, dayEnd, min_confidence);

    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }

  if (name === "context_since_last_session") {
    const project_id = args?.project_id || 'default';
    const lastSession = db.prepare("SELECT ended_at FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 1").get(project_id);
    
    if (!lastSession) {
        return { content: [{ type: "text", text: "No previous sessions found for this project." }] };
    }

    const lastEndedAt = lastSession.ended_at || Date.now();
    const changedSymbols = db.prepare("SELECT id, name, updated_at FROM symbols WHERE project_id = ? AND updated_at > ?").all(project_id, lastEndedAt);
    
    const activeDecisions = db.prepare("SELECT id, summary FROM project_decisions WHERE project_id = ? AND status = 'active'").all(project_id);

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
        db.prepare("DELETE FROM messages WHERE session_id = ?").run(session_id);
        db.prepare("DELETE FROM message_symbol_references WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)").run(session_id);
        db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(session_id);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(session_id);

        if (mode === 'raw_and_derived') {
            db.prepare("UPDATE project_decisions SET status = 'superseded' WHERE source_session = ?").run(session_id);
        }
    });

    transaction();
    return {
      content: [{ type: "text", text: `Session ${session_id} forgotten in ${mode} mode.` }],
    };
  }

  throw new Error(`Tool not found: ${name}`);
});

export async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Memory Server running on stdio");
}
