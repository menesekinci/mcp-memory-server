import { execFileSync, execSync } from 'child_process';
import db from './db';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import JavaScript from 'tree-sitter-javascript';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const LANGUAGES = {
    '.ts': { language: (TypeScript as any).typescript, name: 'typescript' },
    '.tsx': { language: (TypeScript as any).tsx, name: 'typescript' },
    '.js': { language: JavaScript as any, name: 'javascript' },
    '.jsx': { language: JavaScript as any, name: 'javascript' },
    '.py': { language: Python as any, name: 'python' },
};

export function indexGitHistory(projectPath: string, projectId = 'default') {
    console.error(`Indexing Git history for: ${projectPath}`);
    
    try {
        const logOutput = execSync(`git -C "${projectPath}" log --all --diff-filter=ACM --name-only --format="%H|%ae|%s|%at"`, { encoding: 'utf8' });
        const lines = logOutput.split('\n');

        let currentCommit: string | null = null;
        let currentMeta: { sha: string; author: string; subject: string; timestamp: number } | null = null;

        for (const line of lines) {
            if (!line) continue;

            if (line.includes('|')) {
                const [sha, author, subject, timestamp] = line.split('|');
                currentCommit = sha;
                currentMeta = { sha, author, subject, timestamp: parseInt(timestamp) * 1000 };
            } else {
                const filePath = path.join(projectPath, line);
                if (currentCommit && currentMeta) {
                    indexHistoricalFile(projectPath, currentCommit, currentMeta, filePath, projectId);
                }
            }
        }
    } catch (e) {
        console.error("Git indexing failed:", e);
    }
}

function indexHistoricalFile(projectPath: string, sha: string, meta: { subject: string; author: string; timestamp: number }, filePath: string, projectId: string) {
    try {
        const relativePath = path.relative(projectPath, filePath).replace(/\\/g, '/');
        const content = execFileSync('git', ['-C', projectPath, 'show', `${sha}:${relativePath}`], { encoding: 'utf8' });
        const ext = path.extname(filePath);
        const langConfig = LANGUAGES[ext];
        if (!langConfig) return;

        const parser = new Parser();
        parser.setLanguage(langConfig.language);
        const tree = parser.parse(content);
        
        // Use the same extraction logic as indexer.ts
        const symbols = extractHistoricalSymbols(tree, content, filePath, langConfig.name, projectId);

        const insertHistory = db.prepare(`
            INSERT INTO symbol_history (id, symbol_id, version, body, signature, start_line, end_line, commit_sha, commit_message, commit_author, commit_at, change_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertSymbol = db.prepare(`
            INSERT OR IGNORE INTO symbols (id, project_id, name, qualified_name, kind, file_path, start_line, end_line, signature, body, language, commit_sha, updated_at, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `);

        const transaction = db.transaction((syms: any[]) => {
            syms.forEach((s, index) => {
                insertSymbol.run(
                    s.id,
                    projectId,
                    s.name,
                    s.name,
                    s.kind,
                    filePath,
                    s.start_line,
                    s.end_line,
                    s.signature,
                    s.body,
                    langConfig.name,
                    sha,
                    meta.timestamp
                );
                insertHistory.run(
                    uuidv4(),
                    s.id,
                    index,
                    s.body,
                    s.signature,
                    s.start_line,
                    s.end_line,
                    sha,
                    meta.subject,
                    meta.author,
                    meta.timestamp,
                    'modified'
                );
            });
        });

        transaction(symbols);
    } catch (e) {
        // File might have been deleted in that commit
    }
}

function extractHistoricalSymbols(tree: Parser.Tree, content: string, filePath: string, language: string, projectId: string) {
    const symbols: any[] = [];
    function traverse(node: Parser.SyntaxNode) {
        let symbol = null;
        if (language === 'typescript' || language === 'javascript') {
            if (node.type === 'function_declaration') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) symbol = { name: nameNode.text, kind: 'function', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, signature: signatureBeforeBody(node, content), body: node.text };
            } else if (node.type === 'class_declaration') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) symbol = { name: nameNode.text, kind: 'class', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, signature: `class ${nameNode.text}`, body: node.text };
            } else if (node.type === 'method_definition') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) symbol = { name: nameNode.text, kind: 'method', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, signature: signatureBeforeBody(node, content), body: node.text };
            } else if (node.type === 'variable_declarator') {
                const nameNode = node.childForFieldName('name') || node.namedChild(0);
                const valueNode = node.childForFieldName('value') || node.namedChild(1);
                if (nameNode && (valueNode?.type === 'arrow_function' || valueNode?.type === 'function_expression')) {
                    symbol = { name: nameNode.text, kind: 'function', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, signature: variableFunctionSignature(node, content), body: node.text };
                }
            }
        } else if (language === 'python') {
            if (node.type === 'function_definition') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) symbol = { name: nameNode.text, kind: 'function', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, signature: node.text.split(':')[0].trim(), body: node.text };
            }
        }

        if (symbol) {
            const id = `${projectId}:${filePath}:${symbol.kind}:${symbol.name}`;
            symbols.push({ id, ...symbol });
        }

        for (let i = 0; i < node.childCount; i++) traverse(node.child(i));
    }
    traverse(tree.rootNode);
    return symbols;
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
