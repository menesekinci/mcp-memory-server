import { initDb } from './src/db';
import { startIndexer } from './src/indexer';
import db from './src/db';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function runTest() {
    console.log("Starting FAZ 0 Verification...");
    initDb();

    const testProjectPath = path.join(os.homedir(), 'Documents', 'faz0-test-project');
    if (!fs.existsSync(testProjectPath)) {
        fs.mkdirSync(testProjectPath, { recursive: true });
    }

    const fileName = 'test.ts';
    const filePath = path.join(testProjectPath, fileName);
    fs.writeFileSync(filePath, 'function calculateTotal() { return 100; }');
    
    startIndexer(testProjectPath);
    
    await new Promise(resolve => setTimeout(resolve, 1000));

    const symbol = db.prepare("SELECT * FROM symbols WHERE name = ?").get('calculateTotal');
    if (!symbol) throw new Error("Symbol was not indexed!");
    console.log("✅ Symbol indexed correctly.");

    const messageContent = "We should fix the calculateTotal function";
    const messageId = 'msg-1';
    const sessionId = 'session-1';
    db.prepare("INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)").run(sessionId, 'default', Date.now());
    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(messageId, sessionId, 'user', messageContent, Date.now());
    
    const allSymbols = db.prepare("SELECT id, name FROM symbols").all();
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
      WHERE s.updated_at > m.created_at
    `).all();

    if (resultsAfter.length === 0 || !resultsAfter.some(r => r.name === 'calculateTotal')) {
        throw new Error("symbols_discussed_and_changed failed to detect change!");
    }
    console.log("✅ Cross-layer query detected change correctly.");

    console.log("\n🎉 FAZ 0 Verification Successful!");
}

runTest().catch(e => {
    console.error("❌ Test failed:", e);
    process.exit(1);
});
