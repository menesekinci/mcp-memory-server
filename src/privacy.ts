export function bodyStorageEnabled() {
    return !isTruthyEnv(process.env.MCP_MEMORY_DISABLE_BODY_STORAGE);
}

export function bodyUnavailableReason() {
    return bodyStorageEnabled() ? 'body_not_stored' : 'body_storage_disabled';
}

function isTruthyEnv(value: string | undefined) {
    return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}
