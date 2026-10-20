import { decimalAdd, decimalCompare } from "./result-analysis.mjs";
import { isNumeric } from "./result-numbers.mjs";

/**
 * @param {{columns: import("../contracts/workbench").Column[], rows: import("../contracts/workbench").Cell[][]}} data
 * @param {import("../contracts/dashboards").AdvancedVisualConfig} config
 */
export function prepareWaterfall(data, config) {
    const x = data.columns.findIndex(column => column.id === config.x), y = data.columns.findIndex(column => column.id === config.y);
    if (x < 0 || y < 0 || !isNumeric(data.columns[y])) throw new Error("Choose a label and numeric change column.");
    if (!data.rows.length || data.rows.length > 100) throw new Error("A waterfall needs 1–100 steps. Refine the query; no rows are omitted.");
    let current = decimalAdd(config.start, "0");
    const points = data.rows.map(row => {
        if (row[y] === null) throw new Error("A waterfall change is null. Resolve the missing value explicitly; null is not zero.");
        const before = current; current = decimalAdd(current, row[y]);
        return { label: row[x], change: row[y], before, after: current, negative: decimalCompare(row[y], "0") < 0 };
    });
    const numbers = [Number(config.start), ...points.flatMap(point => [Number(point.before), Number(point.after)])];
    if (numbers.some(value => !Number.isFinite(value))) throw new Error("These exact values exceed the chart coordinate range. Use their exact table instead.");
    const minimum = Math.min(0, ...numbers), maximum = Math.max(0, ...numbers);
    if (!Number.isFinite(maximum - minimum)) throw new Error("The waterfall span exceeds the chart coordinate range.");
    return { points, total: current, minimum, maximum: maximum === minimum ? minimum + 1 : maximum };
}

/**
 * @param {{columns: import("../contracts/workbench").Column[], rows: import("../contracts/workbench").Cell[][]}} data
 * @param {import("../contracts/dashboards").AdvancedVisualConfig} config
 */
export function prepareFacets(data, config) {
    const group = data.columns.findIndex(column => column.id === config.group), x = data.columns.findIndex(column => column.id === config.x);
    const y = data.columns.findIndex(column => column.id === config.y);
    if (group < 0 || x < 0 || y < 0 || group === x || !isNumeric(data.columns[y]))
        throw new Error("Choose distinct grouping/category fields and a numeric value.");
    if (!data.rows.length || data.rows.length > 10000) throw new Error("Small multiples support 1–10,000 rows, without sampling.");
    /** @type {Map<string, {value: import("../contracts/workbench").Cell, rows: import("../contracts/workbench").Cell[][], categories: Set<string>}>} */
    const groups = new Map(); let minimum = 0, maximum = 0;
    for (const row of data.rows) {
        const key = JSON.stringify(row[group]), facet = groups.get(key) ?? { value: row[group], rows: [], categories: new Set() };
        const category = JSON.stringify(row[x]);
        if (facet.categories.has(category)) throw new Error("A facet contains repeated categories. Aggregate explicitly in the source query before plotting.");
        if (row[x] === null || row[y] === null) throw new Error("Small-multiple coordinates cannot be null. Resolve missing values explicitly; no rows are omitted.");
        const value = Number(decimalAdd(row[y], "0"));
        if (!Number.isFinite(value)) throw new Error("A small-multiple value exceeds the chart coordinate range.");
        minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
        facet.categories.add(category); facet.rows.push(row); groups.set(key, facet);
        if (groups.size > 8) throw new Error("Choose at most eight groups for small multiples. No groups were sampled.");
    }
    if (!Number.isFinite(maximum - minimum)) throw new Error("The common value-axis span exceeds the chart coordinate range.");
    return { facets: [...groups.values()].map(({ value, rows }) => ({ value, rows })), minimum, maximum: minimum === maximum ? minimum + 1 : maximum };
}
