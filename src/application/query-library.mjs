import { randomUUID, createHash } from "node:crypto";
import { contentHistoryReferences } from "./content-history.mjs";
import { fail, requireId, validateParameters } from "./policy.mjs";
import { validateBuilderDraft } from "../integrations/query-builder.mjs";
import { normalizeBuilderImport } from "../integrations/libraries.mjs";
import { bundledStarterLibrary, legacyStarterEntries } from "./bundled-models.mjs";
import { validateKnowledgeReferences } from "./model-context.mjs";
import { analysisIsStale, validateSavedAnalysis, validateResearchSession, validateResearchNotes, createResearchNote, researchContentVersion } from "./research.mjs";
import { DOCUMENTATION_REVIEW_LIMITS } from "../shared/documentation-review.mjs";
import { summarizeWriting } from "../shared/writing.mjs";

// Embedded in the encrypted schemaVersion:1 workbench record (native limit: 1.5 MB).
export const LIBRARY_LIMITS = Object.freeze({
    bytes: 512 * 1024, entries: 200, collections: 100, depth: 4,
    title: 120, collectionName: 80, description: 500, documentation: 16_384, query: 100_000,
});
const documentationTextSchema = { type: "string", maxLength: LIBRARY_LIMITS.documentation };
const descriptionTextSchema = { type: "string", maxLength: LIBRARY_LIMITS.description };
const documentationRevisionSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
export const reviseDocumentationProperties = {
    documentId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    connectionId: { type: "string", minLength: 1, maxLength: 512 },
    revision: documentationRevisionSchema, builderRevision: documentationRevisionSchema, libraryRevision: documentationRevisionSchema,
    entryTitle: { type: "string", minLength: 1, maxLength: LIBRARY_LIMITS.title },
    expectedDocumentation: documentationTextSchema, documentation: documentationTextSchema,
    expectedDescription: descriptionTextSchema, description: descriptionTextSchema,
};
export const reviseDocumentationRequired = [
    "documentId", "connectionId", "revision", "builderRevision", "libraryRevision", "entryTitle", "expectedDocumentation", "documentation",
];
export const documentationConflict = () => fail("REVISION_CONFLICT",
    "The requested documentation could not be matched safely. Confirm the shared title, original text and fresh context before retrying; no saved content was changed.");
const starterCollections = [
    { id: "starter:getting-started", name: "Getting started", parentId: null, source: "starter" },
    { id: "starter:shaping-data", name: "Shaping data", parentId: null, source: "starter" },
    { id: "starter:calculations", name: "Calculations", parentId: null, source: "starter" },
];
const illustrative = "Synthetic, illustrative constant data only. No model tables or measures are referenced. Opening this example does not execute it; choose a connection and explicitly Run to evaluate it.\n\n";
const starters = [
    {
        id: "starter:row", title: "Your first result row", collectionId: "starter:getting-started",
        description: "Return named values in a single synthetic row.",
        query: 'EVALUATE\nROW("Message", "Hello DAX", "Example amount", 42)',
        documentation: illustrative + "EVALUATE returns a table. ROW creates a one-row table from pairs of column names and scalar expressions. Change the labels or constants to experiment.",
    },
    {
        id: "starter:datatable", title: "Create a small table", collectionId: "starter:getting-started",
        description: "Declare a typed table using three illustrative products.",
        query: 'EVALUATE\nDATATABLE(\n    "Product", STRING,\n    "Units", INTEGER,\n    { { "Alpha", 12 }, { "Beta", 8 }, { "Gamma", 20 } }\n)',
        documentation: illustrative + "DATATABLE declares column names, DAX types and constant rows. Each row must supply a value for every column. These product names are examples, not model entities.",
    },
    {
        id: "starter:filter", title: "Filter illustrative rows", collectionId: "starter:shaping-data",
        description: "Keep only synthetic products with at least ten units.",
        query: 'EVALUATE\nFILTER(\n    DATATABLE("Product", STRING, "Units", INTEGER,\n        { { "Alpha", 12 }, { "Beta", 8 }, { "Gamma", 20 } }),\n    [Units] >= 10\n)',
        documentation: illustrative + "FILTER tests an expression for each row of its input table. This example keeps rows with Units >= 10. It does not create a filter on any semantic-model table.",
    },
    {
        id: "starter:divide", title: "Calculate a safe ratio", collectionId: "starter:calculations",
        description: "Add a calculated unit price, including a zero-denominator example.",
        query: 'EVALUATE\nADDCOLUMNS(\n    DATATABLE("Product", STRING, "Amount", INTEGER, "Units", INTEGER,\n        { { "Alpha", 120, 12 }, { "Beta", 80, 0 } }),\n    "Unit price", DIVIDE([Amount], [Units])\n)',
        documentation: illustrative + "ADDCOLUMNS evaluates an expression for each input row without removing the original columns. DIVIDE returns BLANK when the denominator is zero unless an alternate result is supplied. BLANK is not the same as zero.",
    },
    {
        id: "starter:topn", title: "Rank and order rows", collectionId: "starter:shaping-data",
        description: "Select the top two synthetic products and order the output explicitly.",
        query: 'EVALUATE\nTOPN(\n    2,\n    DATATABLE("Product", STRING, "Units", INTEGER,\n        { { "Alpha", 12 }, { "Beta", 8 }, { "Gamma", 20 } }),\n    [Units], DESC, [Product], ASC\n)\nORDER BY [Units] DESC, [Product] ASC',
        documentation: illustrative + "TOPN selects rows, but does not guarantee their output order. ORDER BY sorts the returned table. The Product tie-breaker makes selection deterministic for these unique example names; without it, ties can return more than N rows.",
    },
    {
        id: "starter:calendar", title: "Build an illustrative calendar", collectionId: "starter:calculations",
        description: "Generate a fixed week of dates with calculated year and month columns.",
        query: 'EVALUATE\nADDCOLUMNS(\n    CALENDAR(DATE(2026, 1, 1), DATE(2026, 1, 7)),\n    "Year", YEAR([Date]),\n    "Month number", MONTH([Date])\n)\nORDER BY [Date] ASC',
        documentation: illustrative + "CALENDAR returns an inclusive range with a Date column. ADDCOLUMNS adds calendar attributes evaluated per date. This fixed example is not a fiscal calendar and creates no persistent model objects.",
    },
].map(entry => ({ ...entry, source: "starter" }));
const clone = value => structuredClone(value);
const object = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("INVALID_LIBRARY", `${label} must be an object.`);
    return value;
};
function text(value, label, max, { empty = false, multiline = false } = {}) {
    if (typeof value !== "string" || value.length > max || (!empty && !value.trim())
        || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\p{Cc}\p{Cf}]/u).test(value))
        throw fail("INVALID_LIBRARY", `${label} must be ${empty ? "" : "non-empty "}text of at most ${max} characters.`);
    return value;
}
function identifier(value, source = "saved") {
    if (typeof value !== "string" || !new RegExp(`^${source}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`).test(value))
        throw fail("INVALID_LIBRARY", "Invalid library identifier.");
    return value;
}
function collectionName(value) {
    const name = text(value, "Collection name", LIBRARY_LIMITS.collectionName).trim().normalize("NFC");
    if (/[\\/<>:"|?*]/.test(name) || name === "." || name === ".." || name.endsWith("."))
        throw fail("INVALID_LIBRARY", "Collection names cannot contain path separators or reserved path characters.");
    return name;
}
function revision(library, expected) {
    if (!Number.isSafeInteger(expected) || expected < 0 || expected !== library.revision || expected >= Number.MAX_SAFE_INTEGER)
        throw fail("REVISION_CONFLICT", "The query library changed. Reload its catalog before saving.");
}
function bounded(library) {
    if (library.entries.length > LIBRARY_LIMITS.entries || library.collections.length > LIBRARY_LIMITS.collections
        || Buffer.byteLength(JSON.stringify(library), "utf8") > LIBRARY_LIMITS.bytes)
        throw fail("LIBRARY_LIMIT", "The query library supports at most 200 saved queries, 100 collections and 512 KiB of saved content.");
}
function checkCollections(collections) {
    const byId = new Map(), siblings = new Set();
    for (const collection of collections) {
        if (byId.has(collection.id)) throw fail("INVALID_LIBRARY", "Duplicate collection identifier.");
        byId.set(collection.id, collection);
        const key = JSON.stringify([collection.parentId, collection.name.toLowerCase()]);
        if (siblings.has(key)) throw fail("DUPLICATE_COLLECTION", "A collection with this name already exists in that folder.");
        siblings.add(key);
    }
    for (const collection of collections) {
        let current = collection, depth = 0;
        const seen = new Set();
        while (current) {
            if (seen.has(current.id) || ++depth > LIBRARY_LIMITS.depth)
                throw fail("LIBRARY_DEPTH", "Collections may be nested at most four levels deep.");
            seen.add(current.id);
            if (current.parentId === null) break;
            current = byId.get(current.parentId);
            if (!current) throw fail("LIBRARY_COLLECTION_NOT_FOUND", "Choose an existing saved collection as the parent.");
        }
    }
}
export function parameterDefinitions(value) {
    object(value, "Parameter definitions");
    if (Object.keys(value).length > 100) throw fail("INVALID_PARAMETERS", "At most 100 parameter definitions may be saved.");
    const definitions = {};
    for (const [name, input] of Object.entries(value)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
            throw fail("INVALID_PARAMETERS", "Invalid parameter name.");
        object(input, "Parameter definition");
        const type = text(input.type, "Parameter type", 20);
        if (!["text", "number", "date", "boolean", "list[text]"].includes(type))
            throw fail("INVALID_PARAMETERS", "Unsupported parameter type.");
        const definition = { type };
        if (input.required !== undefined) {
            if (typeof input.required !== "boolean") throw fail("INVALID_PARAMETERS", "Parameter required must be boolean.");
            definition.required = input.required;
        }
        if (input.description !== undefined) definition.description = text(input.description, "Parameter description", 16_384, { empty: true, multiline: true });
        if (input.default !== undefined) {
            validateParameters({ value: input.default }, true);
            definition.default = clone(input.default);
        }
        if (input.allowed_values !== undefined) {
            if (!Array.isArray(input.allowed_values) || input.allowed_values.length > 200)
                throw fail("INVALID_PARAMETERS", "Parameter allowed values must be a bounded array.");
            for (const item of input.allowed_values) validateParameters({ value: item });
            definition.allowed_values = clone(input.allowed_values);
        }
        definitions[name] = definition;
    }
    return definitions;
}
export const reusableQueryHash = entry => createHash("sha256").update(JSON.stringify({
    query: entry.query, parameters: entry.parameters ?? {}, parameterDefinitions: entry.parameterDefinitions ?? null,
    connectionId: entry.connectionId ?? null, model: entry.model ?? null,
})).digest("hex");
function savedEntry(input) {
    object(input, "Saved query");
    const entry = {
        id: identifier(input.id), source: "saved",
        title: text(input.title, "Query title", LIBRARY_LIMITS.title).trim(),
        description: text(input.description, "Description", LIBRARY_LIMITS.description, { empty: true, multiline: true }),
        collectionId: identifier(input.collectionId),
        query: text(input.query, "Query", LIBRARY_LIMITS.query, { empty: true, multiline: true }),
        // Documentation is plain text, never HTML or an executable template.
        documentation: text(input.documentation, "Documentation", LIBRARY_LIMITS.documentation, { empty: true, multiline: true }),
        parameters: clone(validateParameters(input.parameters ?? {}, !!input.parameterDefinitions)),
        updatedAt: text(input.updatedAt, "Save timestamp", 30),
    };
    if (!Number.isFinite(Date.parse(entry.updatedAt))) throw fail("INVALID_LIBRARY", "Invalid save timestamp.");
    if (input.connectionId) entry.connectionId = text(input.connectionId, "Connection identity", 512);
    if (input.connectionName) entry.connectionName = text(input.connectionName, "Connection name", 200);
    if (input.model) entry.model = text(input.model, "Model identity", 512);
    if (input.knowledgeRefs !== undefined) entry.knowledgeRefs = validateKnowledgeReferences(input.knowledgeRefs);
    if (input.analysis !== undefined) entry.analysis = validateSavedAnalysis(input.analysis);
    if (input.session !== undefined) entry.session = validateResearchSession(input.session);
    if (input.notes !== undefined) entry.notes = validateResearchNotes(input.notes);
    if (input.contentHistory !== undefined) entry.contentHistory = contentHistoryReferences(input.contentHistory);
    if (input.archived !== undefined) {
        if (typeof input.archived !== "boolean") throw fail("INVALID_LIBRARY", "Archived status must be boolean.");
        entry.archived = input.archived;
    }
    if ((entry.notes?.length || entry.session) && !entry.analysis)
        throw fail("INVALID_LIBRARY", "Research session labels and journal notes require an analyzed query.");
    if (input.parameterDefinitions !== undefined) entry.parameterDefinitions = parameterDefinitions(input.parameterDefinitions);
    if (input.reusableEvidence !== undefined) {
        const evidence = input.reusableEvidence;
        if (!evidence || !["not-run", "queued", "connecting", "executing", "streaming", "completed", "cancelling", "cancelled", "failed", "timed-out", "interrupted"].includes(evidence.status)
            || Object.keys(evidence).some(key => !["status", "runId", "startedAt", "truncated", "sourceHash"].includes(key))
            || !/^[a-f0-9]{64}$/.test(evidence.sourceHash)
            || (evidence.runId !== undefined && (typeof evidence.runId !== "string" || evidence.runId.length > 128))
            || (evidence.startedAt !== undefined && !Number.isFinite(Date.parse(evidence.startedAt)))
            || (evidence.truncated !== undefined && typeof evidence.truncated !== "boolean"))
            throw fail("INVALID_LIBRARY", "Invalid reusable query execution evidence.");
        entry.reusableEvidence = clone(evidence);
    }
    if (input.builder !== undefined) entry.builder = validateBuilderDraft(input.builder);
    if (input.builderImport !== undefined) entry.builderImport = normalizeBuilderImport(input.builderImport);
    return entry;
}
export function createQueryLibrary() {
    return { version: 1, revision: 0, collections: [{ id: "saved:general", name: "General", parentId: null, source: "saved" }], entries: [] };
}
export function restoreQueryLibrary(value) {
    if (value === undefined) return createQueryLibrary();
    object(value, "Saved library");
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Array.isArray(value.collections) || !Array.isArray(value.entries))
        throw fail("INVALID_LIBRARY", "Unsupported or corrupt saved query library.");
    bounded(value);
    const library = {
        version: 1, revision: value.revision,
        collections: value.collections.map(raw => {
            object(raw, "Collection");
            return { id: identifier(raw.id), name: collectionName(raw.name), parentId: raw.parentId === null ? null : identifier(raw.parentId), source: "saved" };
        }),
        entries: value.entries.map(savedEntry),
    };
    checkCollections(library.collections);
    if (!library.collections.some(item => item.id === "saved:general" && item.name === "General" && item.parentId === null))
        throw fail("INVALID_LIBRARY", "The default saved collection is missing.");
    const ids = new Set();
    for (const entry of library.entries) {
        if (ids.has(entry.id)) throw fail("INVALID_LIBRARY", "Duplicate saved query identifier.");
        ids.add(entry.id);
        if (!library.collections.some(collection => collection.id === entry.collectionId))
            throw fail("LIBRARY_COLLECTION_NOT_FOUND", "A saved query references a missing collection.");
    }
    bounded(library);
    return library;
}
function summary(entry, connection, connections = connection ? [connection] : []) {
    const resolved = connections.find(item => item.id === libraryConnection(entry, connections, connection?.id ?? ""));
    const model = resolved?.model ?? entry.model;
    return {
        id: entry.id, title: entry.title, description: entry.description,
        collectionId: entry.collectionId, source: entry.source,
        ...(entry.connectionName ? { connectionName: entry.connectionName } : {}),
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        hasBuilder: Boolean(entry.builder || entry.builderImport),
        canReviewDocumentation: entry.source === "saved" && !entry.archived && Boolean(connection)
            && entry.connectionId === connection.id && entry.model === connection.model,
        writing: summarizeWriting([
            { text: entry.documentation, kind: "query" },
            ...(entry.analysis ? [{ text: entry.analysis.content, kind: "research" }] : []),
            ...(entry.notes ?? []).map(note => ({ text: note.content, kind: "journal" })),
        ]),
        ...(entry.analysis ? { hasAnalysis: true, analysisStale: analysisIsStale(entry), researchContentVersion: researchContentVersion(entry) } : {}),
        ...(entry.archived !== undefined ? { archived: entry.archived } : {}),
        ...(entry.session ? { session: clone(entry.session) } : {}),
        ...(entry.notes?.length ? { noteCount: entry.notes.length } : {}),
        ...(entry.reusableEvidence ? { reusableEvidence: { status: entry.reusableEvidence.sourceHash !== reusableQueryHash(entry) ? "stale" : entry.reusableEvidence.truncated ? "partial" : entry.reusableEvidence.status, startedAt: entry.reusableEvidence.startedAt } } : {}),
        modelScope: !resolved ? "unassigned" : resolved.id === connection?.id && resolved.model === connection?.model ? "current" : "other",
        ...(model ? { model } : {}),
    };
}
const starterLibrary = connection => bundledStarterLibrary(connection) ?? { collections: starterCollections, entries: starters };
export function libraryCatalog(library, connection, connections, identity) {
    const examples = starterLibrary(connection);
    return clone({
        revision: library.revision,
        ...(identity ? { identity } : {}),
        collections: [...examples.collections, ...library.collections],
        entries: [...examples.entries, ...library.entries].map(entry => summary(entry, connection, connections)),
    });
}
export function findLibraryEntry(library, id, connection) {
    if (typeof id !== "string" || id.length > 136) throw fail("INVALID_LIBRARY", "Choose a library entry.");
    // Legacy IDs remain resolvable for existing references, but are not recommended in the catalog.
    const legacy = legacyStarterEntries(connection, id);
    const entry = [...starterLibrary(connection).entries, ...legacy, ...library.entries].find(item => item.id === id);
    if (!entry) throw fail("LIBRARY_ENTRY_NOT_FOUND", "This query is no longer in the library.");
    return clone(entry);
}
export function libraryPreview(library, id, connection, connections) {
    const entry = findLibraryEntry(library, id, connection);
    return { ...summary(entry, connection, connections), query: entry.query, documentation: entry.documentation,
        ...(entry.contentHistory?.some(item => item.field === "analysis") ? { analysisRevised: true } : {}),
        ...(entry.analysis ? { analysis: clone(entry.analysis) } : {}),
        ...(entry.notes ? { notes: clone(entry.notes) } : {}),
        ...(entry.knowledgeRefs ? { knowledgeRefs: clone(entry.knowledgeRefs) } : {}) };
}
export function previewDocumentationReview(library, payload, document, connection, identity) {
    object(payload, "Documentation review");
    if (Object.keys(payload).some(key => !["documentId", "connectionId", "libraryRevision", "identity", "entryIds"].includes(key))
        || !Array.isArray(payload.entryIds) || !payload.entryIds.length
        || payload.entryIds.length > DOCUMENTATION_REVIEW_LIMITS.entries || new Set(payload.entryIds).size !== payload.entryIds.length)
        throw fail("INVALID_LIBRARY", `Choose one to ${DOCUMENTATION_REVIEW_LIMITS.entries} distinct saved documentation entries.`);
    revision(library, payload.libraryRevision);
    if (!connection || document.id !== payload.documentId || document.connectionId !== payload.connectionId
        || connection.id !== payload.connectionId || JSON.stringify(identity) !== JSON.stringify(payload.identity))
        throw fail("REVISION_CONFLICT", "The active tab or model changed. Preview the documentation again before sharing.");
    const entries = payload.entryIds.map(id => {
        identifier(id);
        const entry = library.entries.find(item => item.id === id);
        if (!entry || entry.source !== "saved" || entry.archived || entry.connectionId !== connection.id || entry.model !== connection.model)
            throw fail("DOCUMENTATION_REVIEW_SCOPE", "Choose active saved queries or research for the current model. No documentation was shared.");
        if (library.entries.filter(item => item.source === "saved" && item.title === entry.title
            && item.connectionId === connection.id && item.model === connection.model).length !== 1)
            throw fail("DOCUMENTATION_REVIEW_AMBIGUOUS", "A selected title is duplicated on this model. Rename the duplicate in Artifacts, then preview again. Nothing was shared.");
        return { entryTitle: entry.title, expectedDocumentation: entry.documentation };
    });
    const preview = {
        workbenchId: identity.workbenchId, documentId: document.id, connectionId: connection.id,
        model: connection.model, libraryRevision: library.revision, entries,
    };
    const byteLength = Buffer.byteLength(JSON.stringify(preview), "utf8");
    if (byteLength > DOCUMENTATION_REVIEW_LIMITS.bytes)
        throw fail("DOCUMENTATION_REVIEW_LIMIT", "This batch exceeds 96 KiB. Select fewer entries; documentation is never shortened or silently omitted.");
    return { ...preview, byteLength };
}
export function createLibraryCollection(library, { name, parentId = null, expectedRevision }, connection, connections, identity) {
    revision(library, expectedRevision);
    appendCollection(library, name, parentId);
    return libraryCatalog(library, connection, connections, identity);
}
function appendCollection(library, name, parentId) {
    if (parentId !== null) identifier(parentId);
    const collection = { id: `saved:${randomUUID()}`, name: collectionName(name), parentId, source: "saved" };
    library.collections.push(collection);
    checkCollections(library.collections);
    library.revision++;
    bounded(library);
    return collection.id;
}
export function ensureLibraryCollectionPath(library, names, expectedRevision) {
    revision(library, expectedRevision);
    if (!Array.isArray(names) || !names.length || names.length > LIBRARY_LIMITS.depth)
        throw fail("LIBRARY_DEPTH", "Choose a collection path with one to four names.");
    const normalized = names.map(collectionName);
    let parentId = null;
    for (const name of normalized) {
        const existing = library.collections.find(item => item.parentId === parentId && item.name.toLowerCase() === name.toLowerCase());
        parentId = existing?.id ?? appendCollection(library, name, parentId);
    }
    return parentId;
}
export function saveLibraryEntry(library, payload, document, connections, identity, analysis, session) {
    revision(library, payload.expectedRevision);
    if (!library.collections.some(collection => collection.id === payload.collectionId))
        throw fail("LIBRARY_COLLECTION_NOT_FOUND", "Choose a saved collection. Starter collections are read-only.");
    let index = -1;
    if (payload.id !== undefined) {
        if (typeof payload.id === "string" && payload.id.startsWith("starter:"))
            throw fail("LIBRARY_READ_ONLY", "Starter queries cannot be modified. Save a new copy in My queries.");
        identifier(payload.id);
        index = library.entries.findIndex(item => item.id === payload.id);
        if (index < 0) throw fail("LIBRARY_ENTRY_NOT_FOUND", "The query to update no longer exists.");
    } else if (library.entries.length >= LIBRARY_LIMITS.entries) {
        throw fail("LIBRARY_LIMIT", "At most 200 queries may be saved in this workbench.");
    }
    const connection = connections.find(item => item.id === document.connectionId);
    // An unavailable saved connection must not turn into an unrelated active model.
    const original = !document.connectionId && library.entries.find(item => item.id === document.libraryRef?.entryId);
    const inherited = library.entries[index] ?? library.entries.find(item => item.id === document.libraryRef?.entryId);
    const entry = savedEntry({
        id: payload.id ?? `saved:${randomUUID()}`, collectionId: payload.collectionId,
        title: payload.title, description: payload.description, documentation: payload.documentation,
        query: document.query, builder: document.builder, builderImport: document.builderImport,
        parameters: document.parameters, parameterDefinitions: document.parameterDefinitions,
        connectionId: document.connectionId || original?.connectionId,
        connectionName: connection?.name ?? original?.connectionName,
        model: connection?.model ?? original?.model,
        knowledgeRefs: document.libraryRef?.knowledgeRefs ?? original?.knowledgeRefs,
        analysis: analysis ?? inherited?.analysis,
        session: analysis ? session : inherited?.session,
        notes: analysis ? undefined : inherited?.notes,
        reusableEvidence: inherited?.reusableEvidence,
        archived: index >= 0 ? library.entries[index].archived : undefined,
        updatedAt: new Date().toISOString(),
    });
    if (index < 0) library.entries.push(entry);
    else library.entries[index] = entry;
    library.revision++;
    bounded(library);
    return { id: entry.id, catalog: libraryCatalog(library, connection, connections, identity) };
}
function mutationPayload(payload, keys) {
    object(payload, "Library change");
    if (Object.keys(payload).some(key => !keys.includes(key)))
        throw fail("INVALID_LIBRARY", "This library change contains unsupported fields.");
    identifier(payload.id);
}
function documentationFields(payload) {
    text(payload.expectedDocumentation, "Expected documentation", LIBRARY_LIMITS.documentation, { empty: true, multiline: true });
    text(payload.documentation, "Documentation", LIBRARY_LIMITS.documentation, { empty: true, multiline: true });
    if ((payload.expectedDescription === undefined) !== (payload.description === undefined))
        throw fail("INVALID_LIBRARY", "Replacing a description requires both expectedDescription and description.");
    if (payload.description !== undefined) {
        text(payload.expectedDescription, "Expected description", LIBRARY_LIMITS.description, { empty: true, multiline: true });
        text(payload.description, "Description", LIBRARY_LIMITS.description, { empty: true, multiline: true });
    }
}
export function validateDocumentationRevision(payload) {
    object(payload, "Documentation revision");
    if (Object.keys(payload).some(key => !Object.hasOwn(reviseDocumentationProperties, key))
        || reviseDocumentationRequired.some(key => !Object.hasOwn(payload, key)))
        throw fail("INVALID_LIBRARY", "Use the complete supported documentation revision fields.");
    requireId(payload.documentId); text(payload.connectionId, "Connection identity", 512);
    text(payload.entryTitle, "Exact saved title", LIBRARY_LIMITS.title);
    for (const key of ["revision", "builderRevision", "libraryRevision"])
        if (!Number.isSafeInteger(payload[key]) || payload[key] < 0 || payload[key] >= Number.MAX_SAFE_INTEGER)
            throw fail("INVALID_LIBRARY", "Documentation revisions must be nonnegative safe integers.");
    documentationFields(payload);
    return clone(payload);
}
const sameDocumentationText = (left, right) => left.replace(/\s+/gu, " ").trim() === right.replace(/\s+/gu, " ").trim();
export function updateLibraryDocumentation(library, payload) {
    if (typeof payload?.id === "string" && payload.id.startsWith("starter:"))
        throw fail("LIBRARY_READ_ONLY", "Starter documentation is read-only. Save a separate query before editing its documentation.");
    mutationPayload(payload, ["id", "expectedRevision", "expectedDocumentation", "documentation", "expectedDescription", "description"]);
    revision(library, payload.expectedRevision);
    documentationFields(payload);
    const entry = library.entries.find(item => item.id === payload.id);
    if (!entry) throw documentationConflict();
    if (entry.source !== "saved" || entry.archived) throw fail("LIBRARY_READ_ONLY", "Restore this saved entry before revising its documentation.");
    if (!sameDocumentationText(entry.documentation, payload.expectedDocumentation)
        || (payload.description !== undefined && !sameDocumentationText(entry.description, payload.expectedDescription)))
        throw documentationConflict();
    entry.documentation = payload.documentation;
    if (payload.description !== undefined) entry.description = payload.description;
    entry.updatedAt = new Date().toISOString();
    library.revision++; bounded(library);
    return { id: entry.id, libraryRevision: library.revision };
}
export function updateLibraryContent(library, payload, author) {
    revision(library, payload.libraryRevision);
    const entry = library.entries.find(item => item.id === payload.entryId && item.source === "saved" && !item.archived);
    if (!entry) throw documentationConflict();
    const previous = payload.field === "documentation" ? entry.documentation : payload.field === "analysis" ? entry.analysis?.content
        : entry.notes?.find(note => note.id === payload.noteId)?.content;
    if (previous === undefined || previous !== payload.expectedText) throw documentationConflict();
    if (payload.field === "documentation") entry.documentation = text(payload.text, "Documentation", LIBRARY_LIMITS.documentation, { empty: true, multiline: true });
    else if (payload.field === "analysis") entry.analysis = validateSavedAnalysis({ ...entry.analysis, content: payload.text });
    else if (payload.field === "journal") {
        const note = { ...createResearchNote(payload.text, author), correctionOf: payload.noteId };
        entry.notes = validateResearchNotes([...(entry.notes ?? []), note]);
    } else throw fail("INVALID_LIBRARY", "Choose documentation, analysis or a journal correction.");
    entry.updatedAt = new Date().toISOString(); library.revision++; bounded(library);
}
export function organizeLibraryEntry(library, payload, connection, connections, identity) {
    mutationPayload(payload, ["id", "expectedRevision", "title", "collectionId", "archived", "session"]);
    revision(library, payload.expectedRevision);
    const entry = library.entries.find(item => item.id === payload.id);
    if (!entry) throw fail("LIBRARY_ENTRY_NOT_FOUND", "Choose an existing saved artifact.");
    if (payload.title !== undefined) entry.title = text(payload.title, "Query title", LIBRARY_LIMITS.title).trim();
    if (payload.collectionId !== undefined) {
        if (!library.collections.some(item => item.id === payload.collectionId))
            throw fail("LIBRARY_COLLECTION_NOT_FOUND", "Choose an existing saved collection.");
        entry.collectionId = payload.collectionId;
    }
    if (payload.archived !== undefined) {
        if (typeof payload.archived !== "boolean") throw fail("INVALID_LIBRARY", "Archived status must be boolean.");
        entry.archived = payload.archived;
    }
    if (payload.session !== undefined) {
        if (!entry.analysis) throw fail("INVALID_RESEARCH", "Session attribution requires a saved research artifact.");
        if (payload.session === null) delete entry.session;
        else entry.session = validateResearchSession(payload.session);
    }
    entry.updatedAt = new Date().toISOString();
    library.revision++; bounded(library);
    return libraryCatalog(library, connection, connections, identity);
}
export function updateLibraryCollection(library, payload, connection, connections, identity) {
    mutationPayload(payload, ["id", "expectedRevision", "name", "parentId"]);
    revision(library, payload.expectedRevision);
    if (payload.id === "saved:general") throw fail("LIBRARY_READ_ONLY", "The default General collection cannot be renamed or moved.");
    const collection = library.collections.find(item => item.id === payload.id);
    if (!collection) throw fail("LIBRARY_COLLECTION_NOT_FOUND", "Choose an existing saved collection.");
    if (payload.name !== undefined) collection.name = collectionName(payload.name);
    if (payload.parentId !== undefined) collection.parentId = payload.parentId === null ? null : identifier(payload.parentId);
    checkCollections(library.collections);
    library.revision++; bounded(library);
    return libraryCatalog(library, connection, connections, identity);
}
export function appendLibraryResearch(library, payload, author, connection, connections, identity) {
    mutationPayload(payload, ["id", "expectedRevision", "content", "session"]);
    revision(library, payload.expectedRevision);
    const entry = library.entries.find(item => item.id === payload.id);
    if (!entry?.analysis) throw fail("RESEARCH_ENTRY_REQUIRED", "Choose an existing saved research artifact.");
    if (entry.archived) throw fail("RESEARCH_ARCHIVED", "Restore this artifact before appending a note.");
    if ((entry.notes?.length ?? 0) >= 50) throw fail("RESEARCH_NOTE_LIMIT", "This artifact already contains fifty journal notes. Save a new research artifact to continue.");
    const note = createResearchNote(payload.content, author, payload.session);
    entry.notes = [...(entry.notes ?? []), note];
    entry.updatedAt = note.createdAt;
    library.revision++; bounded(library);
    return libraryCatalog(library, connection, connections, identity);
}
export function libraryReference(entry) {
    return { entryId: entry.id, collectionId: entry.collectionId, description: entry.description, documentation: entry.documentation,
        ...(entry.knowledgeRefs ? { knowledgeRefs: validateKnowledgeReferences(entry.knowledgeRefs) } : {}) };
}
export function libraryConnection(entry, connections, currentConnectionId) {
    if (entry.source === "starter" && !entry.connectionName) return currentConnectionId;
    if (connections.some(connection => connection.id === entry.connectionId)) return entry.connectionId;
    const matches = entry.connectionName ? connections.filter(connection => connection.name === entry.connectionName) : [];
    return matches.length === 1 ? matches[0].id : "";
}
