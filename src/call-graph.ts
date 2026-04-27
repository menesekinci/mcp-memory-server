import Parser from 'tree-sitter';

export type CallReference = {
    caller_symbol_id: string;
    target_name: string;
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

export function extractCallReferences(tree: Parser.Tree, symbols: IndexedSymbol[], filePath: string): CallReference[] {
    const calls: CallReference[] = [];

    function traverse(node: Parser.SyntaxNode) {
        if (node.type === 'call_expression' || node.type === 'new_expression') {
            const callee = extractCalleeName(node);
            const caller = findContainingSymbol(symbols, node.startPosition.row + 1);
            if (callee && caller && callee !== caller.name) {
                calls.push({
                    caller_symbol_id: caller.id,
                    target_name: callee,
                    file_path: filePath,
                    line: node.startPosition.row + 1,
                    confidence: 0.95,
                    resolution_method: 'ast_same_file_or_name'
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

function findContainingSymbol(symbols: IndexedSymbol[], line: number) {
    return symbols
        .filter(symbol => symbol.start_line <= line && symbol.end_line >= line)
        .sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0];
}

function extractCalleeName(node: Parser.SyntaxNode): string | null {
    const functionNode = node.childForFieldName('function') || node.namedChild(0);
    if (!functionNode) return null;

    if (functionNode.type === 'identifier') {
        return functionNode.text;
    }

    if (functionNode.type === 'member_expression') {
        const property = functionNode.childForFieldName('property');
        return property?.text || null;
    }

    if (functionNode.type === 'subscript_expression') {
        return null;
    }

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
