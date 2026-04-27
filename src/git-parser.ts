import { execSync } from 'child_process';
import db from './db';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import fs from 'fs';
import path from 'path';

const parser = new Parser();

const LANGUAGES = {
    '.ts': { language: TypeScript.typescript, name: 'typescript' },
    '.tsx': { language: TypeScript.typescript, name: 'typescript' },
    '.py': { language: Python.python, name: 'python' },
};

export function indexGitHistory(projectPath) {
    console.log(`Indexing Git history for: ${projectPath}`);
    
    try {
        const logOutput = execSync(`git -C "${projectPath}" log --all --diff-filter=ACM --name-only --format="%H|%ae|%s|%at"`, { encoding: 'utf8' });
        const lines = logOutput.split('\n');

        let currentCommit = null;
        let currentMeta = null;

        for (const line of lines) {
            if (!line) continue;

            if (line.includes('|')) {
                const [sha, author, subject, timestamp] = line.split('|');
                currentCommit = sha;
                currentMeta = { sha, author, subject, timestamp: parseInt(timestamp) * 1000 };
            } else {
                const filePath = path.join(projectPath, line);
                indexHistoricalFile(currentCommit, currentMeta, filePath);
            }
        }
    } catch (e) {
        console.error("Git indexing failed:", e);
    }
}

function indexHistoricalFile(sha, meta, filePath) {
    try {
        const content = execSync(`git -C "${path.dirname(filePath)}" show ${sha}:${path.basename(filePath)}`, { encoding: 'utf8' });
        const ext = path.extname(filePath);
        const langConfig = LANGUAGES[ext];
        if (!langConfig) return;

        parser.setLanguage(langConfig.language);
        const tree = parser.parse(content);
        
        // Use the same extraction logic as indexer.ts
        const symbols = extractHistoricalSymbols(tree, content, filePath, langConfig.name);

        const insertHistory = db.prepare(`
            INSERT INTO symbol_history (id, symbol_id, version, body, signature, start_line, end_line, commit_sha, commit_message, commit_author, commit_at, change_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = db.transaction((syms) => {
            syms.forEach((s, index) => {
                insertHistory.run(
                    require('uuid').v4(),
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

function extractHistoricalSymbols(tree, content, filePath, language) {
    const symbols = [];
    function traverse(node) {
        let symbol = null;
        if (language === 'typescript') {
            if (node.type === 'function_declaration') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) symbol = { name: nameNode.text, kind: 'function', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, signature: node.text.split('{')[0].trim(), body: node.text };
            } else if (node.type === 'class_declaration') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) symbol = { name: nameNode.text, kind: 'class', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, signature: `class ${nameNode.text}`, body: node.text };
            }
        } else if (language === 'python') {
            if (node.type === 'function_definition') {
                const nameNode = node.childForFieldName('name');
                if (nameNode) symbol = { name: nameNode.text, kind: 'function', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, signature: node.text.split(':')[0].trim(), body: node.text };
            }
        }

        if (symbol) {
            const id = `${filePath}:${symbol.start_line}:${symbol.start_line}`;
            symbols.push({ id, ...symbol });
        }

        for (let i = 0; i < node.childCount; i++) traverse(node.child(i));
    }
    traverse(tree.rootNode);
    return symbols;
}

module.exports = { indexGitHistory };
