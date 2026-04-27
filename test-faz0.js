"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_ts_1 = require("./src/db.ts");
const indexer_ts_1 = require("./src/indexer.ts");
const db_ts_2 = __importDefault(require("./src/db.ts"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
async function runTest() {
    console.log("Starting FAZ 0 Verification...");
    (0, db_ts_1.initDb)();
    const testProjectPath = path_1.default.join(os_1.default.homedir(), 'Documents', 'faz0-test-project');
    if (!fs_1.default.existsSync(testProjectPath)) {
        fs_1.default.mkdirSync(testProjectPath, { recursive: true });
    }
    // 1. Test Indexing
    const fileName = 'test.ts';
    const filePath = path_1.default.join(testProjectPath, fileName);
    fs_1.default.writeFileSync(filePath, 'function calculateTotal() { return 100; }');
    (0, indexer_ts_1.startIndexer)(testProjectPath);
    // Wait for chokidar to pick it up
    await new Promise(resolve => setTimeout(resolve, 1000));
    const symbol = db_ts_2.default.prepare("SELECT * FROM symbols WHERE name = ?").get('calculateTotal');
    if (!symbol)
        throw new Error("Symbol was not indexed!");
    console.log("✅ Symbol indexed correctly.");
    // 2. Test Message Saving & Reference Extraction
    const messageContent = "We should fix the calculateTotal function";
    const messageId = 'msg-1';
    db_ts_2.default.prepare("INSERT INTO messages (id, content, created_at) VALUES (?, ?, ?)").run(messageId, messageContent, Date.now());
    // Simulate the extraction logic from server.ts
    const allSymbols = db_ts_2.default.prepare("SELECT id, name FROM symbols").all();
    for (const sym of allSymbols) {
        if (messageContent.includes(sym.name)) {
            db_ts_2.default.prepare("INSERT INTO message_symbol_references (message_id, symbol_id, confidence) VALUES (?, ?, ?)")
                .run(messageId, sym.id, 0.8);
        }
    }
    const ref = db_ts_2.default.prepare("SELECT * FROM message_symbol_references WHERE message_id = ?").get(messageId);
    if (!ref)
        throw new Error("Symbol reference was not created!");
    console.log("✅ Message linked to symbol correctly.");
    // 3. Test Cross-Layer Query (Discussed and Changed)
    // First, check that it's NOT returned yet (because updated_at is not > message.created_at)
    const resultsBefore = db_ts_2.default.prepare(`
      SELECT s.name FROM symbols s
      JOIN message_symbol_references msr ON s.id = msr.symbol_id
      JOIN messages m ON msr.message_id = m.id
      WHERE s.updated_at > m.created_at
    `).all();
    if (resultsBefore.length > 0) {
        console.log("Warning: Found results before change. This might be due to timing.");
    }
    // Update the file
    fs_1.default.writeFileSync(filePath, 'function calculateTotal() { return 200; }');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const resultsAfter = db_ts_2.default.prepare(`
      SELECT s.name FROM symbols s
      JOIN message_symbol_references msr ON s.id = msr.symbol_id
      JOIN messages m ON msr.message_id = m.id
      WHERE s.updated_at > m.created_at
    `).all();
    if (resultsAfter.length === 0 || !resultsAfter.some((r) => r.name === 'calculateTotal')) {
        throw new Error("symbols_discussed_and_changed failed to detect change!");
    }
    console.log("✅ Cross-layer query detected change correctly.");
    console.log("\n🎉 FAZ 0 Verification Successful!");
}
runTest().catch(e => {
    console.error("❌ Test failed:", e);
    process.exit(1);
});
//# sourceMappingURL=test-faz0.js.map