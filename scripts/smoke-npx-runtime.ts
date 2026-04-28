/// <reference types="node" />

import { spawn, execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function createTempProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-memory-npx-smoke-'));
    const srcDir = path.join(root, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'smoke.ts'), 'export function smokeSymbol() { return "ok"; }\n');
    return root;
}

function npmCommand() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npxCommand() {
    return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function safeUnlink(filePath: string) {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
        // The smoke server may still be releasing SQLite handles on Windows.
    }
}

async function main() {
    const projectPath = createTempProject();
    const dbPath = path.join(os.tmpdir(), `mcp-memory-npx-smoke-${Date.now()}.sqlite`);
    let packFile: string | undefined;

    try {
        const packJson = process.platform === 'win32'
            ? execSync('npm pack --json', { encoding: 'utf8' })
            : execFileSync(npmCommand(), ['pack', '--json'], { encoding: 'utf8' });
        packFile = JSON.parse(packJson)[0].filename;
        const command = process.platform === 'win32'
            ? `${npxCommand()} -y -p "./${packFile}" codex-mcp-memory-server`
            : npxCommand();
        const commandArgs = process.platform === 'win32'
            ? []
            : ['-y', '-p', `./${packFile}`, 'codex-mcp-memory-server'];
        const child = spawn(command, commandArgs, {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PROJECT_PATH: projectPath,
                PROJECT_ID: 'npx-smoke',
                MCP_MEMORY_DB_PATH: dbPath
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32'
        });

        let stderr = '';
        let stdout = '';
        const ready = await new Promise<boolean>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timed out waiting for npx runtime smoke. stderr=${stderr}`));
            }, 90000);

            child.stderr.on('data', chunk => {
                stderr += chunk.toString();
                if (stderr.includes('MCP Memory Server running on stdio')) {
                    clearTimeout(timeout);
                    resolve(true);
                }
            });
            child.stdout.on('data', chunk => {
                stdout += chunk.toString();
            });
            child.on('error', error => {
                clearTimeout(timeout);
                reject(error);
            });
            child.on('exit', code => {
                if (!stderr.includes('MCP Memory Server running on stdio')) {
                    clearTimeout(timeout);
                    reject(new Error(`Server exited before ready with code ${code}. stdout=${stdout} stderr=${stderr}`));
                }
            });
        });

        if (!ready) {
            throw new Error('Runtime smoke did not reach ready state');
        }
        child.kill();
        console.log('NPX runtime smoke passed.');
    } finally {
        if (packFile) safeUnlink(path.join(process.cwd(), packFile));
        fs.rmSync(projectPath, { recursive: true, force: true });
        safeUnlink(dbPath);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
