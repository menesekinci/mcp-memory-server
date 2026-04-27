import db from './db';
import { v4 as uuidv4 } from 'uuid';

export async function resolveSymbolReferences(content, explicitSymbols = []) {
    const references = [];

    // Stage 1: Explicit Tool Calls
    for (const symName of explicitSymbols) {
        const symbol = db.prepare("SELECT id, name FROM symbols WHERE name = ? LIMIT 1").get(symName);
        if (symbol) {
            references.push({
                symbol_id: symbol.id,
                confidence: 1.0,
                reference_type: 'mentioned',
                extraction_source: 'explicit_tool_call'
            });
        }
    }

    // Stage 2: Code Block Extraction
    const codeBlockRegex = /```[\s\S]*?```/g;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
        const blockContent = match[0];
        const words = blockContent.split(/[^a-zA-Z0-9_]/);
        for (const word of words) {
            if (word.length < 3) continue;
            const symbol = db.prepare("SELECT id, name FROM symbols WHERE name = ? LIMIT 1").get(word);
            if (symbol) {
                references.push({
                    symbol_id: symbol.id,
                    confidence: 0.85,
                    reference_type: 'mentioned',
                    extraction_source: 'code_block'
                });
            }
        }
    }

    // Stage 3: Natural Language Extraction (Fuzzy)
    const allSymbols = db.prepare("SELECT id, name FROM symbols").all();
    for (const sym of allSymbols) {
        // Avoid duplicates from previous stages
        if (references.some(r => r.symbol_id === sym.id)) continue;

        if (content.includes(sym.name)) {
            references.push({
                symbol_id: sym.id,
                confidence: 0.6,
                reference_type: 'mentioned',
                extraction_source: 'natural_language'
            });
        }
    }

    // Deduplicate and keep highest confidence
    const uniqueRefs = new Map();
    for (const ref of references) {
        const existing = uniqueRefs.get(ref.symbol_id);
        if (!existing || ref.confidence > existing.confidence) {
            uniqueRefs.set(ref.symbol_id, ref);
        }
    }

    return Array.from(uniqueRefs.values());
}
