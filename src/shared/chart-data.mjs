import { isNumeric } from "./result-numbers.mjs";
import { resultColumnLabels } from "./result-columns.mjs";
import { resultValueText } from "./result-display.mjs";

export const CHART_LIMITS = Object.freeze({ filters: 8, values: 200, series: 32, points: 10000, configBytes: 65536 });
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const field = { type: "string", maxLength: 512 };
const cell = { type: ["string", "number", "boolean", "null"], maxLength: 32768 };
export const chartConfigSchema = object({
    type: { enum: ["bar", "line", "scatter"] }, x: field, y: field,
    aggregation: { enum: ["none", "sum", "average", "count"] }, legend: field,
    filters: { type: "array", maxItems: CHART_LIMITS.filters, items: object({
        column: field, operator: { enum: ["in", "notIn"] },
        values: { type: "array", maxItems: CHART_LIMITS.values, uniqueItems: true, items: cell },
    }) },
    hiddenSeries: { type: "array", maxItems: CHART_LIMITS.series, uniqueItems: true, items: cell },
}, ["type", "x", "y", "aggregation"]);
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const key = value => JSON.stringify(value);
const validField = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
const validCell = value => value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
    || typeof value === "string" && value.length <= 32768 && !value.includes("\0");
/**
 * Scope saved settings to the query version and returned schema, not positional column IDs alone.
 * @param {Pick<import("../contracts/workbench").Run, "documentId" | "connectionId" | "revision">} run
 * @param {Pick<import("../contracts/workbench").ResultSet, "id" | "columns">} result
 */
export function chartSourceKey(run, result) {
    return JSON.stringify([run.documentId, run.connectionId, run.revision, result.id,
        result.columns.map(column => [column.id, column.name, column.dataType])]);
}
/**
 * @param {import("../contracts/workbench").ChartConfig | null} config
 * @param {string | null | undefined} savedSource
 * @param {string} currentSource
 */
export function chartForSource(config, savedSource, currentSource) {
    if (savedSource) return savedSource === currentSource ? config : null;
    return config?.legend || config?.filters?.length || config?.hiddenSeries?.length ? null : config;
}
/** @returns {never} */
const fail = message => { throw Object.assign(new Error(message), { code: "INVALID_CHART" }); };
function values(list, limit) {
    if (!Array.isArray(list) || list.length > limit || list.some(value => !validCell(value))
        || new Set(list.map(key)).size !== list.length) fail(`Choose at most ${limit} distinct typed chart values.`);
}
/** @param {import("../contracts/workbench").ChartConfig} config */
function checkedConfig(config) {
    if (!plain(config) || Object.keys(config).some(name => !Object.hasOwn(chartConfigSchema.properties, name))
        || !["bar", "line", "scatter"].includes(config.type) || !["none", "sum", "average", "count"].includes(config.aggregation)
        || !validField(config.x) || !(validField(config.y) || config.aggregation === "count" && config.y === "")
        || config.legend !== undefined && !validField(config.legend))
        fail("Choose supported chart fields, a chart type and an aggregation.");
    if (config.type === "scatter" && config.aggregation !== "none") fail("Scatter requires no aggregation.");
    if (config.filters !== undefined) {
        if (!Array.isArray(config.filters) || config.filters.length > CHART_LIMITS.filters
            || new Set(config.filters.map(filter => filter?.column)).size !== config.filters.length)
            fail("Choose at most eight filters, one per field.");
        for (const filter of config.filters) {
            if (!plain(filter) || Object.keys(filter).some(name => !["column", "operator", "values"].includes(name))
                || !validField(filter.column) || !["in", "notIn"].includes(filter.operator)) fail("Choose a chart filter field and Include or Exclude.");
            values(filter.values, CHART_LIMITS.values);
        }
    }
    if (config.hiddenSeries !== undefined) values(config.hiddenSeries, CHART_LIMITS.series);
    if (new TextEncoder().encode(JSON.stringify(config)).length > CHART_LIMITS.configBytes) fail("Chart settings exceed 64 KiB. Choose fewer filter values.");
    return structuredClone(config);
}
/** @param {import("../contracts/workbench").ChartConfig} config */
export function validateChartConfig(config, code = "INVALID_CHART") {
    try { return checkedConfig(config); }
    catch (error) {
        if (error?.code === "INVALID_CHART") error.code = code;
        throw error;
    }
}
/** @param {import("../contracts/workbench").Cell} value @param {string} [dataType] */
export function chartValueLabel(value, dataType) {
    return value === null ? "(blank)" : value === "" ? '"" (empty text)' : resultValueText(value, dataType);
}
/**
 * @template {{ value: import("../contracts/workbench").Cell }} T
 * @param {T[]} items
 * @param {string} [dataType]
 * @returns {(T & { label: string })[]}
 */
function labels(items, dataType) {
    const distinct = [...new Map(items.map(item => [key(item.value), item.value])).values()];
    const counts = new Map(), used = new Set(), names = new Map();
    for (const value of distinct) { const label = chartValueLabel(value, dataType); counts.set(label, (counts.get(label) ?? 0) + 1); }
    distinct.forEach((value, index) => {
        let label = chartValueLabel(value, dataType);
        if (counts.get(label) > 1) label += ` (${value === null ? "blank" : typeof value})`;
        const base = label;
        let suffix = 2;
        while (used.has(label)) label = `${base} [${suffix++}]`;
        used.add(label); names.set(key(value), label);
    });
    return items.map(item => ({ ...item, label: names.get(key(item.value)) }));
}
/**
 * @param {{ columns: import("../contracts/workbench").Column[], rows: import("../contracts/workbench").Cell[][] }} data
 * @param {string} column
 */
export function chartFilterOptions(data, column) {
    const index = data.columns.findIndex(item => item.id === column);
    if (index < 0) fail("A chart filter field is missing from this result. Remove it or choose a returned field.");
    /** @type {Map<string, {value: import("../contracts/workbench").Cell}>} */
    const choices = new Map();
    for (const row of data.rows) if (!choices.has(key(row[index]))) choices.set(key(row[index]), { value: row[index] });
    return labels([...choices.values()], data.columns[index].dataType);
}
/**
 * @param {{ columns: import("../contracts/workbench").Column[], rows: import("../contracts/workbench").Cell[][] }} data
 * @param {import("../contracts/workbench").ChartConfig} config
 */
export function prepareChart(data, config) {
    validateChartConfig(config);
    const index = (id, role) => {
        const result = data.columns.findIndex(column => column.id === id);
        if (result < 0) fail(`${role} is missing from this result. Choose a returned field or remove the filter.`);
        return result;
    };
    const xi = index(config.x, "X field"), yi = config.aggregation === "count" ? -1 : index(config.y, "Y field");
    const li = config.legend ? index(config.legend, "Legend field") : -1;
    if (yi >= 0 && !isNumeric(data.columns[yi])) fail("Choose a numeric Y field, or use Count.");
    if (config.type === "scatter" && !isNumeric(data.columns[xi])) fail("Scatter requires a numeric X field.");
    const filters = (config.filters ?? []).map(filter => ({ index: index(filter.column, "Filter field"),
        exclude: filter.operator === "notIn", values: new Set(filter.values.map(key)) }));
    const filteredRows = data.rows.filter(row => filters.every(filter => filter.values.has(key(row[filter.index])) !== filter.exclude));
    const colorOrder = new Map();
    if (li >= 0) for (const row of data.rows) if (!colorOrder.has(key(row[li]))) colorOrder.set(key(row[li]), colorOrder.size);
    /** @type {Map<string, { key: string, value: import("../contracts/workbench").Cell, colorIndex: number, points: Array<{ category: number, x: import("../contracts/workbench").Cell, y: number, count: number, row: import("../contracts/workbench").Cell[] }> }>} */
    const series = new Map();
    /** @type {Array<{ value: import("../contracts/workbench").Cell }>} */
    const categories = [];
    const categoryIds = new Map(), groups = new Map();
    let skipped = 0, precision = false, pointCount = 0;
    for (const row of filteredRows) {
        const source = yi < 0 ? 1 : row[yi], x = row[xi];
        if (x === null || source === null || typeof source === "string" && !source.trim() || typeof source === "boolean"
            || !Number.isFinite(Number(source)) || config.type === "scatter" && (typeof x === "string" && !x.trim() || typeof x === "boolean" || !Number.isFinite(Number(x)))) {
            skipped++; continue;
        }
        const y = Number(source);
        if (typeof source === "string" || Math.abs(y) > Number.MAX_SAFE_INTEGER
            || config.type === "scatter" && (typeof x === "string" || Math.abs(Number(x)) > Number.MAX_SAFE_INTEGER)) precision = true;
        const value = li < 0 ? (config.aggregation === "count" ? "Count" : data.columns[yi].name) : row[li];
        const seriesKey = key(value);
        if (!series.has(seriesKey)) series.set(seriesKey, { key: seriesKey, value, colorIndex: colorOrder.get(seriesKey) ?? 0, points: [] });
        if (series.size > CHART_LIMITS.series) fail("More than 32 legend series. Filter the result or choose a lower-cardinality legend; no series were sampled.");
        const item = series.get(seriesKey);
        const categoryKey = config.aggregation === "none" && li < 0 ? `row:${pointCount}` : key(x);
        if (!categoryIds.has(categoryKey)) { categoryIds.set(categoryKey, categories.length); categories.push({ value: x }); }
        const category = categoryIds.get(categoryKey), groupKey = key([seriesKey, category]);
        const previous = groups.get(groupKey);
        if (previous && config.type !== "scatter" && config.aggregation === "none")
            fail("Multiple rows share an X value within a legend series. Choose Sum, Average or Count, or filter to a finer grain.");
        if (previous && config.aggregation !== "none") {
            previous.y += y; previous.count++;
            if (!Number.isFinite(previous.y)) fail("A chart aggregate exceeds the finite numeric range. Refine the query or use smaller units.");
        } else {
            const point = { category, x, y, count: 1, row };
            item.points.push(point); groups.set(groupKey, point); pointCount++;
        }
    }
    if (pointCount > CHART_LIMITS.points) fail(`${pointCount.toLocaleString()} chart points exceed the 10,000-point limit. Filter or aggregate; no rows were sampled.`);
    const hidden = new Set((config.hiddenSeries ?? []).map(key));
    const columnLabels = resultColumnLabels(data.columns);
    const plotted = labels([...series.values()], li >= 0 ? data.columns[li].dataType : undefined).map(item => ({ ...item,
        label: li < 0 && yi >= 0 ? columnLabels[yi] : item.label, visible: !hidden.has(item.key),
        points: item.points.map(point => ({ ...point, y: config.aggregation === "average" ? point.y / point.count : point.y })) }));
    return { series: plotted, categories: labels(categories, data.columns[xi].dataType), filteredRows, sourceRows: data.rows.length, pointCount, skipped, precision };
}
/**
 * Materialize only the displayed subset; never save hidden series or filtered-out rows.
 * @param {{ columns: import("../contracts/workbench").Column[], rows: import("../contracts/workbench").Cell[][] }} data
 * @param {import("../contracts/workbench").ChartConfig} config
 * @returns {Pick<import("../contracts/artifacts").ArtifactVisual, "config" | "columns" | "rows"> & { approximate: boolean, scope: string }}
 */
export function captureChart(data, config) {
    const prepared = prepareChart(data, config), visible = prepared.series.filter(series => series.visible);
    const scope = `${prepared.filteredRows.length} of ${data.rows.length} captured rows match ${config.filters?.length ?? 0} local filters; ${visible.length} of ${prepared.series.length} series visible. Filtered-out and hidden values are not included in this visual.`;
    if (config.aggregation === "none") {
        const ids = [...new Set([config.x, config.y, ...(config.legend ? [config.legend] : [])])];
        const indices = ids.map(id => data.columns.findIndex(column => column.id === id));
        const kept = new Set(visible.flatMap(series => series.points.map(point => point.row)));
        return { config: { type: config.type, x: config.x, y: config.y, aggregation: /** @type {const} */ ("none"),
            ...(config.legend ? { legend: config.legend } : {}) },
        columns: indices.map(index => data.columns[index]), rows: prepared.filteredRows.filter(row => kept.has(row)).map(row => indices.map(index => row[index])),
        approximate: false, scope };
    }
    const x = { ...data.columns.find(column => column.id === config.x), id: "category" };
    const y = { id: "value", name: config.aggregation === "count" ? "Count" : `${config.aggregation} of ${resultColumnLabels(data.columns)[data.columns.findIndex(column => column.id === config.y)]}`,
        dataType: config.aggregation === "count" ? "Int64" : "Double" };
    const legend = config.legend ? { ...data.columns.find(column => column.id === config.legend), id: "series" } : null;
    return { config: { type: config.type, x: x.id, y: y.id, aggregation: /** @type {const} */ ("none"), ...(legend ? { legend: legend.id } : {}) },
        columns: [x, y, ...(legend ? [legend] : [])],
        rows: visible.flatMap(series => series.points.map(point => [point.x, point.y, ...(legend ? [series.value] : [])])),
        approximate: config.aggregation !== "count", scope };
}
