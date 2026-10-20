import { fail } from "./policy.mjs";
import { BUNDLED_CONTEXT_VERSION, bundledKnowledgeRecords as modelKnowledgeRecords } from "./bundled-models.mjs";

export const CONTEXT_VERSION = BUNDLED_CONTEXT_VERSION;
export { modelKnowledgeRecords };
export const KNOWLEDGE_LIMITS = Object.freeze({ summaries: 10, searchBytes: 8 * 1024, getBytes: 24 * 1024 });
const identityKeys = ["workbenchId", "connectionId", "model", "generation", "contextVersion"];
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const boundedText = (value, max) => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
function validateIdentity(request, current) {
    if (!plain(request) || Object.keys(request).length !== identityKeys.length
        || identityKeys.some(key => !Object.hasOwn(request, key)
            || (["connectionId", "model"].includes(key) && request[key] === null ? false : !boundedText(request[key], 512))))
        throw fail("INVALID_KNOWLEDGE", "Use the complete knowledge identity from the current workbench snapshot or Context Lens.");
    if (identityKeys.some(key => request[key] !== current[key]))
        throw fail("KNOWLEDGE_IDENTITY_MISMATCH", "The workbench model or context generation changed. Read the current identity before looking up bundled knowledge.");
}
function validateRequest(payload, identity, keys) {
    if (!plain(payload) || Object.keys(payload).some(key => !keys.includes(key)))
        throw fail("INVALID_KNOWLEDGE", "Unsupported bundled-knowledge request fields.");
    validateIdentity(payload.identity, identity);
}
export function validateKnowledgeReferences(value) {
    if (!Array.isArray(value) || value.length > 10)
        throw fail("INVALID_LIBRARY", "At most ten knowledge references may be saved.");
    const ids = new Set();
    return value.map(ref => {
        if (!plain(ref) || Object.keys(ref).some(key => !["id", "version"].includes(key))
            || typeof ref.id !== "string" || !/^(?:note|starter):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref.id)
            || !Number.isSafeInteger(ref.version) || ref.version < 1 || ids.has(ref.id))
            throw fail("INVALID_LIBRARY", "Knowledge references require a unique bundled identifier and positive record version.");
        ids.add(ref.id);
        return { id: ref.id, version: ref.version };
    });
}
function summary(record, reason) {
    return { id: record.id, version: record.version, kind: record.kind, title: record.title, summary: record.summary, ...(reason ? { reason } : {}) };
}
export function searchKnowledge({ identity, connection }, payload) {
    validateRequest(payload, identity, ["identity", "query", "field"]);
    if (payload.query !== undefined && !boundedText(payload.query, 200))
        throw fail("INVALID_KNOWLEDGE", "Knowledge search is limited to 200 printable characters.");
    const field = payload.field;
    if (field !== undefined && (!plain(field) || Object.keys(field).some(key => !["kind", "table", "name"].includes(key))
        || !["column", "measure", "table"].includes(field.kind) || !boundedText(field.name, 200) || !field.name.trim()
        || (field.table !== undefined && (!boundedText(field.table, 200) || !field.table.trim()))))
        throw fail("INVALID_KNOWLEDGE", "Choose an exact table, column or measure reference.");
    const terms = (payload.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = modelKnowledgeRecords(connection).flatMap(record => {
        const exact = field && record.fields.some(ref => ref.kind === field.kind && ref.name === field.name && (ref.table ?? "") === (field.table ?? ""));
        const text = `${record.title} ${record.summary} ${record.body} ${record.query ?? ""}`.toLowerCase();
        const textMatch = terms.length && terms.every(term => text.includes(term));
        if (!exact && !textMatch && (field || terms.length)) return [];
        return [{ record, rank: exact ? 0 : textMatch ? 1 : 2, reason: exact ? "Exact field reference" : textMatch ? "Bundled text match" : "Available for the selected model" }];
    }).sort((a, b) => a.rank - b.rank || a.record.id.localeCompare(b.record.id, "en"));
    const result = { identity: structuredClone(identity), entries: [], omitted: false };
    for (const match of matches) {
        if (result.entries.length >= KNOWLEDGE_LIMITS.summaries) { result.omitted = true; break; }
        result.entries.push(summary(match.record, match.reason));
        if (bytes(result) > KNOWLEDGE_LIMITS.searchBytes) { result.entries.pop(); result.omitted = true; break; }
    }
    if (bytes(result) > KNOWLEDGE_LIMITS.searchBytes) throw fail("KNOWLEDGE_LIMIT", "Knowledge search identity exceeds the response budget.");
    return result;
}
export function getKnowledge({ identity, connection }, payload) {
    validateRequest(payload, identity, ["identity", "id", "version"]);
    if (!boundedText(payload.id, 136) || !payload.id.length
        || (payload.version !== undefined && (!Number.isSafeInteger(payload.version) || payload.version < 1)))
        throw fail("INVALID_KNOWLEDGE", "Use a bundled record identifier and an optional positive record version.");
    const record = modelKnowledgeRecords(connection, true).find(item => item.id === payload.id);
    if (!record) throw fail("KNOWLEDGE_NOT_FOUND", "This bundled record is unavailable for the selected model. Saved queries are not knowledge records.");
    if (payload.version !== undefined && payload.version > record.version)
        throw fail("KNOWLEDGE_VERSION_NOT_FOUND", "The requested bundled revision is unavailable; no content was substituted.");
    const result = {
        identity: structuredClone(identity), ...summary(record), body: record.body,
        caveats: [...record.caveats], unknowns: [...record.unknowns], provenance: [...record.provenance],
        referenceStatus: payload.version !== undefined && payload.version < record.version ? "older" : "current",
        ...(payload.version !== undefined ? { requestedVersion: payload.version } : {}),
        ...(record.knowledgeRefs ? { knowledgeRefs: validateKnowledgeReferences(record.knowledgeRefs) } : {}),
        ...(record.query ? { query: record.query } : {}),
        ...(record.builder ? { builder: structuredClone(record.builder) } : {}),
    };
    if (result.referenceStatus === "older")
        result.caveats.push(`Reference revision ${payload.version} is older. This is current revision ${record.version}; the historical revision body is unavailable.`);
    if (bytes(result) > KNOWLEDGE_LIMITS.getBytes) throw fail("KNOWLEDGE_LIMIT", "This bundled record exceeds the response budget; no partial record was returned.");
    return result;
}
