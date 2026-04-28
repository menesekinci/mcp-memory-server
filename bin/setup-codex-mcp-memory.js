#!/usr/bin/env node
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

function usage() {
  console.log(`Usage:
  setup-codex-mcp-memory [options]

Options:
  --project-path <path>   Project to index. Default: current working directory.
  --project-id <id>       Logical project id. Default: basename of project path.
  --db-path <path>        SQLite DB path. Default: ~/.mcp-memory-server/memory.db.
  --name <name>           Codex MCP server name. Default: codex-mcp-memory-server.
  --dry-run               Print the codex command without executing it.
  --help                  Show this help.
`);
}

function readArgs(argv) {
  const args = {
    projectPath: process.cwd(),
    projectId: undefined,
    dbPath: path.join(os.homedir(), '.mcp-memory-server', 'memory.db'),
    name: 'codex-mcp-memory-server',
    dryRun: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const next = argv[++i];
    if (!next) throw new Error(`Missing value for ${arg}`);
    if (arg === '--project-path') args.projectPath = path.resolve(next);
    else if (arg === '--project-id') args.projectId = next;
    else if (arg === '--db-path') args.dbPath = path.resolve(next);
    else if (arg === '--name') args.name = next;
    else throw new Error(`Unknown option: ${arg}`);
  }

  args.projectId = args.projectId || path.basename(args.projectPath) || 'default';
  return args;
}

function quote(value) {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

try {
  const args = readArgs(process.argv.slice(2));
  const commandArgs = [
    'mcp',
    'add',
    args.name,
    '--env',
    `PROJECT_PATH=${args.projectPath}`,
    '--env',
    `PROJECT_ID=${args.projectId}`,
    '--env',
    `MCP_MEMORY_DB_PATH=${args.dbPath}`,
    '--',
    'npx',
    '-y',
    'codex-mcp-memory-server'
  ];

  if (args.dryRun) {
    console.log(['codex', ...commandArgs].map(quote).join(' '));
    process.exit(0);
  }

  const result = spawnSync('codex', commandArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(error.message);
  usage();
  process.exit(1);
}
