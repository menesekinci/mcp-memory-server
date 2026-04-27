import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

type TestDb = typeof import('./src/db').default;

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function parseToolJson<T>(result: any): T {
    return JSON.parse(result.content[0].text) as T;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for condition');
}

function createTempDir(name: string) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

async function withIsolatedRuntime() {
    const dbPath = path.join(os.tmpdir(), `mcp-memory-server-integration-${Date.now()}.sqlite`);
    process.env.MCP_MEMORY_DB_PATH = dbPath;

    const [{ initDb, default: db }, indexer, server, gitParser] = await Promise.all([
        import('./src/db'),
        import('./src/indexer'),
        import('./src/server'),
        import('./src/git-parser')
    ]);

    initDb();

    return {
        db,
        startIndexer: indexer.startIndexer,
        callTool: server.callTool,
        indexGitHistory: gitParser.indexGitHistory
    };
}

async function testMcpTools(db: TestDb, callTool: (name: string, args?: Record<string, any>) => Promise<any>) {
    const projectId = 'tools-project';
    const sessionId = 'tools-session';
    const now = Date.now();
    const symbolId = `${projectId}:memory.ts:function:calculateTotal`;

    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(symbolId, projectId, 'calculateTotal', 'calculateTotal', 'function', 'memory.ts', 1, 3, 'function calculateTotal()', 'function calculateTotal() { return 1; }', 'typescript', now);

    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(`${projectId}:caller.ts:function:checkout`, projectId, 'checkout', 'checkout', 'function', 'caller.ts', 1, 3, 'function checkout()', 'function checkout() { return calculateTotal(); }', 'typescript', now);

    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(`${projectId}:caller.test.ts:function:checkoutTest`, projectId, 'checkoutTest', 'checkoutTest', 'function', 'caller.test.ts', 1, 3, 'function checkoutTest()', 'function checkoutTest() { return calculateTotal(); }', 'typescript', now);

    db.prepare("INSERT INTO sessions (id, project_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, projectId, now - 1000, now - 500);

    const saved = await callTool('save_message', {
        session_id: sessionId,
        role: 'user',
        content: 'Please review calculateTotal and this note has a uniqueSearchTerm.',
        explicit_symbols: ['calculateTotal']
    });
    assert(saved.content[0].text.includes('Extracted 1 symbol references'), 'save_message did not link the explicit symbol');

    const lookup = parseToolJson<any[]>(await callTool('lookup_symbol', {
        project_id: projectId,
        name: 'calculateTotal'
    }));
    assert(lookup.length === 1, 'lookup_symbol should find the symbol by exact name');
    assert(!('body' in lookup[0]), 'lookup_symbol should omit body by default');
    assert('ref' in lookup[0] && !('id' in lookup[0]), 'lookup_symbol should return compact refs by default');
    assert(lookup[0].file === 'memory.ts' || lookup[0].file.endsWith('memory.ts'), 'lookup_symbol should return a short display path');

    const lookupWithBody = parseToolJson<any[]>(await callTool('lookup_symbol', {
        project_id: projectId,
        name: 'calculateTotal',
        include_body: true
    }));
    assert(lookupWithBody[0].body.includes('return 1'), 'lookup_symbol include_body=true should include the body');

    const symbolSearch = parseToolJson<any[]>(await callTool('search_symbols', {
        project_id: projectId,
        query: 'calc',
        limit: 5
    }));
    assert(symbolSearch.length === 1 && !('body' in symbolSearch[0]), 'search_symbols should return compact symbol matches');
    assert('ref' in symbolSearch[0] && !('id' in symbolSearch[0]), 'search_symbols should use compact refs by default');

    const symbolBody = parseToolJson<any>(await callTool('get_symbol_body', {
        symbol_id: symbolId
    }));
    assert(symbolBody.body.includes('calculateTotal'), 'get_symbol_body should return the full symbol body');

    const symbolBodyByRef = parseToolJson<any>(await callTool('get_symbol_body', {
        project_id: projectId,
        ref: lookup[0].ref
    }));
    assert(symbolBodyByRef.body.includes('calculateTotal'), 'get_symbol_body should resolve compact refs');

    const searchResults = parseToolJson<any[]>(await callTool('search_history', {
        project_id: projectId,
        query: 'uniqueSearchTerm'
    }));
    assert(searchResults.length === 1, 'search_history should return the saved message in the same project');

    const callers = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', {
        symbol_id: symbolId,
        include_tests: false,
        min_confidence: 0.5
    }));
    const allCallers = [...callers.definite_callers, ...(callers as any).probable_callers];
    assert(allCallers.length === 1, 'find_callers should exclude test files when requested');
    assert(allCallers[0].qualified_name === 'checkout', 'find_callers returned the wrong caller');

    await callTool('save_decision', {
        project_id: projectId,
        summary: 'Use calculateTotal as the billing total boundary',
        rationale: 'It centralizes billing math.',
        source_session: sessionId,
        related_symbols: ['calculateTotal']
    });

    const activeDecisions = parseToolJson<any[]>(await callTool('get_decisions', {
        project_id: projectId,
        symbol: 'calculateTotal'
    }));
    assert(activeDecisions.length === 1, 'get_decisions should find the active decision linked to a symbol');

    const context = parseToolJson<{ active_decisions: any[] }>(await callTool('context_since_last_session', {
        project_id: projectId
    }));
    assert(context.active_decisions.length === 1, 'context_since_last_session should include active decisions');

    await callTool('forget_session', {
        session_id: sessionId,
        mode: 'raw_and_derived'
    });

    const messagesLeft = db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(sessionId) as { count: number };
    const refsLeft = db.prepare("SELECT COUNT(*) as count FROM message_symbol_references").get() as { count: number };
    assert(messagesLeft.count === 0, 'forget_session should delete raw messages');
    assert(refsLeft.count === 0, 'forget_session should delete message-symbol references before deleting messages');

    const allDecisions = parseToolJson<any[]>(await callTool('get_decisions', {
        project_id: projectId,
        status: 'all'
    }));
    assert(allDecisions.length === 1 && allDecisions[0].status === 'superseded', 'forget_session raw_and_derived should supersede derived decisions');
}

async function testIndexerEdges(db: TestDb, startIndexer: (projectPath: string, projectId?: string) => any, callTool: (name: string, args?: Record<string, any>) => Promise<any>) {
    const projectA = 'indexer-a';
    const projectB = 'indexer-b';
    const projectPath = createTempDir('mcp-memory-indexer');
    const sourceFile = path.join(projectPath, 'src', 'math.ts');
    const secretFile = path.join(projectPath, 'src', 'secret.ts');

    writeFile(sourceFile, 'export function calculateTotal() { return 100; }\n');
    writeFile(secretFile, 'export const api_key = "1234567890abcdef";\n');

    const watcher = startIndexer(projectPath, projectA);
    try {
        await waitFor(() => {
            const row = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectA, 'calculateTotal');
            return Boolean(row);
        });

        const excluded = parseToolJson<{ excluded_files: number }>(await callTool('index_status', { project_id: projectA }));
        assert(excluded.excluded_files === 1, 'index_status should count secret files as excluded');

        writeFile(path.join(projectPath, 'src', 'other.ts'), 'export function calculateTotal() { return 200; }\n');
        await waitFor(() => {
            const row = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectA, 'calculateTotal');
            return Boolean(row);
        });

        const projectBResult = parseToolJson<any[]>(await callTool('lookup_symbol', {
            project_id: projectB,
            name: 'calculateTotal'
        }));
        assert(projectBResult.length === 0, 'lookup_symbol must not leak symbols across projects');

        fs.unlinkSync(sourceFile);
        await waitFor(() => {
            const row = db.prepare("SELECT is_deleted FROM symbols WHERE project_id = ? AND file_path = ? AND name = ?")
              .get(projectA, sourceFile, 'calculateTotal') as { is_deleted: number } | undefined;
            return row?.is_deleted === 1;
        });
    } finally {
        await watcher.close();
    }
}

async function testAstCallGraph(db: TestDb, startIndexer: (projectPath: string, projectId?: string) => any, callTool: (name: string, args?: Record<string, any>) => Promise<any>) {
    const projectId = 'call-graph';
    const projectPath = createTempDir('mcp-memory-call-graph');
    const filePath = path.join(projectPath, 'src', 'cart.ts');

    writeFile(filePath, `
export function calculateTotal() {
  return 100;
}

export function checkout() {
  return calculateTotal();
}

export function mentionOnly() {
  return "calculateTotal";
}
`);

    const watcher = startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const row = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectId, 'checkout');
            return Boolean(row);
        });

        const target = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
          .get(projectId, 'calculateTotal') as { id: string } | undefined;
        assert(target, 'target symbol should be indexed for call graph test');

        await waitFor(() => {
            const row = db.prepare("SELECT COUNT(*) as count FROM symbol_calls WHERE project_id = ? AND target_name = ?")
              .get(projectId, 'calculateTotal') as { count: number };
            return row.count > 0;
        });

        const callers = parseToolJson<{ definite_callers: any[]; probable_callers: any[] }>(await callTool('find_callers', {
            symbol_id: target.id,
            min_confidence: 0.0
        }));

        assert(callers.definite_callers.some(c => c.qualified_name === 'checkout' && c.resolution_method === 'ast_same_file_or_name'), 'AST call graph should mark checkout as a definite caller');
        assert(callers.probable_callers.some(c => c.qualified_name === 'mentionOnly'), 'fuzzy fallback should keep mention-only matches as probable callers');
    } finally {
        await watcher.close();
    }
}

async function testGitHistory(db: TestDb, indexGitHistory: (projectPath: string, projectId?: string) => void) {
    const projectId = 'git-history';
    const projectPath = createTempDir('mcp-memory-git');
    const filePath = path.join(projectPath, 'src', 'history.ts');

    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });

    writeFile(filePath, 'export function calculateTotal() { return 1; }\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'add history symbol'], { cwd: projectPath, stdio: 'ignore' });

    writeFile(filePath, 'export function calculateTotal() { return 2; }\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'update history symbol'], { cwd: projectPath, stdio: 'ignore' });

    indexGitHistory(projectPath, projectId);

    const symbolId = `${projectId}:${filePath}:function:calculateTotal`;
    const history = db.prepare("SELECT commit_message FROM symbol_history WHERE symbol_id = ? ORDER BY commit_at ASC")
      .all(symbolId) as { commit_message: string }[];

    assert(history.length === 2, 'indexGitHistory should index both commits for the symbol');
    assert(history.some(row => row.commit_message === 'add history symbol'), 'git history should include the initial commit');
    assert(history.some(row => row.commit_message === 'update history symbol'), 'git history should include the update commit');
}

async function main() {
    const runtime = await withIsolatedRuntime();

    await testMcpTools(runtime.db, runtime.callTool);
    console.log('MCP tool integration tests passed.');

    await testIndexerEdges(runtime.db, runtime.startIndexer, runtime.callTool);
    console.log('Indexer edge tests passed.');

    await testAstCallGraph(runtime.db, runtime.startIndexer, runtime.callTool);
    console.log('AST call graph tests passed.');

    await testGitHistory(runtime.db, runtime.indexGitHistory);
    console.log('Git history tests passed.');
}

main().catch(error => {
    console.error('Integration test failed:', error);
    process.exit(1);
});
