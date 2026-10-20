export const previewGuardProperties = {
    documentId: { type: "string", minLength: 1, maxLength: 128 },
    connectionId: { type: "string", minLength: 1, maxLength: 512 },
    revision: { type: "integer", minimum: 0 },
};
export const queryPreviewProperties = {
    ...previewGuardProperties,
    title: { type: "string", minLength: 1, maxLength: 120 },
    query: { type: "string", minLength: 1, maxLength: 100000 },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 120, description: "Default 60 seconds; always clamped to the person's current query timeout." },
};
export const queryPreviewRequired = ["documentId", "connectionId", "revision", "title", "query"];
export const queryPreviewStatusProperties = {
    ...previewGuardProperties,
    runId: { type: "string", minLength: 1, maxLength: 128 },
    waitSeconds: { type: "integer", minimum: 0, maximum: 20, description: "Optional bounded wait for completion. Returns metadata only, never result values." },
    includeDiagnostics: { type: "boolean", description: "For requested troubleshooting only: explicitly read at most 2,000 characters of the known preview's local provider error. Requires enabled result-analysis access; no rows or private dashboard errors." },
};
export const queryPreviewStatusRequired = ["documentId", "connectionId", "revision", "runId"];
