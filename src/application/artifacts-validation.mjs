import { fail, requireId } from "./policy.mjs";
import { validateResearchSession } from "./research.mjs";
import { researchSessionSchema } from "../contracts/research.mjs";
import { chartConfigSchema, validateChartConfig } from "../shared/chart-data.mjs";

export const ARTIFACT_LIMITS = Object.freeze({
    maxFileBytes: 64 * 1024 * 1024, maxEntries: 2000, indexBytes: 1024 * 1024,
    textBytes: 192 * 1024, visualBytes: 192 * 1024, rows: 2000, columns: 64,
});
export const artifactIdPattern = "^artifact:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$";
export const payloadIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const managedKinds = ["note", "visual", "image", "presentation", "document", "spreadsheet", "pdf", "text", "file"];
export function artifactObject(value, allowed, required = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
        throw fail("INVALID_ARTIFACT", "Use only the supported artifact fields, including all required fields.");
}
export function artifactText(value, label, max, { empty = false, multiline = false } = {}) {
    if (typeof value !== "string" || value.length > max || (!empty && !value.trim())
        || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\p{Cc}\p{Cf}]/u).test(value))
        throw fail("INVALID_ARTIFACT", `${label} must be ${empty ? "" : "nonempty "}text of at most ${max} characters.`);
    return value;
}
export function artifactId(value) {
    if (typeof value !== "string" || !new RegExp(artifactIdPattern).test(value))
        throw fail("INVALID_ARTIFACT", "Use a managed artifact identifier from this workspace.");
    return value;
}
export function artifactRevision(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
        throw fail("INVALID_ARTIFACT", "Artifact revisions must be nonnegative safe integers.");
    return value;
}
export function artifactCollection(library, id) {
    if (typeof id !== "string" || !library.collections.some(item => item.source === "saved" && item.id === id))
        throw fail("LIBRARY_COLLECTION_NOT_FOUND", "Choose an existing saved business folder. Folders support 100 collections and four levels.");
    return id;
}
export function artifactResearch(library, id) {
    if (typeof id !== "string" || !/^saved:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
        || !library.entries.some(entry => entry.id === id && entry.analysis))
        throw fail("RESEARCH_ENTRY_NOT_FOUND", "Use a known existing saved research identifier. Its private contents are not returned.");
    return id;
}
export function noteText(value) {
    artifactText(value, "Markdown", ARTIFACT_LIMITS.textBytes, { multiline: true, empty: true });
    if (Buffer.byteLength(value, "utf8") > ARTIFACT_LIMITS.textBytes)
        throw fail("ARTIFACT_TOO_LARGE", "Markdown notes support at most 192 KiB of UTF-8 text.");
    return value;
}
export function validateVisual(value) {
    artifactObject(value, ["version", "config", "columns", "rows", "provenance"], ["version", "config", "columns", "rows", "provenance"]);
    if (value.version !== 1 || !Array.isArray(value.columns) || !value.columns.length || value.columns.length > ARTIFACT_LIMITS.columns
        || !Array.isArray(value.rows) || value.rows.length > ARTIFACT_LIMITS.rows)
        throw fail("INVALID_ARTIFACT", "Visuals require version 1, 1–64 columns and at most 2,000 rows. Rows are never silently sampled.");
    const ids = new Set();
    for (const column of value.columns) {
        artifactObject(column, ["id", "name", "dataType", "formatString"], ["id", "name", "dataType"]);
        artifactText(column.id, "Column identifier", 512); artifactText(column.name, "Column name", 512);
        artifactText(column.dataType, "Column type", 80);
        if (column.formatString !== undefined) artifactText(column.formatString, "Format string", 512, { empty: true });
        if (ids.has(column.id)) throw fail("INVALID_ARTIFACT", "Visual column identifiers must be unique.");
        ids.add(column.id);
    }
    validateChartConfig(value.config, "INVALID_ARTIFACT");
    if (!ids.has(value.config.x) || value.config.aggregation !== "count" && !ids.has(value.config.y)
        || value.config.legend && !ids.has(value.config.legend) || value.config.filters?.some(filter => !ids.has(filter.column)))
        throw fail("INVALID_ARTIFACT", "Chart axes, legend and filters must reference existing captured columns.");
    for (const row of value.rows) {
        if (!Array.isArray(row) || row.length !== value.columns.length)
            throw fail("INVALID_ARTIFACT", "Every visual row must match the column count.");
        for (const cell of row) {
            if (cell !== null && typeof cell !== "string" && typeof cell !== "boolean" && !(typeof cell === "number" && Number.isFinite(cell)))
                throw fail("INVALID_ARTIFACT", "Visual cells must be exact strings, finite numbers, booleans or null.");
            if (typeof cell === "string" && (cell.length > 32768 || /\u0000/u.test(cell)))
                throw fail("INVALID_ARTIFACT", "Visual strings must be bounded and contain no NUL characters.");
        }
    }
    artifactObject(value.provenance, ["description", "runId", "resultSetId", "queryRevision", "truncated", "approximate"], ["description", "truncated", "approximate"]);
    artifactText(value.provenance.description, "Provenance description", 2000, { multiline: true, empty: true });
    for (const key of ["runId", "resultSetId"]) if (value.provenance[key] !== undefined) artifactText(value.provenance[key], key, 128);
    if (value.provenance.queryRevision !== undefined) artifactRevision(value.provenance.queryRevision);
    if (typeof value.provenance.truncated !== "boolean" || typeof value.provenance.approximate !== "boolean")
        throw fail("INVALID_ARTIFACT", "Visual provenance requires explicit truncation and approximation flags.");
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > ARTIFACT_LIMITS.visualBytes)
        throw fail("ARTIFACT_TOO_LARGE", "A visual's complete typed JSON must fit within 192 KiB; no silent sampling is performed.");
    return structuredClone(value);
}
export function validateArtifactCreate(value, library) {
    artifactObject(value, ["expectedRevision", "collectionId", "title", "description", "kind", "text", "visual", "researchEntryId", "session"],
        ["expectedRevision", "collectionId", "title", "kind"]);
    artifactRevision(value.expectedRevision); artifactCollection(library, value.collectionId);
    artifactText(value.title, "Title", 120);
    artifactText(value.description ?? "", "Description", 500, { empty: true, multiline: true });
    if (!["note", "visual"].includes(value.kind) || (value.kind === "note" ? value.visual !== undefined : value.text !== undefined))
        throw fail("INVALID_ARTIFACT", "Create a Markdown note or typed visual with only its matching payload.");
    const result = { ...structuredClone(value), description: value.description ?? "" };
    if (value.kind === "note") result.text = noteText(value.text);
    else result.visual = validateVisual(value.visual);
    if (value.researchEntryId != null) artifactResearch(library, value.researchEntryId);
    if (value.researchEntryId === null) delete result.researchEntryId;
    if (value.session !== undefined) result.session = validateResearchSession(value.session);
    return result;
}
export function validateArtifactUpdate(value, library) {
    artifactObject(value, ["id", "expectedRevision", "title", "description", "collectionId", "archived", "researchEntryId", "session", "text"], ["id", "expectedRevision"]);
    artifactId(value.id); artifactRevision(value.expectedRevision);
    if (value.title !== undefined) artifactText(value.title, "Title", 120);
    if (value.description !== undefined) artifactText(value.description, "Description", 500, { empty: true, multiline: true });
    if (value.collectionId !== undefined) artifactCollection(library, value.collectionId);
    if (value.researchEntryId != null) artifactResearch(library, value.researchEntryId);
    if (value.text !== undefined) noteText(value.text);
    if (value.archived !== undefined && typeof value.archived !== "boolean") throw fail("INVALID_ARTIFACT", "Archived must be a boolean.");
    return { ...structuredClone(value), ...(value.session === undefined ? {} : { session: validateResearchSession(value.session) }) };
}
const text = maxLength => ({ type: "string", maxLength });
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
export const visualSchema = object({
    version: { const: 1 },
    config: chartConfigSchema,
    columns: { type: "array", minItems: 1, maxItems: 64, items: object({ id: text(512), name: text(512), dataType: text(80), formatString: text(512) }, ["id", "name", "dataType"]) },
    rows: { type: "array", maxItems: 2000, items: { type: "array", maxItems: 64, items: { type: ["string", "number", "boolean", "null"], maxLength: 32768 } } },
    provenance: object({ description: text(2000), runId: text(128), resultSetId: text(128), queryRevision: integer, truncated: { type: "boolean" }, approximate: { type: "boolean" } },
        ["description", "truncated", "approximate"]),
});
export const saveArtifactProperties = {
    documentId: { ...text(128), minLength: 1 }, connectionId: { ...text(512), minLength: 1 },
    revision: integer, builderRevision: integer, libraryRevision: integer, artifactsRevision: integer,
    collectionPath: { type: "array", minItems: 1, maxItems: 4, items: { ...text(80), minLength: 1 } },
    title: { ...text(120), minLength: 1 }, description: text(500),
    kind: { enum: ["note", "visual"] }, text: text(ARTIFACT_LIMITS.textBytes), visual: visualSchema,
    researchEntryId: { type: ["string", "null"], pattern: "^saved:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }, session: researchSessionSchema,
};
export const saveArtifactRequired = ["documentId", "connectionId", "revision", "builderRevision", "libraryRevision", "artifactsRevision", "collectionPath", "title", "kind"];
export function validateSaveArtifact(value) {
    artifactObject(value, Object.keys(saveArtifactProperties), saveArtifactRequired);
    requireId(value.documentId); artifactText(value.connectionId, "Connection identity", 512);
    for (const key of ["revision", "builderRevision", "libraryRevision", "artifactsRevision"]) artifactRevision(value[key]);
    if (!Array.isArray(value.collectionPath) || !value.collectionPath.length || value.collectionPath.length > 4)
        throw fail("INVALID_ARTIFACT", "Use a saved collection path of one to four names; existing library folder limits apply.");
    value.collectionPath.forEach(name => artifactText(name, "Folder name", 80));
    return structuredClone(value);
}
