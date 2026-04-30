import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';

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
        indexFile: indexer.indexFile,
        reindexChangedFiles: indexer.reindexChangedFiles,
        reconcileProjectFiles: indexer.reconcileProjectFiles,
        callTool: server.callTool,
        listTools: server.listTools,
        indexGitHistory: gitParser.indexGitHistory
    };
}

async function testMcpTools(db: TestDb, callTool: (name: string, args?: Record<string, any>) => Promise<any>, listTools: () => Promise<any>) {
    const projectId = 'tools-project';
    const sessionId = 'tools-session';
    const now = Date.now();
    const symbolId = `${projectId}:memory.ts:function:calculateTotal`;

    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(symbolId, projectId, 'calculateTotal', 'calculateTotal', 'function', 'memory.ts', 1, 3, 'function calculateTotal()', 'function calculateTotal() { return 1; }\n' + 'x'.repeat(1200), 'typescript', now);

    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(`${projectId}:caller.ts:function:checkout`, projectId, 'checkout', 'checkout', 'function', 'caller.ts', 1, 3, 'function checkout()', 'function checkout() { return calculateTotal(); }', 'typescript', now);

    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(`${projectId}:caller.test.ts:function:checkoutTest`, projectId, 'checkoutTest', 'checkoutTest', 'function', 'caller.test.ts', 1, 3, 'function checkoutTest()', 'function checkoutTest() { return calculateTotal(); }', 'typescript', now);
    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(`${projectId}:memory.ts:class:TotalCalculator`, projectId, 'TotalCalculator', 'TotalCalculator', 'class', 'memory.ts', 5, 8, 'class TotalCalculator', 'class TotalCalculator {}', 'typescript', now);
    db.prepare(`
        INSERT INTO symbol_history (id, symbol_id, version, body, signature, start_line, end_line, commit_sha, commit_message, commit_author, commit_at, change_type, branch, pr_reference)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('history-calculateTotal-v1', symbolId, 1, 'function calculateTotal() { return 0; }', 'function calculateTotal()', 1, 3, 'abc123', 'initial total', 'Test User', now - 5000, 'modified', 'main', null);

    db.prepare("INSERT INTO sessions (id, project_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, projectId, now - 1000, now - 500);

    const tools = await listTools();
    const toolNames = tools.tools.map((tool: any) => tool.name);
    for (const expected of ['code_search', 'read_context', 'impact_analysis', 'search_symbols', 'lookup_symbol', 'get_symbol_body', 'find_callers', 'reindex_changed_files', 'reconcile_index', 'changed_symbols_risk']) {
        assert(toolNames.includes(expected), `listTools should expose ${expected}`);
    }
    const saveMessageTool = tools.tools.find((tool: any) => tool.name === 'save_message');
    assert(saveMessageTool.inputSchema.required.includes('role') && saveMessageTool.inputSchema.required.includes('content'), 'save_message should require role and content');
    assert(!saveMessageTool.inputSchema.required.includes('session_id'), 'save_message should not require a pre-created session');

    const saved = await callTool('save_message', {
        session_id: sessionId,
        role: 'user',
        content: 'Please review calculateTotal and this note has a uniqueSearchTerm.',
        explicit_symbols: ['calculateTotal']
    });
    assert(saved.content[0].text.includes('Extracted 1 symbol references'), 'save_message did not link the explicit symbol');

    const autoSessionSaved = await callTool('save_message', {
        project_id: projectId,
        role: 'agent',
        content: 'Auto-created session note with autoSessionSearchTerm.',
        explicit_symbols: []
    });
    assert(autoSessionSaved.content[0].text.includes('Message saved in session'), 'save_message should report the resolved session');
    const autoSession = db.prepare("SELECT s.id FROM sessions s JOIN messages m ON m.session_id = s.id WHERE s.project_id = ? AND m.content LIKE ?")
      .get(projectId, '%autoSessionSearchTerm%') as { id: string } | undefined;
    assert(autoSession?.id, 'save_message should auto-create a valid session when session_id is omitted');

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
    assert(symbolSearch.some(symbol => symbol.name === 'calculateTotal') && symbolSearch.every(symbol => !('body' in symbol)), 'search_symbols should return compact symbol matches');
    assert('ref' in symbolSearch[0] && !('id' in symbolSearch[0]), 'search_symbols should use compact refs by default');
    assert(!JSON.stringify(symbolSearch).includes('return 1'), 'compact search_symbols output should not leak symbol bodies');
    const classSearch = parseToolJson<any[]>(await callTool('search_symbols', {
        project_id: projectId,
        query: 'Total',
        kind: 'class',
        verbose: true
    }));
    assert(classSearch.length === 1 && classSearch[0].kind === 'class' && classSearch[0].id.includes('TotalCalculator'), 'search_symbols should filter by kind and expose verbose metadata');
    assert(!('body' in classSearch[0]), 'search_symbols verbose=true should not include bodies unless explicitly supported');

    const symbolBody = parseToolJson<any>(await callTool('get_symbol_body', {
        symbol_id: symbolId
    }));
    assert(symbolBody.body.includes('calculateTotal'), 'get_symbol_body should return the full symbol body');
    assert(symbolBody.freshness?.freshness === 'unknown', 'get_symbol_body should include freshness metadata even for manually inserted legacy symbols');

    const symbolBodyByRef = parseToolJson<any>(await callTool('get_symbol_body', {
        project_id: projectId,
        ref: lookup[0].ref
    }));
    assert(symbolBodyByRef.body.includes('calculateTotal'), 'get_symbol_body should resolve compact refs');

    const invalidRef = await callTool('get_symbol_body', {
        project_id: projectId,
        ref: 'bad-ref'
    });
    assert(invalidRef.content[0].text === 'Symbol not found.', 'invalid compact refs should return a useful not-found message');

    const missingSymbolId = await callTool('get_symbol_body', {
        project_id: projectId
    });
    assert(missingSymbolId.content[0].text === 'Symbol not found.', 'missing symbol_id/ref should return a useful not-found message');

    const malformedSearch = parseToolJson<any>(await callTool('code_search', {
        project_id: projectId,
        query: ''
    }));
    assert(malformedSearch.error === 'invalid_arguments', 'code_search should reject empty query strings');
    const malformedChangedSince = parseToolJson<any>(await callTool('changed_since', {
        project_id: projectId,
        since: 'yesterday'
    }));
    assert(malformedChangedSince.error === 'invalid_arguments', 'changed_since should reject non-numeric since values');
    const malformedMessage = parseToolJson<any>(await callTool('save_message', {
        project_id: projectId,
        role: 'system',
        content: 'invalid role'
    }));
    assert(malformedMessage.error === 'invalid_arguments', 'save_message should reject unsupported roles');

    const historyWithoutBody = parseToolJson<any[]>(await callTool('get_symbol_history', {
        symbol_id: symbolId
    }));
    assert(historyWithoutBody.length === 1 && !('body' in historyWithoutBody[0]), 'get_symbol_history should omit body by default');
    const historyWithBody = parseToolJson<any[]>(await callTool('get_symbol_history', {
        symbol_id: symbolId,
        include_body: true
    }));
    assert(historyWithBody[0].body.includes('return 0'), 'get_symbol_history include_body=true should include history bodies');

    const searchResults = parseToolJson<any[]>(await callTool('search_history', {
        project_id: projectId,
        query: 'uniqueSearchTerm'
    }));
    assert(searchResults.length === 1, 'search_history should return the saved message in the same project');
    const autoSessionResults = parseToolJson<any[]>(await callTool('search_history', {
        project_id: projectId,
        query: 'autoSessionSearchTerm'
    }));
    assert(autoSessionResults.length === 1, 'search_history should return messages saved through auto-created sessions');

    const callers = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', {
        symbol_id: symbolId,
        include_tests: false,
        min_confidence: 0.5
    }));
    const allCallers = [...callers.definite_callers, ...(callers as any).probable_callers];
    assert(allCallers.length === 1, 'find_callers should exclude test files when requested');
    assert(allCallers[0].qualified_name === 'checkout', 'find_callers returned the wrong caller');

    const highConfidenceCallers = parseToolJson<{ definite_callers: any[]; probable_callers: any[] }>(await callTool('find_callers', {
        symbol_id: symbolId,
        include_tests: true,
        min_confidence: 0.9
    }));
    assert(highConfidenceCallers.probable_callers.length === 0, 'min_confidence should filter fuzzy probable callers');
    const missingCallers = await callTool('find_callers', {
        symbol_id: `${projectId}:missing.ts:function:missingSymbol`
    });
    assert(missingCallers.content[0].text === 'Symbol not found.', 'find_callers should return a useful not-found message for unknown symbols');

    db.prepare("UPDATE symbols SET is_deleted = 1 WHERE id = ?").run(symbolId);
    const deletedLookup = parseToolJson<any[]>(await callTool('lookup_symbol', {
        project_id: projectId,
        name: 'calculateTotal'
    }));
    assert(deletedLookup.length === 0, 'lookup_symbol should hide deleted symbols');
    const deletedSearch = parseToolJson<any[]>(await callTool('search_symbols', {
        project_id: projectId,
        query: 'calculateTotal'
    }));
    assert(deletedSearch.every(symbol => symbol.name !== 'calculateTotal'), 'search_symbols should hide deleted symbols');
    db.prepare("UPDATE symbols SET is_deleted = 0 WHERE id = ?").run(symbolId);

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

    const rankedSearch = parseToolJson<any>(await callTool('code_search', {
        project_id: projectId,
        query: 'calculateTotal',
        limit: 3
    }));
    assert(rankedSearch.results[0].symbol.name === 'calculateTotal', 'code_search should rank the exact symbol first');
    assert(rankedSearch.results[0].why_this_matched.includes('exact_symbol_match'), 'code_search should explain why a result matched');
    assert(!JSON.stringify(rankedSearch).includes('return 1'), 'code_search should not leak symbol bodies');
    assert(rankedSearch.related_decisions.some(decision => decision.summary.includes('billing total boundary')), 'code_search should include matching decisions');
    assert(rankedSearch.budget?.estimated_tokens <= rankedSearch.budget?.max_tokens, 'code_search should report an output token budget');

    const budgetedSearchText = (await callTool('code_search', {
        project_id: projectId,
        query: 'calculateTotal',
        limit: 10,
        max_tokens: 220
    })).content[0].text;
    const budgetedSearch = JSON.parse(budgetedSearchText);
    assert(Math.ceil(budgetedSearchText.length / 4) <= 220, 'code_search should respect max_tokens by trimming optional context');
    assert(budgetedSearch.budget.max_tokens === 220, 'code_search should report the requested max_tokens budget');
    const tinyBudgetSearchText = (await callTool('code_search', {
        project_id: projectId,
        query: 'calculateTotal',
        max_tokens: 1
    })).content[0].text;
    const tinyBudgetSearch = JSON.parse(tinyBudgetSearchText);
    assert(tinyBudgetSearch.budget.max_tokens === 120, 'code_search should clamp tiny positive max_tokens to the minimum supported budget');
    assert(typeof tinyBudgetSearch.budget.over_budget === 'boolean', 'code_search should disclose when a tiny budget cannot fit the minimum response');
    assert(tinyBudgetSearch.budget.truncated === true, 'code_search should truncate optional context for tiny budgets');

    const oldProjectPath = process.env.PROJECT_PATH;
    const pathPollutionRoot = path.join(os.tmpdir(), 'Typer');
    process.env.PROJECT_PATH = pathPollutionRoot;
    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(`${projectId}:docs-js:function:_attributes`, projectId, '_attributes', '_attributes', 'method', path.join(pathPollutionRoot, 'docs', 'js', 'termynal.js'), 1, 3, 'function _attributes()', 'function _attributes() {}', 'javascript', now);
    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(`${projectId}:typer-main:class:Typer`, projectId, 'Typer', 'Typer', 'class', path.join(pathPollutionRoot, 'typer', 'main.py'), 1, 3, 'class Typer', 'class Typer: pass', 'python', now);
    const pathSafeSearch = parseToolJson<any>(await callTool('code_search', {
        project_id: projectId,
        query: 'Typer',
        limit: 3
    }));
    process.env.PROJECT_PATH = oldProjectPath;
    assert(pathSafeSearch.results[0].symbol.name === 'Typer', 'code_search should not rank unrelated symbols by matching the absolute project root path');

    const contextPacket = parseToolJson<any>(await callTool('read_context', {
        project_id: projectId,
        ref: lookup[0].ref,
        include_body: false,
        include_tests: false
    }));
    assert(contextPacket.target.name === 'calculateTotal' && !('body' in contextPacket.target), 'read_context should return target metadata without body by default');
    assert(contextPacket.callers.probable.some((caller: any) => caller.qualified_name === 'checkout'), 'read_context should include likely callers');
    assert(contextPacket.decisions.some((decision: any) => decision.summary.includes('billing total boundary')), 'read_context should include linked decisions');

    const contextWithBody = parseToolJson<any>(await callTool('read_context', {
        project_id: projectId,
        ref: lookup[0].ref,
        include_body: true,
        include_tests: false
    }));
    assert(contextWithBody.target.body.includes('return 1'), 'read_context include_body=true should include the symbol body');

    const budgetedContextText = (await callTool('read_context', {
        project_id: projectId,
        ref: lookup[0].ref,
        include_body: true,
        max_tokens: 220
    })).content[0].text;
    const budgetedContext = JSON.parse(budgetedContextText);
    assert(Math.ceil(budgetedContextText.length / 4) <= 220, 'read_context should respect max_tokens by trimming packet details');
    assert(budgetedContext.budget.truncated === true, 'read_context should disclose budget truncation');

    const impact = parseToolJson<any>(await callTool('impact_analysis', {
        project_id: projectId,
        ref: lookup[0].ref,
        include_tests: false
    }));
    assert(impact.mode === 'target_symbol' && impact.target.name === 'calculateTotal', 'impact_analysis should analyze the requested symbol');
    assert(impact.risk_level === 'medium', 'impact_analysis should raise risk when callers or decisions are linked');
    assert(impact.related_decisions.some((decision: any) => decision.summary.includes('billing total boundary')), 'impact_analysis should include linked decisions');

    db.prepare("UPDATE symbols SET updated_at = ? WHERE id = ?").run(Date.now() + 1000, symbolId);
    const reviewDecisions = parseToolJson<any[]>(await callTool('get_decisions', {
        project_id: projectId,
        symbol: 'calculateTotal'
    }));
    assert(reviewDecisions[0].memory_state === 'needs_review', 'get_decisions should mark decisions as needs_review when linked symbols changed after the decision');
    assert(reviewDecisions[0].stale_symbols.some((symbol: any) => symbol.name === 'calculateTotal'), 'needs_review decisions should explain which linked symbols changed');

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

    db.prepare("UPDATE symbols SET updated_at = ? WHERE id = ?").run(Date.now() - 1000, symbolId);
    await callTool('save_decision', {
        project_id: projectId,
        summary: 'Replacement billing boundary decision',
        related_symbols: ['calculateTotal'],
        supersedes_decision_id: allDecisions[0].id
    });
    const supersession = parseToolJson<any[]>(await callTool('get_decisions', {
        project_id: projectId,
        status: 'all'
    }));
    assert(supersession.some(decision => decision.summary === 'Replacement billing boundary decision' && decision.memory_state === 'current'), 'save_decision should create a current replacement decision');
    assert(supersession.some(decision => decision.id === allDecisions[0].id && decision.superseded_by), 'save_decision should link superseded decisions to their replacement');

    let unknownToolFailed = false;
    try {
        await callTool('missing_tool_for_contract_test');
    } catch (error: any) {
        unknownToolFailed = error.message.includes('Tool not found');
    }
    assert(unknownToolFailed, 'unknown tools should fail with a clear Tool not found error');
}

async function testProjectIsolationContracts(db: TestDb, callTool: (name: string, args?: Record<string, any>) => Promise<any>) {
    const projectA = 'isolation-a';
    const projectB = 'isolation-b';
    const sessionA = 'isolation-session-a';
    const sessionB = 'isolation-session-b';
    const now = Date.now();
    const old = now - 1000;
    const symbolA = `${projectA}:shared.ts:function:sharedBoundary`;
    const symbolB = `${projectB}:shared.ts:function:sharedBoundary`;
    const callerA = `${projectA}:caller.ts:function:callShared`;
    const callerB = `${projectB}:caller.ts:function:callShared`;

    for (const projectId of [projectA, projectB]) {
        db.prepare("INSERT INTO sessions (id, project_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
          .run(projectId === projectA ? sessionA : sessionB, projectId, old, old + 100);
    }

    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(symbolA, projectA, 'sharedBoundary', 'sharedBoundary', 'function', 'shared-a.ts', 1, 3, 'function sharedBoundary()', 'function sharedBoundary() { return "A"; }', 'typescript', now);
    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(symbolB, projectB, 'sharedBoundary', 'sharedBoundary', 'function', 'shared-b.ts', 1, 3, 'function sharedBoundary()', 'function sharedBoundary() { return "B"; }', 'typescript', now);
    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(callerA, projectA, 'callShared', 'callShared', 'function', 'caller-a.ts', 1, 3, 'function callShared()', 'function callShared() { return sharedBoundary(); }', 'typescript', now);
    db.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(callerB, projectB, 'callShared', 'callShared', 'function', 'caller-b.ts', 1, 3, 'function callShared()', 'function callShared() { return sharedBoundary(); }', 'typescript', now);

    db.prepare(`
        INSERT INTO symbol_calls (caller_symbol_id, target_symbol_id, target_name, target_file_path, project_id, file_path, line, confidence, resolution_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(callerA, symbolA, 'sharedBoundary', 'shared-a.ts', projectA, 'caller-a.ts', 1, 1.0, 'test_static');
    db.prepare(`
        INSERT INTO symbol_calls (caller_symbol_id, target_symbol_id, target_name, target_file_path, project_id, file_path, line, confidence, resolution_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(callerB, symbolB, 'sharedBoundary', 'shared-b.ts', projectB, 'caller-b.ts', 1, 1.0, 'test_static');

    await callTool('save_message', {
        session_id: sessionA,
        role: 'user',
        content: 'isolationUniqueA discussed sharedBoundary',
        explicit_symbols: ['sharedBoundary']
    });
    await callTool('save_message', {
        session_id: sessionB,
        role: 'user',
        content: 'isolationUniqueB discussed sharedBoundary',
        explicit_symbols: ['sharedBoundary']
    });
    await callTool('save_decision', {
        project_id: projectA,
        summary: 'Isolation decision A',
        related_symbols: ['sharedBoundary']
    });
    await callTool('save_decision', {
        project_id: projectB,
        summary: 'Isolation decision B',
        related_symbols: ['sharedBoundary']
    });

    const oldMessageA = 'isolation-old-message-a';
    const oldMessageB = 'isolation-old-message-b';
    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(oldMessageA, sessionA, 'user', 'old isolation A sharedBoundary', old);
    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(oldMessageB, sessionB, 'user', 'old isolation B sharedBoundary', old);
    db.prepare("INSERT INTO message_symbol_references (message_id, symbol_id, confidence, reference_type, extraction_source) VALUES (?, ?, ?, ?, ?)")
      .run(oldMessageA, symbolA, 1.0, 'mentioned', 'explicit_tool_call');
    db.prepare("INSERT INTO message_symbol_references (message_id, symbol_id, confidence, reference_type, extraction_source) VALUES (?, ?, ?, ?, ?)")
      .run(oldMessageB, symbolB, 1.0, 'mentioned', 'explicit_tool_call');

    const lookupA = parseToolJson<any[]>(await callTool('lookup_symbol', { project_id: projectA, name: 'sharedBoundary' }));
    const lookupB = parseToolJson<any[]>(await callTool('lookup_symbol', { project_id: projectB, name: 'sharedBoundary' }));
    assert(lookupA.length === 1 && lookupA[0].file === 'shared-a.ts', 'lookup_symbol should isolate project A');
    assert(lookupB.length === 1 && lookupB[0].file === 'shared-b.ts', 'lookup_symbol should isolate project B');

    const searchA = parseToolJson<any[]>(await callTool('search_symbols', { project_id: projectA, query: 'sharedBoundary' }));
    const searchB = parseToolJson<any[]>(await callTool('search_symbols', { project_id: projectB, query: 'sharedBoundary' }));
    assert(searchA.every(symbol => symbol.file !== 'shared-b.ts'), 'search_symbols should not leak project B into project A');
    assert(searchB.every(symbol => symbol.file !== 'shared-a.ts'), 'search_symbols should not leak project A into project B');

    const statusA = parseToolJson<{ total_symbols: number }>(await callTool('index_status', { project_id: projectA }));
    const statusB = parseToolJson<{ total_symbols: number }>(await callTool('index_status', { project_id: projectB }));
    assert(statusA.total_symbols === 2 && statusB.total_symbols === 2, 'index_status should count per project');

    const historyA = parseToolJson<any[]>(await callTool('search_history', { project_id: projectA, query: 'isolationUniqueA' }));
    const historyB = parseToolJson<any[]>(await callTool('search_history', { project_id: projectB, query: 'isolationUniqueB' }));
    const crossHistory = parseToolJson<any[]>(await callTool('search_history', { project_id: projectA, query: 'isolationUniqueB' }));
    assert(historyA.length === 1 && historyB.length === 1 && crossHistory.length === 0, 'search_history should isolate projects');

    const decisionsA = parseToolJson<any[]>(await callTool('get_decisions', { project_id: projectA, symbol: 'sharedBoundary' }));
    const decisionsB = parseToolJson<any[]>(await callTool('get_decisions', { project_id: projectB, symbol: 'sharedBoundary' }));
    assert(decisionsA.some(decision => decision.summary === 'Isolation decision A') && !decisionsA.some(decision => decision.summary === 'Isolation decision B'), 'get_decisions should isolate project A');
    assert(decisionsB.some(decision => decision.summary === 'Isolation decision B') && !decisionsB.some(decision => decision.summary === 'Isolation decision A'), 'get_decisions should isolate project B');

    const changedA = parseToolJson<any[]>(await callTool('changed_since', { project_id: projectA, since: old }));
    const changedB = parseToolJson<any[]>(await callTool('changed_since', { project_id: projectB, since: old }));
    assert(changedA.every(symbol => symbol.file !== 'shared-b.ts'), 'changed_since should isolate project A');
    assert(changedB.every(symbol => symbol.file !== 'shared-a.ts'), 'changed_since should isolate project B');
    assert(changedA.every(symbol => !('body' in symbol) && !('id' in symbol)), 'changed_since should return compact symbol metadata');

    const discussedA = parseToolJson<any[]>(await callTool('symbols_discussed_and_changed', { project_id: projectA }));
    const discussedB = parseToolJson<any[]>(await callTool('symbols_discussed_and_changed', { project_id: projectB }));
    assert(discussedA.length > 0 && discussedA.every(row => row.file_path !== 'shared-b.ts'), 'symbols_discussed_and_changed should isolate project A');
    assert(discussedB.length > 0 && discussedB.every(row => row.file_path !== 'shared-a.ts'), 'symbols_discussed_and_changed should isolate project B');

    const regressionA = parseToolJson<any[]>(await callTool('find_regression_candidates', {
        project_id: projectA,
        changed_on: now - 10000,
        min_confidence: 0.5
    }));
    const regressionB = parseToolJson<any[]>(await callTool('find_regression_candidates', {
        project_id: projectB,
        changed_on: now - 10000,
        min_confidence: 0.5
    }));
    assert(regressionA.length > 0 && regressionA.every(row => row.file_path !== 'shared-b.ts'), 'find_regression_candidates should isolate project A');
    assert(regressionB.length > 0 && regressionB.every(row => row.file_path !== 'shared-a.ts'), 'find_regression_candidates should isolate project B');

    const callersA = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', { symbol_id: symbolA, min_confidence: 0.0 }));
    const callersB = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', { symbol_id: symbolB, min_confidence: 0.0 }));
    assert(callersA.definite_callers.every(caller => caller.file_path !== 'caller-b.ts'), 'find_callers should isolate project A');
    assert(callersB.definite_callers.every(caller => caller.file_path !== 'caller-a.ts'), 'find_callers should isolate project B');

    const contextA = parseToolJson<{ active_decisions: any[] }>(await callTool('context_since_last_session', { project_id: projectA }));
    const contextB = parseToolJson<{ active_decisions: any[] }>(await callTool('context_since_last_session', { project_id: projectB }));
    assert(contextA.active_decisions.some(decision => decision.summary === 'Isolation decision A') && !contextA.active_decisions.some(decision => decision.summary === 'Isolation decision B'), 'context_since_last_session should isolate project A');
    assert(contextB.active_decisions.some(decision => decision.summary === 'Isolation decision B') && !contextB.active_decisions.some(decision => decision.summary === 'Isolation decision A'), 'context_since_last_session should isolate project B');
}

function testLegacyDatabaseCompatibility() {
    const legacyDir = createTempDir('mcp-memory-legacy-db');
    const dbPath = path.join(legacyDir, 'legacy.sqlite');
    const legacyDb = new Database(dbPath);
    const now = Date.now();
    legacyDb.exec(`
        CREATE TABLE symbols (
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
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE symbol_history (
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
            change_type TEXT NOT NULL
        );

        CREATE TABLE files (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            path TEXT NOT NULL,
            language TEXT,
            last_indexed_at INTEGER NOT NULL
        );

        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER
        );

        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            role TEXT NOT NULL CHECK(role IN ('user', 'agent')),
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE message_symbol_references (
            message_id TEXT NOT NULL REFERENCES messages(id),
            symbol_id TEXT NOT NULL REFERENCES symbols(id),
            confidence REAL NOT NULL,
            reference_type TEXT NOT NULL CHECK(reference_type IN ('mentioned', 'modified', 'explained', 'debugged', 'rejected', 'approved')),
            extraction_source TEXT NOT NULL CHECK(extraction_source IN ('explicit_tool_call', 'code_block', 'natural_language', 'agent_summary')),
            PRIMARY KEY (message_id, symbol_id)
        );

        CREATE TABLE session_summaries (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            summary TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE project_decisions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            rationale TEXT,
            decided_at INTEGER NOT NULL,
            source_session TEXT REFERENCES sessions(id),
            status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'under_review'))
        );

        CREATE TABLE decision_symbol_references (
            decision_id TEXT NOT NULL REFERENCES project_decisions(id),
            symbol_id TEXT NOT NULL REFERENCES symbols(id),
            PRIMARY KEY (decision_id, symbol_id)
        );

        CREATE TABLE symbol_calls (
            caller_symbol_id TEXT NOT NULL REFERENCES symbols(id),
            target_symbol_id TEXT REFERENCES symbols(id),
            target_name TEXT NOT NULL,
            project_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            line INTEGER NOT NULL,
            confidence REAL NOT NULL,
            resolution_method TEXT NOT NULL,
            PRIMARY KEY (caller_symbol_id, target_name, file_path, line)
        );
    `);
    legacyDb.prepare(`
        INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-project:legacy.ts:function:legacySymbol', 'legacy-project', 'legacySymbol', 'legacySymbol', 'function', 'legacy.ts', 1, 3, 'function legacySymbol()', 'function legacySymbol() { return 1; }', 'typescript', now);
    legacyDb.prepare("INSERT INTO files (id, project_id, path, language, last_indexed_at) VALUES (?, ?, ?, ?, ?)")
      .run('legacy-project:legacy.ts', 'legacy-project', 'legacy.ts', 'typescript', now);
    legacyDb.prepare("INSERT INTO sessions (id, project_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
      .run('legacy-session', 'legacy-project', now - 1000, now - 500);
    legacyDb.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run('legacy-message', 'legacy-session', 'user', 'legacy message content', now);
    legacyDb.prepare("INSERT INTO project_decisions (id, project_id, summary, rationale, decided_at, source_session, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('legacy-decision', 'legacy-project', 'Legacy decision survives migration', 'legacy rationale', now, 'legacy-session', 'active');
    legacyDb.close();

    const script = `
const { initDb, default: db } = require('./src/db');
initDb();
initDb();
const requiredColumns = {
  symbols: ['commit_sha', 'is_deleted', 'ref'],
  symbol_history: ['branch', 'pr_reference'],
  files: ['git_blob_sha', 'is_excluded'],
  sessions: ['title', 'tags'],
  project_decisions: ['superseded_by', 'confidence', 'review_required_at', 'review_reason'],
  symbol_calls: ['target_file_path']
};
for (const [table, columns] of Object.entries(requiredColumns)) {
  const existing = db.prepare('PRAGMA table_info(' + table + ')').all().map(column => column.name);
  for (const column of columns) {
    if (!existing.includes(column)) throw new Error(table + '.' + column + ' was not migrated');
  }
}
const symbol = db.prepare('SELECT name, is_deleted FROM symbols WHERE id = ?').get('legacy-project:legacy.ts:function:legacySymbol');
if (!symbol || symbol.name !== 'legacySymbol' || symbol.is_deleted !== 0) throw new Error('legacy symbol did not survive migration');
const decision = db.prepare('SELECT summary, confidence FROM project_decisions WHERE id = ?').get('legacy-decision');
if (!decision || decision.summary !== 'Legacy decision survives migration' || decision.confidence !== 1) throw new Error('legacy decision did not survive migration');
const message = db.prepare('SELECT content FROM messages WHERE id = ?').get('legacy-message');
if (!message || message.content !== 'legacy message content') throw new Error('legacy message did not survive migration');
db.prepare('INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages WHERE id = ?').run('legacy-message');
const fts = db.prepare('SELECT COUNT(*) as count FROM messages_fts WHERE messages_fts MATCH ?').get('legacy');
if (fts.count !== 1) throw new Error('messages_fts was not available after migration');
`;
    execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, MCP_MEMORY_DB_PATH: dbPath },
        stdio: 'pipe'
    });
}

async function testIndexerEdges(db: TestDb, startIndexer: (projectPath: string, projectId?: string) => any, callTool: (name: string, args?: Record<string, any>) => Promise<any>) {
    const projectA = 'indexer-a';
    const projectB = 'indexer-b';
    const projectPath = createTempDir('mcp-memory-indexer');
    const sourceFile = path.join(projectPath, 'src', 'math.ts');
    const secretFile = path.join(projectPath, 'src', 'secret.ts');
    const stripeSecretFile = path.join(projectPath, 'src', 'billing.ts');
    const ignoredFile = path.join(projectPath, 'tmp-cache', 'ignored.ts');

    writeFile(path.join(projectPath, '.mcp-memoryignore'), 'tmp-cache/**\n*.generated.ts\n');
    writeFile(sourceFile, 'export function calculateTotal() { return 100; }\n');
    writeFile(secretFile, 'export const api_key = "1234567890abcdef";\n');
    writeFile(stripeSecretFile, 'export const stripeKey = "sk_live_1234567890abcdef";\n');
    writeFile(ignoredFile, 'export function ignoredByMemoryFile() { return 1; }\n');

    const watcher = startIndexer(projectPath, projectA);
    try {
        await waitFor(() => {
            const row = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectA, 'calculateTotal');
            return Boolean(row);
        });

        await waitFor(() => {
            const row = db.prepare("SELECT COUNT(*) as count FROM files WHERE project_id = ? AND is_excluded = 1")
              .get(projectA) as { count: number };
            return row.count === 2;
        });
        const excluded = parseToolJson<{ excluded_files: number; freshness: string; health: any }>(await callTool('index_status', {
            project_id: projectA,
            project_path: projectPath
        }));
        assert(excluded.excluded_files === 2, 'index_status should count secret files as excluded');
        assert(excluded.freshness === 'fresh' && excluded.health.stale_files === 0, 'index_status should report a fresh index when tracked files match the working tree');
        const ignoredResult = parseToolJson<any[]>(await callTool('lookup_symbol', {
            project_id: projectA,
            name: 'ignoredByMemoryFile'
        }));
        assert(ignoredResult.length === 0, '.mcp-memoryignore should prevent ignored files from being indexed');

        writeFile(path.join(projectPath, 'src', 'other.ts'), 'export function calculateTotal() { return 200; }\n');
        await waitFor(() => {
            const row = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectA, 'calculateTotal');
            return Boolean(row);
        });

        const scopedFile = path.join(projectPath, 'src', 'services.ts');
        writeFile(scopedFile, `
export class UserService {
  run() {
    return "user";
  }
}

export class BillingService {
  run() {
    return "billing";
  }
}
`);
        await waitFor(() => {
            const row = db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND file_path = ? AND kind = ? AND name = ? AND is_deleted = 0")
              .get(projectA, scopedFile, 'method', 'run') as { count: number };
            return row.count === 2;
        });
        const scopedMethods = db.prepare("SELECT id, qualified_name, ref FROM symbols WHERE project_id = ? AND file_path = ? AND kind = ? AND name = ? AND is_deleted = 0 ORDER BY qualified_name")
          .all(projectA, scopedFile, 'method', 'run') as Array<{ id: string; qualified_name: string; ref: string | null }>;
        assert(scopedMethods.map(row => row.qualified_name).join(',') === 'BillingService.run,UserService.run', 'same-name methods should keep class-scoped qualified names');
        assert(new Set(scopedMethods.map(row => row.id)).size === 2, 'same-name methods in one file should have distinct symbol IDs');
        assert(scopedMethods.every(row => row.ref && row.ref.length === 10), 'indexed symbols should store compact refs');
        const scopedBody = parseToolJson<any>(await callTool('get_symbol_body', {
            project_id: projectA,
            ref: scopedMethods[0].ref
        }));
        assert(scopedBody.qualified_name === 'BillingService.run' && scopedBody.body.includes('billing'), 'get_symbol_body should resolve indexed refs without scanning all symbols');
        assert(scopedBody.freshness?.freshness === 'fresh', 'indexed symbol bodies should report fresh when file hashes match');

        writeFile(scopedFile, `
export class UserService {
  run() {
    return "user";
  }
}

export class BillingService {
  run() {
    return "billing-updated";
  }
}
`);
        const staleStatus = parseToolJson<{ freshness: string; health: any }>(await callTool('index_status', {
            project_id: projectA,
            project_path: projectPath
        }));
        assert(staleStatus.freshness === 'stale' && staleStatus.health.stale_files >= 1, 'index_status should detect working-tree changes before the index catches up');
        await callTool('reconcile_index', {
            project_id: projectA,
            project_path: projectPath
        });
        const freshAgain = parseToolJson<{ freshness: string; health: any }>(await callTool('index_status', {
            project_id: projectA,
            project_path: projectPath
        }));
        assert(freshAgain.freshness === 'fresh' && freshAgain.health.stale_files === 0, 'reconcile_index should restore fresh index health after stale detection');

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

async function testBodyStoragePrivacyMode(
    db: TestDb,
    indexFile: (filePath: string, projectId?: string, options?: { force?: boolean }) => Promise<{ indexed?: boolean; skipped?: boolean; reason?: string }>,
    callTool: (name: string, args?: Record<string, any>) => Promise<any>
) {
    const projectId = 'privacy-project';
    const projectPath = createTempDir('mcp-memory-privacy');
    const filePath = path.join(projectPath, 'privacy.ts');
    const previous = process.env.MCP_MEMORY_DISABLE_BODY_STORAGE;
    try {
        writeFile(filePath, 'export function privateWorkflow() {\n  return "sensitive implementation";\n}\n');
        process.env.MCP_MEMORY_DISABLE_BODY_STORAGE = '1';
        const result = await indexFile(filePath, projectId, { force: true });
        assert(result.indexed === true, 'privacy-mode indexFile should index source metadata');

        const symbols = parseToolJson<any[]>(await callTool('lookup_symbol', {
            project_id: projectId,
            name: 'privateWorkflow',
            include_body: true
        }));
        assert(symbols.length === 1, 'privacy-mode lookup should still find indexed symbols');
        assert(!('body' in symbols[0]), 'privacy-mode lookup should not return stored source body');
        assert(symbols[0].body_unavailable === 'body_storage_disabled', 'privacy-mode lookup should disclose disabled body storage');

        const body = parseToolJson<any>(await callTool('get_symbol_body', {
            project_id: projectId,
            ref: symbols[0].ref
        }));
        assert(body.body === null && body.body_unavailable === 'body_storage_disabled', 'get_symbol_body should disclose unavailable body in privacy mode');
        assert(!JSON.stringify(body).includes('sensitive implementation'), 'privacy-mode body response should not leak source text');

        const context = parseToolJson<any>(await callTool('read_context', {
            project_id: projectId,
            ref: symbols[0].ref,
            include_body: true
        }));
        assert(context.target.body_unavailable === 'body_storage_disabled' && !('body' in context.target), 'read_context should disclose unavailable body without leaking source text');
    } finally {
        if (previous === undefined) delete process.env.MCP_MEMORY_DISABLE_BODY_STORAGE;
        else process.env.MCP_MEMORY_DISABLE_BODY_STORAGE = previous;
        fs.rmSync(projectPath, { recursive: true, force: true });
        db.prepare("DELETE FROM symbol_calls WHERE project_id = ?").run(projectId);
        db.prepare("DELETE FROM symbols WHERE project_id = ?").run(projectId);
        db.prepare("DELETE FROM files WHERE project_id = ?").run(projectId);
    }
    console.log('Body storage privacy tests passed.');
}

async function testAstCallGraph(db: TestDb, startIndexer: (projectPath: string, projectId?: string) => any, callTool: (name: string, args?: Record<string, any>) => Promise<any>) {
    const projectId = 'call-graph';
    const projectPath = createTempDir('mcp-memory-call-graph');
    const filePath = path.join(projectPath, 'src', 'cart.ts');
    const mathFile = path.join(projectPath, 'src', 'math.ts');
    const barrelFile = path.join(projectPath, 'src', 'index.ts');
    const otherFile = path.join(projectPath, 'src', 'other.ts');
    const serviceFile = path.join(projectPath, 'src', 'service.ts');
    const buttonFile = path.join(projectPath, 'src', 'button.tsx');
    const appFile = path.join(projectPath, 'src', 'app.tsx');

    writeFile(filePath, `
import { calculateTotal } from "./index";
import { calculateTotal as otherTotal } from "./other";

export function sameFileTotal() {
  return 100;
}

export function checkout() {
  return calculateTotal();
}

export function sameFileCheckout() {
  return sameFileTotal();
}

export function otherCheckout() {
  return otherTotal();
}

export function shadowedCheckout() {
  const calculateTotal = () => 1;
  return calculateTotal();
}

export function mentionOnly() {
  return "sameFileTotal";
}
`);
    writeFile(mathFile, `
export function calculateTotal() {
  return 100;
}
`);
    writeFile(barrelFile, 'export { calculateTotal } from "./math";\n');
    writeFile(otherFile, 'export function calculateTotal() { return 200; }\n');
    writeFile(serviceFile, `
export class PriceService {
  total() {
    return 100;
  }
}

export function createService(): PriceService {
  return new PriceService();
}
`);
    writeFile(buttonFile, `
export function CheckoutButton() {
  return null;
}
`);
    writeFile(appFile, `
import { CheckoutButton } from "./button";
import { createService } from "./service";

export function App() {
  const service = createService();
  return <CheckoutButton total={service.total()} />;
}
`);

    const watcher = startIndexer(projectPath, projectId);
    try {
        const waitForSymbol = async (name: string, filePath: string) => {
            let symbol: { id: string } | undefined;
            await waitFor(() => {
                symbol = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
                  .get(projectId, name, filePath) as { id: string } | undefined;
                return Boolean(symbol);
            });
            return symbol!;
        };

        await waitFor(() => {
            const row = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectId, 'checkout');
            return Boolean(row);
        });

        const target = await waitForSymbol('sameFileTotal', filePath);

        await waitFor(() => {
            const row = db.prepare("SELECT COUNT(*) as count FROM symbol_calls WHERE project_id = ? AND target_name = ?")
              .get(projectId, 'sameFileTotal') as { count: number };
            return row.count > 0;
        });

        const callers = parseToolJson<{ definite_callers: any[]; probable_callers: any[] }>(await callTool('find_callers', {
            symbol_id: target.id,
            min_confidence: 0.0
        }));

        assert(callers.definite_callers.some(c => c.qualified_name === 'sameFileCheckout' && c.resolution_method === 'ts_checker_symbol'), 'TypeScript checker should mark same-file calls as definite callers');
        assert(callers.probable_callers.some(c => c.qualified_name === 'mentionOnly'), 'fuzzy fallback should keep mention-only matches as probable callers');

        const importedTarget = await waitForSymbol('calculateTotal', mathFile);

        const importedCallers = parseToolJson<{ definite_callers: any[]; probable_callers: any[] }>(await callTool('find_callers', {
            symbol_id: importedTarget.id,
            min_confidence: 0.0
        }));
        assert(importedCallers.definite_callers.some(c => c.qualified_name === 'checkout' && c.resolution_method === 'ts_checker_symbol'), 'TypeScript checker should resolve barrel imports to the original exported file');
        assert(!importedCallers.definite_callers.some(c => c.qualified_name === 'shadowedCheckout'), 'local shadowing should prevent imported AST caller edges');
        assert(!importedCallers.definite_callers.some(c => c.qualified_name === 'otherCheckout'), 'same-name imports from other files should not point to the wrong target');

        const otherTarget = await waitForSymbol('calculateTotal', otherFile);
        const otherCallers = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', {
            symbol_id: otherTarget.id,
            min_confidence: 0.0
        }));
        assert(otherCallers.definite_callers.some(c => c.qualified_name === 'otherCheckout'), 'aliased direct import should resolve to its source file');

        const methodTarget = await waitForSymbol('total', serviceFile);
        const methodCallers = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', {
            symbol_id: methodTarget.id,
            min_confidence: 0.0
        }));
        assert(methodCallers.definite_callers.some(c => c.qualified_name === 'App' && c.resolution_method === 'ts_checker_symbol'), 'TypeScript checker should resolve instance methods through function return types');

        const componentTarget = await waitForSymbol('CheckoutButton', buttonFile);
        const componentCallers = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', {
            symbol_id: componentTarget.id,
            min_confidence: 0.0
        }));
        assert(componentCallers.definite_callers.some(c => c.qualified_name === 'App' && c.resolution_method === 'ts_checker_jsx_component'), 'TypeScript checker should expose TSX component usage as a caller edge');
    } finally {
        await watcher.close();
    }
}

async function testLanguageDepth(db: TestDb, startIndexer: (projectPath: string, projectId?: string) => any, callTool: (name: string, args?: Record<string, any>) => Promise<any>) {
    const projectId = 'language-depth';
    const projectPath = createTempDir('mcp-memory-language-depth');
    const jsFile = path.join(projectPath, 'src', 'cart.js');
    const pyFile = path.join(projectPath, 'src', 'cart.py');
    const pyPricingFile = path.join(projectPath, 'src', 'pricing.py');
    const pyMoneyFile = path.join(projectPath, 'src', 'billing', 'money.py');
    const pyInitFile = path.join(projectPath, 'src', '__init__.py');

    writeFile(jsFile, `
export const calculateTotal = () => 100;

export function checkout() {
  return calculateTotal();
}

export function mentionOnly() {
  return "calculateTotal";
}
`);
    writeFile(pyFile, `
def calculate_total():
    return 100

def checkout_py():
    return calculate_total()

def mention_only_py():
    return "calculate_total"
`);
    writeFile(pyPricingFile, `
def calculate_external_total():
    return 200

class PriceCalculator:
    def total(self, value):
        return value
`);
    writeFile(pyInitFile, 'from .pricing import calculate_external_total as exported_total\n');
    writeFile(pyMoneyFile, `
def round_money(value):
    return value
`);
    writeFile(pyFile, `
from .pricing import calculate_external_total as external_total
from .pricing import PriceCalculator as Calculator
from . import exported_total
import billing.money as money

def calculate_total():
    return 100

def checkout_py():
    return calculate_total()

def checkout_external_py():
    return external_total()

def checkout_module_py():
    return money.round_money(10)

def checkout_reexport_py():
    return exported_total()

def checkout_instance_py():
    calculator = Calculator()
    return calculator.total(10)

class PriceCalculator:
    def normalize(self, value):
        return value

    def total(self, value):
        return self.normalize(value)

def mention_only_py():
    return "calculate_total"
`);

    const watcher = startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const jsTarget = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculateTotal', jsFile);
            const pyTarget = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculate_total', pyFile);
            const pyExternalTarget = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculate_external_total', pyPricingFile);
            const pyModuleTarget = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'round_money', pyMoneyFile);
            const pyInstanceTarget = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'total', pyPricingFile);
            return Boolean(jsTarget && pyTarget && pyExternalTarget && pyModuleTarget && pyInstanceTarget);
        });

        const jsTarget = db.prepare("SELECT id, language FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculateTotal', jsFile) as { id: string; language: string } | undefined;
        assert(jsTarget?.language === 'javascript', 'JavaScript arrow functions should be indexed as symbols');

        const jsCallers = parseToolJson<{ definite_callers: any[]; probable_callers: any[] }>(await callTool('find_callers', {
            symbol_id: jsTarget.id,
            min_confidence: 0.0
        }));
        assert(jsCallers.definite_callers.some(c => c.qualified_name === 'checkout' && c.resolution_method === 'ast_same_file_or_name'), 'JavaScript callers should be extracted from AST call expressions');
        assert(jsCallers.probable_callers.some(c => c.qualified_name === 'mentionOnly'), 'JavaScript fuzzy fallback should keep string-only mentions as probable');

        const pyTarget = db.prepare("SELECT id, language FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculate_total', pyFile) as { id: string; language: string } | undefined;
        assert(pyTarget?.language === 'python', 'Python functions should be indexed as symbols');

        const pyCallers = parseToolJson<{ definite_callers: any[]; probable_callers: any[] }>(await callTool('find_callers', {
            symbol_id: pyTarget.id,
            min_confidence: 0.0
        }));
        assert(pyCallers.definite_callers.some(c => c.qualified_name === 'checkout_py' && c.resolution_method === 'ast_python_name'), 'Python callers should be extracted from AST call nodes');
        assert(pyCallers.probable_callers.some(c => c.qualified_name === 'mention_only_py'), 'Python fuzzy fallback should keep string-only mentions as probable');

        const pyExternalTarget = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculate_external_total', pyPricingFile) as { id: string } | undefined;
        const pyExternalCallers = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', {
            symbol_id: pyExternalTarget?.id,
            min_confidence: 0.0
        }));
        assert(pyExternalCallers.definite_callers.some(c => c.qualified_name === 'checkout_external_py' && c.resolution_method === 'ast_python_from_import'), 'Python from-import aliases should resolve cross-file callers');
        assert(pyExternalCallers.definite_callers.some(c => c.qualified_name === 'checkout_reexport_py' && c.resolution_method === 'ast_python_from_import'), 'Python __init__.py re-exports should resolve cross-file callers');

        const pyModuleTarget = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'round_money', pyMoneyFile) as { id: string } | undefined;
        const pyModuleCallers = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', {
            symbol_id: pyModuleTarget?.id,
            min_confidence: 0.0
        }));
        assert(pyModuleCallers.definite_callers.some(c => c.qualified_name === 'checkout_module_py' && c.resolution_method === 'ast_python_module_import'), 'Python module import aliases should resolve cross-file callers');

        const pyMethodTarget = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'normalize', pyFile) as { id: string } | undefined;
        const pyMethodCallers = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', {
            symbol_id: pyMethodTarget?.id,
            min_confidence: 0.0
        }));
        assert(pyMethodCallers.definite_callers.some(c => c.qualified_name === 'PriceCalculator.total' && c.resolution_method === 'ast_python_self_method'), 'Python self.method calls should resolve same-file method callers');

        const pyInstanceTarget = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'total', pyPricingFile) as { id: string } | undefined;
        const pyInstanceCallers = parseToolJson<{ definite_callers: any[] }>(await callTool('find_callers', {
            symbol_id: pyInstanceTarget?.id,
            min_confidence: 0.0
        }));
        assert(pyInstanceCallers.definite_callers.some(c => c.qualified_name === 'checkout_instance_py' && c.resolution_method === 'ast_python_instance_method'), 'Python constructor-assigned object method calls should resolve cross-file method callers');
    } finally {
        await watcher.close();
    }
}

async function testGitAwareIncrementalIndexing(
    db: TestDb,
    indexFile: (filePath: string, projectId?: string, options?: { force?: boolean }) => Promise<any>,
    reindexChangedFiles: (projectPath: string, projectId?: string, options?: { force?: boolean }) => Promise<any>,
    reconcileProjectFiles: (projectPath: string, projectId?: string) => Promise<any>,
    callTool: (name: string, args?: Record<string, any>) => Promise<any>
) {
    const projectId = 'incremental-git';
    const projectPath = createTempDir('mcp-memory-incremental');
    const filePath = path.join(projectPath, 'src', 'incremental.ts');
    const deletedPath = path.join(projectPath, 'src', 'deleted.ts');
    const movablePath = path.join(projectPath, 'src', 'movable.ts');
    const movedPath = path.join(projectPath, 'src', 'moved.ts');
    const restoredPath = path.join(projectPath, 'src', 'restored.ts');
    const fallbackOldPath = path.join(projectPath, 'src', 'fallback-old.ts');
    const fallbackNewPath = path.join(projectPath, 'src', 'fallback-new.ts');
    const buildOutputPath = path.join(projectPath, 'build', 'generated.ts');
    const memoryIgnoredPath = path.join(projectPath, 'scratch', 'ignored.ts');

    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });

    writeFile(path.join(projectPath, '.mcp-memoryignore'), 'scratch/**\n');
    writeFile(filePath, 'export function indexedOnce() { return 1; }\n');
    writeFile(deletedPath, 'export function deletedLater() { return 1; }\n');
    writeFile(movablePath, 'export function movedSymbol() { return 1; }\n');
    writeFile(restoredPath, 'export function restoredSymbol() { return 1; }\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial incremental files'], { cwd: projectPath, stdio: 'ignore' });

    const baseBranch = execFileSync('git', ['branch', '--show-current'], { cwd: projectPath, encoding: 'utf8' }).trim() || 'master';
    const first = await indexFile(filePath, projectId);
    assert(first.indexed === true, 'indexFile should index new files');
    const second = await indexFile(filePath, projectId);
    assert(second.skipped === true && second.reason === 'unchanged', 'indexFile should skip unchanged files by blob hash');
    await indexFile(restoredPath, projectId);

    const fileRow = db.prepare("SELECT git_blob_sha FROM files WHERE project_id = ? AND path = ?")
      .get(projectId, filePath) as { git_blob_sha: string | null } | undefined;
    assert(Boolean(fileRow?.git_blob_sha), 'files.git_blob_sha should be populated');

    execFileSync('git', ['checkout', '-b', 'checkout-edge'], { cwd: projectPath, stdio: 'ignore' });
    writeFile(filePath, 'export function indexedOnce() { return 5; }\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'change indexed once on branch'], { cwd: projectPath, stdio: 'ignore' });
    const checkoutReconciled = await reconcileProjectFiles(projectPath, projectId);
    assert(checkoutReconciled.indexed >= 1, 'reconcileProjectFiles should reindex same-path content changes after checkout');
    const branchBody = db.prepare("SELECT body FROM symbols WHERE project_id = ? AND file_path = ? AND name = ? AND is_deleted = 0")
      .get(projectId, filePath, 'indexedOnce') as { body: string } | undefined;
    assert(branchBody?.body.includes('return 5'), 'checkout reconciliation should update symbol bodies when branch content changes');
    execFileSync('git', ['checkout', baseBranch], { cwd: projectPath, stdio: 'ignore' });
    await reconcileProjectFiles(projectPath, projectId);

    execFileSync('git', ['checkout', '-b', 'delete-restore-edge'], { cwd: projectPath, stdio: 'ignore' });
    fs.unlinkSync(restoredPath);
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'delete restored symbol on branch'], { cwd: projectPath, stdio: 'ignore' });
    await reconcileProjectFiles(projectPath, projectId);
    const deletedOnBranch = db.prepare("SELECT is_deleted FROM symbols WHERE project_id = ? AND file_path = ? AND name = ?")
      .get(projectId, restoredPath, 'restoredSymbol') as { is_deleted: number } | undefined;
    assert(deletedOnBranch?.is_deleted === 1, 'checkout reconciliation should mark symbols deleted on a branch');
    execFileSync('git', ['checkout', baseBranch], { cwd: projectPath, stdio: 'ignore' });
    await reconcileProjectFiles(projectPath, projectId);
    const restoredOnBase = db.prepare("SELECT is_deleted FROM symbols WHERE project_id = ? AND file_path = ? AND name = ?")
      .get(projectId, restoredPath, 'restoredSymbol') as { is_deleted: number } | undefined;
    assert(restoredOnBase?.is_deleted === 0, 'checkout reconciliation should reactivate symbols restored by branch checkout');

    await indexFile(movablePath, projectId);
    await callTool('save_decision', {
        project_id: projectId,
        summary: 'Keep movedSymbol decision links after file moves',
        related_symbols: ['movedSymbol']
    });
    execFileSync('git', ['mv', 'src/movable.ts', 'src/moved.ts'], { cwd: projectPath });
    writeFile(movedPath, 'export function movedSymbol() { return 9; }\n');
    const renamed = await reindexChangedFiles(projectPath, projectId);
    assert(renamed.renamed === 1, 'reindexChangedFiles should reconcile git renames');
    const movedSymbol = db.prepare("SELECT id, is_deleted FROM symbols WHERE project_id = ? AND file_path = ? AND name = ?")
      .get(projectId, movedPath, 'movedSymbol') as { id: string; is_deleted: number } | undefined;
    assert(movedSymbol?.is_deleted === 0, 'renamed files should keep symbols active at the new path');
    const movedDecisions = parseToolJson<any[]>(await callTool('get_decisions', {
        project_id: projectId,
        symbol: 'movedSymbol'
    }));
    assert(movedDecisions.some(decision => decision.summary === 'Keep movedSymbol decision links after file moves'), 'rename reconciliation should preserve decision-symbol links');
    const movedBody = db.prepare("SELECT body FROM symbols WHERE project_id = ? AND file_path = ? AND name = ? AND is_deleted = 0")
      .get(projectId, movedPath, 'movedSymbol') as { body: string } | undefined;
    assert(movedBody?.body.includes('return 9'), 'move plus content change should preserve links and update the moved symbol body');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'rename movable symbol'], { cwd: projectPath, stdio: 'ignore' });

    writeFile(fallbackOldPath, 'export function fallbackSymbol() { return 1; }\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'add fallback rename fixture'], { cwd: projectPath, stdio: 'ignore' });
    await indexFile(fallbackOldPath, projectId);
    fs.unlinkSync(fallbackOldPath);
    writeFile(fallbackNewPath, 'export function fallbackSymbol() { return 1000; }\nexport function fallbackExtra() { return 2; }\n');
    const fallback = await reindexChangedFiles(projectPath, projectId);
    assert(fallback.deleted >= 1 && fallback.indexed >= 1, 'rename fallback should delete the old path and index the new path when Git does not report a rename');
    const fallbackOld = db.prepare("SELECT is_deleted FROM symbols WHERE project_id = ? AND file_path = ? AND name = ?")
      .get(projectId, fallbackOldPath, 'fallbackSymbol') as { is_deleted: number } | undefined;
    const fallbackNew = db.prepare("SELECT body, is_deleted FROM symbols WHERE project_id = ? AND file_path = ? AND name = ?")
      .get(projectId, fallbackNewPath, 'fallbackSymbol') as { body: string; is_deleted: number } | undefined;
    assert(fallbackOld?.is_deleted === 1, 'rename fallback should mark the old path symbol as deleted');
    assert(fallbackNew?.is_deleted === 0 && fallbackNew.body.includes('return 1000'), 'rename fallback should index the replacement symbol at the new path');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'fallback rename by delete and add'], { cwd: projectPath, stdio: 'ignore' });

    writeFile(buildOutputPath, 'export function generatedBuildSymbol() { return 1; }\n');
    const generatedChanged = await reindexChangedFiles(projectPath, projectId);
    assert(generatedChanged.changed_files === 0, 'generated build output should be excluded from changed-file indexing');
    const generatedReconciled = await reconcileProjectFiles(projectPath, projectId);
    assert(generatedReconciled.excluded === 0, 'generated build output should be skipped during full reconciliation');
    const generatedSymbol = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
      .get(projectId, 'generatedBuildSymbol') as { id: string } | undefined;
    assert(!generatedSymbol, 'generated build output should not create active symbols');

    writeFile(memoryIgnoredPath, 'export function ignoredScratchSymbol() { return 1; }\n');
    const ignoredChanged = await reindexChangedFiles(projectPath, projectId);
    assert(ignoredChanged.changed_files === 0, '.mcp-memoryignore output should be excluded from changed-file indexing');
    const ignoredReconciled = await reconcileProjectFiles(projectPath, projectId);
    assert(ignoredReconciled.scanned_files >= 4, 'reconcileProjectFiles should keep scanning normal source files while honoring .mcp-memoryignore');
    const ignoredScratchSymbol = db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
      .get(projectId, 'ignoredScratchSymbol') as { id: string } | undefined;
    assert(!ignoredScratchSymbol, '.mcp-memoryignore output should not create active symbols during reconciliation');

    writeFile(filePath, 'export function indexedOnce() { return 2; }\n');
    const changed = await reindexChangedFiles(projectPath, projectId);
    assert(changed.changed_files === 1 && changed.indexed === 1, 'reindexChangedFiles should index only git changed source files');

    await indexFile(deletedPath, projectId);
    fs.unlinkSync(deletedPath);
    const reconciled = await reconcileProjectFiles(projectPath, projectId);
    assert(reconciled.deleted_files === 1, 'reconcileProjectFiles should mark missing indexed files as deleted');
    const deletedSymbol = db.prepare("SELECT is_deleted FROM symbols WHERE project_id = ? AND file_path = ? AND name = ?")
      .get(projectId, deletedPath, 'deletedLater') as { is_deleted: number } | undefined;
    assert(deletedSymbol?.is_deleted === 1, 'reconcileProjectFiles should mark symbols from missing files as deleted');
    const deletedRiskHidden = parseToolJson<{ changed_symbols: any[] }>(await callTool('changed_symbols_risk', {
        project_id: projectId,
        project_path: projectPath
    }));
    assert(!deletedRiskHidden.changed_symbols.some(symbol => symbol.name === 'deletedLater'), 'changed_symbols_risk should hide deleted symbols by default');
    const deletedRiskVisible = parseToolJson<{ changed_symbols: any[] }>(await callTool('changed_symbols_risk', {
        project_id: projectId,
        project_path: projectPath,
        include_deleted: true
    }));
    assert(deletedRiskVisible.changed_symbols.some(symbol => symbol.name === 'deletedLater'), 'changed_symbols_risk include_deleted=true should include deleted changed symbols');

    writeFile(path.join(projectPath, 'src', 'via-tool.ts'), 'export function viaTool() { return 1; }\n');
    const toolResult = parseToolJson<{ changed_files: number; indexed: number }>(await callTool('reindex_changed_files', {
        project_id: projectId,
        project_path: projectPath
    }));
    assert(toolResult.changed_files >= 1 && toolResult.indexed >= 1, 'reindex_changed_files tool should index git changed files');

    await callTool('save_decision', {
        project_id: projectId,
        summary: 'Review viaTool when changed',
        related_symbols: ['viaTool']
    });
    const risk = parseToolJson<{ changed_symbols: any[]; related_decisions: any[] }>(await callTool('changed_symbols_risk', {
        project_id: projectId,
        project_path: projectPath
    }));
    assert(risk.changed_symbols.some(symbol => symbol.name === 'viaTool'), 'changed_symbols_risk should include symbols from changed files');
    assert(risk.related_decisions.some(decision => decision.summary === 'Review viaTool when changed'), 'changed_symbols_risk should include decisions linked to changed symbols');
    assert(risk.related_decisions.some(decision => decision.summary === 'Review viaTool when changed' && decision.memory_state === 'needs_review'), 'changed_symbols_risk should mark linked decisions as needs_review');

    const status = parseToolJson<{ hashed_files: number; indexed_files: number }>(await callTool('index_status', {
        project_id: projectId
    }));
    assert(status.hashed_files > 0 && status.indexed_files > 0, 'index_status should expose file/hash counts');
}

async function testGitMergeRewriteAndLargeSwitch(
    db: TestDb,
    indexFile: (filePath: string, projectId?: string, options?: { force?: boolean }) => Promise<any>,
    reconcileProjectFiles: (projectPath: string, projectId?: string) => Promise<any>
) {
    const projectId = 'git-merge-rewrite';
    const projectPath = createTempDir('mcp-memory-merge-rewrite');
    const mergePath = path.join(projectPath, 'src', 'merge.ts');
    const rewritePath = path.join(projectPath, 'src', 'rewrite.ts');
    const stablePath = path.join(projectPath, 'src', 'stable.ts');

    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });

    writeFile(mergePath, `
export function mainBranchSymbol() { return 1; }
export function sideBranchSymbol() { return 1; }
`);
    writeFile(rewritePath, 'export function rewriteSymbol() { return 1; }\n');
    writeFile(stablePath, 'export function stableAcrossSwitch() { return 1; }\n');
    for (let i = 0; i < 12; i++) {
        writeFile(path.join(projectPath, 'src', `large-${i}.ts`), `export function staleSymbol${i}() { return ${i}; }\n`);
    }
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial merge rewrite fixtures'], { cwd: projectPath, stdio: 'ignore' });

    await reconcileProjectFiles(projectPath, projectId);
    const baseBranch = execFileSync('git', ['branch', '--show-current'], { cwd: projectPath, encoding: 'utf8' }).trim() || 'master';

    execFileSync('git', ['checkout', '-b', 'merge-side'], { cwd: projectPath, stdio: 'ignore' });
    writeFile(mergePath, `
export function mainBranchSymbol() { return 1; }
export function sideBranchSymbol() { return 20; }
`);
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'change side branch symbol'], { cwd: projectPath, stdio: 'ignore' });

    execFileSync('git', ['checkout', baseBranch], { cwd: projectPath, stdio: 'ignore' });
    writeFile(mergePath, `
export function mainBranchSymbol() { return 10; }
export function sideBranchSymbol() { return 1; }
`);
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'change main branch symbol'], { cwd: projectPath, stdio: 'ignore' });
    try {
        execFileSync('git', ['merge', '--no-ff', 'merge-side', '-m', 'merge side branch changes'], { cwd: projectPath, stdio: 'ignore' });
    } catch {
        writeFile(mergePath, `
export function mainBranchSymbol() { return 10; }
export function sideBranchSymbol() { return 20; }
`);
        execFileSync('git', ['add', '.'], { cwd: projectPath });
        execFileSync('git', ['commit', '-m', 'resolve merge side branch changes'], { cwd: projectPath, stdio: 'ignore' });
    }
    const mergeReconciled = await reconcileProjectFiles(projectPath, projectId);
    assert(mergeReconciled.indexed >= 1, 'merge reconciliation should reindex files changed on both branches');
    const mainSymbol = db.prepare("SELECT body FROM symbols WHERE project_id = ? AND file_path = ? AND name = ? AND is_deleted = 0")
      .get(projectId, mergePath, 'mainBranchSymbol') as { body: string } | undefined;
    const sideSymbol = db.prepare("SELECT body FROM symbols WHERE project_id = ? AND file_path = ? AND name = ? AND is_deleted = 0")
      .get(projectId, mergePath, 'sideBranchSymbol') as { body: string } | undefined;
    assert(mainSymbol?.body.includes('return 10'), 'merge reconciliation should keep main-branch symbol updates');
    assert(sideSymbol?.body.includes('return 20'), 'merge reconciliation should keep side-branch symbol updates');

    execFileSync('git', ['checkout', '-b', 'rewrite-edge'], { cwd: projectPath, stdio: 'ignore' });
    writeFile(rewritePath, 'export function rewriteSymbol() { return 2; }\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'rewrite symbol once'], { cwd: projectPath, stdio: 'ignore' });
    await indexFile(rewritePath, projectId);
    writeFile(rewritePath, 'export function rewriteSymbol() { return 3; }\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '--amend', '-m', 'rewrite symbol amended'], { cwd: projectPath, stdio: 'ignore' });
    const rewriteReconciled = await reconcileProjectFiles(projectPath, projectId);
    assert(rewriteReconciled.indexed >= 1, 'history rewrite reconciliation should reindex amended same-path content');
    const rewriteSymbol = db.prepare("SELECT body FROM symbols WHERE project_id = ? AND file_path = ? AND name = ? AND is_deleted = 0")
      .get(projectId, rewritePath, 'rewriteSymbol') as { body: string } | undefined;
    assert(rewriteSymbol?.body.includes('return 3'), 'history rewrite reconciliation should update amended symbol bodies');

    execFileSync('git', ['checkout', baseBranch], { cwd: projectPath, stdio: 'ignore' });
    await reconcileProjectFiles(projectPath, projectId);
    execFileSync('git', ['checkout', '-b', 'large-switch-edge'], { cwd: projectPath, stdio: 'ignore' });
    for (let i = 0; i < 12; i++) {
        fs.unlinkSync(path.join(projectPath, 'src', `large-${i}.ts`));
        writeFile(path.join(projectPath, 'src', `replacement-${i}.ts`), `export function replacementSymbol${i}() { return ${i + 100}; }\n`);
    }
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'large branch switch replacement'], { cwd: projectPath, stdio: 'ignore' });
    const largeSwitch = await reconcileProjectFiles(projectPath, projectId);
    assert(largeSwitch.deleted_files >= 12 && largeSwitch.indexed >= 12, 'large branch switch should delete stale symbols and index replacements');
    const staleActive = db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND name LIKE 'staleSymbol%' AND is_deleted = 0")
      .get(projectId) as { count: number };
    const replacementsActive = db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND name LIKE 'replacementSymbol%' AND is_deleted = 0")
      .get(projectId) as { count: number };
    assert(staleActive.count === 0, 'large branch switch should not leave stale active symbols');
    assert(replacementsActive.count === 12, 'large branch switch should index replacement symbols');
}

async function testGitHistory(
    db: TestDb,
    indexGitHistory: (projectPath: string, projectId?: string) => void,
    callTool: (name: string, args?: Record<string, any>) => Promise<any>
) {
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

    const privacyProjectId = 'git-history-privacy';
    const privacyProjectPath = createTempDir('mcp-memory-git-history-privacy');
    const privacyFilePath = path.join(privacyProjectPath, 'src', 'history.ts');
    const previous = process.env.MCP_MEMORY_DISABLE_BODY_STORAGE;
    try {
        execFileSync('git', ['init'], { cwd: privacyProjectPath, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: privacyProjectPath });
        execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: privacyProjectPath });
        writeFile(privacyFilePath, 'export function privateHistory() { return "private body"; }\n');
        execFileSync('git', ['add', '.'], { cwd: privacyProjectPath });
        execFileSync('git', ['commit', '-m', 'add private history'], { cwd: privacyProjectPath, stdio: 'ignore' });
        process.env.MCP_MEMORY_DISABLE_BODY_STORAGE = '1';
        indexGitHistory(privacyProjectPath, privacyProjectId);

        const privacySymbolId = `${privacyProjectId}:${privacyFilePath}:function:privateHistory`;
        const row = db.prepare("SELECT body FROM symbol_history WHERE symbol_id = ? LIMIT 1")
          .get(privacySymbolId) as { body: string | null } | undefined;
        assert(row && row.body === null, 'privacy-mode git history should not persist historical bodies');
        const historyWithBody = parseToolJson<any[]>(await callTool('get_symbol_history', {
            symbol_id: privacySymbolId,
            include_body: true
        }));
        assert(historyWithBody[0].body === null && historyWithBody[0].body_unavailable === 'body_storage_disabled', 'get_symbol_history should disclose unavailable privacy-mode bodies');
        assert(!JSON.stringify(historyWithBody).includes('private body'), 'privacy-mode history response should not leak source text');
    } finally {
        if (previous === undefined) delete process.env.MCP_MEMORY_DISABLE_BODY_STORAGE;
        else process.env.MCP_MEMORY_DISABLE_BODY_STORAGE = previous;
    }
}

async function main() {
    const runtime = await withIsolatedRuntime();

    await testMcpTools(runtime.db, runtime.callTool, runtime.listTools);
    console.log('MCP tool integration tests passed.');

    await testProjectIsolationContracts(runtime.db, runtime.callTool);
    console.log('Project isolation contract tests passed.');

    testLegacyDatabaseCompatibility();
    console.log('Legacy database compatibility tests passed.');

    await testIndexerEdges(runtime.db, runtime.startIndexer, runtime.callTool);
    console.log('Indexer edge tests passed.');

    await testBodyStoragePrivacyMode(runtime.db, runtime.indexFile, runtime.callTool);

    await testAstCallGraph(runtime.db, runtime.startIndexer, runtime.callTool);
    console.log('AST call graph tests passed.');

    await testLanguageDepth(runtime.db, runtime.startIndexer, runtime.callTool);
    console.log('Language depth tests passed.');

    await testGitAwareIncrementalIndexing(runtime.db, runtime.indexFile, runtime.reindexChangedFiles, runtime.reconcileProjectFiles, runtime.callTool);
    console.log('Git-aware incremental indexing tests passed.');

    await testGitMergeRewriteAndLargeSwitch(runtime.db, runtime.indexFile, runtime.reconcileProjectFiles);
    console.log('Git merge, rewrite, and large switch tests passed.');

    await testGitHistory(runtime.db, runtime.indexGitHistory, runtime.callTool);
    console.log('Git history tests passed.');
}

main().catch(error => {
    console.error('Integration test failed:', error);
    process.exit(1);
});
