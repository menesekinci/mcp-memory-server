import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function installGitHooks(projectPath) {
    console.error(`Installing Git hooks for: ${projectPath}`);
    const hooksDir = path.join(projectPath, '.git', 'hooks');
    
    if (!fs.existsSync(hooksDir)) {
        console.error("Not a git repository or .git/hooks directory missing.");
        return;
    }

    const hooks = ['post-commit', 'post-checkout', 'post-merge', 'post-rewrite'];
    const hookContent = `#!/bin/sh
# MCP Memory Server Hook
# Trigger a re-index of the project
echo "MCP Memory Server: Triggering re-index..."
# In a real scenario, we'd call the server via a socket or a specific CLI command
# For FAZ 2, we'll assume the server is running and watching files.
# However, for branch switches, we might need to force a full scan.
`;

    hooks.forEach(hook => {
        const hookPath = path.join(hooksDir, hook);
        fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
        console.error(`Installed hook: ${hook}`);
    });
}
