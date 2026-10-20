export const PIVOT_LIMITS = Object.freeze({ rows: 100000, columns: 64, cells: 20000, axes: 4, values: 8, filters: 8, filterValues: 1000, layouts: 20 });
export const PIVOT_AGGREGATIONS = Object.freeze({ sum: "Sum", average: "Average", min: "Minimum", max: "Maximum", count: "Count values", countRows: "Count rows", distinct: "Distinct values" });
export const PIVOT_FORMATS = Object.freeze({ exact: "Exact", number: "Number", thousands: "Thousands", millions: "Millions", percent: "Percent" });
/** @param {Pick<import("../contracts/workbench").Column, "name" | "dataType">} column */
export const pivotFieldKey = column => JSON.stringify([column.name, column.dataType]);
/** @returns {import("../contracts/pivot").PivotConfig} */
export const emptyPivot = () => ({ version: 1, rows: [], columns: [], values: [], filters: [], rowOrder: "source", columnOrder: "source", totals: true, collapsedRows: [], collapsedColumns: [] });
/**
 * A revision includes query/binding edits. Ordinals may change between compatible captures.
 * @param {Pick<import("../contracts/workbench").Run, "documentId" | "connectionId" | "revision">} run
 * @param {Pick<import("../contracts/workbench").ResultSet, "id" | "columns">} result
 */
export function pivotSourceKey(run, result) {
    return JSON.stringify([run.documentId, run.connectionId, run.revision, result.id, result.columns.map(pivotFieldKey).sort()]);
}
const fail = message => { throw Object.assign(new Error(message), { code: "INVALID_PIVOT" }); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const strings = (value, limit) => Array.isArray(value) && value.length <= limit && value.every(item => typeof item === "string" && item.length <= 4096) && new Set(value).size === value.length;
const cell = value => value === null || typeof value === "boolean" || typeof value === "string" && value.length <= 32768 || typeof value === "number" && Number.isFinite(value);
/** @returns {import("../contracts/pivot").PivotConfig} */
export function validatePivotConfig(config) {
    if (!exactKeys(config, Object.keys(emptyPivot())) || config.version !== 1
        || !strings(config.rows, PIVOT_LIMITS.axes) || !strings(config.columns, PIVOT_LIMITS.axes)
        || new Set([...config.rows, ...config.columns]).size !== config.rows.length + config.columns.length
        || !["source", "asc", "desc"].includes(config.rowOrder) || !["source", "asc", "desc"].includes(config.columnOrder)
        || typeof config.totals !== "boolean" || !strings(config.collapsedRows, PIVOT_LIMITS.cells) || !strings(config.collapsedColumns, PIVOT_LIMITS.cells)
        || !Array.isArray(config.values) || config.values.length > PIVOT_LIMITS.values
        || !Array.isArray(config.filters) || config.filters.length > PIVOT_LIMITS.filters)
        fail("Choose up to four fields per axis, eight values and eight filters with supported pivot options.");
    for (const value of config.values) {
        const hasDecimals = plain(value) && Object.hasOwn(value, "decimalPlaces");
        if (!exactKeys(value, hasDecimals ? ["field", "aggregation", "format", "decimalPlaces"] : ["field", "aggregation", "format"]) || !strings([value.field], 1)
            || !Object.hasOwn(PIVOT_AGGREGATIONS, value.aggregation) || !Object.hasOwn(PIVOT_FORMATS, value.format))
            fail("Choose a supported aggregation and display format for every pivot value.");
        if (hasDecimals && (!Number.isInteger(value.decimalPlaces) || value.decimalPlaces < 0 || value.decimalPlaces > 12))
            fail("Choose a whole number of decimal places from 0 to 12.");
    }
    for (const filter of config.filters)
        if (!exactKeys(filter, ["field", "values"]) || !strings([filter.field], 1) || filter.values !== null
            && (!Array.isArray(filter.values) || filter.values.length > PIVOT_LIMITS.filterValues
                || filter.values.some(value => !cell(value)) || new Set(filter.values.map(value => JSON.stringify(value))).size !== filter.values.length))
            fail("Choose at most 1,000 distinct typed values per local pivot filter.");
    if (new Set(config.values.map(value => value.field)).size !== config.values.length
        || new Set(config.filters.map(filter => filter.field)).size !== config.filters.length)
        fail("Use each field once in Values and once in Filters.");
    if (new TextEncoder().encode(JSON.stringify(config)).length > 131072) fail("Pivot settings exceed 128 KiB. Choose fewer fields or filter values.");
    return structuredClone(config);
}
/** Layout persistence deliberately excludes captured literals and hierarchy member keys. */
export function pivotLayoutOnly(config) {
    const checked = validatePivotConfig(config);
    return { ...checked, filters: checked.filters.map(filter => ({ field: filter.field, values: null })), collapsedRows: [], collapsedColumns: [] };
}
/** @param {import("../contracts/pivot").PivotConfig} config @param {import("../contracts/workbench").Column[]} columns */
export function validatePivotFields(config, columns) {
    const keys = columns.map(pivotFieldKey);
    if (new Set(keys).size !== keys.length) fail("Pivot requires unique column names and types. Alias duplicate result fields in DAX.");
    for (const key of [...config.rows, ...config.columns, ...config.values.map(value => value.field), ...config.filters.map(filter => filter.field)])
        if (!keys.includes(key)) fail("A pivot field is missing or its type changed. Reset the layout or return the original field.");
}
/** @returns {import("../contracts/pivot").PivotLayout[]} */
export function restorePivotLayouts(layouts) {
    if (!Array.isArray(layouts) || layouts.length > PIVOT_LIMITS.layouts) fail("Saved pivot layouts are invalid.");
    for (const layout of layouts) {
        if (!exactKeys(layout, ["source", "config"]) || typeof layout.source !== "string" || layout.source.length > 65536)
            fail("A saved pivot source is invalid.");
        if (JSON.stringify(pivotLayoutOnly(layout.config)) !== JSON.stringify(layout.config)) fail("Saved pivot layouts must not contain result values.");
    }
    if (new Set(layouts.map(layout => layout.source)).size !== layouts.length) fail("Saved pivot sources must be unique.");
    return structuredClone(layouts);
}
