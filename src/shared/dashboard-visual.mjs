const quoted = value => JSON.stringify(value.length > 96 ? `${value.slice(0, 93)}...` : value);
const alias = value => /^\[((?:[^\]]|\]\])*)\]$/.exec(value)?.[1].replace(/\]\]/g, "]") ?? value;

/**
 * @param {import("../contracts/workbench").Column[]} columns
 * @param {string | undefined} reference
 * @param {string} role
 */
export function resolveDashboardColumn(columns, reference, role) {
    const field = reference ?? "";
    const byId = columns.find(column => column.id === field);
    if (field && byId) return byId.id;
    let matches = field ? columns.filter(column => column.name === field) : [];
    // Only bracketed/unbracketed aliases are equivalent; never drop a table qualifier.
    if (!matches.length && field) matches = columns.filter(column => alias(column.name) === alias(field));
    if (matches.length === 1) return matches[0].id;
    const available = columns.slice(0, 8).map(column => `${quoted(column.name)} (${quoted(column.id)})`).join(", ");
    throw Object.assign(new Error(`${role} ${quoted(field)} ${matches.length ? "matches multiple returned columns" : "is not present in this capture"}. `
        + `Returned columns: ${available}${columns.length > 8 ? ", ..." : ""}. `
        + "Edit the tile to select an exact returned field, or give the query output a unique alias."), { code: "DASHBOARD_VISUAL_CHANGED" });
}

/**
 * Resolve only for this capture; saved references and provider metadata stay unchanged.
 * @param {import("../contracts/dashboards").DashboardVisual} visual
 * @param {import("../contracts/workbench").Column[]} columns
 * @returns {import("../contracts/dashboards").DashboardVisual}
 */
export function resolveDashboardVisual(visual, columns) {
    const field = (reference, role) => resolveDashboardColumn(columns, reference, role);
    if (visual.type === "indicator") return { ...visual, valueColumn: field(visual.valueColumn, "Indicator value field"),
        ...(visual.contextColumn === undefined ? {} : { contextColumn: field(visual.contextColumn, "Indicator context field") }) };
    if (visual.chart) return { ...visual, chart: { ...visual.chart,
        x: field(visual.chart.x, "Chart X field"),
        y: visual.chart.aggregation === "count" ? visual.chart.y : field(visual.chart.y, "Chart Y field"),
        ...(visual.chart.legend ? { legend: field(visual.chart.legend, "Legend field") } : {}),
        ...(visual.chart.filters ? { filters: visual.chart.filters.map(filter => ({ ...filter, column: field(filter.column, "Chart filter field") })) } : {}),
    } };
    if (visual.advanced) return { ...visual, advanced: { ...visual.advanced,
        x: field(visual.advanced.x, "Category field"), y: field(visual.advanced.y, "Numeric value field"),
        group: visual.type === "small-multiples" ? field(visual.advanced.group, "Grouping field") : visual.advanced.group,
    } };
    if (visual.matrix) return { ...visual, matrix: { ...visual.matrix,
        row: field(visual.matrix.row, "Matrix row field"), column: field(visual.matrix.column, "Matrix column field"),
        value: field(visual.matrix.value, "Matrix value field"),
    } };
    return { ...visual };
}
