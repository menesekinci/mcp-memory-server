import fs from 'fs';
import os from 'os';
import path from 'path';

type BenchmarkResult = {
    name: string;
    classic_chars?: number;
    classic_tokens?: number;
    mcp_chars?: number;
    mcp_tokens?: number;
    token_savings_pct?: number;
    notes: string;
    passed: boolean;
};

function approxTokens(text: string) {
    return Math.ceil(text.length / 4);
}

function createTempDir(name: string) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for benchmark condition');
}

function recursiveFiles(root: string, ignored = /(^|[\/\\])(\.git|node_modules|dist)([\/\\]|$)/) {
    const files: string[] = [];
    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (ignored.test(fullPath)) continue;
            if (entry.isDirectory()) walk(fullPath);
            else files.push(fullPath);
        }
    }
    walk(root);
    return files;
}

function classicSearch(root: string, query: string) {
    const lines: string[] = [];
    for (const file of recursiveFiles(root)) {
        if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
        const content = fs.readFileSync(file, 'utf8');
        content.split(/\r?\n/).forEach((line, index) => {
            if (line.includes(query)) {
                lines.push(`${file}:${index + 1}: ${line.trim()}`);
            }
        });
    }
    return lines.join('\n');
}

async function withRuntime(projectPath: string, projectId: string) {
    const dbPath = path.join(os.tmpdir(), `mcp-memory-benchmark-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
    process.env.MCP_MEMORY_DB_PATH = dbPath;
    process.env.PROJECT_PATH = projectPath;
    process.env.PROJECT_ID = projectId;

    const [{ initDb, default: db }, indexer, server] = await Promise.all([
        import('../src/db'),
        import('../src/indexer'),
        import('../src/server')
    ]);
    initDb();
    return {
        db,
        startIndexer: indexer.startIndexer,
        callTool: server.callTool
    };
}

async function benchmarkSymbolDiscovery(): Promise<BenchmarkResult> {
    const projectPath = process.cwd();
    const projectId = 'benchmark-discovery';
    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const row = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectId, 'callTool');
            return Boolean(row);
        }, 8000);

        const classic = classicSearch(projectPath, 'callTool');
        const mcp = await runtime.callTool('search_symbols', { project_id: projectId, query: 'callTool', limit: 5 });
        const mcpText = mcp.content[0].text;
        const classicTokens = approxTokens(classic);
        const mcpTokens = approxTokens(mcpText);
        return {
            name: 'symbol_discovery_callTool',
            classic_chars: classic.length,
            classic_tokens: classicTokens,
            mcp_chars: mcpText.length,
            mcp_tokens: mcpTokens,
            token_savings_pct: Math.round((1 - (mcpTokens / classicTokens)) * 1000) / 10,
            notes: 'Find the callTool symbol with broad text search versus compact MCP symbol search.',
            passed: mcpTokens < classicTokens
        };
    } finally {
        await watcher.close();
    }
}

async function benchmarkAstCallers(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-callers');
    const projectId = 'benchmark-callers';
    writeFile(path.join(projectPath, 'src', 'cart.ts'), `
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

    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const row = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectId, 'calculateTotal');
            return Boolean(row);
        });

        const target = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
          .get(projectId, 'calculateTotal') as { id: string };
        const result = await runtime.callTool('find_callers', { symbol_id: target.id, min_confidence: 0.0 });
        const payload = JSON.parse(result.content[0].text);
        const definiteNames = payload.definite_callers.map((caller: any) => caller.qualified_name);
        const probableNames = payload.probable_callers.map((caller: any) => caller.qualified_name);

        return {
            name: 'ast_callers_vs_fuzzy_fallback',
            notes: `Definite callers: ${definiteNames.join(', ') || 'none'}; probable fuzzy callers: ${probableNames.join(', ') || 'none'}.`,
            passed: definiteNames.includes('checkout') && probableNames.includes('mentionOnly')
        };
    } finally {
        await watcher.close();
    }
}

function writeReports(results: BenchmarkResult[]) {
    const outDir = path.join(process.cwd(), 'benchmark', 'results');
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, 'latest.json');
    const mdPath = path.join(outDir, 'latest.md');
    const payload = {
        generated_at: new Date().toISOString(),
        results
    };
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

    const rows = results.map(result => `| ${result.name} | ${result.passed ? 'pass' : 'fail'} | ${result.classic_tokens ?? '-'} | ${result.mcp_tokens ?? '-'} | ${result.token_savings_pct ?? '-'} | ${result.notes} |`);
    fs.writeFileSync(mdPath, [
        '# Benchmark Results',
        '',
        '| Benchmark | Status | Classic Tokens | MCP Tokens | Savings % | Notes |',
        '| --- | --- | ---: | ---: | ---: | --- |',
        ...rows,
        ''
    ].join('\n'));
}

async function main() {
    const results = [
        await benchmarkSymbolDiscovery(),
        await benchmarkAstCallers()
    ];
    writeReports(results);
    console.log(JSON.stringify(results, null, 2));
    if (results.some(result => !result.passed)) {
        process.exit(1);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
