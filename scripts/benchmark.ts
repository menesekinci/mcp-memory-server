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

async function waitFor(condition: () => boolean, timeoutMs = 15000) {
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
    const mcpPayload = JSON.parse(mcpText);
    const foundTarget = Array.isArray(mcpPayload) && mcpPayload.some((symbol: any) => symbol.name === 'callTool');
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
        passed: foundTarget && mcpTokens < classicTokens
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

async function benchmarkTsxComponentAndInstanceResolution(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-tsx-graph');
    const projectId = 'benchmark-tsx-graph';
    const serviceFile = path.join(projectPath, 'src', 'service.ts');
    const buttonFile = path.join(projectPath, 'src', 'button.tsx');
    const appFile = path.join(projectPath, 'src', 'app.tsx');

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

    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const methodTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'total', serviceFile);
            const componentTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'CheckoutButton', buttonFile);
            return Boolean(methodTarget && componentTarget);
        });

        const methodTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'total', serviceFile) as { id: string };
        const componentTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'CheckoutButton', buttonFile) as { id: string };
        const methodPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: methodTarget.id, min_confidence: 0.0 })).content[0].text);
        const componentPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: componentTarget.id, min_confidence: 0.0 })).content[0].text);
        const methodCallers = methodPayload.definite_callers.map((caller: any) => `${caller.qualified_name}:${caller.resolution_method}`);
        const componentCallers = componentPayload.definite_callers.map((caller: any) => `${caller.qualified_name}:${caller.resolution_method}`);

        return {
            name: 'tsx_component_and_instance_graph',
            notes: `Instance method callers: ${methodCallers.join(', ') || 'none'}; component callers: ${componentCallers.join(', ') || 'none'}.`,
            passed: methodCallers.includes('App:ts_checker_symbol')
                && componentCallers.includes('App:ts_checker_jsx_component')
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
    const pyBaseFile = path.join(projectPath, 'src', 'base.py');
    const pyMoneyFile = path.join(projectPath, 'src', 'billing', 'money.py');
    const pyInitFile = path.join(projectPath, 'src', '__init__.py');
    const goModFile = path.join(projectPath, 'go.mod');
    const goFile = path.join(projectPath, 'go', 'cart', 'cart.go');
    const goPricingFile = path.join(projectPath, 'go', 'pricing', 'pricing.go');
    const goReplaceFile = path.join(projectPath, 'replaced', 'discount', 'discount.go');
    const goGeneratedFile = path.join(projectPath, 'go', 'cart', 'cart.pb.go');
    const goBuildTaggedFile = path.join(projectPath, 'go', 'cart', 'ignored.go');
    const goImpossibleBuildFile = path.join(projectPath, 'go', 'cart', 'impossible.go');
    const goSuffixBuildFile = path.join(projectPath, 'go', 'cart', 'suffix_plan9.go');
    const goCustomBuildFile = path.join(projectPath, 'go', 'cart', 'custom.go');
    const goVendorFile = path.join(projectPath, 'vendor', 'example.com', 'vendorpkg', 'vendorpkg.go');
    const goWorkFile = path.join(projectPath, 'go.work');
    const goWorkspaceAppModFile = path.join(projectPath, 'workspace', 'app', 'go.mod');
    const goWorkspaceAppFile = path.join(projectPath, 'workspace', 'app', 'checkout', 'checkout.go');
    const goWorkspaceLibModFile = path.join(projectPath, 'workspace', 'lib', 'go.mod');
    const goWorkspaceLibFile = path.join(projectPath, 'workspace', 'lib', 'pricing', 'pricing.go');

    writeFile(jsFile, `
export const calculateTotal = () => 100;
export function checkout() {
  return calculateTotal();
}
`);
    writeFile(pyPricingFile, `
def calculate_external_total():
    return 200

class PriceCalculator:
    def total(self, value):
        return value

class Worker:
    def run(self):
        return 1
`);
    writeFile(pyBaseFile, `
class RemoteBaseCalculator:
    def remote_total(self, value):
        return value

    def super_total(self, value):
        return value
`);
    writeFile(pyInitFile, 'from .pricing import calculate_external_total as exported_total\n');
    writeFile(pyMoneyFile, `
def round_money(value):
    return value
`);
    writeFile(goModFile, 'module example.com/shop\n\ngo 1.22\n\nreplace example.com/replaced => ./replaced\n');
    writeFile(goWorkFile, 'go 1.22\n\nuse (\n    ./workspace/app\n    ./workspace/lib\n)\n');
    writeFile(goPricingFile, `
package pricing

func Round(value int) int {
    return value
}
`);
    writeFile(goFile, `
package cart

import (
    price "example.com/shop/go/pricing"
    discount "example.com/replaced/discount"
    vendored "example.com/vendorpkg"
)

type Calculator struct{}
type AdvancedCalculator struct {
    Calculator
}

func CalculateTotal(value int) int {
    return price.Round(value)
}

func CheckoutReplace(value int) int {
    return discount.Apply(value)
}

func CheckoutVendor(value int) int {
    return vendored.Touch(value)
}

func CheckoutGo(value int) int {
    return CalculateTotal(value)
}

func (c *Calculator) normalize(value int) int {
    return value
}

func (c *Calculator) Total(value int) int {
    return c.normalize(value)
}

func BuildWithLocal(value int) int {
    calculator := &Calculator{}
    return calculator.normalize(value)
}

func (a *AdvancedCalculator) Total(value int) int {
    return a.normalize(value)
}

type Pricer interface {
    Price() int
}

type FixedPricer struct{}

func (f *FixedPricer) Price() int {
    return 42
}

func CheckoutInterface(p Pricer) int {
    return p.Price()
}
`);
    writeFile(goReplaceFile, `
package discount

func Apply(value int) int {
    return value
}
`);
    writeFile(goGeneratedFile, `
// Code generated by protoc-gen-go. DO NOT EDIT.
package cart

func GeneratedNoise() int {
    return 1
}
`);
    writeFile(goBuildTaggedFile, `
//go:build ignore

package cart

func IgnoredBuildTagNoise() int {
    return 1
}
`);
    writeFile(goImpossibleBuildFile, `
//go:build linux && windows

package cart

func ImpossibleBuildTagNoise() int {
    return 1
}
`);
    writeFile(goSuffixBuildFile, `
package cart

func Plan9SuffixNoise() int {
    return 1
}
`);
    writeFile(goCustomBuildFile, `
//go:build mcpmemory

package cart

func CustomTaggedGo() int {
    return 7
}
`);
    writeFile(goVendorFile, `
package vendorpkg

func Touch(value int) int {
    return value
}
`);
    writeFile(goWorkspaceAppModFile, 'module example.com/workspace/app\n\ngo 1.22\n');
    writeFile(goWorkspaceLibModFile, 'module example.com/workspace/lib\n\ngo 1.22\n');
    writeFile(goWorkspaceLibFile, `
package pricing

func WorkspaceRound(value int) int {
    return value
}
`);
    writeFile(goWorkspaceAppFile, `
package checkout

import pricing "example.com/workspace/lib/pricing"

func CheckoutWorkspace(value int) int {
    return pricing.WorkspaceRound(value)
}
`);
    writeFile(pyFile, `
from .pricing import calculate_external_total as external_total
from .pricing import PriceCalculator as Calculator
from .pricing import Worker
from .base import RemoteBaseCalculator
from . import exported_total
import billing.money as money
import billing.money

def calculate_total():
    return 100

async def calculate_async_total():
    return 300

def checkout_py():
    return calculate_total()

async def checkout_async_py():
    return await calculate_async_total()

def checkout_external_py():
    return external_total()

def checkout_module_py():
    return money.round_money(10)

def checkout_nested_module_py():
    return billing.money.round_money(20)

def checkout_reexport_py():
    return exported_total()

def checkout_instance_py():
    calculator = Calculator()
    return calculator.total(10)

class BaseCalculator:
    def inherited_total(self, value):
        return value

class AdvancedCalculator(BaseCalculator):
    def total(self, value):
        return self.inherited_total(value)

class RemoteAdvancedCalculator(RemoteBaseCalculator):
    def total(self, value):
        return self.remote_total(value)

class SuperAdvancedCalculator(RemoteBaseCalculator):
    def total(self, value):
        return super().super_total(value)

class UsesWorker:
    def __init__(self):
        self.worker = Worker()

    def execute(self):
        return self.worker.run()
`);

    const previousGoBuildTags = process.env.MCP_MEMORY_GO_BUILD_TAGS;
    process.env.MCP_MEMORY_GO_BUILD_TAGS = [previousGoBuildTags, 'mcpmemory'].filter(Boolean).join(',');
    const runtime = await withRuntime(projectPath, projectId);
    const watcher = runtime.startIndexer(projectPath, projectId);
    try {
        await waitFor(() => {
            const jsTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculateTotal', jsFile);
            const pyTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculate_total', pyFile);
            const pyAsyncTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculate_async_total', pyFile);
            const pyExternalTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'calculate_external_total', pyPricingFile);
            const pyModuleTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'round_money', pyMoneyFile);
            const pyInstanceTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'total', pyPricingFile);
            const pyInheritedTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'inherited_total', pyFile);
            const pyRemoteTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'remote_total', pyBaseFile);
            const pySuperTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'super_total', pyBaseFile);
            const pyWorkerTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'run', pyPricingFile);
            const goTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'CalculateTotal', goFile);
            const goExternalTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'Round', goPricingFile);
            const goReplaceTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'Apply', goReplaceFile);
            const goVendorTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'Touch', goVendorFile);
            const goMethodTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND qualified_name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'Calculator.normalize', goFile);
            const goInterfaceTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND qualified_name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'FixedPricer.Price', goFile);
            const goWorkspaceTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'WorkspaceRound', goWorkspaceLibFile);
            const goGeneratedExcluded = runtime.db.prepare("SELECT is_excluded FROM files WHERE project_id = ? AND path = ?")
              .get(projectId, goGeneratedFile) as { is_excluded: number } | undefined;
            const goBuildTaggedExcluded = runtime.db.prepare("SELECT is_excluded FROM files WHERE project_id = ? AND path = ?")
              .get(projectId, goBuildTaggedFile) as { is_excluded: number } | undefined;
            const goImpossibleBuildExcluded = runtime.db.prepare("SELECT is_excluded FROM files WHERE project_id = ? AND path = ?")
              .get(projectId, goImpossibleBuildFile) as { is_excluded: number } | undefined;
            const goSuffixBuildExcluded = runtime.db.prepare("SELECT is_excluded FROM files WHERE project_id = ? AND path = ?")
              .get(projectId, goSuffixBuildFile) as { is_excluded: number } | undefined;
            const goCustomTaggedTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, 'CustomTaggedGo', goCustomBuildFile);
            return Boolean(jsTarget && pyTarget && pyAsyncTarget && pyExternalTarget && pyModuleTarget && pyInstanceTarget && pyInheritedTarget && pyRemoteTarget && pySuperTarget && pyWorkerTarget && goTarget && goExternalTarget && goReplaceTarget && goVendorTarget && goMethodTarget && goInterfaceTarget && goWorkspaceTarget && goGeneratedExcluded?.is_excluded === 1 && goBuildTaggedExcluded?.is_excluded === 1 && goImpossibleBuildExcluded?.is_excluded === 1 && goSuffixBuildExcluded?.is_excluded === 1 && goCustomTaggedTarget);
        });

        const jsTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculateTotal', jsFile) as { id: string };
        const pyTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculate_total', pyFile) as { id: string };
        const pyAsyncTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculate_async_total', pyFile) as { id: string };
        const pyExternalTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'calculate_external_total', pyPricingFile) as { id: string };
        const pyModuleTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'round_money', pyMoneyFile) as { id: string };
        const pyInstanceTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'total', pyPricingFile) as { id: string };
        const pyInheritedTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'inherited_total', pyFile) as { id: string };
        const pyRemoteTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'remote_total', pyBaseFile) as { id: string };
        const pySuperTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'super_total', pyBaseFile) as { id: string };
        const pyWorkerTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'run', pyPricingFile) as { id: string };
        const goTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'CalculateTotal', goFile) as { id: string };
        const goExternalTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'Round', goPricingFile) as { id: string };
        const goReplaceTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'Apply', goReplaceFile) as { id: string };
        const goVendorTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'Touch', goVendorFile) as { id: string };
        const goMethodTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND qualified_name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'Calculator.normalize', goFile) as { id: string };
        const goInterfaceTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND qualified_name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'FixedPricer.Price', goFile) as { id: string };
        const goWorkspaceTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'WorkspaceRound', goWorkspaceLibFile) as { id: string };
        const jsPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: jsTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyAsyncPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyAsyncTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyExternalPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyExternalTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyModulePayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyModuleTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyInstancePayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyInstanceTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyInheritedPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyInheritedTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyRemotePayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyRemoteTarget.id, min_confidence: 0.0 })).content[0].text);
        const pySuperPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pySuperTarget.id, min_confidence: 0.0 })).content[0].text);
        const pyWorkerPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: pyWorkerTarget.id, min_confidence: 0.0 })).content[0].text);
        const goPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: goTarget.id, min_confidence: 0.0 })).content[0].text);
        const goExternalPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: goExternalTarget.id, min_confidence: 0.0 })).content[0].text);
        const goReplacePayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: goReplaceTarget.id, min_confidence: 0.0 })).content[0].text);
        const goVendorPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: goVendorTarget.id, min_confidence: 0.0 })).content[0].text);
        const goMethodPayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: goMethodTarget.id, min_confidence: 0.0 })).content[0].text);
        const goInterfacePayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: goInterfaceTarget.id, min_confidence: 0.0 })).content[0].text);
        const goWorkspacePayload = JSON.parse((await runtime.callTool('find_callers', { symbol_id: goWorkspaceTarget.id, min_confidence: 0.0 })).content[0].text);
        const jsCallers = jsPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyCallers = pyPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyAsyncCallers = pyAsyncPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyExternalCallers = pyExternalPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyModuleCallers = pyModulePayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyInstanceCallers = pyInstancePayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyInheritedCallers = pyInheritedPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyRemoteCallers = pyRemotePayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pySuperCallers = pySuperPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const pyWorkerCallers = pyWorkerPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const goCallers = goPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const goExternalCallers = goExternalPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const goReplaceCallers = goReplacePayload.definite_callers.map((caller: any) => caller.qualified_name);
        const goVendorCallers = goVendorPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const goMethodCallers = goMethodPayload.definite_callers.map((caller: any) => caller.qualified_name);
        const goInterfaceCallers = goInterfacePayload.definite_callers.map((caller: any) => caller.qualified_name);
        const goWorkspaceCallers = goWorkspacePayload.definite_callers.map((caller: any) => caller.qualified_name);
        const goGeneratedExcluded = runtime.db.prepare("SELECT is_excluded FROM files WHERE project_id = ? AND path = ?")
          .get(projectId, goGeneratedFile) as { is_excluded: number } | undefined;
        const goBuildTaggedExcluded = runtime.db.prepare("SELECT is_excluded FROM files WHERE project_id = ? AND path = ?")
          .get(projectId, goBuildTaggedFile) as { is_excluded: number } | undefined;
        const goImpossibleBuildExcluded = runtime.db.prepare("SELECT is_excluded FROM files WHERE project_id = ? AND path = ?")
          .get(projectId, goImpossibleBuildFile) as { is_excluded: number } | undefined;
        const goSuffixBuildExcluded = runtime.db.prepare("SELECT is_excluded FROM files WHERE project_id = ? AND path = ?")
          .get(projectId, goSuffixBuildFile) as { is_excluded: number } | undefined;
        const goCustomTaggedTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0")
          .get(projectId, 'CustomTaggedGo', goCustomBuildFile) as { id: string } | undefined;

        return {
            name: 'language_depth_js_python_callers',
            notes: `JavaScript callers: ${jsCallers.join(', ') || 'none'}; Python same-file: ${pyCallers.join(', ') || 'none'}; Python async: ${pyAsyncCallers.join(', ') || 'none'}; Python from/re-export: ${pyExternalCallers.join(', ') || 'none'}; Python module-import: ${pyModuleCallers.join(', ') || 'none'}; Python instance-method: ${pyInstanceCallers.join(', ') || 'none'}; Python inherited-self: ${pyInheritedCallers.join(', ') || 'none'}; Python imported-base: ${pyRemoteCallers.join(', ') || 'none'}; Python super: ${pySuperCallers.join(', ') || 'none'}; Python self-attribute instance: ${pyWorkerCallers.join(', ') || 'none'}; Go same-package: ${goCallers.join(', ') || 'none'}; Go import/replace/vendor: ${[...goExternalCallers, ...goReplaceCallers, ...goVendorCallers].join(', ') || 'none'}; Go receiver/local/embedded/interface methods: ${[...goMethodCallers, ...goInterfaceCallers].join(', ') || 'none'}; Go workspace import: ${goWorkspaceCallers.join(', ') || 'none'}; generated excluded: ${goGeneratedExcluded?.is_excluded === 1}; build-tag excluded: ${goBuildTaggedExcluded?.is_excluded === 1}; false-build-expression excluded: ${goImpossibleBuildExcluded?.is_excluded === 1}; suffix excluded: ${goSuffixBuildExcluded?.is_excluded === 1}; custom tag indexed: ${Boolean(goCustomTaggedTarget)}.`,
            passed: jsCallers.includes('checkout')
                && pyCallers.includes('checkout_py')
                && pyAsyncCallers.includes('checkout_async_py')
                && pyExternalCallers.includes('checkout_external_py')
                && pyExternalCallers.includes('checkout_reexport_py')
                && pyModuleCallers.includes('checkout_module_py')
                && pyModuleCallers.includes('checkout_nested_module_py')
                && pyInstanceCallers.includes('checkout_instance_py')
                && pyInheritedCallers.includes('AdvancedCalculator.total')
                && pyRemoteCallers.includes('RemoteAdvancedCalculator.total')
                && pySuperCallers.includes('SuperAdvancedCalculator.total')
                && pyWorkerCallers.includes('UsesWorker.execute')
                && goCallers.includes('CheckoutGo')
                && goExternalCallers.includes('CalculateTotal')
                && goReplaceCallers.includes('CheckoutReplace')
                && goVendorCallers.includes('CheckoutVendor')
                && goMethodCallers.includes('Calculator.Total')
                && goMethodCallers.includes('BuildWithLocal')
                && goMethodCallers.includes('AdvancedCalculator.Total')
                && goInterfaceCallers.includes('CheckoutInterface')
                && goWorkspaceCallers.includes('CheckoutWorkspace')
                && goGeneratedExcluded?.is_excluded === 1
                && goBuildTaggedExcluded?.is_excluded === 1
                && goImpossibleBuildExcluded?.is_excluded === 1
                && goSuffixBuildExcluded?.is_excluded === 1
                && Boolean(goCustomTaggedTarget)
        };
    } finally {
        await watcher.close();
        if (previousGoBuildTags === undefined) delete process.env.MCP_MEMORY_GO_BUILD_TAGS;
        else process.env.MCP_MEMORY_GO_BUILD_TAGS = previousGoBuildTags;
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

async function benchmarkMonorepoScale(): Promise<BenchmarkResult> {
    const projectPath = createTempDir('mcp-memory-benchmark-monorepo');
    const projectId = 'benchmark-monorepo';
    const packageCount = 20;
    const filesPerPackage = 40;
    const functionsPerFile = 6;
    const targetPackage = packageCount - 1;
    const targetFileIndex = filesPerPackage - 1;
    const targetFnIndex = functionsPerFile - 1;
    const targetName = `pkg${targetPackage}Symbol_${targetFileIndex}_${targetFnIndex}`;

    writeFile(path.join(projectPath, 'package.json'), JSON.stringify({
        private: true,
        workspaces: ['packages/*']
    }, null, 2));

    for (let packageIndex = 0; packageIndex < packageCount; packageIndex++) {
        const packageRoot = path.join(projectPath, 'packages', `pkg-${packageIndex}`);
        writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
            name: `@benchmark/pkg-${packageIndex}`,
            version: '0.0.0'
        }, null, 2));
        writeFile(path.join(packageRoot, 'dist', 'generated.ts'), 'export function generatedMonorepoOutput() { return 1; }\n');

        for (let fileIndex = 0; fileIndex < filesPerPackage; fileIndex++) {
            const lines: string[] = [];
            for (let fnIndex = 0; fnIndex < functionsPerFile; fnIndex++) {
                const name = `pkg${packageIndex}Symbol_${fileIndex}_${fnIndex}`;
                if (packageIndex === 0 && fileIndex === 0 && fnIndex === 1) {
                    lines.push(`export function ${name}() { return pkg0Symbol_0_0(); }`);
                } else {
                    lines.push(`export function ${name}() { return ${packageIndex + fileIndex + fnIndex}; }`);
                }
            }
            writeFile(path.join(packageRoot, 'src', `module-${String(fileIndex).padStart(3, '0')}.ts`), `${lines.join('\n')}\n`);
        }
    }

    await initGitRepo(projectPath, 'initial monorepo benchmark');

    const runtime = await withRuntime(projectPath, projectId);
    const sourceFiles = recursiveFiles(projectPath)
        .filter(file => file.endsWith('.ts') && file.includes(`${path.sep}src${path.sep}`));

    const coldStartedAt = performance.now();
    for (const file of sourceFiles) {
        await runtime.indexFile(file, projectId);
    }
    const coldIndexMs = Math.round(performance.now() - coldStartedAt);

    const searchStartedAt = performance.now();
    const searchResult = await runtime.callTool('search_symbols', {
        project_id: projectId,
        query: targetName,
        limit: 5
    });
    const searchMs = Math.round((performance.now() - searchStartedAt) * 10) / 10;

    const callerTarget = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
      .get(projectId, 'pkg0Symbol_0_0') as { id: string };
    const callerStartedAt = performance.now();
    const callers = JSON.parse((await runtime.callTool('find_callers', {
        symbol_id: callerTarget.id,
        min_confidence: 0.8
    })).content[0].text);
    const callerMs = Math.round((performance.now() - callerStartedAt) * 10) / 10;

    const changedFile = path.join(projectPath, 'packages', `pkg-${targetPackage}`, 'src', `module-${String(targetFileIndex).padStart(3, '0')}.ts`);
    writeFile(changedFile, `${fs.readFileSync(changedFile, 'utf8')}\nexport function ${targetName}_changed() { return 999; }\n`);
    const incrementalStartedAt = performance.now();
    const incremental = await runtime.reindexChangedFiles(projectPath, projectId);
    const incrementalMs = Math.round((performance.now() - incrementalStartedAt) * 10) / 10;

    for (let packageIndex = 0; packageIndex < 5; packageIndex++) {
        const file = path.join(projectPath, 'packages', `pkg-${packageIndex}`, 'src', 'module-001.ts');
        writeFile(file, `${fs.readFileSync(file, 'utf8')}\nexport function pkg${packageIndex}RiskMarker() { return ${packageIndex}; }\n`);
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
    const generatedSymbol = runtime.db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0")
      .get(projectId, 'generatedMonorepoOutput');

    return {
        name: 'performance_monorepo_workspace',
        notes: `Cold index: ${coldIndexMs}ms for ${packageCount} packages/${sourceFiles.length} files/${symbolCount} symbols; search: ${searchMs}ms; caller: ${callerMs}ms; incremental: ${incrementalMs}ms for ${incremental.changed_files} changed file; risk: ${riskMs}ms for ${risk.changed_files.length} changed files; db: ${dbSizeMb}MB.`,
        passed: symbolCount >= packageCount * filesPerPackage * functionsPerFile
            && searchPayload[0]?.name === targetName
            && callerNames.includes('pkg0Symbol_0_1')
            && incremental.changed_files === 1
            && risk.changed_files.length >= 5
            && !generatedSymbol
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
        await benchmarkTsxComponentAndInstanceResolution(),
        await benchmarkIncrementalReindex(),
        await benchmarkLanguageDepth(),
        await benchmarkBugFixInvestigationNarrowing(),
        await benchmarkBugFixRootSymbolSuccess(),
        await benchmarkRefactorImpactAnalysis(),
        await benchmarkRegressionNarrowing(),
        await benchmarkPrRiskSummary(),
        await benchmarkDiscoveryWorkloadComparison(),
        await benchmarkPerformanceScale(),
        await benchmarkMonorepoScale()
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
