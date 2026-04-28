import { initDb } from './db';
import { reconcileProjectFiles, reindexChangedFiles, startIndexer } from './indexer';
import { indexGitHistory } from './git-parser';
import { installGitHooks } from './git-hooks';
import { runServer } from './server';
import path from 'path';
import fs from 'fs';

async function bootstrap() {
    initDb();

    const projectPath = process.env.PROJECT_PATH || process.cwd();
    
    if (!fs.existsSync(projectPath)) {
        throw new Error(`PROJECT_PATH does not exist: ${projectPath}`);
    }

    const projectId = process.env.PROJECT_ID || path.basename(projectPath) || 'default';

    indexGitHistory(projectPath, projectId);
    reconcileProjectFiles(projectPath, projectId);
    await reindexChangedFiles(projectPath, projectId);
    if (process.env.INSTALL_GIT_HOOKS === '1') {
        installGitHooks(projectPath);
    }
    startIndexer(projectPath, projectId);
    await runServer();
}

bootstrap().catch(console.error);
