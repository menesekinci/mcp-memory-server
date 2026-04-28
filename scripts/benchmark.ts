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
        indexFile: indexer.indexFile,
        reindexChangedFiles: indexer.reindexChangedFiles,
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

async function benchmarkAstImportResolverPrecision(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-imports');
    const projectId = 'benchmark-imports';
    const cartFile = path.join(projectPath, 'src', 'cart.ts');
    const mathFile = path.join(projectPath, 'src', 'math.ts');
    const barrelFile = path.join(projectPath, 'src', 'index.ts');
    const otherFile = path.join(projectPath, 'src', 'other.ts');

    writeFile(mathFile, `
export function calculateTotal() {
  return 100;
}
`);
    writeFile(barrelFile, 'export { calculateTotal } from "./math";\n');
    writeFile(otherFile, 'export function calculateTotal() { return 200; }\n');
    writeFile(cartFile, `
import { calculateTotal } from "./index";
import { calculateTotal as otherTotal } from "./other";

export function checkout() {
  return calculateTotal();
}

export function otherCheckout() {
  return otherTotal();
}

export function shadowedCheckout() {
  const calculateTotal = () => 1;
  return calculateTotal();
}
`);

    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const row = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculateTotal', mathFile);
            return Boolean(row);
        });

        const target = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculateTotal', mathFile) as { id: string };
        const result = await runtime.callTool('find_callers', { symbol_id: target.id, min_confidence: 0.0 });
        const payload = JSON.parse(result.content[0].text);
        const definiteNames = payload.definite_callers.map((caller: any) => caller.qualified_name);
        const expected = definiteNames.includes('checkout');
        const falsePositives = definiteNames.filter((name: string) => name === 'otherCheckout' || name === 'shadowedCheckout');

        return {
            name: 'ast_import_resolver_precision',
            notes: `Definite callers for barrel import: ${definiteNames.join(', ') || 'none'}; false positives: ${falsePositives.join(', ') || 'none'}.`,
            passed: expected && falsePositives.length === 0
        };
    } finally {
        await watcher.close();
    }
}

async function benchmarkIncrementalReindex(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-incremental');
    const projectId = 'benchmark-incremental';
    writeFile(path.join(projectPath, 'src', 'stable.ts'), 'export function stableSymbol() { return 1; }\n');
    writeFile(path.join(projectPath, 'src', 'changed.ts'), 'export function changedSymbol() { return 1; }\n');

    const { execFileSync } = await import('child_process');
    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial benchmark files'], { cwd: projectPath, stdio: 'ignore' });

    const runtime = await withRuntime(projectPath, projectId);
    await runtime.indexFile(path.join(projectPath, 'src', 'stable.ts'), projectId);
    await runtime.indexFile(path.join(projectPath, 'src', 'changed.ts'), projectId);

    writeFile(path.join(projectPath, 'src', 'changed.ts'), 'export function changedSymbol() { return 2; }\n');
    const result = await runtime.reindexChangedFiles(projectPath, projectId);

    return {
        name: 'incremental_changed_file_reindex',
        notes: `Changed files: ${result.changed_files}; indexed: ${result.indexed}; skipped: ${result.skipped}; deleted: ${result.deleted}.`,
        passed: result.changed_files === 1 && result.indexed === 1
    };
}

async function benchmarkLanguageDepth(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-language-depth');
    const projectId = 'benchmark-language-depth';
    const jsFile = path.join(projectPath, 'src', 'cart.js');
    const pyFile = path.join(projectPath, 'src', 'cart.py');

    writeFile(jsFile, `
export const calculateTotal = () => 100;
export function checkout() {
  return calculateTotal();
}
`);
    writeFile(pyFile, `
def calculate_total():
    return 100

def checkout_py():
    return calculate_total()
`);

    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const jsTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculateTotal', jsFile);
            const pyTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculate_total', pyFile);
            return Boolean(jsTarget && pyTarget);
        });

        const jsTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculateTotal', jsFile) as { id: string };
        const pyTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculate_total', pyFile) as { id: string };
        const jsPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: jsTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyTarget.id, min_confidence: 0.0 })).content[0].text);
        const jsCallers = jsPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyCallers = pyPayload.definite_callers.map((caller: any) => caller.qualified_name);

        return {
            name: 'language_depth_js_python_callers',
            notes: `JavaScript callers: ${jsCallers.join(', ') || 'none'}; Python callers: ${pyCallers.join(', ') || 'none'}.`,
            passed: jsCallers.includes('checkout') && pyCallers.includes('checkout_py')
        };
    } finally {
        await watcher.close();
    }
}

async function benchmarkBugFixInvestigationNarrowing(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-bugfix');
    const projectId = 'benchmark-bugfix';
    const sessionId = 'benchmark-bugfix-session';

    writeFile(path.join(projectPath, 'src', 'billing', 'discounts.ts'), `
export function applyDiscount(total: number, coupon: string) {
  if (coupon === "VIP") return Math.round(total * 0.85);
  return total;
}

export function calculateInvoiceTotal(subtotal: number, coupon: string) {
  return applyDiscount(subtotal, coupon);
}
`);
    writeFile(path.join(projectPath, 'src', 'billing', 'checkout.ts'), `
import { calculateInvoiceTotal } from "./discounts";

export function checkout(subtotal: number, coupon: string) {
  return calculateInvoiceTotal(subtotal, coupon);
}
`);
    for (let i = 0; i < 12; i++) {
        writeFile(path.join(projectPath, 'src', 'noise', `discount-note-${i}.ts`), `
export function discountNote${i}() {
  return [
    "discount banner copy",
    "discount analytics label",
    "discount help text"
  ].join(" ");
}
`);
    }

    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const row = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectId, 'applyDiscount');
            return Boolean(row);
        });

        const now = Date.now();
        runtime.db.prepare("INSERT INTO sessions (id, project_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
          .run(sessionId, projectId, now - 1000, now - 500);
        await runtime.callTool('save_message', {
            session_id: sessionId,
            project_id: projectId,
            role: 'user',
            content: 'Regression report: VIP discount rounding changed near applyDiscount.',
            explicit_symbols: ['applyDiscount']
        });
        await runtime.callTool('save_decision', {
            project_id: projectId,
            summary: 'applyDiscount owns coupon rounding behavior',
            rationale: 'Checkout and invoice totals should depend on one billing boundary.',
            source_session: sessionId,
            related_symbols: ['applyDiscount']
        });

        const classic = classicSearch(projectPath, 'discount');
        const symbolMatches = await runtime.callTool('search_symbols', {
            project_id: projectId,
            query: 'discount',
            limit: 5
        });
        const historyMatches = await runtime.callTool('search_history', {
            project_id: projectId,
            query: 'discount',
            limit: 3
        });
        const decisions = await runtime.callTool('get_decisions', {
            project_id: projectId,
            symbol: 'applyDiscount'
        });
        const mcpText = [
            symbolMatches.content[0].text,
            historyMatches.content[0].text,
            decisions.content[0].text
        ].join('\n');
        const classicTokens = approxTokens(classic);
        const mcpTokens = approxTokens(mcpText);
        const includesTarget = mcpText.includes('applyDiscount') && mcpText.includes('coupon rounding');

        return {
            name: 'bugfix_investigation_narrowing',
            classic_chars: classic.length,
            classic_tokens: classicTokens,
            mcp_chars: mcpText.length,
            mcp_tokens: mcpTokens,
            token_savings_pct: Math.round((1 - (mcpTokens / classicTokens)) * 1000) / 10,
            notes: 'Narrow a noisy discount regression from broad text matches to compact symbol, history, and decision context.',
            passed: includesTarget && mcpTokens < classicTokens
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
        await benchmarkAstCallers(),
        await benchmarkAstImportResolverPrecision(),
        await benchmarkIncrementalReindex(),
        await benchmarkLanguageDepth(),
        await benchmarkBugFixInvestigationNarrowing()
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
