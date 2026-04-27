import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import db from './db';
import { v4 as uuidv4 } from 'uuid';

const LANGUAGES = {
    '.ts': { language: (TypeScript as any).typescript, name: 'typescript' },
    '.tsx': { language: (TypeScript as any).tsx, name: 'typescript' },
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
                this.processFile(filePath, projectId).finally(() => {
                    this.activeWorkers--;
                    this.processQueue(projectId);
                });
            }
        }
        this.isProcessing = false;
    }

    private async processFile(filePath: string, projectId: string) {
        const ext = path.extname(filePath);
        const langConfig = LANGUAGES[ext];
        if (!langConfig) return;

        try {
            const fileId = fileRecordId(projectId, filePath);

            if (isSecretFile(filePath)) {
                db.prepare("INSERT OR REPLACE INTO files (id, project_id, path, language, last_indexed_at, is_excluded) VALUES (?, ?, ?, ?, ?, ?)")
                  .run(fileId, projectId, filePath, langConfig.name, Date.now(), 1);
                return;
            }

            const content = fs.readFileSync(filePath, 'utf8');
            if (containsSecrets(content)) {
                db.prepare("INSERT OR REPLACE INTO files (id, project_id, path, language, last_indexed_at, is_excluded) VALUES (?, ?, ?, ?, ?, ?)")
                  .run(fileId, projectId, filePath, langConfig.name, Date.now(), 1);
                return;
            }

            const parser = new Parser();
            parser.setLanguage(langConfig.language);
            const tree = parser.parse(content);
            const symbols = extractSymbols(tree, content, filePath, langConfig.name, projectId);
            const now = Date.now();

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

            const transaction = db.transaction((symbolsToSave) => {
                db.prepare("UPDATE symbols SET is_deleted = 1, updated_at = ? WHERE project_id = ? AND file_path = ?")
                  .run(now, projectId, filePath);
                for (const s of symbolsToSave) {
                    upsertSymbol.run(s.id, s.project_id, s.name, s.qualified_name, s.kind, s.file_path, s.start_line, s.end_line, s.signature, s.body, s.language, s.updated_at);
                }
                db.prepare("INSERT OR REPLACE INTO files (id, project_id, path, language, last_indexed_at, is_excluded) VALUES (?, ?, ?, ?, ?, ?)")
                  .run(fileId, projectId, filePath, langConfig.name, now, 0);
            });

            transaction(symbols);
        } catch (e) {
            console.error(`Error indexing file ${filePath}:`, e);
        }
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
    db.prepare("UPDATE files SET last_indexed_at = ? WHERE project_id = ? AND path = ?")
      .run(now, projectId, filePath);
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

function extractSymbols(tree: Parser.Tree, content: string, filePath: string, language: string, projectId = 'default') {
    const symbols: any[] = [];
    
    function traverse(node: Parser.SyntaxNode) {
        let symbol = null;

        if (language === 'typescript') {
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
