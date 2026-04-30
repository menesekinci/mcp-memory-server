/// <reference types="node" />

import { execFileSync, spawnSync } from 'child_process';
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
        const doctorOutput = execFileSync(nodeCommand(), [
            path.join(process.cwd(), 'bin', 'mcp-memory-doctor.js'),
            '--project-path',
            projectPath,
            '--db-path',
            dbPath,
            '--json'
        ], { encoding: 'utf8' });
        const doctor = JSON.parse(doctorOutput);
        if (!doctor.ok) {
            throw new Error(`Doctor did not report ready. output=${doctorOutput}`);
        }
        if (!doctor.checks.some((check: any) => check.name === 'supported_sources')) {
            throw new Error(`Doctor did not include supported source scan. output=${doctorOutput}`);
        }
        const failedDoctor = spawnSync(nodeCommand(), [
            path.join(process.cwd(), 'bin', 'mcp-memory-doctor.js'),
            '--project-path',
            path.join(projectPath, 'missing-project'),
            '--db-path',
            dbPath,
            '--json'
        ], { encoding: 'utf8' });
        if (failedDoctor.status === 0) {
            throw new Error(`Doctor should fail for a missing project path. output=${failedDoctor.stdout}`);
        }
        const failedReport = JSON.parse(failedDoctor.stdout);
        if (failedReport.ok !== false || !failedReport.checks.some((check: any) => check.name === 'project_path' && check.status === 'fail')) {
            throw new Error(`Doctor failure report did not include project_path failure. output=${failedDoctor.stdout}`);
        }
        console.log('Setup helper smoke passed.');
    } finally {
        fs.rmSync(projectPath, { recursive: true, force: true });
    }
}

main();
