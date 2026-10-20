import { BUILDER_OPERATORS } from "../integrations/query-builder.mjs";

const object = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
const text = maxLength => ({ type: "string", maxLength });
const identifier = maxLength => ({ ...text(maxLength), minLength: 1 });
const field = object({
    id: identifier(1024), kind: { type: "string", enum: ["column", "measure"] },
    table: identifier(256), name: identifier(256), dataType: identifier(80),
    caption: identifier(256), expression: text(16384), isCustom: { type: "boolean" },
}, ["id", "kind", "name"]);
const items = schema => ({ type: "array", maxItems: 200, items: schema });

export const builderDefinitionSchema = object({
    version: { type: "integer", const: 2 },
    fields: items(field),
    filters: items(object({
        id: identifier(1024), field, operator: { type: "string", enum: BUILDER_OPERATORS },
        value: text(16384), value2: text(16384), enabled: { type: "boolean" },
        isParameter: { type: "boolean" }, isParameter2: { type: "boolean" },
    }, ["id", "field", "operator", "enabled"])),
    orderBy: items(object({ fieldId: identifier(1024), direction: { type: "string", enum: ["ASC", "DESC"] } }, ["fieldId", "direction"])),
}, ["version", "fields", "filters", "orderBy"]);

export const builderProposalProperties = {
    documentId: identifier(128), connectionId: identifier(128),
    revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    builderRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    definition: builderDefinitionSchema, rationale: text(2000),
};
export const builderProposalRequired = ["documentId", "connectionId", "revision", "builderRevision", "definition"];
