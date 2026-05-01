#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pkg = require('../package.json');

function parseArgs(argv) {
  const args = {
    projectPath: process.env.PROJECT_PATH || process.cwd(),
    dbPath: process.env.MCP_MEMORY_DB_PATH || path.join(os.homedir(), '.mcp-memory-server', 'memory.db'),
    json: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-path') args.projectPath = argv[++i];
    else if (arg === '--db-path') args.dbPath = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function commandExists(command) {
  const check = process.platform === 'win32'
    ? spawnSync('where.exe', [command], { encoding: 'utf8' })
    : spawnSync('which', [command], { encoding: 'utf8' });
  return check.status === 0;
}

function supportedSourceCount(projectPath) {
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go']);
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
  let count = 0;
  const stack = [projectPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && exts.has(path.extname(entry.name))) count++;
    }
  }
  return count;
}

function canWriteDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.mcp-memory-doctor-${process.pid}.tmp`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
}

function check(name, status, detail, severity = 'error') {
  return { name, status, detail, severity };
}

function runDoctor(options) {
  const checks = [];
  const projectPath = path.resolve(options.projectPath);
  const dbPath = path.resolve(options.dbPath);
  const dbDir = path.dirname(dbPath);

  checks.push(check('package_version', 'pass', pkg.version, 'info'));
  checks.push(check('node_version', Number(process.versions.node.split('.')[0]) >= 18 ? 'pass' : 'fail', process.version));

  if (fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()) {
    checks.push(check('project_path', 'pass', projectPath));
    checks.push(check('supported_sources', 'pass', `${supportedSourceCount(projectPath)} supported source files`, 'info'));
  } else {
    checks.push(check('project_path', 'fail', `Directory does not exist: ${projectPath}`));
  }

  try {
    canWriteDirectory(dbDir);
    checks.push(check('database_directory', 'pass', `Writable: ${dbDir}`));
  } catch (error) {
    checks.push(check('database_directory', 'fail', `Cannot write to ${dbDir}: ${error.message}`));
  }

  checks.push(check('npx', commandExists('npx') ? 'pass' : 'fail', 'Required for npx-based installs'));
  checks.push(check('codex_cli', commandExists('codex') ? 'pass' : 'warn', 'Needed only for automatic Codex MCP registration', 'warn'));

  if (process.env.MCP_MEMORY_DISABLE_BODY_STORAGE === '1') {
    checks.push(check('body_storage', 'pass', 'MCP_MEMORY_DISABLE_BODY_STORAGE=1, metadata-only body storage is enabled', 'info'));
  } else {
    checks.push(check('body_storage', 'pass', 'Full symbol body storage is enabled', 'info'));
  }

  const goEnv = [
    process.env.GOOS ? `GOOS=${process.env.GOOS}` : null,
    process.env.GOARCH ? `GOARCH=${process.env.GOARCH}` : null,
    process.env.CGO_ENABLED ? `CGO_ENABLED=${process.env.CGO_ENABLED}` : null,
    process.env.MCP_MEMORY_GO_BUILD_TAGS ? `MCP_MEMORY_GO_BUILD_TAGS=${process.env.MCP_MEMORY_GO_BUILD_TAGS}` : null,
  ].filter(Boolean);
  checks.push(check('go_build_context', 'pass', goEnv.length > 0 ? goEnv.join(', ') : 'Using host GOOS/GOARCH defaults; no custom Go build tags configured', 'info'));

  const hasFailure = checks.some(item => item.status === 'fail');
  const hasWarning = checks.some(item => item.status === 'warn');
  return {
    ok: !hasFailure && !(options.strict && hasWarning),
    project_path: projectPath,
    db_path: dbPath,
    checks
  };
}

function printText(report) {
  console.log(`MCP Memory Doctor v${pkg.version}`);
  console.log(`Project: ${report.project_path}`);
  console.log(`DB: ${report.db_path}`);
  for (const item of report.checks) {
    const mark = item.status === 'pass' ? 'OK' : item.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${mark}] ${item.name}: ${item.detail}`);
  }
  console.log(report.ok ? 'Result: ready' : 'Result: needs attention');
}

function printHelp() {
  console.log(`Usage: mcp-memory-doctor [--project-path <path>] [--db-path <path>] [--json] [--strict]

Checks Node, project path, supported source files, database write access, npx, Codex CLI visibility, and body-storage mode.`);
}

const options = parseArgs(process.argv.slice(2));
const report = runDoctor(options);
if (options.json) console.log(JSON.stringify(report, null, 2));
else printText(report);
process.exit(report.ok ? 0 : 1);
