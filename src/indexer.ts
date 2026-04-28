import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import JavaScript from 'tree-sitter-javascript';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import db from './db';
import { extractCallReferences } from './call-graph';

const LANGUAGES = {
    '.ts': { language: (TypeScript as any).typescript, name: 'typescript' },
    '.tsx': { language: (TypeScript as any).tsx, name: 'typescript' },
    '.js': { language: JavaScript as any, name: 'javascript' },
    '.jsx': { language: JavaScript as any, name: 'javascript' },
    '.py': { language: Python as any, name: 'python' },
};

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
        ignored: (filePath) => /(^|[\/\\])(\.git|node_modules|dist)([\/\\]|$)/.test(filePath),
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
        if (isSecretFile(filePath) || containsSecrets(content)) {
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
        const tree = parser.parse(content);
        const symbols = extractSymbols(tree, content, filePath, langConfig.name, projectId);
        const callReferences = ['typescript', 'javascript', 'python'].includes(langConfig.name)
            ? extractCallReferences(tree, symbols, filePath, langConfig.name)
            : [];

        const upsertSymbol = db.prepare(`
            INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
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
                upsertSymbol.run(s.id, s.project_id, s.name, s.qualified_name, s.kind, s.file_path, s.start_line, s.end_line, s.signature, s.body, s.language, s.updated_at);
            }
            db.prepare("DELETE FROM symbol_calls WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
            for (const call of callsToSave) {
                const target = call.target_file_path
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
        .filter(file => isSupportedSourceFile(file)))];
}

export function reconcileProjectFiles(projectPath: string, projectId = 'default') {
    const renames = reconcileRenamedFiles(projectPath, projectId);
    const rows = db.prepare("SELECT path FROM files WHERE project_id = ?").all(projectId) as Array<{ path: string }>;
    let deleted = 0;
    for (const row of rows) {
        if (path.resolve(row.path).startsWith(path.resolve(projectPath)) && !fs.existsSync(row.path)) {
            markFileDeleted(row.path, projectId);
            deleted++;
        }
    }
    return { reconciled_files: rows.length, deleted_files: deleted, renamed_files: renames.renamed_files };
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
    const secretPatterns = [/\.env/, /secret/, /credential/, /token/, /\.pem$/, /\.key$/];
    return secretPatterns.some(pattern => pattern.test(filePath));
}

function containsSecrets(content: string) {
    const secretRegex = /(api[_-]?key|token|password|secret)\s*=\s*['"][^'"]{8,}['"]/i;
    return secretRegex.test(content);
}

function isSupportedSourceFile(filePath: string) {
    return Boolean(LANGUAGES[path.extname(filePath)]);
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
            const output = execFileSync('git', ['-C', projectPath, ...args], { encoding: 'utf8' });
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
            const output = execFileSync('git', ['-C', projectPath, ...args], { encoding: 'utf8' });
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
    const oldSymbols = db.prepare("SELECT id, kind, name FROM symbols WHERE project_id = ? AND file_path = ?")
      .all(projectId, oldPath) as Array<{ id: string; kind: string; name: string }>;
    if (oldSymbols.length === 0) return 0;

    const now = Date.now();
    const transaction = db.transaction(() => {
        for (const symbol of oldSymbols) {
            const newId = `${projectId}:${newPath}:${symbol.kind}:${symbol.name}`;
            const existing = db.prepare("SELECT id FROM symbols WHERE id = ?").get(newId) as { id: string } | undefined;
            if (!existing) {
                db.prepare(`
                    INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, commit_sha, updated_at, is_deleted)
                    SELECT ?, project_id, name, qualified_name, kind, ?, start_line, end_line, signature, body, language, commit_sha, ?, 0
                    FROM symbols WHERE id = ?
                `).run(newId, newPath, now, symbol.id);
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
    
    function traverse(node: Parser.SyntaxNode) {
        let symbol = null;

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
            if (node.type === 'function_definition') {
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
                }
            }
        }

        if (symbol) {
            const id = `${projectId}:${filePath}:${symbol.kind}:${symbol.name}`;
            symbols.push({
                id,
                project_id: projectId,
                ...symbol,
                qualified_name: symbol.name,
                file_path: filePath,
                language,
                updated_at: Date.now()
            });
        }

        for (let i = 0; i < node.childCount; i++) {
            traverse(node.child(i));
        }
    }

    traverse(tree.rootNode);
    return symbols;
}

export { extractSymbols };

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
