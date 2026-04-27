import { initDb } from './db.ts';
import { startIndexer } from './indexer.ts';
import { indexGitHistory } from './git-parser.ts';
import { installGitHooks } from './git-hooks.ts';
import { runServer } from './server.ts';
import path from 'path';
import os from 'os';
import fs from 'fs';

async function bootstrap() {
    initDb();

    const projectPath = process.env.PROJECT_PATH || path.join(os.homedir(), 'Documents', 'test-project');
    
    if (!fs.existsSync(projectPath)) {
        fs.mkdirSync(projectPath, { recursive: true });
        fs.writeFileSync(path.join(projectPath, 'test.ts'), 'function calculateTotal() { return 100; }\nfunction main() { calculateTotal(); }');
    }

    indexGitHistory(projectPath);
    installGitHooks(projectPath);
    startIndexer(projectPath);
    await runServer();
}

bootstrap().catch(console.error);
