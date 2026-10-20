const object = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
export const knowledgeIdentitySchema = object({
    workbenchId: { type: "string", minLength: 1, maxLength: 512 },
    connectionId: { type: ["string", "null"], maxLength: 512 },
    model: { type: ["string", "null"], maxLength: 512 },
    generation: { type: "string", minLength: 1, maxLength: 512 },
    contextVersion: { type: "string", minLength: 1, maxLength: 512 },
}, ["workbenchId", "connectionId", "model", "generation", "contextVersion"]);
export const knowledgeSearchProperties = {
    identity: knowledgeIdentitySchema,
    query: { type: "string", maxLength: 200 },
    field: object({
        kind: { type: "string", enum: ["column", "measure", "table"] },
        table: { type: "string", minLength: 1, maxLength: 200 },
        name: { type: "string", minLength: 1, maxLength: 200 },
    }, ["kind", "name"]),
};
export const knowledgeGetProperties = {
    identity: knowledgeIdentitySchema,
    id: { type: "string", minLength: 1, maxLength: 136 },
    version: { type: "integer", minimum: 1 },
};
