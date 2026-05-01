import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import ts from 'typescript';

export type CallReference = {
    caller_symbol_id: string;
    target_name: string;
    target_qualified_name?: string;
    target_file_path?: string;
    file_path: string;
    line: number;
    confidence: number;
    resolution_method: string;
};

type IndexedSymbol = {
    id: string;
    name: string;
    qualified_name?: string;
    start_line: number;
    end_line: number;
};

export function extractCallReferences(tree: Parser.Tree, symbols: IndexedSymbol[], filePath: string, language = 'typescript'): CallReference[] {
    if (language === 'python') {
        return extractPythonCallReferences(tree, symbols, filePath);
    }
    if (language === 'go') {
        return extractGoCallReferences(tree, symbols, filePath);
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
                    target_qualified_name: instanceMethod?.qualifiedName,
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
    const classBases = extractPythonClassBases(tree.rootNode, filePath, imports);
    const classMethods = collectPythonClassMethods(symbols);

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'call') {
            const callee = extractPythonCallee(node);
            const caller = findContainingSymbol(symbols, node.startPosition.row + 1);
            if (callee && caller && (callee.memberName || callee.localName) !== caller.name) {
                const imported = resolvePythonImportedTarget(callee, imports);
                const selfMethod = callee.localName === 'self' && callee.memberName;
                const superMethod = callee.localName === 'super' && callee.memberName
                    ? resolvePythonSuperMethod(caller, callee.memberName, classMethods, classBases)
                    : null;
                const instanceMethod = !imported && !selfMethod && !superMethod && callee.memberName
                    ? resolvePythonInstanceMethod(callee, objectTypes, caller)
                    : null;
                const inheritedSelfMethod = selfMethod
                    ? resolvePythonSelfMethod(caller, callee.memberName, classMethods, classBases)
                    : null;
                const selfQualifiedName = selfMethod
                    ? inheritedSelfMethod?.qualifiedName || scopedMemberName(caller.qualified_name, callee.memberName)
                    : undefined;
                calls.push({
                    caller_symbol_id: caller.id,
                    target_name: imported?.name || instanceMethod?.name || inheritedSelfMethod?.name || superMethod?.name || callee.memberName || callee.localName,
                    target_qualified_name: instanceMethod?.qualifiedName || selfQualifiedName || superMethod?.qualifiedName,
                    target_file_path: imported?.filePath || instanceMethod?.filePath || inheritedSelfMethod?.filePath || superMethod?.filePath,
                    file_path: filePath,
                    line: node.startPosition.row + 1,
                    confidence: imported ? 0.95 : instanceMethod ? 0.93 : inheritedSelfMethod ? 0.91 : superMethod ? 0.91 : selfMethod ? 0.92 : 0.9,
                    resolution_method: imported?.method || instanceMethod?.method || inheritedSelfMethod?.method || superMethod?.method || (selfMethod ? 'ast_python_self_method' : 'ast_python_name')
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

function scopedMemberName(qualifiedName: string | undefined, memberName: string | undefined) {
    if (!qualifiedName || !memberName || !qualifiedName.includes('.')) return undefined;
    return `${qualifiedName.split('.').slice(0, -1).join('.')}.${memberName}`;
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
type PythonClassBaseMap = Map<string, Array<{ className: string; filePath: string }>>;
type PythonClassMethodMap = Map<string, Set<string>>;
type GoImportMap = Map<string, { importPath: string; packageDir?: string }>;
type GoReceiverMap = Map<string, { receiverName: string; typeName: string }>;
type GoObjectTypeMap = Map<string, { typeName: string; filePath: string }>;
type GoEmbeddedTypeMap = Map<string, string[]>;
type GoMethodMap = Map<string, Set<string>>;
type GoInterfaceMethodMap = Map<string, Set<string>>;

function extractGoCallReferences(tree: Parser.Tree, symbols: IndexedSymbol[], filePath: string): CallReference[] {
    const calls: CallReference[] = [];
    const imports = extractGoImports(tree.rootNode, filePath);
    const receivers = extractGoReceivers(tree.rootNode, symbols);
    const objectTypes = extractGoObjectTypes(tree.rootNode, filePath);
    const embeddedTypes = extractGoEmbeddedTypes(tree.rootNode);
    const interfaceMethods = extractGoInterfaceMethods(tree.rootNode);
    const methods = collectGoMethods(symbols);

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'call_expression') {
            const callee = extractGoCallee(node);
            const caller = findContainingSymbol(symbols, node.startPosition.row + 1);
            if (callee && caller && (callee.memberName || callee.localName) !== caller.name) {
                const imported = callee.memberName ? resolveGoImportedTarget(callee, imports) : null;
                const instanceMethod = !imported && callee.memberName
                    ? resolveGoInstanceMethod(callee, caller, objectTypes, methods, embeddedTypes, interfaceMethods, filePath)
                    : null;
                const interfaceTargets = !imported && !instanceMethod && callee.memberName
                    ? resolveGoInterfaceMethodTargets(callee, caller, objectTypes, methods, interfaceMethods, filePath)
                    : [];
                if (interfaceTargets.length > 0) {
                    for (const target of interfaceTargets) {
                        calls.push({
                            caller_symbol_id: caller.id,
                            target_name: callee.memberName,
                            target_qualified_name: target.qualifiedName,
                            target_file_path: target.filePath,
                            file_path: filePath,
                            line: node.startPosition.row + 1,
                            confidence: 0.72,
                            resolution_method: 'ast_go_interface_dispatch'
                        });
                    }
                    return;
                }
                const receiverMethod = !imported && !instanceMethod && callee.memberName
                    ? resolveGoReceiverMethod(callee, caller, receivers, methods, embeddedTypes, filePath)
                    : null;
                calls.push({
                    caller_symbol_id: caller.id,
                    target_name: imported?.name || instanceMethod?.name || receiverMethod?.name || callee.memberName || callee.localName,
                    target_qualified_name: instanceMethod?.qualifiedName || receiverMethod?.qualifiedName,
                    target_file_path: imported?.filePath || instanceMethod?.filePath || receiverMethod?.filePath,
                    file_path: filePath,
                    line: node.startPosition.row + 1,
                    confidence: imported ? 0.94 : instanceMethod ? 0.93 : receiverMethod ? 0.93 : 0.9,
                    resolution_method: imported?.method || instanceMethod?.method || receiverMethod?.method || 'ast_go_name'
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

function extractGoCallee(node: Parser.SyntaxNode): Callee | null {
    const functionNode = node.childForFieldName('function') || node.namedChild(0);
    if (!functionNode) return null;
    if (functionNode.type === 'identifier') return { localName: functionNode.text };
    if (functionNode.type === 'selector_expression') {
        const identifiers = identifiersOf(functionNode);
        if (identifiers.length >= 2) {
            return {
                localName: identifiers.slice(0, -1).map(identifier => identifier.text).join('.'),
                memberName: identifiers[identifiers.length - 1].text
            };
        }
    }
    const lastIdentifier = findLastIdentifier(functionNode);
    return lastIdentifier?.text ? { localName: lastIdentifier.text } : null;
}

function extractGoImports(root: Parser.SyntaxNode, filePath: string): GoImportMap {
    const imports: GoImportMap = new Map();

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'import_spec') {
            const rawPath = node.text.match(/"([^"]+)"/)?.[1];
            if (rawPath) {
                const aliasNode = node.namedChildren.find(child => child.type === 'package_identifier');
                const localName = aliasNode?.text || rawPath.split('/').slice(-1)[0];
                imports.set(localName, {
                    importPath: rawPath,
                    packageDir: resolveGoPackageDir(filePath, rawPath) || undefined
                });
            }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(root);
    return imports;
}

function extractGoReceivers(root: Parser.SyntaxNode, symbols: IndexedSymbol[]): GoReceiverMap {
    const receivers: GoReceiverMap = new Map();

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'method_declaration') {
            const caller = findContainingSymbol(symbols, node.startPosition.row + 1);
            const receiver = node.childForFieldName('receiver');
            const receiverName = receiver ? findFirstGoIdentifier(receiver)?.text : null;
            const typeName = receiver ? findFirstGoTypeIdentifier(receiver)?.text : null;
            if (caller?.qualified_name && receiverName && typeName) {
                receivers.set(caller.qualified_name, { receiverName, typeName });
            }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(root);
    return receivers;
}

function extractGoObjectTypes(root: Parser.SyntaxNode, filePath: string): GoObjectTypeMap {
    const objectTypes: GoObjectTypeMap = new Map();

    function traverse(node: Parser.SyntaxNode, functionScope?: string) {
        if (node.type === 'function_declaration' || node.type === 'method_declaration') {
            const nameNode = node.childForFieldName('name');
            const qualifiedFunction = nameNode ? goFunctionScopeName(node, nameNode.text) : functionScope;
            const receiverNode = node.type === 'method_declaration' ? node.childForFieldName('receiver') : null;
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (receiverNode && child.id === receiverNode.id) continue;
                traverse(child, qualifiedFunction);
            }
            return;
        }

        if (node.type === 'short_var_declaration' || node.type === 'var_spec') {
            const left = node.childForFieldName('left') || node.childForFieldName('name') || node.namedChild(0);
            const right = node.childForFieldName('right') || node.childForFieldName('value') || node.namedChild(1);
            const variableName = left ? findFirstGoIdentifier(left)?.text : null;
            const typeName = right ? goConstructedTypeName(right) : null;
            if (variableName && typeName) {
                objectTypes.set(goObjectTypeKey(variableName, functionScope), { typeName, filePath });
            }
        } else if (node.type === 'parameter_declaration' && functionScope) {
            const typeName = findFirstGoTypeIdentifier(node)?.text;
            const names = goParameterNames(node, typeName);
            if (typeName) {
                for (const name of names) {
                    objectTypes.set(goObjectTypeKey(name, functionScope), { typeName, filePath });
                }
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i), functionScope);
        }
    }

    traverse(root);
    return objectTypes;
}

function extractGoInterfaceMethods(root: Parser.SyntaxNode): GoInterfaceMethodMap {
    const interfaces: GoInterfaceMethodMap = new Map();

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'type_spec') {
            const nameNode = node.childForFieldName('name');
            const typeNode = node.childForFieldName('type');
            if (nameNode && typeNode?.type === 'interface_type') {
                const methods = new Set<string>();
                for (const match of typeNode.text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
                    methods.add(match[1]);
                }
                for (let i = 0; i < typeNode.namedChildCount; i++) {
                    collectGoInterfaceMethodNames(typeNode.namedChild(i), methods);
                }
                if (methods.size > 0) interfaces.set(nameNode.text, methods);
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(root);
    return interfaces;
}

function collectGoInterfaceMethodNames(node: Parser.SyntaxNode, methods: Set<string>) {
    if (node.type === 'method_elem' || node.type === 'method_spec') {
        const name = findFirstGoIdentifier(node)?.text;
        if (name) methods.add(name);
    }
    for (let i = 0; i < node.namedChildCount; i++) {
        collectGoInterfaceMethodNames(node.namedChild(i), methods);
    }
}

function extractGoEmbeddedTypes(root: Parser.SyntaxNode): GoEmbeddedTypeMap {
    const embeddedTypes: GoEmbeddedTypeMap = new Map();

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'type_spec') {
            const nameNode = node.childForFieldName('name');
            const typeNode = node.childForFieldName('type');
            if (nameNode && typeNode?.type === 'struct_type') {
                const embedded: string[] = [];
                for (let i = 0; i < typeNode.namedChildCount; i++) {
                    const child = typeNode.namedChild(i);
                    if (child.type !== 'field_declaration') continue;
                    const fieldName = findFirstGoIdentifier(child);
                    const typeName = findFirstGoTypeIdentifier(child)?.text;
                    if (!fieldName && typeName) embedded.push(typeName);
                }
                if (embedded.length > 0) embeddedTypes.set(nameNode.text, embedded);
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(root);
    return embeddedTypes;
}

function collectGoMethods(symbols: IndexedSymbol[]): GoMethodMap {
    const methods: GoMethodMap = new Map();
    for (const symbol of symbols) {
        if (!symbol.qualified_name?.includes('.')) continue;
        const parts = symbol.qualified_name.split('.');
        const methodName = parts.pop()!;
        const typeName = parts.join('.');
        if (!methods.has(typeName)) methods.set(typeName, new Set());
        methods.get(typeName)!.add(methodName);
    }
    return methods;
}

function resolveGoImportedTarget(callee: Callee, imports: GoImportMap) {
    if (!callee.memberName) return null;
    const binding = imports.get(callee.localName);
    if (!binding) return null;
    return {
        name: callee.memberName,
        filePath: binding.packageDir ? findGoPackageSymbolFile(binding.packageDir, callee.memberName) : undefined,
        method: 'ast_go_import'
    };
}

function resolveGoInstanceMethod(
    callee: Callee,
    caller: IndexedSymbol,
    objectTypes: GoObjectTypeMap,
    methods: GoMethodMap,
    embeddedTypes: GoEmbeddedTypeMap,
    interfaceMethods: GoInterfaceMethodMap,
    filePath: string
) {
    if (!callee.memberName) return null;
    const objectType = objectTypes.get(goObjectTypeKey(callee.localName, caller.qualified_name)) || objectTypes.get(callee.localName);
    if (!objectType) return null;
    if (interfaceMethods.get(objectType.typeName)?.has(callee.memberName)) return null;
    const targetType = resolveGoMethodOwner(objectType.typeName, callee.memberName, methods, embeddedTypes, objectType.filePath || filePath);
    return {
        name: callee.memberName,
        qualifiedName: `${targetType.typeName}.${callee.memberName}`,
        filePath: objectType.filePath || filePath,
        method: targetType.promoted ? 'ast_go_embedded_method' : 'ast_go_instance_method'
    };
}

function resolveGoInterfaceMethodTargets(
    callee: Callee,
    caller: IndexedSymbol,
    objectTypes: GoObjectTypeMap,
    methods: GoMethodMap,
    interfaceMethods: GoInterfaceMethodMap,
    filePath: string
) {
    if (!callee.memberName) return [];
    const objectType = objectTypes.get(goObjectTypeKey(callee.localName, caller.qualified_name)) || objectTypes.get(callee.localName);
    if (!objectType || !interfaceMethods.get(objectType.typeName)?.has(callee.memberName)) return [];
    return [...methods.entries()]
        .filter(([typeName, methodNames]) => typeName !== objectType.typeName && methodNames.has(callee.memberName))
        .map(([typeName]) => ({
            qualifiedName: `${typeName}.${callee.memberName}`,
            filePath
        }));
}

function resolveGoReceiverMethod(
    callee: Callee,
    caller: IndexedSymbol,
    receivers: GoReceiverMap,
    methods: GoMethodMap,
    embeddedTypes: GoEmbeddedTypeMap,
    filePath: string
) {
    if (!callee.memberName || !caller.qualified_name) return null;
    const receiver = receivers.get(caller.qualified_name);
    if (!receiver || receiver.receiverName !== callee.localName) return null;
    const targetType = resolveGoMethodOwner(receiver.typeName, callee.memberName, methods, embeddedTypes, filePath);
    return {
        name: callee.memberName,
        qualifiedName: `${targetType.typeName}.${callee.memberName}`,
        filePath,
        method: targetType.promoted ? 'ast_go_embedded_method' : 'ast_go_receiver_method'
    };
}

function resolveGoMethodOwner(typeName: string, methodName: string, methods: GoMethodMap, embeddedTypes: GoEmbeddedTypeMap, filePath?: string, seen = new Set<string>()): { typeName: string; promoted: boolean } {
    if (methods.get(typeName)?.has(methodName)) return { typeName, promoted: false };
    if (seen.has(typeName)) return { typeName, promoted: false };
    seen.add(typeName);
    const embeddedCandidates = embeddedTypes.get(typeName) || goEmbeddedTypesFromSource(filePath, typeName);
    for (const embeddedType of embeddedCandidates) {
        if (methods.get(embeddedType)?.has(methodName)) return { typeName: embeddedType, promoted: true };
        const resolved = resolveGoMethodOwner(embeddedType, methodName, methods, embeddedTypes, filePath, seen);
        if (resolved.typeName !== embeddedType || resolved.promoted) return { ...resolved, promoted: true };
    }
    return { typeName, promoted: false };
}

function goEmbeddedTypesFromSource(filePath: string | undefined, typeName: string) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(new RegExp(`type\\s+${escapeRegex(typeName)}\\s+struct\\s*\\{([\\s\\S]*?)\\}`));
    if (!match) return [];
    return match[1]
        .split(/\r?\n|;/)
        .map(line => line.trim())
        .filter(line => /^[*]?[A-Z]\w*(?:\s*(?:\/\/.*)?)?$/.test(line))
        .map(line => line.replace(/^\*/, '').replace(/\/\/.*$/, '').trim());
}

function goObjectTypeKey(variableName: string, functionScope?: string) {
    return functionScope ? `${functionScope}:${variableName}` : variableName;
}

function goFunctionScopeName(node: Parser.SyntaxNode, functionName: string) {
    if (node.type !== 'method_declaration') return functionName;
    const receiverType = node.childForFieldName('receiver')
        ? findFirstGoTypeIdentifier(node.childForFieldName('receiver'))?.text
        : null;
    return receiverType ? `${receiverType}.${functionName}` : functionName;
}

function goConstructedTypeName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'composite_literal') return findFirstGoTypeIdentifier(node)?.text || null;
    if (node.type === 'unary_expression') {
        for (let i = 0; i < node.namedChildCount; i++) {
            const typeName = goConstructedTypeName(node.namedChild(i));
            if (typeName) return typeName;
        }
    }
    if (node.type === 'expression_list') {
        for (let i = 0; i < node.namedChildCount; i++) {
            const typeName = goConstructedTypeName(node.namedChild(i));
            if (typeName) return typeName;
        }
    }
    return null;
}

function goParameterNames(node: Parser.SyntaxNode, typeName: string | undefined) {
    if (!typeName) return [];
    const names: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === 'identifier') names.push(child.text);
    }
    return names.filter(name => name !== typeName);
}

function resolveGoPackageDir(fromFilePath: string, importPath: string) {
    const moduleRoot = findGoModuleRoot(path.dirname(fromFilePath));
    const local = moduleRoot ? resolveGoImportInModule(moduleRoot, importPath) : null;
    if (local) return local;
    for (const workspaceModule of findGoWorkspaceModules(path.dirname(fromFilePath))) {
        const resolved = resolveGoImportInModule(workspaceModule, importPath);
        if (resolved) return resolved;
    }
    return null;
}

function findGoModuleRoot(startDir: string) {
    let current = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(current, 'go.mod'))) return current;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

function resolveGoImportInModule(moduleRoot: string, importPath: string) {
    const goModPath = path.join(moduleRoot, 'go.mod');
    if (!fs.existsSync(goModPath)) return null;
    const goMod = fs.readFileSync(goModPath, 'utf8');
    const moduleName = goMod.match(/^module\s+(.+)$/m)?.[1]?.trim();
    if (moduleName && importPath.startsWith(moduleName)) {
        const relativePath = importPath.slice(moduleName.length).replace(/^\/+/, '');
        const packageDir = path.join(moduleRoot, ...relativePath.split('/').filter(Boolean));
        return fs.existsSync(packageDir) ? packageDir : null;
    }
    for (const replacement of parseGoReplaceTargets(goMod, moduleRoot)) {
        if (!importPath.startsWith(replacement.modulePath)) continue;
        const relativePath = importPath.slice(replacement.modulePath.length).replace(/^\/+/, '');
        const packageDir = path.join(replacement.localPath, ...relativePath.split('/').filter(Boolean));
        if (fs.existsSync(packageDir)) return packageDir;
    }
    return null;
}

function parseGoReplaceTargets(goMod: string, moduleRoot: string) {
    const replacements: Array<{ modulePath: string; localPath: string }> = [];
    const addReplacement = (line: string) => {
        const normalized = line.replace(/\/\/.*$/, '').trim();
        const match = normalized.match(/^replace\s+(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)/) || normalized.match(/^(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)/);
        if (!match) return;
        const [, modulePath, targetPath] = match;
        if (!targetPath.startsWith('.') && !path.isAbsolute(targetPath)) return;
        replacements.push({ modulePath, localPath: path.resolve(moduleRoot, targetPath) });
    };

    for (const match of goMod.matchAll(/^replace\s+(.+)$/gm)) {
        const line = match[1].trim();
        if (line && !line.startsWith('(')) addReplacement(`replace ${line}`);
    }
    const replaceBlock = goMod.match(/replace\s*\(([\s\S]*?)\)/m)?.[1];
    for (const rawLine of (replaceBlock || '').split(/\r?\n/)) {
        addReplacement(rawLine);
    }
    return replacements;
}

function findGoWorkspaceModules(startDir: string) {
    const workspaceRoot = findGoWorkspaceRoot(startDir);
    if (!workspaceRoot) return [];
    const goWork = fs.readFileSync(path.join(workspaceRoot, 'go.work'), 'utf8');
    const usePaths = new Set<string>();
    const useBlock = goWork.match(/use\s*\(([\s\S]*?)\)/m)?.[1];
    for (const rawLine of (useBlock || '').split(/\r?\n/)) {
        const line = rawLine.replace(/\/\/.*$/, '').trim();
        if (line) usePaths.add(line);
    }
    for (const match of goWork.matchAll(/^use\s+(.+)$/gm)) {
        const line = match[1].replace(/\/\/.*$/, '').trim();
        if (line && !line.startsWith('(')) usePaths.add(line);
    }
    return [...usePaths]
        .map(usePath => path.resolve(workspaceRoot, usePath))
        .filter(modulePath => fs.existsSync(path.join(modulePath, 'go.mod')));
}

function findGoWorkspaceRoot(startDir: string) {
    let current = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(current, 'go.work'))) return current;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

function findGoPackageSymbolFile(packageDir: string, symbolName: string) {
    if (!fs.existsSync(packageDir)) return undefined;
    for (const entry of fs.readdirSync(packageDir)) {
        if (!entry.endsWith('.go') || entry.endsWith('_test.go')) continue;
        const filePath = path.join(packageDir, entry);
        const content = fs.readFileSync(filePath, 'utf8');
        const pattern = new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${escapeRegex(symbolName)}\\s*\\(`);
        if (pattern.test(content)) return filePath;
    }
    return undefined;
}

function findFirstGoIdentifier(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (node.type === 'identifier') return node;
    for (let i = 0; i < node.namedChildCount; i++) {
        const found = findFirstGoIdentifier(node.namedChild(i));
        if (found) return found;
    }
    return null;
}

function findFirstGoTypeIdentifier(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (node.type === 'type_identifier') return node;
    for (let i = 0; i < node.namedChildCount; i++) {
        const found = findFirstGoTypeIdentifier(node.namedChild(i));
        if (found) return found;
    }
    return null;
}

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
                localName: identifiers.slice(0, -1).map(identifier => identifier.text).join('.'),
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
        qualifiedName: `${objectType.className}.${callee.memberName}`,
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
        traceResolution: false,
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
            call.target_qualified_name || '',
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
    if (node.type !== 'aliased_import') {
        const fullName = identifiers.map(identifier => identifier.text).join('.');
        imports.modules.set(fullName, sourceFilePath);
    }
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

    function traverse(node: Parser.SyntaxNode, classScope?: string, functionScope?: string) {
        if (node.type === 'class_definition') {
            const nameNode = node.childForFieldName('name');
            for (let i = 0; i < node.namedChildCount; i++) {
                traverse(node.namedChild(i), nameNode?.text || classScope, undefined);
            }
            return;
        }

        if (node.type === 'function_definition' || node.type === 'async_function_definition') {
            const nameNode = node.childForFieldName('name');
            const qualifiedFunction = nameNode ? (classScope ? `${classScope}.${nameNode.text}` : nameNode.text) : functionScope;
            for (let i = 0; i < node.namedChildCount; i++) {
                traverse(node.namedChild(i), classScope, qualifiedFunction);
            }
            return;
        }

        if (node.type === 'assignment') {
            const left = node.namedChild(0);
            const right = node.namedChild(1);
            const constructor = right?.type === 'call' ? extractPythonCallee(right) : null;
            const targetName = left ? pythonAssignmentTargetName(left) : null;
            if (targetName && constructor && !constructor.memberName) {
                const imported = imports.named.get(constructor.localName);
                objectTypes.set(pythonObjectTypeKey(targetName, classScope, functionScope), {
                    className: imported?.importedName || constructor.localName,
                    filePath: imported ? resolvePythonExportedTarget(imported.importedName, imported.sourceFilePath).filePath : filePath
                });
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i), classScope, functionScope);
        }
    }

    traverse(root);
    return objectTypes;
}

function pythonAssignmentTargetName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'identifier') return node.text;
    if (node.type !== 'attribute') return null;
    const identifiers = identifiersOf(node).map(identifier => identifier.text);
    return identifiers.length >= 2 ? identifiers.join('.') : null;
}

function pythonObjectTypeKey(targetName: string, classScope?: string, functionScope?: string) {
    if (targetName.startsWith('self.') && classScope) return `${classScope}:${targetName}`;
    if (functionScope) return `${functionScope}:${targetName}`;
    return targetName;
}

function resolvePythonInstanceMethod(callee: Callee, objectTypes: PythonObjectTypeMap, caller: IndexedSymbol) {
    if (!callee.memberName) return null;
    const currentClass = caller.qualified_name?.split('.').slice(0, -1).join('.');
    const candidates = [
        caller.qualified_name ? `${caller.qualified_name}:${callee.localName}` : undefined,
        currentClass ? `${currentClass}:${callee.localName}` : undefined,
        callee.localName
    ].filter(Boolean) as string[];
    const objectType = candidates.map(candidate => objectTypes.get(candidate)).find(Boolean);
    if (!objectType) return null;
    return {
        name: callee.memberName,
        qualifiedName: `${objectType.className}.${callee.memberName}`,
        filePath: objectType.filePath,
        method: 'ast_python_instance_method'
    };
}

function collectPythonClassMethods(symbols: IndexedSymbol[]): PythonClassMethodMap {
    const methods: PythonClassMethodMap = new Map();
    for (const symbol of symbols) {
        if (!symbol.qualified_name || !symbol.qualified_name.includes('.')) continue;
        const parts = symbol.qualified_name.split('.');
        const methodName = parts.pop()!;
        const className = parts.join('.');
        if (!methods.has(className)) methods.set(className, new Set());
        methods.get(className)!.add(methodName);
    }
    return methods;
}

function extractPythonClassBases(root: Parser.SyntaxNode, filePath: string, imports: PythonImportMap): PythonClassBaseMap {
    const bases: PythonClassBaseMap = new Map();

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'class_definition') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const classBases: Array<{ className: string; filePath: string }> = [];
                for (const baseName of pythonBaseNames(node)) {
                    const imported = imports.named.get(baseName) || imports.named.get(baseName.split('.').slice(-1)[0]);
                    classBases.push({
                        className: imported?.importedName || baseName.split('.').slice(-1)[0],
                        filePath: imported ? resolvePythonExportedTarget(imported.importedName, imported.sourceFilePath).filePath : filePath
                    });
                }
                bases.set(nameNode.text, classBases);
            }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(root);
    return bases;
}

function pythonBaseNames(classNode: Parser.SyntaxNode) {
    const header = classNode.text.split(':')[0];
    const match = header.match(/class\s+\w+\s*\(([^)]*)\)/);
    if (!match) return [];
    return match[1]
        .split(',')
        .map(base => base.trim())
        .filter(Boolean)
        .map(base => base.split(/\s+/)[0].replace(/\(.*$/, ''));
}

function resolvePythonSelfMethod(
    caller: IndexedSymbol,
    memberName: string | undefined,
    classMethods: PythonClassMethodMap,
    classBases: PythonClassBaseMap,
) {
    const currentClass = caller.qualified_name?.split('.').slice(0, -1).join('.');
    if (!currentClass || !memberName) return null;
    if (classMethods.get(currentClass)?.has(memberName)) {
        return {
            name: memberName,
            qualifiedName: `${currentClass}.${memberName}`,
            filePath: undefined,
            method: 'ast_python_self_method'
        };
    }
    const base = resolvePythonBaseMethod(currentClass, memberName, classMethods, classBases);
    if (!base) return null;
    return {
        name: memberName,
        qualifiedName: `${base.className}.${memberName}`,
        filePath: base.filePath,
        method: 'ast_python_inherited_self_method'
    };
}

function resolvePythonSuperMethod(
    caller: IndexedSymbol,
    memberName: string | undefined,
    classMethods: PythonClassMethodMap,
    classBases: PythonClassBaseMap,
) {
    const currentClass = caller.qualified_name?.split('.').slice(0, -1).join('.');
    if (!currentClass || !memberName) return null;
    const base = resolvePythonBaseMethod(currentClass, memberName, classMethods, classBases);
    if (!base) return null;
    return {
        name: memberName,
        qualifiedName: `${base.className}.${memberName}`,
        filePath: base.filePath,
        method: 'ast_python_super_method'
    };
}

function resolvePythonBaseMethod(
    className: string,
    memberName: string,
    classMethods: PythonClassMethodMap,
    classBases: PythonClassBaseMap,
    seen = new Set<string>()
): { className: string; filePath: string } | null {
    if (seen.has(className)) return null;
    seen.add(className);
    for (const base of classBases.get(className) || []) {
        if (classMethods.get(base.className)?.has(memberName) || pythonFileDeclaresClassMethod(base.filePath, base.className, memberName)) return base;
        const inherited = resolvePythonBaseMethod(base.className, memberName, classMethods, classBases, seen);
        if (inherited) return inherited;
    }
    return null;
}

function pythonFileDeclaresClassMethod(filePath: string | undefined, className: string, methodName: string) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const classPattern = new RegExp(`^(\\s*)class\\s+${escapeRegex(className)}\\b`);
    const methodPattern = new RegExp(`^\\s+(?:async\\s+def|def)\\s+${escapeRegex(methodName)}\\s*\\(`);
    let classIndent = -1;

    for (const line of lines) {
        const classMatch = line.match(classPattern);
        if (classMatch) {
            classIndent = classMatch[1].length;
            continue;
        }
        if (classIndent >= 0) {
            const indent = line.match(/^(\s*)/)?.[1].length || 0;
            if (line.trim() && indent <= classIndent) return false;
            if (methodPattern.test(line)) return true;
        }
    }
    return false;
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
        if (current.type === 'identifier' || current.type === 'property_identifier' || current.type === 'field_identifier') {
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
