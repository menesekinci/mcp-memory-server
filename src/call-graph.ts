import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import ts from 'typescript';

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
    const objectTypes = extractObjectTypes(tree.rootNode, filePath, imports);

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'call_expression' || node.type === 'new_expression') {
            const callee = extractCallee(node);
            const caller = findContainingSymbol(symbols, node.startPosition.row + 1);
            if (callee && caller && (callee.memberName || callee.localName) !== caller.name) {
                const instanceMethod = callee.memberName
                    ? resolveInstanceMethod(callee, objectTypes)
                    : null;
                if (!instanceMethod && isShadowed(tree.rootNode, caller, callee.localName, node.startIndex)) return;
                const imported = instanceMethod ? null : resolveImportedTarget(callee, imports);
                calls.push({
                    caller_symbol_id: caller.id,
                    target_name: imported?.name || instanceMethod?.name || callee.memberName || callee.localName,
                    target_file_path: imported?.filePath || instanceMethod?.filePath,
                    file_path: filePath,
                    line: node.startPosition.row + 1,
                    confidence: imported ? 0.98 : instanceMethod ? 0.94 : 0.95,
                    resolution_method: imported ? imported.method : instanceMethod?.method || 'ast_same_file_or_name'
                });
            }
        } else if (node.type === 'jsx_self_closing_element' || node.type === 'jsx_opening_element') {
            const componentName = extractJsxComponentName(node);
            const caller = findContainingSymbol(symbols, node.startPosition.row + 1);
            if (componentName && caller && componentName !== caller.name) {
                const imported = resolveImportedTarget({ localName: componentName }, imports);
                calls.push({
                    caller_symbol_id: caller.id,
                    target_name: imported?.name || componentName,
                    target_file_path: imported?.filePath,
                    file_path: filePath,
                    line: node.startPosition.row + 1,
                    confidence: imported ? 0.97 : 0.93,
                    resolution_method: 'ast_jsx_component_usage'
                });
            }
        }

        for (let i = 0; i < node.childCount; i++) {
            traverse(node.child(i));
        }
    }

    traverse(tree.rootNode);
    const checkerCalls = language === 'typescript'
        ? extractTypeScriptCheckerReferences(filePath, symbols)
        : [];
    return mergeCallReferences([...calls, ...checkerCalls]);
}

function extractPythonCallReferences(tree: Parser.Tree, symbols: IndexedSymbol[], filePath: string): CallReference[] {
    const calls: CallReference[] = [];
    const imports = extractPythonImports(tree.rootNode, filePath);
    const objectTypes = extractPythonObjectTypes(tree.rootNode, filePath, imports);

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'call') {
            const callee = extractPythonCallee(node);
            const caller = findContainingSymbol(symbols, node.startPosition.row + 1);
            if (callee && caller && (callee.memberName || callee.localName) !== caller.name) {
                const imported = resolvePythonImportedTarget(callee, imports);
                const selfMethod = callee.localName === 'self' && callee.memberName;
                const instanceMethod = !imported && !selfMethod && callee.memberName
                    ? resolvePythonInstanceMethod(callee, objectTypes)
                    : null;
                calls.push({
                    caller_symbol_id: caller.id,
                    target_name: imported?.name || instanceMethod?.name || callee.memberName || callee.localName,
                    target_file_path: imported?.filePath || instanceMethod?.filePath,
                    file_path: filePath,
                    line: node.startPosition.row + 1,
                    confidence: imported ? 0.95 : instanceMethod ? 0.93 : selfMethod ? 0.92 : 0.9,
                    resolution_method: imported?.method || instanceMethod?.method || (selfMethod ? 'ast_python_self_method' : 'ast_python_name')
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

type ObjectTypeMap = Map<string, { className: string; filePath: string }>;

type PythonImportMap = {
    named: Map<string, ImportedBinding>;
    modules: Map<string, string>;
};

type PythonObjectTypeMap = Map<string, { className: string; filePath: string }>;

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

function extractPythonCallee(node: Parser.SyntaxNode): Callee | null {
    const functionNode = node.childForFieldName('function') || node.namedChild(0);
    if (!functionNode) return null;
    if (functionNode.type === 'identifier') return { localName: functionNode.text };
    if (functionNode.type === 'attribute') {
        const identifiers = identifiersOf(functionNode);
        if (identifiers.length >= 2) {
            return {
                localName: identifiers[identifiers.length - 2].text,
                memberName: identifiers[identifiers.length - 1].text
            };
        }
    }
    const lastIdentifier = findLastIdentifier(functionNode);
    return lastIdentifier?.text ? { localName: lastIdentifier.text } : null;
}

function extractJsxComponentName(node: Parser.SyntaxNode) {
    const nameNode = node.namedChild(0);
    if (!nameNode || nameNode.type !== 'identifier') return null;
    return /^[A-Z]/.test(nameNode.text) ? nameNode.text : null;
}

function findLastIdentifier(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let match: Parser.SyntaxNode | null = node.type === 'identifier' || node.type === 'property_identifier' ? node : null;
    for (let i = 0; i < node.childCount; i++) {
        const childMatch = findLastIdentifier(node.child(i));
        if (childMatch) match = childMatch;
    }
    return match;
}

function extractObjectTypes(root: Parser.SyntaxNode, filePath: string, imports: ImportMap): ObjectTypeMap {
    const objectTypes: ObjectTypeMap = new Map();

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'variable_declarator') {
            const nameNode = node.childForFieldName('name') || node.namedChild(0);
            const typeName = readTypeAnnotationName(node);
            const valueNode = node.childForFieldName('value') || node.namedChild(node.namedChildCount - 1);
            const constructor = valueNode?.type === 'new_expression' ? extractCallee(valueNode) : null;
            const className = constructor?.localName || typeName;
            if (nameNode?.type === 'identifier' && className) {
                const resolved = resolveClassTarget(className, filePath, imports);
                objectTypes.set(nameNode.text, resolved);
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(root);
    return objectTypes;
}

function resolveClassTarget(className: string, filePath: string, imports: ImportMap) {
    const binding = imports.named.get(className);
    if (binding) {
        const resolved = resolveThroughBarrel(binding.importedName, binding.sourceFilePath);
        return { className: resolved.name, filePath: resolved.filePath };
    }
    return { className, filePath };
}

function resolveInstanceMethod(callee: Callee, objectTypes: ObjectTypeMap) {
    if (!callee.memberName) return null;
    const objectType = objectTypes.get(callee.localName);
    if (!objectType) return null;
    return {
        name: callee.memberName,
        filePath: objectType.filePath,
        method: 'ast_instance_method'
    };
}

function readTypeAnnotationName(node: Parser.SyntaxNode) {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === 'type_annotation') {
            const identifier = findTypeIdentifier(child);
            return identifier?.text || null;
        }
    }
    return null;
}

function findTypeIdentifier(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (node.type === 'type_identifier' || node.type === 'identifier') return node;
    for (let i = 0; i < node.namedChildCount; i++) {
        const match = findTypeIdentifier(node.namedChild(i));
        if (match) return match;
    }
    return null;
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

function extractTypeScriptCheckerReferences(filePath: string, symbols: IndexedSymbol[]): CallReference[] {
    if (!/\.(ts|tsx)$/.test(filePath) || !fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    if (!shouldUseTypeScriptChecker(filePath, content)) return [];

    const options = readTypeScriptCompilerOptions(filePath);
    const program = ts.createProgram([filePath], {
        ...options,
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true
    });
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return [];

    const checker = program.getTypeChecker();
    const calls: CallReference[] = [];

    function pushReference(node: ts.Node, targetNode: ts.Node, method: string, confidence: number) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const caller = findContainingSymbol(symbols, line);
        if (!caller) return;
        const target = resolveTypeScriptSymbolTarget(checker, targetNode);
        if (!target || target.name === caller.name) return;
        calls.push({
            caller_symbol_id: caller.id,
            target_name: target.name,
            target_file_path: target.filePath,
            file_path: filePath,
            line,
            confidence,
            resolution_method: method
        });
    }

    function visit(node: ts.Node) {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            pushReference(node, node.expression, 'ts_checker_symbol', 0.99);
        } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            pushReference(node, node.tagName, 'ts_checker_jsx_component', 0.985);
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return calls;
}

function shouldUseTypeScriptChecker(filePath: string, content: string) {
    return filePath.endsWith('.tsx')
        || /\bimport\b|\bexport\s+.*\s+from\b/.test(content)
        || /<[A-Z][A-Za-z0-9_.]*(\s|>|\/>)/.test(content)
        || /\.[A-Za-z_$][\w$]*\s*\(/.test(content);
}

function readTypeScriptCompilerOptions(filePath: string): ts.CompilerOptions {
    const tsconfig = ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, 'tsconfig.json');
    if (!tsconfig) {
        return {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            jsx: ts.JsxEmit.ReactJSX,
            esModuleInterop: true
        };
    }

    const config = ts.readConfigFile(tsconfig, ts.sys.readFile);
    if (config.error) return {};
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsconfig));
    return parsed.options;
}

function resolveTypeScriptSymbolTarget(checker: ts.TypeChecker, node: ts.Node) {
    const symbol = resolveAliasedSymbol(checker, checker.getSymbolAtLocation(node));
    if (!symbol) return null;
    const declaration = symbol.valueDeclaration || symbol.declarations?.[0];
    if (!declaration) return null;
    const sourceFile = declaration.getSourceFile();
    if (sourceFile.isDeclarationFile) return null;
    const name = declarationName(declaration) || symbol.getName();
    if (!name || name === '__function' || name === 'prototype') return null;
    return {
        name,
        filePath: path.resolve(sourceFile.fileName)
    };
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined) {
    if (!symbol) return null;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        try {
            return checker.getAliasedSymbol(symbol);
        } catch {
            return symbol;
        }
    }
    return symbol;
}

function declarationName(declaration: ts.Declaration) {
    const named = declaration as ts.Declaration & { name?: ts.PropertyName | ts.BindingName };
    if (!named.name) return null;
    return ts.isIdentifier(named.name) || ts.isStringLiteral(named.name) || ts.isNumericLiteral(named.name)
        ? named.name.text
        : null;
}

function mergeCallReferences(calls: CallReference[]) {
    const merged = new Map<string, CallReference>();
    for (const call of calls) {
        const key = [
            call.caller_symbol_id,
            call.target_name,
            call.target_file_path || '',
            call.file_path,
            call.line
        ].join('\0');
        const existing = merged.get(key);
        if (!existing || call.confidence > existing.confidence) {
            merged.set(key, call);
        }
    }
    return [...merged.values()];
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

function extractPythonImports(root: Parser.SyntaxNode, filePath: string): PythonImportMap {
    const imports: PythonImportMap = {
        named: new Map(),
        modules: new Map()
    };

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'import_from_statement') {
            const moduleNode = node.namedChild(0);
            const sourceFilePath = resolvePythonModuleFile(filePath, moduleNode?.text || null);
            if (sourceFilePath) {
                for (let i = 1; i < node.namedChildCount; i++) {
                    readPythonImportedName(node.namedChild(i), sourceFilePath, imports);
                }
            }
        } else if (node.type === 'import_statement') {
            for (let i = 0; i < node.namedChildCount; i++) {
                readPythonImportedModule(node.namedChild(i), filePath, imports);
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(root);
    return imports;
}

function readPythonImportedName(node: Parser.SyntaxNode, sourceFilePath: string, imports: PythonImportMap) {
    const identifiers = identifiersOf(node);
    if (identifiers.length === 0) return;
    const importedName = identifiers[0].text;
    const localName = identifiers[identifiers.length - 1].text;
    imports.named.set(localName, {
        importedName,
        sourceFilePath,
        method: 'ast_python_from_import'
    });
}

function readPythonImportedModule(node: Parser.SyntaxNode, filePath: string, imports: PythonImportMap) {
    const sourceFilePath = resolvePythonModuleFile(filePath, node.text.split(/\s+as\s+/)[0].trim());
    if (!sourceFilePath) return;
    const identifiers = identifiersOf(node);
    if (identifiers.length === 0) return;
    const localName = node.type === 'aliased_import'
        ? identifiers[identifiers.length - 1].text
        : identifiers[0].text;
    imports.modules.set(localName, sourceFilePath);
}

function resolvePythonImportedTarget(callee: Callee, imports: PythonImportMap) {
    if (callee.memberName && imports.modules.has(callee.localName)) {
        const resolved = resolvePythonExportedTarget(callee.memberName, imports.modules.get(callee.localName)!);
        return {
            name: resolved.name,
            filePath: resolved.filePath,
            method: resolved.method === 'ast_python_name' ? 'ast_python_module_import' : resolved.method
        };
    }

    const binding = imports.named.get(callee.localName);
    if (!binding || callee.memberName) return null;

    const resolved = resolvePythonExportedTarget(binding.importedName, binding.sourceFilePath);
    return {
        name: resolved.name,
        filePath: resolved.filePath,
        method: resolved.method === 'ast_python_name' ? binding.method : resolved.method
    };
}

function extractPythonObjectTypes(root: Parser.SyntaxNode, filePath: string, imports: PythonImportMap): PythonObjectTypeMap {
    const objectTypes: PythonObjectTypeMap = new Map();

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'assignment') {
            const left = node.namedChild(0);
            const right = node.namedChild(1);
            const constructor = right?.type === 'call' ? extractPythonCallee(right) : null;
            if (left?.type === 'identifier' && constructor && !constructor.memberName) {
                const imported = imports.named.get(constructor.localName);
                objectTypes.set(left.text, {
                    className: imported?.importedName || constructor.localName,
                    filePath: imported ? resolvePythonExportedTarget(imported.importedName, imported.sourceFilePath).filePath : filePath
                });
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(root);
    return objectTypes;
}

function resolvePythonInstanceMethod(callee: Callee, objectTypes: PythonObjectTypeMap) {
    if (!callee.memberName) return null;
    const objectType = objectTypes.get(callee.localName);
    if (!objectType) return null;
    return {
        name: callee.memberName,
        filePath: objectType.filePath,
        method: 'ast_python_instance_method'
    };
}

function resolvePythonExportedTarget(importedName: string, sourceFilePath: string, seen = new Set<string>()): { name: string; filePath: string; method: string } {
    if (seen.has(sourceFilePath) || !fs.existsSync(sourceFilePath)) {
        return { name: importedName, filePath: sourceFilePath, method: 'ast_python_name' };
    }
    seen.add(sourceFilePath);

    const content = fs.readFileSync(sourceFilePath, 'utf8');
    const reexport = findPythonReexport(content, sourceFilePath, importedName);
    if (reexport) {
        return resolvePythonExportedTarget(reexport.importedName, reexport.sourceFilePath, seen);
    }

    return { name: importedName, filePath: sourceFilePath, method: 'ast_python_name' };
}

function findPythonReexport(content: string, filePath: string, exportedName: string) {
    const fromImport = /from\s+([.\w]+)\s+import\s+([^\n]+)/g;
    let match: RegExpExecArray | null;
    while ((match = fromImport.exec(content))) {
        const sourceFilePath = resolvePythonModuleFile(filePath, match[1]);
        if (!sourceFilePath) continue;
        for (const rawPart of match[2].split(',')) {
            const part = rawPart.trim();
            if (!part || part === '*') continue;
            const [imported, exported] = part.split(/\s+as\s+/).map(value => value.trim());
            if ((exported || imported) === exportedName) {
                return { importedName: imported, sourceFilePath };
            }
        }
    }
    return null;
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

function resolvePythonModuleFile(fromFilePath: string, specifier: string | null) {
    if (!specifier) return null;
    const normalized = specifier.trim();
    const relativePrefix = normalized.match(/^\.+/)?.[0] || '';
    const moduleName = normalized.slice(relativePrefix.length);
    const moduleParts = moduleName ? moduleName.split('.').filter(Boolean) : [];
    const bases: string[] = [];

    if (relativePrefix) {
        let base = path.dirname(fromFilePath);
        for (let i = 1; i < relativePrefix.length; i++) {
            base = path.dirname(base);
        }
        bases.push(base);
    } else {
        let current = path.dirname(fromFilePath);
        while (true) {
            bases.push(current);
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    }

    for (const base of bases) {
        const modulePath = path.join(base, ...moduleParts);
        const candidates = [
            `${modulePath}.py`,
            path.join(modulePath, '__init__.py')
        ];
        const found = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (found) return found;
    }

    return null;
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
