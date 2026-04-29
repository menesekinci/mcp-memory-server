import fs from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';

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

function classicSearchStats(root: string, query: string) {
    const files = new Set<string>();
    const matches: string[] = [];
    for (const file of recursiveFiles(root)) {
        if (!/\.(ts|tsx|js|jsx|py)$/.test(file)) continue;
        const content = fs.readFileSync(file, 'utf8');
        content.split(/\r?\n/).forEach((line, index) => {
            if (line.includes(query)) {
                files.add(file);
                matches.push(`${file}:${index + 1}: ${line.trim()}`);
            }
        });
    }
    return {
        files_read: files.size,
        matches: matches.length,
        text: matches.join('\n')
    };
}

async function initGitRepo(projectPath: string, message: string) {
    const { execFileSync } = await import('child_process');
    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: projectPath });
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', message], { cwd: projectPath, stdio: 'ignore' });
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
    await runtime.indexFile(path.join(projectPath, 'src', 'server.ts'), projectId, { force: true });

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

    await initGitRepo(projectPath, 'initial benchmark files');

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
    const pyPricingFile = path.join(projectPath, 'src', 'pricing.py');
    const pyMoneyFile = path.join(projectPath, 'src', 'billing', 'money.py');

    writeFile(jsFile, `
export const calculateTotal = () => 100;
export function checkout() {
  return calculateTotal();
}
`);
    writeFile(pyPricingFile, `
def calculate_external_total():
    return 200
`);
    writeFile(pyMoneyFile, `
def round_money(value):
    return value
`);
    writeFile(pyFile, `
from .pricing import calculate_external_total as external_total
import billing.money as money

def calculate_total():
    return 100

def checkout_py():
    return calculate_total()

def checkout_external_py():
    return external_total()

def checkout_module_py():
    return money.round_money(10)
`);

    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const jsTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculateTotal', jsFile);
            const pyTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculate_total', pyFile);
            const pyExternalTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculate_external_total', pyPricingFile);
            const pyModuleTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'round_money', pyMoneyFile);
            return Boolean(jsTarget && pyTarget && pyExternalTarget && pyModuleTarget);
        });

        const jsTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculateTotal', jsFile) as { id: string };
        const pyTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculate_total', pyFile) as { id: string };
        const pyExternalTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculate_external_total', pyPricingFile) as { id: string };
        const pyModuleTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'round_money', pyMoneyFile) as { id: string };
        const jsPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: jsTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyExternalPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyExternalTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyModulePayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyModuleTarget.id, min_confidence: 0.0 })).content[0].text);
        const jsCallers = jsPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyCallers = pyPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyExternalCallers = pyExternalPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyModuleCallers = pyModulePayload.definite_callers.map((caller: any) => caller.qualified_name);

        return {
            name: 'language_depth_js_python_callers',
            notes: `JavaScript callers: ${jsCallers.join(', ') || 'none'}; Python same-file: ${pyCallers.join(', ') || 'none'}; Python from-import: ${pyExternalCallers.join(', ') || 'none'}; Python module-import: ${pyModuleCallers.join(', ') || 'none'}.`,
            passed: jsCallers.includes('checkout')
                && pyCallers.includes('checkout_py')
                && pyExternalCallers.includes('checkout_external_py')
                && pyModuleCallers.includes('checkout_module_py')
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

async function benchmarkBugFixRootSymbolSuccess(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-root-symbol');
    const projectId = 'benchmark-root-symbol';
    const sessionId = 'benchmark-root-symbol-session';
    writeFile(path.join(projectPath, 'src', 'billing', 'invoice.ts'), `
export function normalizeInvoiceTotal(input: number) {
  return Math.max(0, Math.round(input * 100) / 100);
}

export function formatInvoiceTotal(input: number) {
  return "$" + normalizeInvoiceTotal(input).toFixed(2);
}
`);
    for (let i = 0; i < 16; i++) {
        writeFile(path.join(projectPath, 'src', 'noise', `invoice-copy-${i}.ts`), `
export function invoiceCopy${i}() {
  return "normalize invoice total copy appears in UI text";
}
`);
    }

    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const row = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectId, 'normalizeInvoiceTotal');
            return Boolean(row);
        });

        const now = Date.now();
        runtime.db.prepare("INSERT INTO sessions (id, project_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
          .run(sessionId, projectId, now - 1000, now - 500);
        await runtime.callTool('save_message', {
            session_id: sessionId,
            project_id: projectId,
            role: 'user',
            content: 'Bug report: negative invoice totals should be clamped by normalizeInvoiceTotal.',
            explicit_symbols: ['normalizeInvoiceTotal']
        });

        const classic = classicSearchStats(projectPath, 'invoice total');
        const symbols = await runtime.callTool('search_symbols', {
            project_id: projectId,
            query: 'normalizeInvoiceTotal',
            limit: 3
        });
        const history = await runtime.callTool('search_history', {
            project_id: projectId,
            query: 'normalizeInvoiceTotal',
            limit: 2
        });
        const mcpText = `${symbols.content[0].text}\n${history.content[0].text}`;
        const parsedSymbols = JSON.parse(symbols.content[0].text);
        const rootSelected = parsedSymbols[0]?.name === 'normalizeInvoiceTotal';
        const classicTokens = approxTokens(classic.text);
        const mcpTokens = approxTokens(mcpText);

        return {
            name: 'task_success_bugfix_root_symbol',
            classic_chars: classic.text.length,
            classic_tokens: classicTokens,
            mcp_chars: mcpText.length,
            mcp_tokens: mcpTokens,
            token_savings_pct: Math.round((1 - (mcpTokens / classicTokens)) * 1000) / 10,
            notes: `Root symbol selected: ${rootSelected}; classic files read: ${classic.files_read}; MCP bodies read: 0.`,
            passed: rootSelected && mcpTokens < classicTokens
        };
    } finally {
        await watcher.close();
    }
}

async function benchmarkRefactorImpactAnalysis(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-refactor-impact');
    const projectId = 'benchmark-refactor-impact';
    const targetFile = path.join(projectPath, 'src', 'pricing.ts');
    writeFile(targetFile, `
export function calculatePublicPrice(amount: number) {
  return amount * 1.2;
}

export function checkoutPrice(amount: number) {
  return calculatePublicPrice(amount);
}

export function invoicePreview(amount: number) {
  return calculatePublicPrice(amount);
}

export function mentionOnly() {
  return "calculatePublicPrice";
}
`);
    writeFile(path.join(projectPath, 'src', 'pricing.test.ts'), `
import { calculatePublicPrice } from "./pricing";

export function testPrice() {
  return calculatePublicPrice(10);
}
`);

    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const row = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculatePublicPrice', targetFile);
            return Boolean(row);
        });

        const target = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculatePublicPrice', targetFile) as { id: string };
        const result = await runtime.callTool('find_callers', {
            symbol_id: target.id,
            include_tests: false,
            min_confidence: 0.8
        });
        const payload = JSON.parse(result.content[0].text);
        const callers = payload.definite_callers.map((caller: any) => caller.qualified_name);
        const falsePositives = callers.filter((name: string) => name === 'mentionOnly' || name === 'testPrice');
        const expected = ['checkoutPrice', 'invoicePreview'].every(name => callers.includes(name));

        return {
            name: 'task_success_refactor_impact',
            notes: `Production callers: ${callers.join(', ') || 'none'}; false positives: ${falsePositives.join(', ') || 'none'}.`,
            passed: expected && falsePositives.length === 0
        };
    } finally {
        await watcher.close();
    }
}

async function benchmarkRegressionNarrowing(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-regression-narrowing');
    const projectId = 'benchmark-regression-narrowing';
    const sessionId = 'benchmark-regression-session';
    const filePath = path.join(projectPath, 'src', 'checkout.ts');
    writeFile(filePath, `
export function calculateCheckoutTax(amount: number) {
  return amount * 0.18;
}

export function stableCheckoutLabel() {
  return "checkout";
}
`);
    await initGitRepo(projectPath, 'initial checkout logic');

    const runtime = await withRuntime(projectPath, projectId);
    await runtime.indexFile(filePath, projectId);
    const now = Date.now();
    runtime.db.prepare("INSERT INTO sessions (id, project_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, projectId, now - 2000, now - 1500);
    await runtime.callTool('save_message', {
        session_id: sessionId,
        project_id: projectId,
        role: 'user',
        content: 'Prior regression discussion: calculateCheckoutTax is sensitive to regional tax changes.',
        explicit_symbols: ['calculateCheckoutTax']
    });
    await runtime.callTool('save_decision', {
        project_id: projectId,
        summary: 'calculateCheckoutTax owns regional tax behavior',
        rationale: 'Checkout totals should not duplicate tax logic elsewhere.',
        source_session: sessionId,
        related_symbols: ['calculateCheckoutTax']
    });

    writeFile(filePath, `
export function calculateCheckoutTax(amount: number) {
  return amount * 0.20;
}

export function stableCheckoutLabel() {
  return "checkout";
}
`);
    await runtime.reindexChangedFiles(projectPath, projectId);
    const risk = JSON.parse((await runtime.callTool('changed_symbols_risk', {
        project_id: projectId,
        project_path: projectPath
    })).content[0].text);
    const discussed = JSON.parse((await runtime.callTool('symbols_discussed_and_changed', {
        project_id: projectId
    })).content[0].text);
    const changedNames = risk.changed_symbols.map((symbol: any) => symbol.name);
    const decisionSummaries = risk.related_decisions.map((decision: any) => decision.summary);
    const discussedNames = discussed.map((row: any) => row.name);

    return {
        name: 'task_success_regression_narrowing',
        notes: `Changed symbols: ${changedNames.join(', ') || 'none'}; linked decisions: ${decisionSummaries.join(', ') || 'none'}; discussed changed: ${discussedNames.join(', ') || 'none'}.`,
        passed: changedNames.includes('calculateCheckoutTax')
            && decisionSummaries.some((summary: string) => summary.includes('regional tax'))
            && discussedNames.includes('calculateCheckoutTax')
    };
}

async function benchmarkPrRiskSummary(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-pr-risk');
    const projectId = 'benchmark-pr-risk';
    const sessionId = 'benchmark-pr-risk-session';
    const publicFile = path.join(projectPath, 'src', 'api.ts');
    const internalFile = path.join(projectPath, 'src', 'internal.ts');
    writeFile(publicFile, `
export function publicCheckoutApi(input: number) {
  return input;
}
`);
    writeFile(internalFile, `
export function internalAuditMarker() {
  return "ok";
}
`);
    await initGitRepo(projectPath, 'initial api');

    const runtime = await withRuntime(projectPath, projectId);
    await runtime.indexFile(publicFile, projectId);
    await runtime.indexFile(internalFile, projectId);
    const now = Date.now();
    runtime.db.prepare("INSERT INTO sessions (id, project_id, started_at, ended_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, projectId, now - 1000, now - 500);
    await runtime.callTool('save_decision', {
        project_id: projectId,
        summary: 'publicCheckoutApi is an external contract',
        rationale: 'Any PR changing it should be called out in risk summaries.',
        source_session: sessionId,
        related_symbols: ['publicCheckoutApi']
    });

    writeFile(publicFile, `
export function publicCheckoutApi(input: number) {
  return input + 1;
}
`);
    writeFile(internalFile, `
export function internalAuditMarker() {
  return "changed";
}
`);
    await runtime.reindexChangedFiles(projectPath, projectId);
    const risk = JSON.parse((await runtime.callTool('changed_symbols_risk', {
        project_id: projectId,
        project_path: projectPath
    })).content[0].text);
    const changedNames = risk.changed_symbols.map((symbol: any) => symbol.name);
    const decisionSummaries = risk.related_decisions.map((decision: any) => decision.summary);

    return {
        name: 'task_success_pr_risk_summary',
        notes: `Changed symbols: ${changedNames.join(', ') || 'none'}; related decisions: ${decisionSummaries.join(', ') || 'none'}.`,
        passed: changedNames.includes('publicCheckoutApi')
            && changedNames.includes('internalAuditMarker')
            && decisionSummaries.length === 1
            && decisionSummaries[0].includes('external contract')
    };
}

async function benchmarkDiscoveryWorkloadComparison(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-workload');
    const projectId = 'benchmark-workload';
    writeFile(path.join(projectPath, 'src', 'target.ts'), `
export function reconcilePaymentState() {
  return "reconciled";
}
`);
    for (let i = 0; i < 20; i++) {
        writeFile(path.join(projectPath, 'src', 'logs', `payment-log-${i}.ts`), `
export function paymentLog${i}() {
  return "payment state reconciliation log";
}
`);
    }

    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const row = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
              .get(projectId, 'reconcilePaymentState');
            return Boolean(row);
        });

        const classic = classicSearchStats(projectPath, 'payment state');
        const symbols = await runtime.callTool('search_symbols', {
            project_id: projectId,
            query: 'reconcilePaymentState',
            limit: 5
        });
        const target = JSON.parse(symbols.content[0].text)[0];
        const body = await runtime.callTool('get_symbol_body', {
            project_id: projectId,
            ref: target.ref
        });
        const mcpText = `${symbols.content[0].text}\n${body.content[0].text}`;
        const classicTokens = approxTokens(classic.text);
        const mcpTokens = approxTokens(mcpText);
        const falsePositiveFiles = classic.files_read - 1;

        return {
            name: 'task_success_discovery_workload',
            classic_chars: classic.text.length,
            classic_tokens: classicTokens,
            mcp_chars: mcpText.length,
            mcp_tokens: mcpTokens,
            token_savings_pct: Math.round((1 - (mcpTokens / classicTokens)) * 1000) / 10,
            notes: `Classic files read: ${classic.files_read}; MCP bodies read: 1; classic false-positive files: ${falsePositiveFiles}.`,
            passed: target.name === 'reconcilePaymentState'
                && falsePositiveFiles >= 10
                && mcpTokens < classicTokens
        };
    } finally {
        await watcher.close();
    }
}

async function benchmarkPerformanceScale(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-scale');
    const projectId = 'benchmark-scale';
    const fileCount = 1000;
    const functionsPerFile = 10;
    const targetFile = path.join(projectPath, 'src', 'module-0000.ts');

    for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
        const lines: string[] = [];
        for (let fnIndex = 0; fnIndex < functionsPerFile; fnIndex++) {
            const name = `scaleSymbol_${fileIndex}_${fnIndex}`;
            if (fileIndex === 0 && fnIndex === 0) {
                lines.push(`export function ${name}() { return "target"; }`);
            } else if (fileIndex === 0 && fnIndex === 1) {
                lines.push(`export function ${name}() { return scaleSymbol_0_0(); }`);
            } else {
                lines.push(`export function ${name}() { return ${fileIndex + fnIndex}; }`);
            }
        }
        writeFile(path.join(projectPath, 'src', `module-${String(fileIndex).padStart(4, '0')}.ts`), `${lines.join('\n')}\n`);
    }
    await initGitRepo(projectPath, 'initial scale benchmark');

    const runtime = await withRuntime(projectPath, projectId);
    const sourceFiles = recursiveFiles(projectPath).filter(file => file.endsWith('.ts'));

    const coldStartedAt = performance.now();
    for (const file of sourceFiles) {
        await runtime.indexFile(file, projectId);
    }
    const coldIndexMs = Math.round(performance.now() - coldStartedAt);

    const searchStartedAt = performance.now();
    const searchResult = await runtime.callTool('search_symbols', {
        project_id: projectId,
        query: 'scaleSymbol_999_9',
        limit: 5
    });
    const searchMs = Math.round((performance.now() - searchStartedAt) * 10) / 10;

    const target = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
      .get(projectId, 'scaleSymbol_0_0') as { id: string };
    const callerStartedAt = performance.now();
    const callers = JSON.parse((await runtime.callTool('find_callers', {
        symbol_id: target.id,
        min_confidence: 0.8
    })).content[0].text);
    const callerMs = Math.round((performance.now() - callerStartedAt) * 10) / 10;

    writeFile(targetFile, `${fs.readFileSync(targetFile, 'utf8')}\nexport function scaleSymbol_extra() { return scaleSymbol_0_0(); }\n`);
    const incrementalStartedAt = performance.now();
    const incremental = await runtime.reindexChangedFiles(projectPath, projectId);
    const incrementalMs = Math.round((performance.now() - incrementalStartedAt) * 10) / 10;

    for (let i = 1; i <= 25; i++) {
        const file = path.join(projectPath, 'src', `module-${String(i).padStart(4, '0')}.ts`);
        writeFile(file, `${fs.readFileSync(file, 'utf8')}\nexport function scaleSymbol_changed_${i}() { return ${i}; }\n`);
    }
    const riskStartedAt = performance.now();
    const risk = JSON.parse((await runtime.callTool('changed_symbols_risk', {
        project_id: projectId,
        project_path: projectPath
    })).content[0].text);
    const riskMs = Math.round((performance.now() - riskStartedAt) * 10) / 10;

    const dbInfo = runtime.db.prepare("PRAGMA database_list").all() as Array<{ file: string }>;
    const dbPath = dbInfo.find(row => row.file)?.file;
    const dbSizeMb = dbPath && fs.existsSync(dbPath)
        ? Math.round((fs.statSync(dbPath).size / 1024 / 1024) * 10) / 10
        : 0;
    const symbolCount = (runtime.db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND is_deleted = 0")
      .get(projectId) as { count: number }).count;
    const searchPayload = JSON.parse(searchResult.content[0].text);
    const callerNames = callers.definite_callers.map((caller: any) => caller.qualified_name);

    return {
        name: 'performance_scale_10k_symbols',
        notes: `Cold index: ${coldIndexMs}ms for ${fileCount} files/${symbolCount} symbols; search: ${searchMs}ms; caller: ${callerMs}ms; incremental: ${incrementalMs}ms for ${incremental.changed_files} changed file; risk: ${riskMs}ms for ${risk.changed_files.length} changed files; db: ${dbSizeMb}MB.`,
        passed: symbolCount >= 10000
            && searchPayload[0]?.name === 'scaleSymbol_999_9'
            && callerNames.includes('scaleSymbol_0_1')
            && incremental.changed_files === 1
            && risk.changed_files.length >= 25
            && coldIndexMs < 120000
            && searchMs < 1000
            && callerMs < 1000
            && incrementalMs < 10000
            && riskMs < 10000
            && dbSizeMb < 100
    };
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
        await benchmarkBugFixInvestigationNarrowing(),
        await benchmarkBugFixRootSymbolSuccess(),
        await benchmarkRefactorImpactAnalysis(),
        await benchmarkRegressionNarrowing(),
        await benchmarkPrRiskSummary(),
        await benchmarkDiscoveryWorkloadComparison(),
        await benchmarkPerformanceScale()
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
