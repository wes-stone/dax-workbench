import { builderLiteral, builderReference } from "../integrations/query-builder.mjs";
import { fail } from "./policy.mjs";

export const MODEL_PREVIEW_LIMITS = Object.freeze({ timeoutSeconds: 30, maxRows: 100, maxBytes: 256 * 1024 });
export const MODEL_PREVIEW_COLUMNS = 32;

export function modelPreviewQuery(object, objects) {
    if (!object || !["table", "column"].includes(object.kind) || object.kind === "column" && !object.table)
        throw fail("INVALID_PREVIEW_OBJECT", "Preview data is available for native model tables and columns.");
    const table = object.kind === "table" ? object.name : object.table;
    const available = object.kind === "column" ? [object] : objects
        .filter(field => field.kind === "column" && field.table === table && !field.isHidden)
        .sort((a, b) => (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    if (!available.length) throw fail("PREVIEW_COLUMNS_UNAVAILABLE", "No visible native columns are available for this table. Refresh model metadata or preview an individual column.");
    const columns = available.slice(0, MODEL_PREVIEW_COLUMNS);
    const reference = object.kind === "column" ? `VALUES(${builderReference(object)})` : `'${table.replaceAll("'", "''")}'`;
    const projection = columns.map(field => `${builderLiteral(field.name, { dataType: "String" })}, ${builderReference(field)}`).join(",\n        ");
    const sort = object.kind === "column" ? `[${object.name.replaceAll("]", "]]")}]` : null;
    return {
        query: `EVALUATE\nTOPN(\n    101,\n    SELECTCOLUMNS(\n        ${reference},\n        ${projection}\n    )${sort ? `,\n    ${sort}, ASC` : ""}\n)${sort ? `\nORDER BY ${sort} ASC` : ""}`,
        title: `Preview data: ${table}${object.kind === "column" ? ` / ${object.name}` : ""}`,
        warnings: [
            "Preview data reads the accessible model, without editor/builder filters or parameter bindings. The current query and builder are unchanged.",
            object.kind === "column" ? "Distinct column values in ascending model order. This is not a frequency sample."
                : `Up to 100 rows in unspecified order, not a random or representative sample. Showing ${columns.length} of ${available.length} visible native columns; hidden columns and measures are excluded.`,
        ],
    };
}
