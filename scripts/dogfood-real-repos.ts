import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { performance } from 'perf_hooks';

type RepoCase = {
    name: string;
    url: string;
    queryHint?: string;
};

const repos: RepoCase[] = [
    { name: 'express', url: 'https://github.com/expressjs/express.git', queryHint: 'Router' },
    { name: 'zod', url: 'https://github.com/colinhacks/zod.git', queryHint: 'ZodObject' },
    { name: 'typer', url: 'https://github.com/fastapi/typer.git', queryHint: 'Typer' },
    { name: 'click', url: 'https://github.com/pallets/click.git', queryHint: 'Command' },
    { name: 'requests', url: 'https://github.com/psf/requests.git', queryHint: 'Session' }
];

const supportedSource = /\.(ts|tsx|js|jsx|py)$/;
const ignored = /(^|[\/\\])(\.git|node_modules|dist|build|coverage|docs\/_build|site-packages)([\/\\]|$)/;

let db: any;
let indexFile: any;
let getProjectIndexHealth: any;
let callTool: any;

function approxTokens(text: string) {
    return Math.ceil(text.length / 4);
}

function cloneRepo(repo: RepoCase, root: string) {
    const target = path.join(root, repo.name);
    if (fs.existsSync(target)) return target;
    execFileSync('git', ['clone', '--depth', '1', repo.url, target], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return target;
}

function recursiveFiles(root: string) {
    const files: string[] = [];
    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (ignored.test(fullPath)) continue;
            if (entry.isDirectory()) walk(fullPath);
            else if (supportedSource.test(fullPath)) files.push(fullPath);
        }
    }
    walk(root);
    return files;
}

function classicSearch(files: string[], query: string) {
    const lines: string[] = [];
    const matchedFiles = new Set<string>();
    for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        content.split(/\r?\n/).forEach((line, index) => {
            if (line.includes(query)) {
                matchedFiles.add(file);
                lines.push(`${file}:${index + 1}: ${line.trim()}`);
            }
        });
    }
    return {
        text: lines.join('\n'),
        files_read: matchedFiles.size,
        matches: lines.length
    };
}

function pickQuery(projectId: string, hint?: string) {
    if (hint) {
        const hinted = db.prepare(`
            SELECT name
            FROM symbols
            WHERE project_id = ?
            AND is_deleted = 0
            AND (name = ? OR qualified_name LIKE ?)
            ORDER BY length(body) DESC
            LIMIT 1
        `).get(projectId, hint, `%${hint}%`) as { name: string } | undefined;
        if (hinted) return hinted.name;
    }
    const row = db.prepare(`
        SELECT name
        FROM symbols
        WHERE project_id = ?
        AND is_deleted = 0
        AND kind IN ('function', 'class', 'method')
        ORDER BY length(body) DESC
        LIMIT 1
    `).get(projectId) as { name: string } | undefined;
    return row?.name || hint || '';
}

async function runRepo(repo: RepoCase, root: string) {
    const projectPath = cloneRepo(repo, root);
    const projectId = `dogfood-${repo.name}`;
    process.env.PROJECT_PATH = projectPath;
    process.env.PROJECT_ID = projectId;

    const files = recursiveFiles(projectPath);
    const startedAt = performance.now();
    let indexed = 0;
    let skipped = 0;
    let excluded = 0;
    let failed = 0;

    for (const file of files) {
        const result = await indexFile(file, projectId, { force: true });
        if (result.indexed) indexed++;
        else if (result.reason === 'excluded') excluded++;
        else if (result.skipped) skipped++;
        else failed++;
    }
    const indexMs = Math.round(performance.now() - startedAt);
    const symbolCount = (db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND is_deleted = 0")
        .get(projectId) as { count: number }).count;
    const query = pickQuery(projectId, repo.queryHint);
    const classic = classicSearch(files, query);
    const searchStarted = performance.now();
    const search = await callTool('code_search', {
        project_id: projectId,
        project_path: projectPath,
        query,
        limit: 5,
        max_tokens: 900
    });
    const searchMs = Math.round((performance.now() - searchStarted) * 10) / 10;
    const searchText = search.content[0].text;
    const searchPayload = JSON.parse(searchText);
    const first = searchPayload.results?.[0]?.symbol;
    const context = first ? await callTool('read_context', {
        project_id: projectId,
        ref: first.ref,
        include_body: false,
        max_tokens: 1000
    }) : undefined;
    const impact = first ? await callTool('impact_analysis', {
        project_id: projectId,
        ref: first.ref,
        max_tokens: 1000
    }) : undefined;
    const health = getProjectIndexHealth(projectPath, projectId);

    return {
        repo: repo.name,
        url: repo.url,
        project_path: projectPath,
        source_files: files.length,
        indexed_files: indexed,
        skipped_files: skipped,
        excluded_files: excluded,
        failed_files: failed,
        symbols: symbolCount,
        index_ms: indexMs,
        query,
        classic_tokens: approxTokens(classic.text),
        classic_files_read: classic.files_read,
        classic_matches: classic.matches,
        mcp_tokens: approxTokens(searchText),
        mcp_results: searchPayload.results?.length || 0,
        mcp_search_ms: searchMs,
        selected_symbol: first ? {
            name: first.name,
            kind: first.kind,
            file: first.file,
            freshness: first.freshness
        } : null,
        read_context_tokens: context ? approxTokens(context.content[0].text) : 0,
        impact_tokens: impact ? approxTokens(impact.content[0].text) : 0,
        freshness: health.freshness,
        stale_files: 'stale_files' in health ? health.stale_files : undefined,
        unindexed_files: 'unindexed_files' in health ? health.unindexed_files : undefined,
        passed: symbolCount > 0 && Boolean(first) && health.freshness === 'fresh'
    };
}

function writeReports(results: any[]) {
    const outDir = path.join(process.cwd(), 'dogfood', 'results');
    fs.mkdirSync(outDir, { recursive: true });
    const payload = {
        generated_at: new Date().toISOString(),
        repos: results
    };
    fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(payload, null, 2));
    const rows = results.map(result => [
        result.repo,
        result.passed ? 'pass' : 'fail',
        result.source_files,
        result.symbols,
        result.index_ms,
        result.query,
        result.classic_tokens,
        result.mcp_tokens,
        result.freshness
    ]);
    fs.writeFileSync(path.join(outDir, 'latest.md'), [
        '# Real Repository Dogfooding Results',
        '',
        '| Repo | Status | Source Files | Symbols | Index ms | Query | Classic Tokens | MCP Tokens | Freshness |',
        '| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- |',
        ...rows.map(row => `| ${row.join(' | ')} |`),
        ''
    ].join('\n'));
}

async function main() {
    const root = path.join(os.tmpdir(), 'mcp-memory-real-repos');
    fs.mkdirSync(root, { recursive: true });
    const dbPath = path.join(root, 'dogfood.sqlite');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    process.env.MCP_MEMORY_DB_PATH = dbPath;

    const dbModule = await import('../src/db');
    const indexer = await import('../src/indexer');
    const server = await import('../src/server');
    db = dbModule.default;
    indexFile = indexer.indexFile;
    getProjectIndexHealth = indexer.getProjectIndexHealth;
    callTool = server.callTool;

    dbModule.initDb();
    const results = [];
    for (const repo of repos) {
        results.push(await runRepo(repo, root));
    }
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
