import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_PATH = process.env.MCP_MEMORY_DB_PATH || path.join(os.homedir(), '.mcp-memory-server', 'memory.db');

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

export function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS symbols (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            qualified_name TEXT NOT NULL,
            kind TEXT NOT NULL,
            file_path TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            signature TEXT,
            body TEXT,
            language TEXT NOT NULL,
            commit_sha TEXT,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS symbol_history (
            id TEXT PRIMARY KEY,
            symbol_id TEXT NOT NULL REFERENCES symbols(id),
            version INTEGER NOT NULL,
            body TEXT,
            signature TEXT,
            start_line INTEGER,
            end_line INTEGER,
            commit_sha TEXT NOT NULL,
            commit_message TEXT,
            commit_author TEXT,
            commit_at INTEGER NOT NULL,
            change_type TEXT NOT NULL,
            branch TEXT,
            pr_reference TEXT
        );

        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            path TEXT NOT NULL,
            language TEXT,
            last_indexed_at INTEGER NOT NULL,
            git_blob_sha TEXT,
            is_excluded INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            title TEXT,
            tags TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            role TEXT NOT NULL CHECK(role IN ('user', 'agent')),
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS message_symbol_references (
            message_id TEXT NOT NULL REFERENCES messages(id),
            symbol_id TEXT NOT NULL REFERENCES symbols(id),
            confidence REAL NOT NULL,
            reference_type TEXT NOT NULL CHECK(reference_type IN ('mentioned', 'modified', 'explained', 'debugged', 'rejected', 'approved')),
            extraction_source TEXT NOT NULL CHECK(extraction_source IN ('explicit_tool_call', 'code_block', 'natural_language', 'agent_summary')),
            PRIMARY KEY (message_id, symbol_id)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            content='messages',
            content_rowid='rowid'
        );

        CREATE TABLE IF NOT EXISTS session_summaries (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            summary TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_decisions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            rationale TEXT,
            decided_at INTEGER NOT NULL,
            source_session TEXT REFERENCES sessions(id),
            superseded_by TEXT REFERENCES project_decisions(id),
            confidence REAL DEFAULT 1.0,
            status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'under_review'))
        );

        CREATE TABLE IF NOT EXISTS decision_symbol_references (
            decision_id TEXT NOT NULL REFERENCES project_decisions(id),
            symbol_id TEXT NOT NULL REFERENCES symbols(id),
            PRIMARY KEY (decision_id, symbol_id)
        );

        CREATE INDEX IF NOT EXISTS idx_symbols_project ON symbols(project_id);
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_project_name ON symbols(project_id, name);
        CREATE INDEX IF NOT EXISTS idx_files_project_path ON files(project_id, path);
        CREATE INDEX IF NOT EXISTS idx_history_symbol ON symbol_history(symbol_id);
        CREATE INDEX IF NOT EXISTS idx_history_commit ON symbol_history(commit_sha);
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    `);
}

export default db;
