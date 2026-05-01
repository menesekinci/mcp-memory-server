import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import JavaScript from 'tree-sitter-javascript';
import Go from 'tree-sitter-go';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import db from './db';
import { extractCallReferences } from './call-graph';
import { symbolRef } from './refs';
import { bodyStorageEnabled } from './privacy';

const LANGUAGES = {
    '.ts': { language: (TypeScript as any).typescript, name: 'typescript' },
    '.tsx': { language: (TypeScript as any).tsx, name: 'typescript' },
    '.js': { language: JavaScript as any, name: 'javascript' },
    '.jsx': { language: JavaScript as any, name: 'javascript' },
    '.py': { language: Python as any, name: 'python' },
    '.go': { language: Go as any, name: 'go' },
};

const IGNORED_PATH_PATTERN = /(^|[\/\\])(\.git|node_modules|dist|build|coverage)([\/\\]|$)/;
const ignoreCache = new Map<string, string[]>();

class IndexWorkerPool {
    private queue: string[] = [];
    private isProcessing = false;
    private maxConcurrent = 4; // Simple concurrency limit
    private activeWorkers = 0;

    async add(filePath: string, projectId = 'default') {
        if (!this.queue.includes(filePath)) {
            this.queue.push(filePath);
        }
        this.processQueue(projectId);
    }

    private async processQueue(projectId: string) {
        if (this.isProcessing || this.activeWorkers >= this.maxConcurrent) return;
        this.isProcessing = true;

        while (this.queue.length > 0 && this.activeWorkers < this.maxConcurrent) {
            const filePath = this.queue.shift();
            if (filePath) {
                this.activeWorkers++;
                indexFile(filePath, projectId).finally(() => {
                    this.activeWorkers--;
                    this.processQueue(projectId);
                });
            }
        }
        this.isProcessing = false;
    }
}

const workerPool = new IndexWorkerPool();
const debounceMap = new Map<string, NodeJS.Timeout>();

export function startIndexer(projectPath: string, projectId = 'default') {
    console.error(`Indexing project: ${projectPath}`);

    const watcher = chokidar.watch(projectPath, {
        ignored: (filePath) => isIgnoredProjectPath(filePath, projectPath),
        persistent: true,
    });

    watcher.on('change', (filePath) => {
        debounceIndex(filePath, projectId);
    });

    watcher.on('add', (filePath) => {
        debounceIndex(filePath, projectId);
    });

    watcher.on('unlink', (filePath) => {
        markFileDeleted(filePath, projectId);
    });

    watcher.on('ready', () => {
        console.error('Initial scan complete. Watching for changes...');
    });

    return watcher;
}

function debounceIndex(filePath: string, projectId: string) {
    if (debounceMap.has(filePath)) {
        clearTimeout(debounceMap.get(filePath));
    }
    const timeout = setTimeout(() => {
        debounceMap.delete(filePath);
        workerPool.add(filePath, projectId);
    }, 300);
    debounceMap.set(filePath, timeout);
}

function markFileDeleted(filePath: string, projectId: string) {
    const now = Date.now();
    db.prepare("UPDATE symbols SET is_deleted = 1, updated_at = ? WHERE project_id = ? AND file_path = ?")
      .run(now, projectId, filePath);
    db.prepare("DELETE FROM symbol_calls WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
    db.prepare("UPDATE files SET last_indexed_at = ?, git_blob_sha = NULL WHERE project_id = ? AND path = ?")
      .run(now, projectId, filePath);
}

export async function indexFile(filePath: string, projectId = 'default', options: { force?: boolean } = {}) {
    const ext = path.extname(filePath);
    const langConfig = LANGUAGES[ext];
    if (!langConfig) return { indexed: false, skipped: true, reason: 'unsupported' };
    if (isIgnoredProjectPath(filePath)) return { indexed: false, skipped: true, reason: 'ignored' };
    if (!fs.existsSync(filePath)) {
        markFileDeleted(filePath, projectId);
        return { indexed: false, skipped: false, reason: 'deleted' };
    }

    try {
        const fileId = fileRecordId(projectId, filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const blobSha = gitBlobSha(content);
        const existing = db.prepare("SELECT git_blob_sha, is_excluded FROM files WHERE id = ?")
          .get(fileId) as { git_blob_sha: string | null; is_excluded: number } | undefined;

        if (!options.force && existing?.git_blob_sha === blobSha) {
            return { indexed: false, skipped: true, reason: 'unchanged' };
        }

        const now = Date.now();
        if (isSecretFile(filePath) || containsSecrets(content) || isGeneratedGoFile(filePath, content) || isExcludedGoBuildFile(filePath, content)) {
            db.prepare(`
                INSERT INTO files (id, project_id, path, language, last_indexed_at, git_blob_sha, is_excluded)
                VALUES (?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(id) DO UPDATE SET
                    language=excluded.language,
                    last_indexed_at=excluded.last_indexed_at,
                    git_blob_sha=excluded.git_blob_sha,
                    is_excluded=1
            `).run(fileId, projectId, filePath, langConfig.name, now, blobSha);
            return { indexed: false, skipped: false, reason: 'excluded' };
        }

        const parser = new Parser();
        parser.setLanguage(langConfig.language);
        const tree = parseContent(parser, content);
        const symbols = extractSymbols(tree, content, filePath, langConfig.name, projectId);
        const shouldStoreBodies = bodyStorageEnabled();
        const callReferences = ['typescript', 'javascript', 'python', 'go'].includes(langConfig.name)
            ? extractCallReferences(tree, symbols, filePath, langConfig.name)
            : [];

        const upsertSymbol = db.prepare(`
            INSERT INTO symbols (id, ref, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
                ref=excluded.ref,
                name=excluded.name,
                qualified_name=excluded.qualified_name,
                kind=excluded.kind,
                file_path=excluded.file_path,
                start_line=excluded.start_line,
                end_line=excluded.end_line,
                signature=excluded.signature,
                body=excluded.body,
                updated_at=excluded.updated_at,
                is_deleted=0
        `);
        const insertCall = db.prepare(`
            INSERT OR REPLACE INTO symbol_calls (caller_symbol_id, target_symbol_id, target_name, target_file_path, project_id, file_path, line, confidence, resolution_method)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = db.transaction((symbolsToSave, callsToSave) => {
            db.prepare("UPDATE symbols SET is_deleted = 1, updated_at = ? WHERE project_id = ? AND file_path = ?")
              .run(now, projectId, filePath);
            for (const s of symbolsToSave) {
                upsertSymbol.run(s.id, s.ref, s.project_id, s.name, s.qualified_name, s.kind, s.file_path, s.start_line, s.end_line, s.signature, shouldStoreBodies ? s.body : null, s.language, s.updated_at);
            }
            db.prepare("DELETE FROM symbol_calls WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
            for (const call of callsToSave) {
                const target = call.target_qualified_name && call.target_file_path
                    ? db.prepare("SELECT id FROM symbols WHERE project_id = ? AND qualified_name = ? AND file_path = ? AND is_deleted = 0 LIMIT 1")
                      .get(projectId, call.target_qualified_name, call.target_file_path) as { id: string } | undefined
                    : call.target_qualified_name
                    ? db.prepare("SELECT id FROM symbols WHERE project_id = ? AND qualified_name = ? AND is_deleted = 0 LIMIT 1")
                      .get(projectId, call.target_qualified_name) as { id: string } | undefined
                    : call.target_file_path
                    ? db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND file_path = ? AND is_deleted = 0 LIMIT 1")
                      .get(projectId, call.target_name, call.target_file_path) as { id: string } | undefined
                    : db.prepare("SELECT id FROM symbols WHERE project_id = ? AND name = ? AND is_deleted = 0 LIMIT 1")
                      .get(projectId, call.target_name) as { id: string } | undefined;
                insertCall.run(call.caller_symbol_id, target?.id || null, call.target_name, call.target_file_path || null, projectId, call.file_path, call.line, call.confidence, call.resolution_method);
            }
            db.prepare(`
                INSERT INTO files (id, project_id, path, language, last_indexed_at, git_blob_sha, is_excluded)
                VALUES (?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(id) DO UPDATE SET
                    language=excluded.language,
                    last_indexed_at=excluded.last_indexed_at,
                    git_blob_sha=excluded.git_blob_sha,
                    is_excluded=0
            `).run(fileId, projectId, filePath, langConfig.name, now, blobSha);
        });

        transaction(symbols, callReferences);
        return { indexed: true, skipped: false, reason: 'changed' };
    } catch (e) {
        console.error(`Error indexing file ${filePath}:`, e);
        return { indexed: false, skipped: false, reason: 'error' };
    }
}

export async function reindexChangedFiles(projectPath: string, projectId = 'default', options: { force?: boolean } = {}) {
    const renames = reconcileRenamedFiles(projectPath, projectId);
    const uniqueFiles = listChangedSourceFiles(projectPath);
    let indexed = 0;
    let skipped = 0;
    let deleted = 0;

    for (const file of uniqueFiles) {
        const result = await indexFile(file, projectId, options);
        if (result.reason === 'deleted') deleted++;
        else if (result.indexed) indexed++;
        else if (result.skipped) skipped++;
    }

    return { changed_files: uniqueFiles.length, indexed, skipped, deleted, renamed: renames.renamed_files };
}

export function listChangedSourceFiles(projectPath: string) {
    return [...new Set(gitChangedFiles(projectPath)
        .map(file => path.resolve(projectPath, file))
        .filter(file => !isIgnoredProjectPath(file, projectPath) && isSupportedSourceFile(file)))];
}

export type FileFreshness = {
    freshness: 'fresh' | 'stale' | 'excluded' | 'unknown';
    reason: string;
    indexed_at?: number;
    git_blob_sha?: string | null;
    working_tree_blob_sha?: string | null;
};

export function getFileFreshness(filePath: string, projectId = 'default'): FileFreshness {
    const row = db.prepare("SELECT git_blob_sha, last_indexed_at, is_excluded FROM files WHERE project_id = ? AND path = ?")
      .get(projectId, filePath) as { git_blob_sha: string | null; last_indexed_at: number; is_excluded: number } | undefined;
    if (!row) {
        return { freshness: 'unknown', reason: 'file_not_tracked' };
    }
    if (row.is_excluded) {
        return { freshness: 'excluded', reason: 'file_excluded', indexed_at: row.last_indexed_at, git_blob_sha: row.git_blob_sha };
    }
    if (!fs.existsSync(filePath)) {
        return { freshness: 'stale', reason: 'file_missing', indexed_at: row.last_indexed_at, git_blob_sha: row.git_blob_sha };
    }
    if (!row.git_blob_sha) {
        return { freshness: 'unknown', reason: 'missing_index_hash', indexed_at: row.last_indexed_at };
    }
    const workingTreeBlobSha = gitBlobSha(fs.readFileSync(filePath, 'utf8'));
    return {
        freshness: workingTreeBlobSha === row.git_blob_sha ? 'fresh' : 'stale',
        reason: workingTreeBlobSha === row.git_blob_sha ? 'hash_match' : 'hash_mismatch',
        indexed_at: row.last_indexed_at,
        git_blob_sha: row.git_blob_sha,
        working_tree_blob_sha: workingTreeBlobSha
    };
}

export function getProjectIndexHealth(projectPath: string | undefined, projectId = 'default') {
    const checkedAt = Date.now();
    if (!projectPath) {
        return {
            freshness: 'unknown',
            reason: 'project_path_not_provided',
            checked_at: checkedAt
        };
    }
    const root = path.resolve(projectPath);
    if (!fs.existsSync(root)) {
        return {
            freshness: 'unknown',
            reason: 'project_path_missing',
            project_path: root,
            checked_at: checkedAt
        };
    }

    const sourceFiles = collectSupportedSourceFiles(root);
    const sourceSet = new Set(sourceFiles.map(file => path.resolve(file)));
    const trackedRows = db.prepare("SELECT path, git_blob_sha, is_excluded FROM files WHERE project_id = ?")
      .all(projectId) as Array<{ path: string; git_blob_sha: string | null; is_excluded: number }>;
    const trackedUnderRoot = trackedRows.filter(row => path.resolve(row.path).startsWith(root));
    const trackedSet = new Set(trackedUnderRoot.map(row => path.resolve(row.path)));

    const stalePaths: string[] = [];
    const missingPaths: string[] = [];
    const unindexedPaths: string[] = [];
    let freshFiles = 0;
    let excludedFiles = 0;

    for (const row of trackedUnderRoot) {
        if (row.is_excluded) {
            excludedFiles++;
            continue;
        }
        const freshness = getFileFreshness(row.path, projectId);
        if (freshness.freshness === 'fresh') freshFiles++;
        else if (freshness.reason === 'file_missing') missingPaths.push(row.path);
        else if (freshness.freshness === 'stale') stalePaths.push(row.path);
    }

    for (const sourceFile of sourceFiles) {
        if (!trackedSet.has(path.resolve(sourceFile))) {
            unindexedPaths.push(sourceFile);
        }
    }

    const freshness = stalePaths.length === 0 && missingPaths.length === 0 && unindexedPaths.length === 0
        ? 'fresh'
        : 'stale';
    return {
        freshness,
        reason: freshness === 'fresh' ? 'all_tracked_source_files_match' : 'index_differs_from_working_tree',
        project_path: root,
        checked_at: checkedAt,
        source_files: sourceFiles.length,
        tracked_files: trackedUnderRoot.length,
        fresh_files: freshFiles,
        excluded_files: excludedFiles,
        stale_files: stalePaths.length,
        missing_files: missingPaths.length,
        unindexed_files: unindexedPaths.length,
        stale_paths: stalePaths.slice(0, 20).map(file => path.relative(root, file).replace(/\\/g, '/')),
        missing_paths: missingPaths.slice(0, 20).map(file => path.relative(root, file).replace(/\\/g, '/')),
        unindexed_paths: unindexedPaths.slice(0, 20).map(file => path.relative(root, file).replace(/\\/g, '/'))
    };
}

export async function reconcileProjectFiles(projectPath: string, projectId = 'default') {
    const renames = reconcileRenamedFiles(projectPath, projectId);
    const rows = db.prepare("SELECT path, git_blob_sha FROM files WHERE project_id = ?").all(projectId) as Array<{ path: string; git_blob_sha: string | null }>;
    let deleted = 0;
    for (const row of rows) {
        if (path.resolve(row.path).startsWith(path.resolve(projectPath)) && !fs.existsSync(row.path)) {
            const activeSymbols = db.prepare("SELECT COUNT(*) as count FROM symbols WHERE project_id = ? AND file_path = ? AND is_deleted = 0")
              .get(projectId, row.path) as { count: number };
            if (row.git_blob_sha || activeSymbols.count > 0) {
                markFileDeleted(row.path, projectId);
                deleted++;
            }
        }
    }

    let indexed = 0;
    let skipped = 0;
    let excluded = 0;
    const sourceFiles = collectSupportedSourceFiles(projectPath);
    for (const file of sourceFiles) {
        const result = await indexFile(file, projectId);
        if (result.indexed) indexed++;
        else if (result.reason === 'excluded') excluded++;
        else if (result.skipped) skipped++;
    }

    return {
        reconciled_files: rows.length,
        scanned_files: sourceFiles.length,
        indexed,
        skipped,
        excluded,
        deleted_files: deleted,
        renamed_files: renames.renamed_files
    };
}

export function reconcileRenamedFiles(projectPath: string, projectId = 'default') {
    const renames = gitRenamedFiles(projectPath);
    let renamedFiles = 0;
    let movedSymbols = 0;
    for (const rename of renames) {
        const moved = migrateRenamedFile(projectId, rename.oldPath, rename.newPath);
        if (moved > 0) {
            renamedFiles++;
            movedSymbols += moved;
        }
    }
    return { renamed_files: renamedFiles, moved_symbols: movedSymbols };
}

function fileRecordId(projectId: string, filePath: string) {
    return `${projectId}:${filePath}`;
}

function isSecretFile(filePath: string) {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const secretPatterns = [
        /(^|\/)\.env([./-]|$)/,
        /secret/,
        /credential/,
        /token/,
        /private[_-]?key/,
        /id_rsa/,
        /\.pem$/,
        /\.key$/,
        /\.p12$/,
        /\.pfx$/
    ];
    return secretPatterns.some(pattern => pattern.test(normalized));
}

function containsSecrets(content: string) {
    const secretPatterns = [
        /(api[_-]?key|token|password|secret|client[_-]?secret|private[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
        /AKIA[0-9A-Z]{16}/,
        /gh[pousr]_[A-Za-z0-9_]{30,}/,
        /sk[_-](live|test)[_-][A-Za-z0-9]{16,}/,
        /sk-proj-[A-Za-z0-9_-]{20,}/,
        /xox[baprs]-[A-Za-z0-9-]{20,}/,
        /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/
    ];
    return secretPatterns.some(pattern => pattern.test(content));
}

function isGeneratedGoFile(filePath: string, content: string) {
    return filePath.endsWith('.go') && /Code generated .* DO NOT EDIT\./i.test(content.slice(0, 2048));
}

function isExcludedGoBuildFile(filePath: string, content: string) {
    if (!filePath.endsWith('.go')) return false;
    const header = content.slice(0, 2048);
    return /\/\/go:build\s+ignore\b/.test(header) || /\/\/\s*\+build\s+ignore\b/.test(header);
}

function isSupportedSourceFile(filePath: string) {
    return Boolean(LANGUAGES[path.extname(filePath)]);
}

function collectSupportedSourceFiles(projectPath: string) {
    const root = path.resolve(projectPath);
    const files: string[] = [];
    function walk(dir: string) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (isIgnoredProjectPath(fullPath, root)) continue;
            if (entry.isDirectory()) walk(fullPath);
            else if (isSupportedSourceFile(fullPath)) files.push(fullPath);
        }
    }
    walk(root);
    return files;
}

function isIgnoredProjectPath(filePath: string, projectPath?: string) {
    if (IGNORED_PATH_PATTERN.test(filePath)) return true;
    const ignoreRoot = projectPath ? path.resolve(projectPath) : findIgnoreRoot(filePath);
    if (!ignoreRoot) return false;
    const patterns = readMcpMemoryIgnore(ignoreRoot);
    if (patterns.length === 0) return false;
    const relative = path.relative(ignoreRoot, filePath).replace(/\\/g, '/');
    if (relative.startsWith('..')) return false;
    return patterns.some(pattern => ignorePatternMatches(pattern, relative));
}

function findIgnoreRoot(filePath: string) {
    let dir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
        ? path.resolve(filePath)
        : path.dirname(path.resolve(filePath));
    while (true) {
        if (fs.existsSync(path.join(dir, '.mcp-memoryignore'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

function readMcpMemoryIgnore(projectPath: string) {
    const ignorePath = path.join(projectPath, '.mcp-memoryignore');
    if (!fs.existsSync(ignorePath)) return [];
    const stat = fs.statSync(ignorePath);
    const cacheKey = `${ignorePath}:${stat.mtimeMs}`;
    const cached = ignoreCache.get(cacheKey);
    if (cached) return cached;
    for (const key of ignoreCache.keys()) {
        if (key.startsWith(`${ignorePath}:`)) ignoreCache.delete(key);
    }
    const patterns = fs.readFileSync(ignorePath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .map(line => line.replace(/\\/g, '/').replace(/^\/+/, ''));
    ignoreCache.set(cacheKey, patterns);
    return patterns;
}

function ignorePatternMatches(pattern: string, relativePath: string) {
    const normalized = relativePath.replace(/\\/g, '/');
    const directoryPattern = pattern.endsWith('/') ? `${pattern}**` : pattern;
    const regex = globToRegExp(directoryPattern);
    return regex.test(normalized) || regex.test(path.basename(normalized));
}

function globToRegExp(pattern: string) {
    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        const next = pattern[i + 1];
        if (char === '*' && next === '*') {
            regex += '.*';
            i++;
        } else if (char === '*') {
            regex += '[^/]*';
        } else if (char === '?') {
            regex += '[^/]';
        } else {
            regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
    }
    regex += '$';
    return new RegExp(regex);
}

function gitBlobSha(content: string) {
    const buffer = Buffer.from(content, 'utf8');
    return crypto
        .createHash('sha1')
        .update(`blob ${buffer.length}\0`)
        .update(buffer)
        .digest('hex');
}

function gitChangedFiles(projectPath: string) {
    const files = new Set<string>();
    const commands: string[][] = [
        ['diff', '--name-only', 'HEAD'],
        ['diff', '--name-only', '--cached'],
        ['ls-files', '--others', '--exclude-standard']
    ];

    for (const args of commands) {
        try {
            const output = execFileSync('git', ['-C', projectPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            output.split(/\r?\n/).filter(Boolean).forEach(file => files.add(file));
        } catch {
            // Non-git projects still work through chokidar; this helper simply has no changed files.
        }
    }

    return [...files];
}

function gitRenamedFiles(projectPath: string) {
    const renames: Array<{ oldPath: string; newPath: string }> = [];
    const commands: string[][] = [
        ['diff', '--name-status', '-M', 'HEAD'],
        ['diff', '--name-status', '-M', '--cached']
    ];

    for (const args of commands) {
        try {
            const output = execFileSync('git', ['-C', projectPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            for (const line of output.split(/\r?\n/).filter(Boolean)) {
                const [status, oldRelative, newRelative] = line.split(/\t/);
                if (!status?.startsWith('R') || !oldRelative || !newRelative) continue;
                const oldPath = path.resolve(projectPath, oldRelative);
                const newPath = path.resolve(projectPath, newRelative);
                if (isSupportedSourceFile(oldPath) && isSupportedSourceFile(newPath)) {
                    renames.push({ oldPath, newPath });
                }
            }
        } catch {
            // Non-git projects or repositories without HEAD have no rename metadata.
        }
    }

    return renames;
}

function migrateRenamedFile(projectId: string, oldPath: string, newPath: string) {
    const oldSymbols = db.prepare("SELECT id, kind, name, qualified_name FROM symbols WHERE project_id = ? AND file_path = ?")
      .all(projectId, oldPath) as Array<{ id: string; kind: string; name: string; qualified_name: string }>;
    if (oldSymbols.length === 0) return 0;

    const now = Date.now();
    const transaction = db.transaction(() => {
        for (const symbol of oldSymbols) {
            const newId = `${projectId}:${newPath}:${symbol.kind}:${symbol.qualified_name || symbol.name}`;
            const ref = symbolRef(newId);
            const existing = db.prepare("SELECT id FROM symbols WHERE id = ?").get(newId) as { id: string } | undefined;
            if (!existing) {
                db.prepare(`
                    INSERT INTO symbols (id, ref, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, commit_sha, updated_at, is_deleted)
                    SELECT ?, ?, project_id, name, qualified_name, kind, ?, start_line, end_line, signature, body, language, commit_sha, ?, 0
                    FROM symbols WHERE id = ?
                `).run(newId, ref, newPath, now, symbol.id);
            }
            db.prepare("UPDATE message_symbol_references SET symbol_id = ? WHERE symbol_id = ?").run(newId, symbol.id);
            db.prepare("UPDATE decision_symbol_references SET symbol_id = ? WHERE symbol_id = ?").run(newId, symbol.id);
            db.prepare("UPDATE symbol_history SET symbol_id = ? WHERE symbol_id = ?").run(newId, symbol.id);
            db.prepare("UPDATE symbol_calls SET caller_symbol_id = ?, file_path = ? WHERE caller_symbol_id = ?").run(newId, newPath, symbol.id);
            db.prepare("UPDATE symbol_calls SET target_symbol_id = ? WHERE target_symbol_id = ?").run(newId, symbol.id);
            db.prepare("DELETE FROM symbols WHERE id = ?").run(symbol.id);
        }
        db.prepare("UPDATE symbol_calls SET file_path = ? WHERE project_id = ? AND file_path = ?").run(newPath, projectId, oldPath);
        db.prepare("UPDATE symbol_calls SET target_file_path = ? WHERE project_id = ? AND target_file_path = ?").run(newPath, projectId, oldPath);
        db.prepare(`
            INSERT INTO files (id, project_id, path, language, last_indexed_at, git_blob_sha, is_excluded)
            SELECT ?, project_id, ?, language, ?, git_blob_sha, is_excluded
            FROM files WHERE id = ?
            ON CONFLICT(id) DO UPDATE SET
                path=excluded.path,
                language=excluded.language,
                last_indexed_at=excluded.last_indexed_at,
                git_blob_sha=excluded.git_blob_sha,
                is_excluded=excluded.is_excluded
        `).run(fileRecordId(projectId, newPath), newPath, now, fileRecordId(projectId, oldPath));
        db.prepare("DELETE FROM files WHERE id = ?").run(fileRecordId(projectId, oldPath));
    });

    transaction();
    return oldSymbols.length;
}

function extractSymbols(tree: Parser.Tree, content: string, filePath: string, language: string, projectId = 'default') {
    const symbols: any[] = [];
    
    function traverse(node: Parser.SyntaxNode, scope: string[] = []) {
        let symbol = null;
        let pushesScope = false;

        if (language === 'typescript' || language === 'javascript') {
            if (node.type === 'function_declaration') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) {
                    symbol = {
                        name: nameNode.text,
                        kind: 'function',
                        start_line: node.startPosition.row + 1,
                        end_line: node.endPosition.row + 1,
                        signature: signatureBeforeBody(node, content),
                        body: node.text
                    };
                }
            } else if (node.type === 'class_declaration') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) {
                    symbol = {
                        name: nameNode.text,
                        kind: 'class',
                        start_line: node.startPosition.row + 1,
                        end_line: node.endPosition.row + 1,
                        signature: `class ${nameNode.text}`,
                        body: node.text
                    };
                    pushesScope = true;
                }
            } else if (node.type === 'method_definition') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) {
                    symbol = {
                        name: nameNode.text,
                        kind: 'method',
                        start_line: node.startPosition.row + 1,
                        end_line: node.endPosition.row + 1,
                        signature: signatureBeforeBody(node, content),
                        body: node.text
                    };
                }
            } else if (node.type === 'variable_declarator') {
                const nameNode = node.childForFieldName('name') || node.namedChild(0);
                const valueNode = node.childForFieldName('value') || node.namedChild(1);
                if (nameNode && (valueNode?.type === 'arrow_function' || valueNode?.type === 'function_expression')) {
                    symbol = {
                        name: nameNode.text,
                        kind: 'function',
                        start_line: node.startPosition.row + 1,
                        end_line: node.endPosition.row + 1,
                        signature: variableFunctionSignature(node, content),
                        body: node.text
                    };
                }
            }
        } else if (language === 'python') {
            if (node.type === 'function_definition' || node.type === 'async_function_definition') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) {
                    symbol = {
                        name: nameNode.text,
                        kind: 'function',
                        start_line: node.startPosition.row + 1,
                        end_line: node.endPosition.row + 1,
                        signature: node.text.split(':')[0].trim(),
                        body: node.text
                    };
                }
            } else if (node.type === 'class_definition') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) {
                    symbol = {
                        name: nameNode.text,
                        kind: 'class',
                        start_line: node.startPosition.row + 1,
                        end_line: node.endPosition.row + 1,
                        signature: `class ${nameNode.text}`,
                        body: node.text
                    };
                    pushesScope = true;
                }
            }
        } else if (language === 'go') {
            if (node.type === 'function_declaration') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) {
                    symbol = {
                        name: nameNode.text,
                        kind: 'function',
                        start_line: node.startPosition.row + 1,
                        end_line: node.endPosition.row + 1,
                        signature: signatureBeforeBody(node, content),
                        body: node.text
                    };
                }
            } else if (node.type === 'method_declaration') {
                const nameNode = node.childForFieldName('name');
                const receiverType = goReceiverTypeName(node);
                if (nameNode) {
                    symbol = {
                        name: nameNode.text,
                        qualified_name: receiverType ? `${receiverType}.${nameNode.text}` : nameNode.text,
                        kind: 'method',
                        start_line: node.startPosition.row + 1,
                        end_line: node.endPosition.row + 1,
                        signature: signatureBeforeBody(node, content),
                        body: node.text
                    };
                }
            } else if (node.type === 'type_spec') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) {
                    symbol = {
                        name: nameNode.text,
                        kind: 'class',
                        start_line: node.startPosition.row + 1,
                        end_line: node.endPosition.row + 1,
                        signature: `type ${nameNode.text}`,
                        body: node.text
                    };
                    pushesScope = true;
                }
            }
        }

        let childScope = scope;
        if (symbol) {
            const qualifiedName = symbol.qualified_name || (scope.length > 0 ? `${scope.join('.')}.${symbol.name}` : symbol.name);
            const id = `${projectId}:${filePath}:${symbol.kind}:${qualifiedName}`;
            symbols.push({
                id,
                ref: symbolRef(id),
                project_id: projectId,
                ...symbol,
                qualified_name: qualifiedName,
                file_path: filePath,
                language,
                updated_at: Date.now()
            });
            if (pushesScope) {
                childScope = [...scope, symbol.name];
            }
        }

        for (let i = 0; i < node.childCount; i++) {
            traverse(node.child(i), childScope);
        }
    }

    traverse(tree.rootNode);
    return symbols;
}

export { extractSymbols };

function goReceiverTypeName(node: Parser.SyntaxNode) {
    const receiver = node.childForFieldName('receiver');
    if (!receiver) return null;
    const typeNode = findFirstNodeOfType(receiver, 'type_identifier');
    return typeNode?.text || null;
}

function findFirstNodeOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    if (node.type === type) return node;
    for (let i = 0; i < node.namedChildCount; i++) {
        const found = findFirstNodeOfType(node.namedChild(i), type);
        if (found) return found;
    }
    return null;
}

function parseContent(parser: Parser, content: string) {
    return parser.parse((index) => {
        if (index >= content.length) return null;
        return content.slice(index, index + 4096);
    });
}

function signatureBeforeBody(node: Parser.SyntaxNode, content: string) {
    const bodyNode = node.childForFieldName('body');
    if (!bodyNode) return node.text.split('\n')[0].trim();
    return content.slice(node.startIndex, bodyNode.startIndex).trim();
}

function variableFunctionSignature(node: Parser.SyntaxNode, content: string) {
    const valueNode = node.childForFieldName('value') || node.namedChild(1);
    if (!valueNode) return node.text.split('\n')[0].trim();
    return content.slice(node.startIndex, valueNode.startIndex).trim();
}
