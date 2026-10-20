import { builderLiteral, builderReference } from "../integrations/query-builder.mjs";
import { fail, isCell } from "./policy.mjs";
import { defaultFilterValueOrder, filterValueOrderChoices } from "../shared/filter-value-order.mjs";

export const FILTER_VALUE_LIMITS = Object.freeze({ timeoutSeconds: 30, maxRows: 201, maxBytes: 64 * 1024 });
export const FILTER_MONTH_VALUE_LIMITS = Object.freeze({ ...FILTER_VALUE_LIMITS, maxRows: 2001 });

export function filterValuesQuery(field, search = "", order = undefined) {
    if (field?.kind !== "column" || !field.table)
        throw fail("INVALID_FILTER_FIELD", "Choose a native model column to load filter values.");
    if (typeof search !== "string" || search.length > 200)
        throw fail("INVALID_FILTER_SEARCH", "Search supports at most 200 characters.");
    if (order === undefined) order = defaultFilterValueOrder(field);
    if (!filterValueOrderChoices(field).some(choice => choice.value === order))
        throw fail("INVALID_FILTER_ORDER", "Choose a supported value order for this column.");
    const reference = builderReference(field);
    const pattern = search.replaceAll("~", "~~").replaceAll("*", "~*").replaceAll("?", "~?");
    const values = `VALUES(${reference})`;
    const source = search ? `FILTER(${values}, CONTAINSSTRING(${reference} & "", ${builderLiteral(pattern, { dataType: "String" })}))` : values;
    const monthly = order.startsWith("month-");
    const direction = !monthly && order === "desc" ? "DESC" : "ASC";
    const limit = monthly ? FILTER_MONTH_VALUE_LIMITS.maxRows : FILTER_VALUE_LIMITS.maxRows;
    // Month labels are interpreted locally only after verifying a complete bounded capture.
    return `EVALUATE\nTOPN(\n    ${limit},\n    SELECTCOLUMNS(${source}, "Value", ${reference}),\n    [Value], ${direction}\n)\nORDER BY [Value] ${direction}`;
}

export function filterValueOption(value, field) {
    if (!isCell(value)) throw fail("INVALID_FILTER_RESULT", "The provider returned a non-scalar filter value.");
    if (value === null) return { value, literal: null, label: "(Blank)" };
    const literal = String(value);
    const label = value === "" ? '(Empty text "")'
        : typeof value === "string" && (value.trim() !== value || /[\r\n\t]/.test(value)) ? JSON.stringify(value) : literal;
    try {
        if (typeof value === "number" && /int|whole|long|bigint/i.test(field.dataType ?? "") && !Number.isSafeInteger(value))
            throw new Error("The provider did not return this integer as exact text. Use an exact literal instead.");
        builderLiteral(literal, field);
        return { value, literal, label };
    } catch (error) {
        return { value, literal, label, unavailable: error.message };
    }
}
