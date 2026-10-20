import { createHash, randomUUID } from "node:crypto";
import { fail, requireId } from "./policy.mjs";
import { researchProperties, researchRequired, appendResearchProperties, appendResearchRequired } from "../contracts/research.mjs";

function object(value, keys, required = keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
        throw fail("INVALID_RESEARCH", "Use the complete supported research fields; additional or missing fields are not allowed.");
}
function text(value, max, empty = true) {
    if (typeof value !== "string" || value.length > max || (!empty && !value.trim())
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
        throw fail("INVALID_RESEARCH", `Research text must be ${empty ? "" : "non-empty "}plain text of at most ${max} characters.`);
    return value;
}
function integer(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw fail("INVALID_RESEARCH", "Research revisions and row counts must be nonnegative safe integers.");
}
function timestamp(value) {
    text(value, 30, false);
    if (!Number.isFinite(Date.parse(value))) throw fail("INVALID_RESEARCH", "Research timestamps must be valid dates.");
}
function fingerprint(value) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw fail("INVALID_RESEARCH", "Invalid research query fingerprint.");
}
const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function queryFingerprint(document) {
    return createHash("sha256").update(JSON.stringify(canonical({
        connectionId: document.connectionId, query: document.query, parameters: document.parameters ?? {},
        parameterDefinitions: document.parameterDefinitions ?? null,
    }))).digest("hex");
}
export function researchContentVersion(entry) {
    return createHash("sha256").update(JSON.stringify(canonical({
        connectionId: entry.connectionId ?? null, model: entry.model ?? null, query: entry.query, parameters: entry.parameters ?? {},
        parameterDefinitions: entry.parameterDefinitions ?? null, builder: entry.builder ?? null, builderImport: entry.builderImport ?? null,
        documentation: entry.documentation ?? "", analysis: entry.analysis ?? null, notes: entry.notes ?? [],
    }))).digest("hex");
}
export function validateResearchRequest(value) {
    object(value, Object.keys(researchProperties), researchRequired);
    requireId(value.documentId); text(value.connectionId, 512, false);
    for (const key of ["revision", "builderRevision", "libraryRevision"]) integer(value[key]);
    if (!Array.isArray(value.collectionPath) || value.collectionPath.length < 1 || value.collectionPath.length > 4)
        throw fail("INVALID_RESEARCH", "Choose a collection path with one to four folder names.");
    value.collectionPath.forEach(name => text(name, 80, false));
    for (const key of ["title", "description", "documentation"]) text(value[key], researchProperties[key].maxLength, key !== "title");
    object(value.analysis, ["question", "content", "limitations"]);
    text(value.analysis.question, 500, false); text(value.analysis.content, 16384, false); text(value.analysis.limitations, 4000);
    if (!Array.isArray(value.runIds) || value.runIds.length > 20 || new Set(value.runIds).size !== value.runIds.length)
        throw fail("INVALID_RESEARCH", "Reference at most twenty distinct run identifiers.");
    value.runIds.forEach(requireId);
    return { ...structuredClone(value), ...(value.session === undefined ? {} : { session: validateResearchSession(value.session) }) };
}
export function validateResearchSession(value) {
    object(value, ["id", "title"]);
    for (const [key, max] of [["id", 128], ["title", 120]]) {
        text(value[key], max, false);
        if (/[\p{Cc}\p{Cf}]/u.test(value[key])) throw fail("INVALID_RESEARCH", "Session labels must be printable single-line text.");
    }
    return { id: value.id.trim(), title: value.title.trim() };
}
export function validateAppendResearch(value) {
    object(value, Object.keys(appendResearchProperties), appendResearchRequired);
    if (typeof value.entryId !== "string" || !/^saved:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.entryId))
        throw fail("INVALID_RESEARCH", "Use a known saved research identifier from a previous save or an explicitly shared artifact.");
    requireId(value.documentId); text(value.connectionId, 512, false);
    for (const key of ["revision", "builderRevision", "libraryRevision"]) integer(value[key]);
    text(value.content, 4000, false);
    return { ...structuredClone(value), ...(value.session === undefined ? {} : { session: validateResearchSession(value.session) }) };
}
export function validateResearchNotes(value) {
    if (!Array.isArray(value) || value.length > 50 || new Set(value.map(note => note?.id)).size !== value.length)
        throw fail("INVALID_RESEARCH", "A research artifact can keep at most fifty distinct journal notes.");
    return value.map(note => {
        object(note, ["id", "author", "createdAt", "content", "session", "correctionOf"], ["id", "author", "createdAt", "content"]);
        requireId(note.id); timestamp(note.createdAt); text(note.content, 4000, false);
        if (!["human", "copilot"].includes(note.author)) throw fail("INVALID_RESEARCH", "Unknown research note author.");
        if (note.correctionOf !== undefined && !value.slice(0, value.indexOf(note)).some(prior => prior.id === note.correctionOf))
            throw fail("INVALID_RESEARCH", "A journal correction must reference an earlier note in the same artifact.");
        return { id: note.id, author: note.author, createdAt: note.createdAt, content: note.content,
            ...(note.correctionOf === undefined ? {} : { correctionOf: note.correctionOf }),
            ...(note.session === undefined ? {} : { session: validateResearchSession(note.session) }) };
    });
}
export function createResearchNote(content, author, session) {
    return validateResearchNotes([{ id: randomUUID(), author, createdAt: new Date().toISOString(), content,
        ...(session === undefined ? {} : { session }) }])[0];
}
export function validateSavedAnalysis(value) {
    object(value, ["version", "author", "createdAt", "question", "content", "limitations", "source", "evidence"]);
    if (value.version !== 1 || value.author !== "copilot") throw fail("INVALID_RESEARCH", "Unsupported saved Copilot analysis.");
    timestamp(value.createdAt);
    text(value.question, 500, false); text(value.content, 16384, false); text(value.limitations, 4000);
    object(value.source, ["documentId", "revision", "builderRevision", "connectionId", "queryFingerprint"]);
    requireId(value.source.documentId); integer(value.source.revision); integer(value.source.builderRevision);
    text(value.source.connectionId, 512, false); fingerprint(value.source.queryFingerprint);
    if (!Array.isArray(value.evidence) || value.evidence.length > 20 || new Set(value.evidence.map(item => item?.runId)).size !== value.evidence.length)
        throw fail("INVALID_RESEARCH", "Saved analysis has invalid run evidence.");
    for (const run of value.evidence) {
        object(run, ["runId", "revision", "status", "startedAt", "durationMs", "rowCount", "truncated", "queryFingerprint", "metadataFingerprint", "connectionKind", "querySource"]);
        requireId(run.runId); integer(run.revision); timestamp(run.startedAt); integer(run.rowCount);
        if (!["completed", "failed", "cancelled", "interrupted"].includes(run.status)
            || !Number.isFinite(run.durationMs) || run.durationMs < 0 || run.durationMs > Number.MAX_SAFE_INTEGER
            || typeof run.truncated !== "boolean" || !["editor", "builder"].includes(run.querySource))
            throw fail("INVALID_RESEARCH", "Saved analysis requires bounded terminal run metadata.");
        text(run.connectionKind, 80, false); fingerprint(run.queryFingerprint);
        if (run.metadataFingerprint !== null) fingerprint(run.metadataFingerprint);
    }
    return structuredClone(value);
}
export function captureAnalysis(input, document, runs, runIds) {
    const evidence = runIds.map(id => {
        const run = runs.find(item => item.id === id);
        if (!run || run.documentId !== document.id || run.connectionId !== document.connectionId)
            throw fail("RESEARCH_RUN_MISMATCH", "Each evidence run must belong to this active document and connection.");
        if (!["completed", "failed", "cancelled", "interrupted"].includes(run.status))
            throw fail("RESEARCH_RUN_PENDING", "Finish or cancel the referenced run before saving its evidence.");
        return {
            runId: run.id, revision: run.revision, status: run.status, startedAt: run.startedAt,
            durationMs: run.durationMs, rowCount: run.rowCount, truncated: run.truncated,
            queryFingerprint: run.sourceQueryFingerprint ?? queryFingerprint({ ...run, query: run.templateQuery ?? run.query }),
            metadataFingerprint: run.metadataFingerprint ?? null,
            connectionKind: run.connectionKind, querySource: run.querySource ?? "editor",
        };
    });
    return validateSavedAnalysis({
        version: 1, author: "copilot", createdAt: new Date().toISOString(), ...input,
        source: { documentId: document.id, revision: document.revision, builderRevision: document.builderRevision ?? 0,
            connectionId: document.connectionId, queryFingerprint: queryFingerprint(document) },
        evidence,
    });
}
export const analysisIsStale = entry => Boolean(entry.analysis && entry.analysis.source.queryFingerprint !== queryFingerprint(entry));
export function sharedAnalysisProjection(entry) {
    const { source, evidence, ...content } = entry.analysis;
    const { queryFingerprint: _sourceFingerprint, ...safeSource } = source;
    const projection = {
        entryId: entry.id, title: entry.title, stale: analysisIsStale(entry), ...content, source: safeSource,
        ...(entry.contentHistory?.some(item => item.field === "analysis") ? { textRevised: true } : {}),
        evidence: evidence.map(({ queryFingerprint: _fingerprint, ...run }) => run),
        ...(entry.session ? { session: structuredClone(entry.session) } : {}),
    };
    const budget = 64 * 1024 - 256;
    let bytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
    if (bytes > budget) throw fail("RESEARCH_SHARE_LIMIT", "This analysis exceeds the 64 KiB context-sharing limit. Share a shorter analysis instead; the local artifact is unchanged.");
    if (entry.notes?.length) {
        projection.notes = [];
        for (const note of [...entry.notes].reverse()) {
            const nextBytes = Buffer.byteLength(JSON.stringify(note), "utf8") + 1;
            if (projection.notes.length >= 10 || bytes + nextBytes > budget) break;
            projection.notes.unshift(structuredClone(note)); bytes += nextBytes;
        }
        projection.omittedNotes = entry.notes.length - projection.notes.length;
    }
    return projection;
}
