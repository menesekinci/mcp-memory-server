import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';

export type CallReference = {
    caller_symbol_id: string;
    target_name: string;
    target_file_path?: string;
    file_path: string;
    line: number;
    confidence: number;
    resolution_method: string;
};

type IndexedSymbol = {
    id: string;
    name: string;
    start_line: number;
    end_line: number;
};

export function extractCallReferences(tree: Parser.Tree, symbols: IndexedSymbol[], filePath: string, language = 'typescript'): CallReference[] {
    if (language === 'python') {
        return extractPythonCallReferences(tree, symbols, filePath);
    }

    const calls: CallReference[] = [];
    const imports = extractImports(tree.rootNode, filePath);

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'call_expression' || node.type === 'new_expression') {
            const callee = extractCallee(node);
            const caller = findContainingSymbol(symbols, node.startPosition.row + 1);
            if (callee && caller && (callee.memberName || callee.localName) !== caller.name && !isShadowed(tree.rootNode, caller, callee.localName, node.startIndex)) {
                const imported = resolveImportedTarget(callee, imports);
                calls.push({
                    caller_symbol_id: caller.id,
                    target_name: imported?.name || callee.memberName || callee.localName,
                    target_file_path: imported?.filePath,
                    file_path: filePath,
                    line: node.startPosition.row + 1,
                    confidence: imported ? 0.98 : 0.95,
                    resolution_method: imported ? imported.method : 'ast_same_file_or_name'
                });
            }
        }

        for (let i = 0; i < node.childCount; i++) {
            traverse(node.child(i));
        }
    }

    traverse(tree.rootNode);
    return calls;
}

function extractPythonCallReferences(tree: Parser.Tree, symbols: IndexedSymbol[], filePath: string): CallReference[] {
    const calls: CallReference[] = [];

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'call') {
            const callee = extractPythonCalleeName(node);
            const caller = findContainingSymbol(symbols, node.startPosition.row + 1);
            if (callee && caller && callee !== caller.name) {
                calls.push({
                    caller_symbol_id: caller.id,
                    target_name: callee,
                    file_path: filePath,
                    line: node.startPosition.row + 1,
                    confidence: 0.9,
                    resolution_method: 'ast_python_name'
                });
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(tree.rootNode);
    return calls;
}

function findContainingSymbol(symbols: IndexedSymbol[], line: number) {
    return symbols
        .filter(symbol => symbol.start_line <= line && symbol.end_line >= line)
        .sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0];
}

type Callee = {
    localName: string;
    memberName?: string;
};

type ImportedBinding = {
    importedName: string;
    sourceFilePath: string;
    method: string;
};

type ImportMap = {
    named: Map<string, ImportedBinding>;
    namespaces: Map<string, string>;
};

function extractCallee(node: Parser.SyntaxNode): Callee | null {
    const functionNode = node.childForFieldName('function') || node.namedChild(0);
    if (!functionNode) return null;

    if (functionNode.type === 'identifier') {
        return { localName: functionNode.text };
    }

    if (functionNode.type === 'member_expression') {
        const object = functionNode.childForFieldName('object') || functionNode.namedChild(0);
        const property = functionNode.childForFieldName('property');
        if (object?.type === 'identifier' && property?.text) {
            return { localName: object.text, memberName: property.text };
        }
        return property?.text ? { localName: property.text } : null;
    }

    if (functionNode.type === 'subscript_expression') {
        return null;
    }

    const lastIdentifier = findLastIdentifier(functionNode);
    return lastIdentifier?.text ? { localName: lastIdentifier.text } : null;
}

function extractPythonCalleeName(node: Parser.SyntaxNode) {
    const functionNode = node.childForFieldName('function') || node.namedChild(0);
    if (!functionNode) return null;
    if (functionNode.type === 'identifier') return functionNode.text;
    const lastIdentifier = findLastIdentifier(functionNode);
    return lastIdentifier?.text || null;
}

function findLastIdentifier(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let match: Parser.SyntaxNode | null = node.type === 'identifier' || node.type === 'property_identifier' ? node : null;
    for (let i = 0; i < node.childCount; i++) {
        const childMatch = findLastIdentifier(node.child(i));
        if (childMatch) match = childMatch;
    }
    return match;
}

function resolveImportedTarget(callee: Callee, imports: ImportMap) {
    if (callee.memberName && imports.namespaces.has(callee.localName)) {
        const sourceFilePath = imports.namespaces.get(callee.localName)!;
        const resolved = resolveThroughBarrel(callee.memberName, sourceFilePath);
        return {
            name: resolved.name,
            filePath: resolved.filePath,
            method: resolved.method
        };
    }

    const binding = imports.named.get(callee.localName);
    if (!binding || callee.memberName) return null;

    const resolved = resolveThroughBarrel(binding.importedName, binding.sourceFilePath);
    return {
        name: resolved.name,
        filePath: resolved.filePath,
        method: resolved.method === 'ast_static_import' ? binding.method : resolved.method
    };
}

function extractImports(root: Parser.SyntaxNode, filePath: string): ImportMap {
    const imports: ImportMap = {
        named: new Map(),
        namespaces: new Map()
    };

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'import_statement') {
            const sourceFilePath = resolveModuleFile(filePath, moduleSpecifier(node));
            if (sourceFilePath) {
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child.type === 'import_clause') {
                        readImportClause(child, sourceFilePath, imports);
                    }
                }
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(root);
    return imports;
}

function readImportClause(node: Parser.SyntaxNode, sourceFilePath: string, imports: ImportMap) {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === 'named_imports') {
            readNamedImports(child, sourceFilePath, imports);
        } else if (child.type === 'namespace_import') {
            const local = findLastIdentifier(child);
            if (local) imports.namespaces.set(local.text, sourceFilePath);
        }
    }
}

function readNamedImports(node: Parser.SyntaxNode, sourceFilePath: string, imports: ImportMap) {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type !== 'import_specifier') continue;
        const identifiers = identifiersOf(child);
        if (identifiers.length === 0) continue;
        const importedName = identifiers[0].text;
        const localName = identifiers[identifiers.length - 1].text;
        imports.named.set(localName, {
            importedName,
            sourceFilePath,
            method: 'ast_static_import'
        });
    }
}

function resolveThroughBarrel(importedName: string, sourceFilePath: string, seen = new Set<string>()): { name: string; filePath: string; method: string } {
    if (seen.has(sourceFilePath) || !fs.existsSync(sourceFilePath)) {
        return { name: importedName, filePath: sourceFilePath, method: 'ast_static_import' };
    }
    seen.add(sourceFilePath);

    const content = fs.readFileSync(sourceFilePath, 'utf8');
    for (const reexport of readReexports(content, sourceFilePath)) {
        if (reexport.exportedName === '*' || reexport.exportedName === importedName) {
            return resolveThroughBarrel(reexport.importedName === '*' ? importedName : reexport.importedName, reexport.sourceFilePath, seen);
        }
    }

    if (declaresExportedSymbol(content, importedName)) {
        return { name: importedName, filePath: sourceFilePath, method: 'ast_static_import' };
    }

    return { name: importedName, filePath: sourceFilePath, method: 'ast_static_import' };
}

function readReexports(content: string, filePath: string) {
    const reexports: Array<{ exportedName: string; importedName: string; sourceFilePath: string }> = [];
    const namedReexport = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
    const starReexport = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;

    let namedMatch: RegExpExecArray | null;
    while ((namedMatch = namedReexport.exec(content))) {
        const sourceFilePath = resolveModuleFile(filePath, namedMatch[2]);
        if (!sourceFilePath) continue;
        for (const rawPart of namedMatch[1].split(',')) {
            const part = rawPart.trim();
            if (!part) continue;
            const [imported, exported] = part.split(/\s+as\s+/);
            reexports.push({
                importedName: imported.trim(),
                exportedName: (exported || imported).trim(),
                sourceFilePath
            });
        }
    }

    let starMatch: RegExpExecArray | null;
    while ((starMatch = starReexport.exec(content))) {
        const sourceFilePath = resolveModuleFile(filePath, starMatch[1]);
        if (sourceFilePath) {
            reexports.push({ importedName: '*', exportedName: '*', sourceFilePath });
        }
    }

    return reexports;
}

function declaresExportedSymbol(content: string, name: string) {
    const escaped = escapeRegex(name);
    return new RegExp(`export\\s+(async\\s+)?function\\s+${escaped}\\b`).test(content)
        || new RegExp(`export\\s+class\\s+${escaped}\\b`).test(content)
        || new RegExp(`export\\s+(const|let|var)\\s+${escaped}\\b`).test(content)
        || new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(content);
}

function moduleSpecifier(node: Parser.SyntaxNode) {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === 'string') {
            const fragment = child.namedChild(0);
            return fragment?.text || child.text.replace(/^['"]|['"]$/g, '');
        }
    }
    return null;
}

function resolveModuleFile(fromFilePath: string, specifier: string | null) {
    if (!specifier || !specifier.startsWith('.')) return null;
    const basePath = path.resolve(path.dirname(fromFilePath), specifier);
    const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, 'index.ts'),
        path.join(basePath, 'index.tsx')
    ];
    return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function isShadowed(root: Parser.SyntaxNode, caller: IndexedSymbol, localName: string, callStartIndex: number) {
    const callerNode = findSymbolNode(root, caller);
    if (!callerNode) return false;
    return hasLocalDeclarationBefore(callerNode, localName, callStartIndex, caller.start_line);
}

function findSymbolNode(root: Parser.SyntaxNode, symbol: IndexedSymbol): Parser.SyntaxNode | null {
    if (root.startPosition.row + 1 === symbol.start_line && root.endPosition.row + 1 === symbol.end_line) {
        return root;
    }
    for (let i = 0; i < root.namedChildCount; i++) {
        const match = findSymbolNode(root.namedChild(i), symbol);
        if (match) return match;
    }
    return null;
}

function hasLocalDeclarationBefore(node: Parser.SyntaxNode, name: string, callStartIndex: number, callerStartLine: number): boolean {
    if (node.startIndex >= callStartIndex) return false;

    if (node.type === 'variable_declarator') {
        const declared = node.childForFieldName('name') || node.namedChild(0);
        if (declared?.text === name) return true;
    }

    if (node.type === 'formal_parameters' && identifiersOf(node).some(identifier => identifier.text === name)) {
        return true;
    }

    if (node.type === 'function_declaration' && node.startPosition.row + 1 !== callerStartLine) {
        const declared = node.childForFieldName('name');
        if (declared?.text === name) return true;
    }

    for (let i = 0; i < node.namedChildCount; i++) {
        if (hasLocalDeclarationBefore(node.namedChild(i), name, callStartIndex, callerStartLine)) return true;
    }
    return false;
}

function identifiersOf(node: Parser.SyntaxNode) {
    const identifiers: Parser.SyntaxNode[] = [];
    function traverse(current: Parser.SyntaxNode) {
        if (current.type === 'identifier' || current.type === 'property_identifier') {
            identifiers.push(current);
        }
        for (let i = 0; i < current.namedChildCount; i++) {
            traverse(current.namedChild(i));
        }
    }
    traverse(node);
    return identifiers;
}

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
