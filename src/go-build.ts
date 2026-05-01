import path from 'path';

const GOOS_TAGS = new Set([
    'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'illumos', 'ios', 'js', 'linux',
    'netbsd', 'openbsd', 'plan9', 'solaris', 'wasip1', 'windows'
]);

const GOARCH_TAGS = new Set([
    '386', 'amd64', 'amd64p32', 'arm', 'arm64', 'loong64', 'mips', 'mipsle', 'mips64',
    'mips64le', 'ppc64', 'ppc64le', 'riscv64', 's390x', 'sparc64', 'wasm'
]);

const UNIX_GOOS = new Set([
    'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'illumos', 'ios', 'linux',
    'netbsd', 'openbsd', 'solaris'
]);

type Token = string;

export function isExcludedByGoBuildConstraints(filePath: string, content: string) {
    if (!filePath.endsWith('.go')) return false;
    const tags = activeGoBuildTags();
    const suffixExpression = goFileSuffixExpression(filePath);
    if (suffixExpression && !suffixExpression.every(tag => tags.has(tag))) return true;

    const header = goBuildHeader(content);
    const goBuild = header.match(/^\/\/go:build\s+(.+)$/m)?.[1]?.trim();
    if (goBuild) return !evaluateGoBuildExpression(goBuild, tags);

    const legacyLines = [...header.matchAll(/^\/\/\s*\+build\s+(.+)$/gm)].map(match => match[1].trim());
    if (legacyLines.length === 0) return false;
    return !legacyLines.every(line => evaluateLegacyBuildLine(line, tags));
}

function activeGoBuildTags() {
    const goos = (process.env.GOOS || nodeGoos()).toLowerCase();
    const goarch = (process.env.GOARCH || nodeGoarch()).toLowerCase();
    const tags = new Set<string>([goos, goarch]);
    if (UNIX_GOOS.has(goos)) tags.add('unix');
    if ((process.env.CGO_ENABLED || '').trim() === '1') tags.add('cgo');
    for (const tag of (process.env.MCP_MEMORY_GO_BUILD_TAGS || '').split(/[,\s]+/)) {
        if (tag.trim()) tags.add(tag.trim());
    }
    return tags;
}

function nodeGoos() {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'darwin';
    if (process.platform === 'freebsd') return 'freebsd';
    if (process.platform === 'openbsd') return 'openbsd';
    if (process.platform === 'sunos') return 'solaris';
    return 'linux';
}

function nodeGoarch() {
    if (process.arch === 'x64') return 'amd64';
    if (process.arch === 'ia32') return '386';
    if (process.arch === 'arm64') return 'arm64';
    if (process.arch === 'arm') return 'arm';
    if (process.arch === 'ppc64') return 'ppc64';
    if (process.arch === 's390x') return 's390x';
    return process.arch;
}

function goFileSuffixExpression(filePath: string) {
    const base = path.basename(filePath, '.go');
    const parts = base.split('_');
    if (parts.length < 2) return null;
    const tags: string[] = [];
    const last = parts[parts.length - 1];
    const previous = parts[parts.length - 2];
    if (GOARCH_TAGS.has(last)) tags.unshift(last);
    if (GOOS_TAGS.has(last)) tags.unshift(last);
    if (GOOS_TAGS.has(previous) && GOARCH_TAGS.has(last)) tags.unshift(previous);
    return tags.length > 0 ? tags : null;
}

function goBuildHeader(content: string) {
    const lines = content.split(/\r?\n/);
    const header: string[] = [];
    for (const line of lines) {
        if (line.trim() === '') {
            header.push(line);
            continue;
        }
        if (!line.trim().startsWith('//')) break;
        header.push(line);
    }
    return header.join('\n');
}

function evaluateLegacyBuildLine(line: string, tags: Set<string>) {
    return line.split(/\s+/)
        .filter(Boolean)
        .some(option => option.split(',').every(term => {
            const tag = term.replace(/^!/, '');
            const active = tags.has(tag);
            return term.startsWith('!') ? !active : active;
        }));
}

function evaluateGoBuildExpression(expression: string, tags: Set<string>) {
    const tokens = expression.match(/[A-Za-z0-9_./-]+|&&|\|\||!|\(|\)/g) || [];
    let index = 0;

    const peek = () => tokens[index];
    const consume = (expected?: Token) => {
        const token = tokens[index++];
        if (expected && token !== expected) throw new Error(`Expected ${expected}`);
        return token;
    };

    const parseOr = (): boolean => {
        let value = parseAnd();
        while (peek() === '||') {
            consume('||');
            value = parseAnd() || value;
        }
        return value;
    };

    const parseAnd = (): boolean => {
        let value = parseUnary();
        while (peek() === '&&') {
            consume('&&');
            value = parseUnary() && value;
        }
        return value;
    };

    const parseUnary = (): boolean => {
        if (peek() === '!') {
            consume('!');
            return !parseUnary();
        }
        if (peek() === '(') {
            consume('(');
            const value = parseOr();
            consume(')');
            return value;
        }
        const token = consume();
        return Boolean(token && tags.has(token));
    };

    try {
        const value = parseOr();
        return index === tokens.length ? value : false;
    } catch {
        return false;
    }
}
