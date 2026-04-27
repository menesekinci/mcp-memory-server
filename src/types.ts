export type SymbolRow = {
    id: string;
    project_id: string;
    name: string;
    qualified_name: string;
    kind: string;
    file_path: string;
    start_line: number;
    end_line: number;
    signature: string | null;
    body: string | null;
    language: string;
    commit_sha: string | null;
    updated_at: number;
    is_deleted: number;
};

export type CountRow = {
    count: number;
};

export type MessageRow = {
    id: string;
    rowid: number;
    session_id: string;
    content: string;
    created_at: number;
};

export type SessionRow = {
    ended_at: number | null;
};

export type DecisionRow = {
    id: string;
    summary: string;
};

export type SymbolReference = {
    symbol_id: string;
    confidence: number;
    reference_type: 'mentioned' | 'modified' | 'explained' | 'debugged' | 'rejected' | 'approved';
    extraction_source: 'explicit_tool_call' | 'code_block' | 'natural_language' | 'agent_summary';
};
