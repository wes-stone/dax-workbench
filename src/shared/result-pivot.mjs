import { decimalAdd, decimalCompare, decimalDivide } from "./result-analysis.mjs";
import { isNumeric, isVariant } from "./result-numbers.mjs";
import { resultColumnLabels } from "./result-columns.mjs";
import { resultValueText } from "./result-display.mjs";
import { PIVOT_LIMITS, PIVOT_AGGREGATIONS, pivotFieldKey, validatePivotConfig, validatePivotFields } from "./pivot-config.mjs";

const key = value => JSON.stringify(value);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const numericAggregation = aggregation => ["sum", "average", "min", "max"].includes(aggregation);
export const pivotCellKey = (row, column) => key([row, column]);
export const pivotLabel = value => value === undefined ? "(absent)" : value === null ? "(null)" : value === "" ? '"" (empty text)' : String(value);
/** @param {import("../contracts/workbench").Cell | undefined} value @param {string} [dataType] */
export const pivotDisplayLabel = (value, dataType) => value == null || value === "" ? pivotLabel(value) : resultValueText(value, dataType);
/**
 * Every prefix is accumulated directly from contributing rows, never from displayed subtotals.
 * @param {{columns: import("../contracts/workbench").Column[], rows: import("../contracts/workbench").Cell[][]}} data
 * @param {import("../contracts/pivot").PivotConfig} input
 * @param {AbortSignal} [signal]
 * @returns {Promise<import("../contracts/pivot").PivotOutput>}
 */
export async function pivotResult(data, input, signal) {
    const config = validatePivotConfig(input);
    if (!data || !Array.isArray(data.rows) || !Array.isArray(data.columns) || data.rows.length > PIVOT_LIMITS.rows || data.columns.length > PIVOT_LIMITS.columns)
        throw new Error("Local pivots support 100,000 rows and 64 columns. Refine the query; nothing is sampled.");
    validatePivotFields(config, data.columns);
    const indices = new Map(data.columns.map((column, index) => [pivotFieldKey(column), index]));
    const indexOf = field => indices.get(field);
    const rowIndices = config.rows.map(indexOf), columnIndices = config.columns.map(indexOf);
    const measures = config.values.map(value => ({ ...value, index: indexOf(value.field) }));
    for (const value of measures)
        if (numericAggregation(value.aggregation) && !isNumeric(data.columns[value.index]) && !isVariant(data.columns[value.index]))
            throw new Error(`${data.columns[value.index].name} is not numeric. Use Count or Distinct values, or return a numeric measure in DAX.`);
    const filters = config.filters.filter(filter => filter.values !== null).map(filter => ({ index: indexOf(filter.field), keys: new Set(filter.values.map(key)) }));
    /** @type {Map<string, import("../contracts/pivot").PivotNode>} */
    const rowNodes = new Map(), columnNodes = new Map();
    const root = () => ({ key: "[]", path: [], parent: null, depth: 0, children: [] });
    rowNodes.set("[]", root()); columnNodes.set("[]", root());
    const newStates = () => measures.map(() => ({ count: 0, rows: 0, sum: "0", min: null, max: null, distinct: new Set() }));
    const groups = new Map([[pivotCellKey("[]", "[]"), newStates()]]), inferred = new Set();
    let filteredRows = 0, distinctEntries = 0, lastYield = -Infinity;
    const prefixes = (row, indices, nodes) => {
        const keys = ["[]"], path = [];
        for (const index of indices) {
            path.push(row[index]); const id = key(path), parent = keys.at(-1);
            if (!nodes.has(id)) {
                nodes.set(id, { key: id, path: [...path], parent, depth: path.length, children: [] });
                nodes.get(parent).children.push(id);
            }
            keys.push(id);
        }
        return keys;
    };
    for (let i = 0; i < data.rows.length; i++) {
        if (i % 32 === 0 && performance.now() - lastYield >= 8) { await pause(); signal?.throwIfAborted(); lastYield = performance.now(); }
        const row = data.rows[i];
        if (!Array.isArray(row) || row.length !== data.columns.length) throw new Error(`Captured row ${i + 1} has an inconsistent width.`);
        if (row.some(value => value !== null && !["string", "boolean", "number"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)))
            throw new Error(`Captured row ${i + 1} contains an invalid cell.`);
        const numeric = measures.map(value => {
            if (!numericAggregation(value.aggregation) || row[value.index] === null) return null;
            try {
                const exact = decimalAdd("0", row[value.index]);
                if (isVariant(data.columns[value.index])) inferred.add(value.field);
                return exact;
            } catch (error) {
                throw new Error(`${data.columns[value.index].name}, captured row ${i + 1}: ${error.message} Use Count/Distinct values or fix the source. All captured values are checked, including filtered-out rows.`);
            }
        });
        if (filters.some(filter => !filter.keys.has(key(row[filter.index])))) continue;
        filteredRows++;
        const rows = prefixes(row, rowIndices, rowNodes), columns = prefixes(row, columnIndices, columnNodes);
        if (rowNodes.size * columnNodes.size * Math.max(1, measures.length) > PIVOT_LIMITS.cells)
            throw new Error("The pivot exceeds 20,000 cells including hierarchy totals. Filter or remove dimensions; nothing is sampled.");
        for (const r of rows) for (const c of columns) {
            const id = pivotCellKey(r, c);
            if (!groups.has(id)) groups.set(id, newStates());
            groups.get(id).forEach((state, mi) => {
                const measure = measures[mi], value = row[measure.index], number = numeric[mi];
                state.rows++;
                if (value === null) return;
                state.count++;
                if (measure.aggregation === "distinct") {
                    const id = key(value);
                    if (!state.distinct.has(id)) { state.distinct.add(id); distinctEntries++; }
                    if (distinctEntries > 2000000) throw new Error("Distinct-value pivot storage exceeds 2,000,000 memberships. Filter or remove dimensions; nothing is sampled.");
                }
                if (number !== null) {
                    if (["sum", "average"].includes(measure.aggregation)) state.sum = decimalAdd(state.sum, number);
                    if (measure.aggregation === "min" && (state.min === null || decimalCompare(number, state.min) < 0)) state.min = number;
                    if (measure.aggregation === "max" && (state.max === null || decimalCompare(number, state.max) > 0)) state.max = number;
                }
            });
        }
    }
    signal?.throwIfAborted();
    const cells = new Map();
    let visited = 0;
    for (const [id, states] of groups) {
      if (++visited % 512 === 0) { await pause(); signal?.throwIfAborted(); }
      cells.set(id, states.map((state, index) => {
        switch (measures[index].aggregation) {
            case "count": return state.count;
            case "countRows": return state.rows;
            case "distinct": return state.distinct.size;
            case "sum": return state.count ? state.sum : null;
            case "average": return state.count ? decimalDivide(state.sum, state.count) : null;
            case "min": return state.min;
            case "max": return state.max;
        }
      }));
    }
    const ordered = (nodes, order, indices) => {
        const output = [];
        const visit = id => {
            const node = nodes.get(id);
            if (order !== "source") node.children.sort((left, right) => {
                const a = nodes.get(left).path.at(-1), b = nodes.get(right).path.at(-1);
                const comparison = a === null ? b === null ? 0 : -1 : b === null ? 1
                    : isNumeric(data.columns[indices[node.depth]]) ? decimalCompare(a, b)
                        : String(a).localeCompare(String(b), undefined, { numeric: true }) || (typeof a).localeCompare(typeof b);
                return order === "desc" ? -comparison : comparison;
            });
            for (const child of node.children) visit(child);
            output.push(node);
        };
        visit("[]"); return output;
    };
    return { rows: ordered(rowNodes, config.rowOrder, rowIndices), columns: ordered(columnNodes, config.columnOrder, columnIndices),
        cells, sourceRows: data.rows.length, filteredRows, inferredFields: [...inferred] };
}
/** @param {import("../contracts/pivot").PivotNode[]} nodes @param {string[]} collapsed @param {boolean} totals */
export function visiblePivotNodes(nodes, collapsed, totals) {
    const hidden = new Set(collapsed), byKey = new Map(nodes.map(node => [node.key, node]));
    return nodes.filter(node => {
        let parent = node.parent;
        while (parent !== null) {
            if (hidden.has(parent)) return false;
            parent = byKey.get(parent)?.parent ?? null;
        }
        return nodes.length === 1 || !node.children.length || hidden.has(node.key) || totals;
    });
}
/** @param {import("../contracts/workbench").Cell | undefined} value @param {import("../contracts/pivot").PivotFormat} format @param {number} [places] */
export function formatPivotNumber(value, format, places = 2) {
    if (!Number.isInteger(places) || places < 0 || places > 12) throw new Error("Choose a whole number of decimal places from 0 to 12.");
    if (value === null || value === undefined) return pivotLabel(value);
    if (format === "exact") return String(value);
    const exact = decimalAdd("0", value);
    const scaled = decimalDivide(format === "percent" ? `${exact}e2` : exact, format === "thousands" ? 1000 : format === "millions" ? 1000000 : 1, places);
    const [integer, fraction = ""] = scaled.split(".");
    return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${places ? `.${fraction.padEnd(places, "0")}` : ""}${format === "percent" ? "%" : ""}`;
}
/**
 * Flat, rectangular output follows visible hierarchy nodes; exact values are never replaced by display rounding.
 * @param {import("../contracts/pivot").PivotOutput} output @param {import("../contracts/pivot").PivotConfig} config
 * @param {import("../contracts/workbench").Column[]} fields
 * @param {{rows: (import("../contracts/pivot").PivotNode & {groupOnly?: boolean})[], columns: import("../contracts/pivot").PivotNode[]}} [view]
 */
export function pivotTableData(output, config, fields, view) {
    const captions = resultColumnLabels(fields);
    const labels = new Map(fields.map((field, index) => [pivotFieldKey(field), captions[index]]));
    const rows = view?.rows ?? visiblePivotNodes(output.rows, config.collapsedRows, config.totals);
    const columns = view?.columns ?? visiblePivotNodes(output.columns, config.collapsedColumns, config.totals);
    const name = node => node.depth === 0 ? "Grand total" : node.path.map(pivotLabel).join(" / ") + (node.children.length ? " / Total" : "");
    const headers = ["Row kind", ...config.rows.map(field => labels.get(field)), ...columns.flatMap(column =>
        config.values.map(value => `${name(column)} / ${PIVOT_AGGREGATIONS[value.aggregation]} ${labels.get(value.field)}`))];
    const values = rows.map(row => [
        row.groupOnly ? "Group" : row.depth === 0 ? "Grand total" : row.children.length ? "Subtotal" : "Detail",
        ...config.rows.map((_, i) => i < row.path.length ? pivotLabel(row.path[i]) : ""),
        ...columns.flatMap(column => config.values.map((_, index) => row.groupOnly ? "" : output.cells.get(pivotCellKey(row.key, column.key))?.[index] ?? pivotLabel(output.cells.get(pivotCellKey(row.key, column.key))?.[index]))),
    ]);
    return { headers, rows: values };
}
/** Protect spreadsheet formulas while retaining delimiters, quotes and exact numeric strings. */
export function pivotDelimited(table, delimiter = "\t") {
    const escape = value => {
        let text = String(value);
        if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
        return /["\r\n\t,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    return [table.headers, ...table.rows].map(row => row.map(escape).join(delimiter)).join("\r\n");
}
/**
 * @param {{columns: import("../contracts/workbench").Column[], rows: import("../contracts/workbench").Cell[][]}} data
 * @param {import("../contracts/pivot").PivotConfig} config
 * @param {import("../contracts/workbench").Cell[]} rowPath @param {import("../contracts/workbench").Cell[]} columnPath
 * @param {AbortSignal} signal
 */
export async function pivotContributingRows(data, config, rowPath, columnPath, signal) {
    const indices = new Map(data.columns.map((column, index) => [pivotFieldKey(column), index]));
    const filters = config.filters.filter(filter => filter.values !== null)
        .map(filter => ({ index: indices.get(filter.field), values: new Set(filter.values.map(key)) }));
    const matches = [];
    let lastYield = -Infinity;
    for (let i = 0; i < data.rows.length; i++) {
        if (i % 128 === 0 && performance.now() - lastYield >= 8) { await pause(); signal.throwIfAborted(); lastYield = performance.now(); }
        const row = data.rows[i];
        if (filters.every(filter => filter.values.has(key(row[filter.index])))
            && rowPath.every((value, index) => key(value) === key(row[indices.get(config.rows[index])]))
            && columnPath.every((value, index) => key(value) === key(row[indices.get(config.columns[index])])))
            matches.push(row);
    }
    signal.throwIfAborted();
    return matches;
}
