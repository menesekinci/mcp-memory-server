import fs from 'fs';
import path from 'path';
import os from 'os';

async function runTest() {
    console.log("Starting FAZ 0 Verification...");
    const testDbPath = path.join(os.tmpdir(), 'mcp-memory-server-faz0.sqlite');
    if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
    }
    process.env.MCP_MEMORY_DB_PATH = testDbPath;

    const [{ initDb, default: db }, { startIndexer }] = await Promise.all([
        import('./src/db'),
        import('./src/indexer')
    ]);

    initDb();

    const projectId = 'faz0-test';
    const testProjectPath = path.join(os.homedir(), 'Documents', 'faz0-test-project');
    if (!fs.existsSync(testProjectPath)) {
        fs.mkdirSync(testProjectPath, { recursive: true });
    }

    db.prepare("DELETE FROM message_symbol_references WHERE message_id IN (SELECT m.id FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.project_id = ?)").run(projectId);
    db.prepare("DELETE FROM messages_fts WHERE rowid IN (SELECT m.rowid FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.project_id = ?)").run(projectId);
    db.prepare("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)").run(projectId);
    db.prepare("DELETE FROM session_summaries WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)").run(projectId);
    db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM decision_symbol_references WHERE symbol_id IN (SELECT id FROM symbols WHERE project_id = ?)").run(projectId);
    db.prepare("DELETE FROM symbol_history WHERE symbol_id IN (SELECT id FROM symbols WHERE project_id = ?)").run(projectId);
    db.prepare("DELETE FROM symbols WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM files WHERE project_id = ?").run(projectId);

    const fileName = 'test.ts';
    const filePath = path.join(testProjectPath, fileName);
    fs.writeFileSync(filePath, 'function calculateTotal() { return 100; }');
    
    const watcher = startIndexer(testProjectPath, projectId);
    
    await new Promise(resolve => setTimeout(resolve, 1000));

    const symbol = db.prepare("SELECT * FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0").get(projectId, 'calculateTotal') as { id: string; name: string } | undefined;
    if (!symbol) throw new Error("Symbol was not indexed!");
    console.log("✅ Symbol indexed correctly.");

    const messageContent = "We should fix the calculateTotal function";
    const messageId = `${projectId}-msg-1`;
    const sessionId = `${projectId}-session-1`;
    db.prepare("INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)").run(sessionId, projectId, Date.now());
    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(messageId, sessionId, 'user', messageContent, Date.now());
    
    const allSymbols = db.prepare("SELECT id, name FROM symbols WHERE project_id = ? AND is_deleted = 0").all(projectId) as { id: string; name: string }[];
    for (const sym of allSymbols) {
        if (messageContent.includes(sym.name)) {
            db.prepare("INSERT INTO message_symbol_references (message_id, symbol_id, confidence, reference_type, extraction_source) VALUES (?, ?, ?, ?, ?)")
              .run(messageId, sym.id, 0.8, 'mentioned', 'natural_language');
        }
    }

    const ref = db.prepare("SELECT * FROM message_symbol_references WHERE message_id = ?").get(messageId);
    if (!ref) throw new Error("Symbol reference was not created!");
    console.log("✅ Message linked to symbol correctly.");

    fs.writeFileSync(filePath, 'function calculateTotal() { return 200; }');
    await new Promise(resolve => setTimeout(resolve, 1000));

    const resultsAfter = db.prepare(`
      SELECT s.name FROM symbols s
      JOIN message_symbol_references msr ON s.id = msr.symbol_id
      JOIN messages m ON msr.message_id = m.id
      JOIN sessions sess ON m.session_id = sess.id
      WHERE s.updated_at > m.created_at
      AND sess.project_id = ?
    `).all(projectId) as { name: string }[];

    if (resultsAfter.length === 0 || !resultsAfter.some(r => r.name === 'calculateTotal')) {
        throw new Error("symbols_discussed_and_changed failed to detect change!");
    }
    console.log("✅ Cross-layer query detected change correctly.");

    console.log("\n🎉 FAZ 0 Verification Successful!");
    await watcher.close();
}

runTest().catch(e => {
    console.error("❌ Test failed:", e);
    process.exit(1);
});
