const text = maxLength => ({ type: "string", maxLength });
const revision = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const researchSessionSchema = {
    type: "object", additionalProperties: false,
    properties: { id: { ...text(128), minLength: 1 }, title: { ...text(120), minLength: 1 } },
    required: ["id", "title"],
    description: "Explicit source-session identifier and display label; not a URL, path, verified session link or automatic history import.",
};
export const researchProperties = {
    documentId: { ...text(128), minLength: 1 },
    connectionId: { ...text(512), minLength: 1 },
    revision, builderRevision: revision, libraryRevision: revision,
    collectionPath: { type: "array", minItems: 1, maxItems: 4, items: { ...text(80), minLength: 1 } },
    title: { ...text(120), minLength: 1 },
    description: text(500), documentation: text(16384),
    analysis: {
        type: "object", additionalProperties: false,
        properties: { question: { ...text(500), minLength: 1 }, content: { ...text(16384), minLength: 1 }, limitations: text(4000) },
        required: ["question", "content", "limitations"],
    },
    runIds: { type: "array", maxItems: 20, uniqueItems: true, items: { ...text(128), minLength: 1 } },
};
export const researchRequired = Object.keys(researchProperties);
researchProperties.session = researchSessionSchema;
export const appendResearchProperties = {
    entryId: { ...text(136), minLength: 1 },
    documentId: researchProperties.documentId, connectionId: researchProperties.connectionId,
    revision, builderRevision: revision, libraryRevision: revision,
    content: { ...text(4000), minLength: 1 },
    session: researchSessionSchema,
};
export const appendResearchRequired = Object.keys(appendResearchProperties).filter(key => key !== "session");
