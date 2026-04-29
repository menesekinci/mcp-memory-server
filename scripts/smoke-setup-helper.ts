/// <reference types="node" />

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function nodeCommand() {
    return process.execPath;
}

function main() {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-memory-setup-smoke-'));
    const dbPath = path.join(projectPath, 'memory.db');
    try {
        const output = execFileSync(nodeCommand(), [
            path.join(process.cwd(), 'bin', 'setup-codex-mcp-memory.js'),
            '--project-path',
            projectPath,
            '--project-id',
            'setup-smoke',
            '--db-path',
            dbPath,
            '--name',
            'setup-smoke-server',
            '--dry-run'
        ], { encoding: 'utf8' });

        if (!output.includes('codex mcp add setup-smoke-server')) {
            throw new Error(`Dry-run command did not include the expected server name. output=${output}`);
        }
        if (!output.includes(`PROJECT_PATH=${projectPath}`)) {
            throw new Error(`Dry-run command did not include PROJECT_PATH. output=${output}`);
        }
        if (!output.includes('npx -y codex-mcp-memory-server')) {
            throw new Error(`Dry-run command did not include npx launch. output=${output}`);
        }
        console.log('Setup helper smoke passed.');
    } finally {
        fs.rmSync(projectPath, { recursive: true, force: true });
    }
}

main();
