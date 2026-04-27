import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import db from './db';
import { v4 as uuidv4 } from 'uuid';

const parser = new Parser();

const LANGUAGES = {
    '.ts': { language: TypeScript.typescript, name: 'typescript' },
    '.tsx': { language: TypeScript.typescript, name: 'typescript' },
    '.py': { language: Python.python, name: 'python' },
};

class IndexWorkerPool {
    private queue: string[] = [];
    private isProcessing = false;
    private maxConcurrent = 4; // Simple concurrency limit
    private activeWorkers = 0;

    async add(filePath: string) {
        if (!this.queue.includes(filePath)) {
            this.queue.push(filePath);
        }
        this.processQueue();
    }

    private async processQueue() {
        if (this.isProcessing || this.activeWorkers >= this.maxConcurrent) return;
        this.isProcessing = true;

        while (this.queue.length > 0 && this.activeWorkers < this.maxConcurrent) {
            const filePath = this.queue.shift();
            if (filePath) {
                this.activeWorkers++;
                this.processFile(filePath).finally(() => {
                    this.activeWorkers--;
                    this.processQueue();
                });
            }
        }
        this.isProcessing = false;
    }

    private async processFile(filePath: string) {
        // Actual indexing logic moved here from indexFile
        const ext = path.extname(filePath);
        const langConfig = LANGUAGES[ext];
        if (!langConfig) return;

        try {
            if (isSecretFile(filePath)) {
                db.prepare("INSERT OR REPLACE INTO files (id, project_id, path, language, last_indexed_at, is_excluded) VALUES (?, ?, ?, ?, ?, ?)")
                  .run(uuidv4(), 'default', filePath, langConfig.name, Date.now(), 1);
                return;
            }

            const content = fs.readFileSync(filePath, 'utf8');
            if (containsSecrets(content)) {
                db.prepare("INSERT OR REPLACE INTO files (id, project_id, path, language, last_indexed_at, is_excluded) VALUES (?, ?, ?, ?, ?, ?)")
                  .run(uuidv4(), 'default', filePath, langConfig.name, Date.now(), 1);
                return;
            }

            parser.setLanguage(langConfig.language);
            const tree = parser.parse(content);
            const symbols = extractSymbols(tree, content, filePath, langConfig.name);

            const upsertSymbol = db.prepare(`
                INSERT INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    qualified_name=excluded.qualified_name,
                    kind=excluded.kind,
                    file_path=excluded.file_path,
                    start_line=excluded.start_line,
                    end_line=excluded.end_line,
                    signature=excluded.signature,
                    body=excluded.body,
                    updated_at=excluded.updated_at
            `);

            const transaction = db.transaction((symbolsToSave) => {
                for (const s of symbolsToSave) {
                    upsertSymbol.run(s.id, s.project_id, s.name, s.qualified_name, s.kind, s.file_path, s.start_line, s.end_line, s.signature, s.body, s.language, s.updated_at);
                }
            });

            transaction(symbols);
        } catch (e) {
            console.error(`Error indexing file ${filePath}:`, e);
        }
    }
}

const workerPool = new IndexWorkerPool();
const debounceMap = new Map<string, NodeJS.Timeout>();

export function startIndexer(projectPath) {
    console.log(`Indexing project: ${projectPath}`);

    const watcher = chokidar.watch(projectPath, {
        ignored: /(^|[\/\\])\.(git|node_modules|dist)\(/,
        persistent: true,
    });

    watcher.on('change', (filePath) => {
        debounceIndex(filePath);
    });

    watcher.on('add', (filePath) => {
        debounceIndex(filePath);
    });

    watcher.on('ready', () => {
        console.log('Initial scan complete. Watching for changes...');
    });
}

function debounceIndex(filePath: string) {
    if (debounceMap.has(filePath)) {
        clearTimeout(debounceMap.get(filePath));
    }
    const timeout = setTimeout(() => {
        debounceMap.delete(filePath);
        workerPool.add(filePath);
    }, 300); // 300ms debounce as per design
    debounceMap.set(filePath, timeout);
}

function isSecretFile(filePath) {
    const secretPatterns = [/\.env/, /secret/, /credential/, /token/, /\.pem$/, /\.key$/];
    return secretPatterns.some(pattern => pattern.test(filePath));
}

function containsSecrets(content) {
    const secretRegex = /(api[_-]?key|token|password|secret)\s*=\s*['"][^'"]{8,}['"]/i;
    return secretRegex.test(content);
}

function extractSymbols(tree, content, filePath, language) {
    const symbols = [];
    
    function traverse(node) {
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
                        signature: node.text.split('{')[0].trim(),
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
                        signature: node.text.split('{')[0].trim(),
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
            const id = `${filePath}:${symbol.start_line}:${symbol.start_line}`;
            symbols.push({
                id,
                project_id: 'default',
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
