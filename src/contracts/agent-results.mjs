export const MAX_AGENT_RESULT_ROWS = 200;
export const DEFAULT_AGENT_RESULT_ROWS = 100;
export const MAX_AGENT_RESULT_BYTES = 64 * 1024;

const id = { type: "string", minLength: 1, maxLength: 128 };
export const resultReadProperties = {
    documentId: id,
    connectionId: { type: "string", minLength: 1, maxLength: 512 },
    revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    runId: id,
    resultSetId: id,
    offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: "integer", minimum: 1, maximum: MAX_AGENT_RESULT_ROWS },
};
export const resultReadRequired = ["documentId", "connectionId", "revision", "runId", "resultSetId"];
