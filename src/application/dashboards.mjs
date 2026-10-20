import { createHash, randomUUID } from "node:crypto";
import { fail, validateQuery, validateParameters } from "./policy.mjs";
import { generateBuilderQuery, validateBuilderDraft, builderDataType } from "../integrations/query-builder.mjs";
import { parameterDefinitions } from "./query-library.mjs";
import { evaluateAssertions, validateAssertions } from "../shared/result-assertions.mjs";
import { decimalAdd, matrixResult } from "../shared/result-analysis.mjs";
import { prepareFacets, prepareWaterfall } from "../shared/advanced-visuals.mjs";
import { resolveDashboardVisual } from "../shared/dashboard-visual.mjs";
import { validateChartConfig, prepareChart } from "../shared/chart-data.mjs";

export const DASHBOARD_LIMITS = Object.freeze({
    dashboards: 30, pages: 10, tiles: 48, filters: 16,
    snapshotRows: 10000, snapshotColumns: 64, snapshotBytes: 1_200_000,
    snapshots: 2000, totalBytes: 128 * 1024 * 1024, definitionBytes: 1_200_000, transferBytes: 192 * 1024,
});
const copy = value => structuredClone(value);
export const dashboardFingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
export function dashboardObject(value, keys, required = keys) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
        || required.some(key => !Object.hasOwn(value, key))) throw fail("INVALID_DASHBOARD", "Use the supported dashboard fields.");
}
export function dashboardText(value, label, limit = 120, empty = false) {
    if (typeof value !== "string" || value.length > limit || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
        throw fail("INVALID_DASHBOARD", `${label} must be ${empty ? "" : "nonempty "}text of at most ${limit} characters.`);
    return value;
}
export function dashboardId(value) {
    if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
        throw fail("INVALID_DASHBOARD", "Use a dashboard, page, tile or snapshot identifier from this workspace.");
    return value;
}
function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw fail("INVALID_DASHBOARD", "Use the current dashboard revision.");
}
export function validateDashboardSource(source) {
    dashboardObject(source, ["version", "connectionId", "connectionName", "model", "connectionKind", "query", "parameters", "parameterDefinitions", "builder", "documentId", "queryRevision", "fingerprint"],
        ["version", "connectionId", "connectionName", "model", "connectionKind", "query", "parameters", "queryRevision", "fingerprint"]);
    if (source.version !== 1) throw fail("INVALID_DASHBOARD", "Unsupported dashboard source version.");
    dashboardText(source.connectionId, "Connection", 512); dashboardText(source.connectionName, "Connection name", 512);
    dashboardText(source.connectionKind, "Transport", 80); if (source.model !== null) dashboardText(source.model, "Model", 512);
    validateQuery(source.query); validateParameters(source.parameters, Boolean(source.parameterDefinitions));
    if (source.parameterDefinitions !== undefined) {
        parameterDefinitions(source.parameterDefinitions);
        for (const definition of Object.values(source.parameterDefinitions))
            dashboardObject(definition, ["type", "default", "required", "allowed_values", "description"], ["type"]);
    }
    if (source.builder !== undefined) validateBuilderDraft(source.builder);
    revision(source.queryRevision); dashboardText(source.fingerprint, "Source fingerprint", 64);
    if (!/^[a-f0-9]{64}$/.test(source.fingerprint)) throw fail("INVALID_DASHBOARD", "Invalid source fingerprint.");
    return copy(source);
}
function validateVisual(visual) {
    dashboardObject(visual, ["type", "chart", "advanced", "matrix", "valueColumn", "contextColumn", "units"], ["type", "units"]);
    if (!["table", "indicator", "bar", "line", "scatter", "waterfall", "small-multiples", "matrix"].includes(visual.type)) throw fail("INVALID_DASHBOARD", "Choose a supported dashboard visual.");
    for (const [key, types] of Object.entries({ chart: ["bar", "line", "scatter"], advanced: ["waterfall", "small-multiples"], matrix: ["matrix"], valueColumn: ["indicator"], contextColumn: ["indicator"] }))
        if (visual[key] !== undefined && !types.includes(visual.type))
            throw fail("INVALID_DASHBOARD", "Visual configuration must match its selected type.");
    dashboardText(visual.units, "Units", 120, true);
    if (visual.valueColumn !== undefined) dashboardText(visual.valueColumn, "Value column", 512);
    if (visual.contextColumn !== undefined) dashboardText(visual.contextColumn, "Indicator context column", 512);
    if (visual.type === "matrix") {
        dashboardObject(visual.matrix, ["row", "column", "value", "aggregation", "emphasizeNegative"]);
        for (const key of ["row", "column", "value"]) dashboardText(visual.matrix[key], "Matrix field", 512);
        if (visual.matrix.row === visual.matrix.column || !["none", "sum", "count"].includes(visual.matrix.aggregation) || typeof visual.matrix.emphasizeNegative !== "boolean")
            throw fail("INVALID_DASHBOARD", "Choose distinct matrix dimensions and an explicit aggregation.");
    }
    if (["waterfall", "small-multiples"].includes(visual.type)) {
        dashboardObject(visual.advanced, ["type", "x", "y", "group", "start"]);
        if (visual.advanced.type !== visual.type) throw fail("INVALID_DASHBOARD", "The advanced visual type must match.");
        dashboardText(visual.advanced.x, "Category column", 512); dashboardText(visual.advanced.y, "Value column", 512);
        dashboardText(visual.advanced.group, "Grouping column", 512, visual.type === "waterfall");
        dashboardText(visual.advanced.start, "Waterfall starting amount", 1000);
        decimalAdd(visual.advanced.start, "0");
    }
    if (["bar", "line", "scatter"].includes(visual.type)) {
        validateChartConfig(visual.chart, "INVALID_DASHBOARD");
        if (visual.chart.type !== visual.type)
            throw fail("INVALID_DASHBOARD", "Choose a matching chart configuration.");
    }
    return copy(visual);
}
function validateVisualData(visual, snapshot) {
    visual = resolveDashboardVisual(visual, snapshot.columns);
    if (visual.type === "waterfall") prepareWaterfall(snapshot, visual.advanced);
    else if (visual.chart) prepareChart(snapshot, visual.chart);
    else if (visual.type === "small-multiples") prepareFacets(snapshot, visual.advanced);
    else if (visual.type === "matrix") matrixResult(snapshot, visual.matrix.row, visual.matrix.column, visual.matrix.value, visual.matrix.aggregation);
    else if (visual.type === "indicator" && (snapshot.rows.length !== 1 || !snapshot.columns.some(column => column.id === visual.valueColumn)))
        throw fail("DASHBOARD_VISUAL_CHANGED", "An indicator needs exactly one captured row and its selected value column.");
}
function validateDashboard(board) {
    dashboardObject(board, ["id", "title", "revision", "favorite", "archived", "pages", "filters", "tiles", "release"],
        ["id", "title", "revision", "favorite", "archived", "pages", "filters", "tiles"]);
    dashboardId(board.id); dashboardText(board.title, "Dashboard title"); revision(board.revision);
    if (board.release) {
        dashboardObject(board.release, ["sourceId", "sourceRevision", "reviewedAt", "reviewer"]);
        dashboardId(board.release.sourceId); revision(board.release.sourceRevision); dashboardText(board.release.reviewer, "Review label", 120);
        if (typeof board.release.reviewedAt !== "string" || !Number.isFinite(Date.parse(board.release.reviewedAt)))
            throw fail("INVALID_DASHBOARD", "Invalid release review timestamp.");
    }
    if (typeof board.favorite !== "boolean" || typeof board.archived !== "boolean") throw fail("INVALID_DASHBOARD", "Dashboard flags must be booleans.");
    if (!Array.isArray(board.pages) || !board.pages.length || board.pages.length > DASHBOARD_LIMITS.pages
        || !Array.isArray(board.tiles) || board.tiles.length > DASHBOARD_LIMITS.tiles
        || !Array.isArray(board.filters) || board.filters.length > DASHBOARD_LIMITS.filters)
        throw fail("DASHBOARD_LIMIT", "Each dashboard supports 10 pages, 48 tiles and 16 filters.");
    const ids = new Set();
    const unique = id => { dashboardId(id); if (ids.has(id)) throw fail("INVALID_DASHBOARD", "Dashboard identifiers must be unique."); ids.add(id); };
    board.pages.forEach(page => { dashboardObject(page, ["id", "title"]); unique(page.id); dashboardText(page.title, "Page title", 80); });
    board.filters.forEach(filter => {
        dashboardObject(filter, ["id", "label", "type", "value"]); unique(filter.id); dashboardText(filter.label, "Filter label", 80);
        if (!["text", "number", "date", "boolean"].includes(filter.type)) throw fail("INVALID_DASHBOARD", "Choose a typed dashboard filter.");
        dashboardText(filter.value, "Filter value", 2000, true);
        filterValue(filter);
    });
    board.tiles.forEach(tile => {
        dashboardObject(tile, ["id", "pageId", "title", "description", "width", "height", "note", "source", "unboundSource", "visual", "mappings", "snapshotId", "previousSnapshotIds", "archived", "assertions", "crossFilterId"],
            ["id", "pageId", "title", "width", "height", "visual", "mappings", "previousSnapshotIds"]);
        unique(tile.id); dashboardText(tile.title, "Tile title");
        if (tile.description !== undefined) dashboardText(tile.description, "Tile explanation", 600, true);
        if (!board.pages.some(page => page.id === tile.pageId)) throw fail("INVALID_DASHBOARD", "Choose an existing dashboard page.");
        if (![4, 6, 8, 12].includes(tile.width) || ![160, 240, 360, 480, 600].includes(tile.height)) throw fail("INVALID_DASHBOARD", "Choose a supported tile size.");
        if (tile.archived !== undefined && typeof tile.archived !== "boolean") throw fail("INVALID_DASHBOARD", "Tile archived must be a boolean.");
        validateVisual(tile.visual);
        if (tile.crossFilterId !== undefined && (!board.filters.some(filter => filter.id === tile.crossFilterId) || !["bar", "line"].includes(tile.visual.type) || tile.note !== undefined))
            throw fail("INVALID_DASHBOARD", "Chart interactions require an existing shared filter and a bar/line visual.");
        if (tile.assertions !== undefined) {
            validateAssertions(tile.assertions);
            if (tile.note !== undefined || (!tile.source && !tile.unboundSource))
                throw fail("INVALID_DASHBOARD", "Assertions require a refreshable query source.");
        }
        if (tile.note !== undefined) {
            dashboardText(tile.note, "Note", 16000, true);
            if (tile.source || tile.unboundSource || tile.snapshotId || tile.mappings.length) throw fail("INVALID_DASHBOARD", "Notes do not execute queries or receive data filters.");
        }
        if (tile.source) validateDashboardSource(tile.source);
        if (tile.unboundSource) {
            validateDashboardSource(tile.unboundSource);
            if (tile.source) throw fail("INVALID_DASHBOARD", "A tile cannot be both bound and unbound.");
        }
        if (tile.snapshotId) dashboardId(tile.snapshotId);
        if (!Array.isArray(tile.previousSnapshotIds) || tile.previousSnapshotIds.length > 3) throw fail("INVALID_DASHBOARD", "Tiles retain three previous captures.");
        if (new Set(tile.previousSnapshotIds).size !== tile.previousSnapshotIds.length || tile.previousSnapshotIds.includes(tile.snapshotId))
            throw fail("INVALID_DASHBOARD", "Current and previous captures must be distinct.");
        tile.previousSnapshotIds.forEach(dashboardId);
        if (!Array.isArray(tile.mappings) || tile.mappings.length > DASHBOARD_LIMITS.filters) throw fail("INVALID_DASHBOARD", "Invalid tile filter mappings.");
        const parameters = new Set();
        tile.mappings.forEach(mapping => {
            dashboardObject(mapping, ["filterId", "parameter"]);
            const filter = board.filters.find(item => item.id === mapping.filterId), definition = dashboardTargets(tile.source ?? tile.unboundSource).find(target => target.name === mapping.parameter);
            if (!filter || !definition || parameters.has(mapping.parameter) || definition.type !== filter.type)
                throw fail("INVALID_DASHBOARD", "Map each filter to one distinct, matching typed source parameter. Unmapped tiles remain independent.");
            parameters.add(mapping.parameter);
        });
    });
    return copy(board);
}
export function dashboardDefinition(board) {
    const definition = validateDashboard(board);
    delete definition.release;
    definition.tiles.forEach(tile => {
        delete tile.snapshotId; tile.previousSnapshotIds = [];
        if (tile.source) { tile.unboundSource = tile.source; delete tile.source; }
    });
    const result = { format: "dax-workbench-dashboard", version: 1, dashboard: definition };
    if (bytes(result) > DASHBOARD_LIMITS.transferBytes)
        throw fail("DASHBOARD_EXPORT_LIMIT", "Definition transfer supports 192 KiB. Split large definitions before exporting; nothing was omitted.");
    return result;
}
export function filterValue(filter) {
    if (filter.type === "number") {
        if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(filter.value) || !Number.isFinite(Number(filter.value)))
            throw fail("INVALID_DASHBOARD", "Numeric filters require a finite decimal number.");
        const canonical = text => {
            const [, sign, whole, fraction = "", exponent = "0"] = /^([+-]?)(\d*)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
            const digits = (whole + fraction).replace(/^0+/, "");
            const trimmed = digits.replace(/0+$/, "");
            return trimmed ? `${sign === "-" ? "-" : ""}${trimmed}e${Number(exponent) - fraction.length + digits.length - trimmed.length}` : "0";
        };
        if (canonical(filter.value) !== canonical(String(Number(filter.value))))
            throw fail("INVALID_DASHBOARD", "This numeric filter loses decimal precision. Use a typed text parameter or a more precise query literal instead.");
        return Number(filter.value);
    }
    if (filter.type === "boolean") {
        if (!["true", "false"].includes(filter.value)) throw fail("INVALID_DASHBOARD", "Boolean filters use true or false.");
        return filter.value === "true";
    }
    if (filter.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(filter.value) || !Number.isFinite(Date.parse(filter.value)) || new Date(filter.value).toISOString().slice(0, 10) !== filter.value))
        throw fail("INVALID_DASHBOARD", "Date filters use a valid YYYY-MM-DD date.");
    return filter.value;
}
export function dashboardTargets(source) {
    const targets = Object.entries(source?.parameterDefinitions ?? {}).map(([name, definition]) => ({ name, type: definition.type, label: name }));
    for (const field of source?.builder?.fields ?? []) {
        if (field.kind !== "column") continue;
        const kind = builderDataType(field);
        const type = /date/i.test(kind) ? "date" : /bool/i.test(kind) ? "boolean" : /int|decimal|currency|double|float|numeric|number/i.test(kind) ? "number" : "text";
        targets.push({ name: `field:${field.id}`, label: `${field.table}[${field.name}]`, type });
    }
    return targets;
}
export function tileExecution(board, tile) {
    if (!tile.source || tile.archived) throw fail("DASHBOARD_SNAPSHOT_ONLY", "This tile has no refreshable query source.");
    const source = copy(tile.source), executedFilters = [];
    for (const mapping of tile.mappings) {
        const filter = board.filters.find(item => item.id === mapping.filterId);
        const value = filterValue(filter);
        if (mapping.parameter.startsWith("field:") && source.builder) {
            const field = source.builder.fields.find(field => `field:${field.id}` === mapping.parameter && field.kind === "column");
            if (!field) throw fail("INVALID_DASHBOARD", "The mapped builder field is no longer available.");
            source.builder.filters.push({ id: `dashboard:${filter.id}`, field: copy(field), operator: "Is", value: String(value), enabled: true });
        } else source.parameters[mapping.parameter] = value;
        executedFilters.push({ label: filter.label, parameter: mapping.parameter, value });
    }
    if (source.builder && tile.mappings.some(mapping => mapping.parameter.startsWith("field:")))
        source.query = generateBuilderQuery(source.builder).query;
    const fingerprintSource = copy(source);
    if (fingerprintSource.builder) fingerprintSource.builder.filters = fingerprintSource.builder.filters.map(({ id: _id, ...filter }) => filter);
    return { source, executedFilters, fingerprint: dashboardFingerprint({ source: fingerprintSource, executedFilters,
        ...(tile.assertions?.length ? { assertions: tile.assertions } : {}) }) };
}
export function validateDashboardSnapshot(snapshot) {
    dashboardObject(snapshot, ["version", "id", "capturedAt", "durationMs", "runId", "resultSetId", "source", "executedFilters", "columns", "rows", "truncated", "origin", "sourceDescription", "checks"],
        ["version", "id", "capturedAt", "executedFilters", "columns", "rows", "truncated", "origin"]);
    dashboardId(snapshot.id);
    if (snapshot.durationMs !== undefined && (!Number.isFinite(snapshot.durationMs) || snapshot.durationMs < 0))
        throw fail("INVALID_DASHBOARD", "Query duration must be a nonnegative number of milliseconds.");
    dashboardText(snapshot.capturedAt, "Capture time", 30);
    if (snapshot.version !== 1 || !["run", "artifact"].includes(snapshot.origin) || typeof snapshot.truncated !== "boolean"
        || !Number.isFinite(Date.parse(snapshot.capturedAt))) throw fail("INVALID_DASHBOARD", "Invalid snapshot provenance.");
    if (snapshot.source) validateDashboardSource(snapshot.source);
    if (snapshot.runId !== undefined) dashboardId(snapshot.runId);
    if (snapshot.resultSetId !== undefined) dashboardText(snapshot.resultSetId, "Result set", 128);
    if (snapshot.sourceDescription !== undefined) dashboardText(snapshot.sourceDescription, "Source description", 4000, true);
    if (!Array.isArray(snapshot.executedFilters) || snapshot.executedFilters.length > DASHBOARD_LIMITS.filters)
        throw fail("INVALID_DASHBOARD", "Invalid executed filter evidence.");
    snapshot.executedFilters.forEach(filter => {
        dashboardObject(filter, ["label", "parameter", "value"]);
        dashboardText(filter.label, "Filter label", 80); dashboardText(filter.parameter, "Filter target", 512);
        if (!(typeof filter.value === "string" && filter.value.length <= 2000) && typeof filter.value !== "boolean"
            && !(typeof filter.value === "number" && Number.isFinite(filter.value)))
            throw fail("INVALID_DASHBOARD", "Executed filters must contain bounded typed scalar values.");
    });
    if (!Array.isArray(snapshot.columns) || !snapshot.columns.length || snapshot.columns.length > DASHBOARD_LIMITS.snapshotColumns
        || !Array.isArray(snapshot.rows) || snapshot.rows.length > DASHBOARD_LIMITS.snapshotRows
        || bytes(snapshot) > DASHBOARD_LIMITS.snapshotBytes) throw fail("DASHBOARD_SNAPSHOT_LIMIT", "A dashboard capture supports 10,000 rows, 64 columns and 1.2 MB. Refine the query; no rows are sampled.");
    const ids = new Set();
    snapshot.columns.forEach(column => {
        dashboardText(column.id, "Column ID", 512); dashboardText(column.name, "Column name", 512); dashboardText(column.dataType, "Column type", 80);
        if (ids.has(column.id)) throw fail("INVALID_DASHBOARD", "Snapshot column IDs must be unique."); ids.add(column.id);
    });
    for (const row of snapshot.rows) if (!Array.isArray(row) || row.length !== snapshot.columns.length
        || row.some(cell => cell !== null && typeof cell !== "string" && typeof cell !== "boolean" && !(typeof cell === "number" && Number.isFinite(cell))))
        throw fail("INVALID_DASHBOARD", "Snapshot cells must preserve their exact typed values.");
    if (snapshot.checks !== undefined) {
        dashboardObject(snapshot.checks, ["version", "rules", "status", "results"]);
        validateAssertions(snapshot.checks.rules);
        if (snapshot.checks.version !== 1 || !["passed", "failed", "not-evaluated"].includes(snapshot.checks.status)
            || !Array.isArray(snapshot.checks.results) || snapshot.checks.results.length > 20)
            throw fail("INVALID_DASHBOARD", "Invalid captured assertion outcome.");
        if (snapshot.checks.results.length !== snapshot.checks.rules.length
            || snapshot.checks.results.some((result, index) => result.id !== snapshot.checks.rules[index].id))
            throw fail("INVALID_DASHBOARD", "Assertion outcomes must match the captured rule definitions.");
        snapshot.checks.results.forEach(result => {
            dashboardObject(result, ["id", "status", "message", "actual"], ["id", "status", "message"]);
            dashboardText(result.id, "Assertion ID", 80); dashboardText(result.message, "Assertion message", 1000);
            if (!["passed", "failed", "not-evaluated"].includes(result.status)) throw fail("INVALID_DASHBOARD", "Invalid assertion status.");
            if (result.actual !== undefined) dashboardText(result.actual, "Assertion value", 1100, true);
        });
        const status = snapshot.checks.results.some(result => result.status === "not-evaluated") ? "not-evaluated"
            : snapshot.checks.results.some(result => result.status === "failed") ? "failed" : "passed";
        if (snapshot.checks.status !== status || snapshot.truncated && snapshot.checks.results.some(result => result.status !== "not-evaluated"))
            throw fail("INVALID_DASHBOARD", "The overall assertion status must accurately describe its captured results.");
    }
    return copy(snapshot);
}

export class DashboardStore {
    constructor({ native, id }) {
        this.native = native; this.key = `dashboards:${id}`; this.snapshotPrefix = `dashboard-snapshot:${id}:`;
        this.value = null; this.revision = 0; this.queue = Promise.resolve();
    }
    async initialize() { await this.reload(); }
    async reload() {
        const saved = await this.native.request("store.read", { key: this.key });
        if (saved.revision < this.revision) return;
        if (saved.value === null && saved.revision === 0) this.value = { version: 1, homeId: null, entries: [], snapshots: [] };
        else {
            const value = saved.value;
            dashboardObject(value, ["version", "homeId", "entries", "snapshots"]);
            if (value.version !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.snapshots)
                || value.entries.length > DASHBOARD_LIMITS.dashboards || value.snapshots.length > DASHBOARD_LIMITS.snapshots)
                throw fail("DASHBOARD_CORRUPT", "The dashboard catalog is invalid. Existing records were not changed.");
            value.entries.forEach(validateDashboard);
            const ids = new Set();
            value.snapshots.forEach(item => {
                dashboardObject(item, ["id", "bytes", "ready", "fingerprint", "deleting", "digest"], ["id", "bytes", "ready"]);
                dashboardId(item.id);
                if (ids.has(item.id) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > DASHBOARD_LIMITS.snapshotBytes
                    || typeof item.ready !== "boolean" || (item.deleting !== undefined && typeof item.deleting !== "boolean")
                    || (item.digest !== undefined && !/^[a-f0-9]{64}$/.test(item.digest))
                    || (item.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(item.fingerprint)))
                    throw fail("DASHBOARD_CORRUPT", "The snapshot ledger is invalid. Existing records were not changed.");
                ids.add(item.id);
            });
            for (const board of value.entries) for (const tile of board.tiles) for (const id of [tile.snapshotId, ...tile.previousSnapshotIds].filter(Boolean))
                if (!value.snapshots.some(item => item.id === id && item.ready && !item.deleting))
                    throw fail("DASHBOARD_CORRUPT", "A tile references a missing or unpublished capture. Existing records were not changed.");
            if (new Set(value.entries.map(board => board.id)).size !== value.entries.length
                || (value.homeId !== null && !value.entries.some(board => board.id === value.homeId && !board.archived))
                || value.snapshots.reduce((sum, item) => sum + item.bytes, 0) > DASHBOARD_LIMITS.totalBytes
                || bytes(value) > DASHBOARD_LIMITS.definitionBytes)
                throw fail("DASHBOARD_CORRUPT", "The dashboard catalog exceeds its limits or contains invalid references.");
            this.value = copy(value);
        }
        this.revision = saved.revision;
    }
    catalog() {
        return { revision: this.revision, homeId: this.value.homeId,
            entries: this.value.entries.map(({ id, title, revision, favorite, archived }) => ({ id, title, revision, favorite, archived })),
            limits: { ...DASHBOARD_LIMITS } };
    }
    get(id) {
        dashboardId(id);
        const board = this.value.entries.find(entry => entry.id === id);
        if (!board) throw fail("DASHBOARD_NOT_FOUND", "This dashboard is no longer available. Reload the dashboard list.");
        return copy(board);
    }
    captureStatus(board) {
        return Object.fromEntries(board.tiles.map(tile => {
            const entry = this.value.snapshots.find(item => item.id === tile.snapshotId && item.ready);
            return [tile.id, !entry ? "missing" : !tile.source ? "snapshot-only"
                : entry.fingerprint === tileExecution(board, { ...tile, archived: false }).fingerprint ? "matching" : "changed"];
        }));
    }
    serialize(fn) {
        const operation = this.queue.then(fn);
        this.queue = operation.then(() => {}, () => {});
        return operation;
    }
    async writeProtected(key, expectedRevision, value) {
        try { return await this.native.request("store.write", { key, expectedRevision, value }); }
        catch (error) {
            if (["NATIVE_RESPONSE_TIMEOUT", "NATIVE_DISCONNECTED", "NATIVE_WRITE_FAILED", "NATIVE_UNAVAILABLE", "PROTOCOL_ERROR", "NATIVE_CLOSED"].includes(error.code)) {
                try {
                    const saved = await this.native.request("store.read", { key });
                    if (saved.revision === expectedRevision + 1 && dashboardFingerprint(saved.value) === dashboardFingerprint(value))
                        return { revision: saved.revision };
                } catch {
                    throw fail("DASHBOARD_COMMIT_UNCERTAIN", "The save acknowledgement was lost. Data was retained; reopen the dashboard before retrying.");
                }
                throw fail("DASHBOARD_COMMIT_UNCERTAIN", "The save could not be reconciled. Reload before retrying; do not assume it was discarded.");
            }
            if (error.code === "STORE_CONFLICT") throw fail("REVISION_CONFLICT", "Dashboards changed in another process. Reload before saving.");
            throw error;
        }
    }
    async commit(next, expectedRevision = this.revision) {
        if (next.entries.length > DASHBOARD_LIMITS.dashboards || bytes(next) > DASHBOARD_LIMITS.definitionBytes)
            throw fail("DASHBOARD_LIMIT", "Dashboard definitions exceed 30 dashboards or 1.2 MB. Archive is recoverable and still counts toward this limit.");
        const result = await this.writeProtected(this.key, expectedRevision, next);
        if (result.revision >= this.revision) { this.value = next; this.revision = result.revision; }
    }
    create(title, expectedRevision) {
        return this.serialize(async () => {
            await this.reload(); revision(expectedRevision);
            if (expectedRevision !== this.revision) throw fail("REVISION_CONFLICT", "The dashboard list changed. Reload before creating.");
            const board = { id: randomUUID(), title: dashboardText(title, "Dashboard title"), revision: 0, favorite: false, archived: false,
                pages: [{ id: randomUUID(), title: "Overview" }], tiles: [], filters: [] };
            const next = copy(this.value); next.entries.push(board); next.homeId ??= board.id;
            await this.commit(next); return copy(board);
        });
    }
    importDefinition(value, expectedRevision) {
        dashboardObject(value, ["format", "version", "dashboard"]);
        if (value.format !== "dax-workbench-dashboard" || value.version !== 1 || bytes(value) > DASHBOARD_LIMITS.transferBytes)
            throw fail("INVALID_DASHBOARD", "Choose a version-1 dashboard definition under 192 KiB.");
        const board = validateDashboard(value.dashboard);
        if (board.release || board.tiles.some(tile => tile.source || tile.snapshotId || tile.previousSnapshotIds.length))
            throw fail("INVALID_DASHBOARD", "Definitions cannot import captures, bound connections, or review claims.");
        return this.serialize(async () => {
            await this.reload(); revision(expectedRevision);
            if (expectedRevision !== this.revision) throw fail("REVISION_CONFLICT", "Reload the dashboard list before importing.");
            const mapping = new Map([...board.pages, ...board.filters, ...board.tiles].map(item => [item.id, randomUUID()]));
            board.id = randomUUID(); board.revision = 0; board.archived = false; board.favorite = false;
            board.pages.forEach(page => { page.id = mapping.get(page.id); });
            board.filters.forEach(filter => { filter.id = mapping.get(filter.id); });
            board.tiles.forEach(tile => {
                tile.id = mapping.get(tile.id); tile.pageId = mapping.get(tile.pageId);
                tile.mappings.forEach(item => { item.filterId = mapping.get(item.filterId); });
                if (tile.crossFilterId) tile.crossFilterId = mapping.get(tile.crossFilterId);
            });
            validateDashboard(board);
            const next = copy(this.value); next.entries.push(board); next.homeId ??= board.id;
            await this.commit(next); return copy(board);
        });
    }
    freeze(id, expectedRevision, reviewer) {
        dashboardText(reviewer, "Review label", 120);
        return this.serialize(async () => {
            await this.reload(); const original = this.get(id); revision(expectedRevision);
            if (original.revision !== expectedRevision || original.release) throw fail("REVISION_CONFLICT", "Choose the current editable dashboard to freeze.");
            const status = this.captureStatus(original);
            if (original.tiles.some(tile => !tile.archived && tile.note === undefined
                && (!tile.snapshotId || tile.unboundSource || status[tile.id] === "changed")))
                throw fail("DASHBOARD_STALE", "Every visible data tile must have a matching saved capture before freezing. Refresh changed sources explicitly.");
            const next = copy(this.value), baseline = this.revision;
            for (const tile of original.tiles.filter(tile => !tile.archived && tile.snapshotId)) {
                const snapshot = await this.snapshot(tile.snapshotId);
                validateVisualData(tile.visual, snapshot);
                if (tile.assertions?.length) {
                    const checks = await evaluateAssertions(snapshot, tile.assertions, !snapshot.truncated && snapshot.origin === "run");
                    if (checks.status !== "passed") throw fail("DASHBOARD_ASSERTION_FAILED", "Every configured assertion must pass on its complete capture before freezing.");
                }
            }
            const board = { ...original, id: randomUUID(), title: `${original.title.slice(0, 109)} (reviewed)`, revision: 0, favorite: false, archived: false,
                release: { sourceId: original.id, sourceRevision: original.revision, reviewedAt: new Date().toISOString(), reviewer } };
            validateDashboard(board);
            next.entries.push(board);
            await this.commit(next, baseline); return copy(board);
        });
    }
    update(id, expectedRevision, edit) {
        return this.serialize(async () => {
            await this.reload(); const board = this.get(id); revision(expectedRevision);
            if (board.revision !== expectedRevision) throw fail("REVISION_CONFLICT", "This dashboard changed. Reload before saving; your draft is preserved.");
            const next = copy(this.value), baseline = this.revision;
            const frozen = board.release ? JSON.stringify({ ...board, favorite: false, archived: false }) : null;
            await edit(board);
            if (frozen && frozen !== JSON.stringify({ ...board, favorite: false, archived: false }))
                throw fail("DASHBOARD_FROZEN", "Reviewed releases are immutable. Only favorite/archive status may change; edit the original dashboard instead.");
            board.revision++; validateDashboard(board);
            next.entries[next.entries.findIndex(entry => entry.id === id)] = board;
            if (board.archived && next.homeId === id) next.homeId = null;
            await this.commit(next, baseline); return copy(board);
        });
    }
    setHome(id, expectedRevision) {
        return this.serialize(async () => {
            await this.reload(); const board = this.get(id); revision(expectedRevision);
            if (this.revision !== expectedRevision || board.archived) throw fail("REVISION_CONFLICT", "Reload before selecting a home dashboard.");
            const next = copy(this.value); next.homeId = id; await this.commit(next); return this.catalog();
        });
    }
    remove(id, expectedRevision, beforeCommit) {
        return this.serialize(async () => {
            await this.reload(); const board = this.get(id); revision(expectedRevision);
            if (board.revision !== expectedRevision)
                throw fail("REVISION_CONFLICT", "This dashboard changed. Reload and review it again before deleting.");
            const next = copy(this.value), baseline = this.revision;
            next.entries = next.entries.filter(entry => entry.id !== id);
            if (next.homeId === id) next.homeId = null;
            beforeCommit?.();
            await this.commit(next, baseline);
            return { deletedId: id, catalog: this.catalog() };
        });
    }
    async snapshot(id) {
        dashboardId(id);
        if (!this.value.snapshots.some(item => item.id === id && item.ready && !item.deleting)) throw fail("DASHBOARD_SNAPSHOT_MISSING", "The saved capture is unavailable. Refresh this tile explicitly.");
        const result = await this.native.request("store.read", { key: this.snapshotPrefix + id });
        if (!result.value) throw fail("DASHBOARD_SNAPSHOT_MISSING", "The saved capture could not be read. The source query has not been rerun.");
        const snapshot = validateDashboardSnapshot(result.value);
        if (snapshot.id !== id) throw fail("DASHBOARD_CORRUPT", "Snapshot identity mismatch.");
        const descriptor = this.value.snapshots.find(item => item.id === id);
        if (descriptor?.digest && descriptor.digest !== dashboardFingerprint(snapshot))
            throw fail("DASHBOARD_CORRUPT", "The saved capture does not match its recorded digest. It was not rerun or replaced.");
        return snapshot;
    }
    capture(boardId, tileId, snapshot, expectedFingerprint, addition, beforePublish) {
        const captured = validateDashboardSnapshot(snapshot);
        return this.serialize(async () => {
            await this.reload(); let board = this.get(boardId), tile = board.tiles.find(item => item.id === tileId);
            const reserved = copy(this.value), baseline = this.revision;
            if (addition) {
                revision(addition.expectedRevision);
                if (board.revision !== addition.expectedRevision || tile) throw fail("REVISION_CONFLICT", "Reload the dashboard before pinning.");
                tile = copy(addition.tile); board.tiles.push(tile); validateDashboard(board);
            }
            if (!tile || tile.archived || board.archived || board.release || (expectedFingerprint && tileExecution(board, tile).fingerprint !== expectedFingerprint))
                throw fail("REVISION_CONFLICT", "The tile or its filters changed during capture. The previous visual was preserved.");
            validateVisualData(tile.visual, captured);
            if (tile.snapshotId && captured.origin === "run") {
                const previous = await this.snapshot(tile.snapshotId);
                if (JSON.stringify(previous.columns.map(column => [column.id, column.name, column.dataType]))
                    !== JSON.stringify(captured.columns.map(column => [column.id, column.name, column.dataType])))
                    throw fail("DASHBOARD_SCHEMA_CHANGED", "Returned columns changed. The previous visual was preserved; inspect the query and pin a new tile.");
            }
            if (this.value.snapshots.some(item => item.id === captured.id)) throw fail("REVISION_CONFLICT", "This capture already exists.");
            if (this.value.snapshots.length >= DASHBOARD_LIMITS.snapshots || this.value.snapshots.reduce((sum, item) => sum + item.bytes, 0) + bytes(captured) > DASHBOARD_LIMITS.totalBytes)
                throw fail("DASHBOARD_STORAGE_LIMIT", "Saved dashboard captures reached the 128 MiB or 2,000-capture limit. Remove unused captures before refreshing.");
            // Reserve before writing so an interrupted save is discoverable and bounded.
            reserved.snapshots.push({ id: captured.id, bytes: bytes(captured), ready: false, digest: dashboardFingerprint(captured),
                ...(expectedFingerprint ? { fingerprint: expectedFingerprint } : {}) });
            await this.commit(reserved, baseline);
            await this.writeProtected(this.snapshotPrefix + captured.id, 0, captured);
            await this.reload(); board = this.get(boardId); tile = board.tiles.find(item => item.id === tileId);
            if (!this.value.snapshots.some(item => item.id === captured.id && !item.deleting))
                throw fail("REVISION_CONFLICT", "Capture cleanup interrupted this save. No tile was changed; refresh again.");
            if (addition) {
                if (board.revision !== addition.expectedRevision || tile) throw fail("REVISION_CONFLICT", "The dashboard changed during pinning. No tile was added.");
                tile = copy(addition.tile); board.tiles.push(tile);
            }
            if (!tile || tile.archived || board.archived || board.release || (expectedFingerprint && tileExecution(board, tile).fingerprint !== expectedFingerprint))
                throw fail("REVISION_CONFLICT", "The tile changed while saving. The previous visual was preserved; the unused capture can be removed.");
            beforePublish?.();
            validateVisualData(tile.visual, captured);
            if (tile.snapshotId) tile.previousSnapshotIds = [tile.snapshotId, ...tile.previousSnapshotIds].slice(0, 3);
            tile.snapshotId = captured.id; board.revision++;
            const next = copy(this.value);
            next.entries[next.entries.findIndex(entry => entry.id === boardId)] = board;
            next.snapshots.find(item => item.id === captured.id).ready = true;
            await this.commit(next); return copy(board);
        });
    }
    duplicate(id, expectedRevision, tileId) {
        if (tileId) return this.update(id, expectedRevision, board => {
            const tile = board.tiles.find(tile => tile.id === tileId);
            if (!tile) throw fail("DASHBOARD_NOT_FOUND", "Choose an existing tile to duplicate.");
            board.tiles.push({ ...copy(tile), id: randomUUID(), title: `${tile.title.slice(0, 113)} (copy)`, archived: false });
        });
        return this.serialize(async () => {
            await this.reload(); const board = this.get(id);
            if (board.revision !== expectedRevision) throw fail("REVISION_CONFLICT", "Reload before duplicating the dashboard.");
            const mapping = new Map([...board.pages, ...board.filters, ...board.tiles].map(item => [item.id, randomUUID()]));
            board.id = randomUUID(); board.revision = 0; board.archived = false; board.favorite = false;
            board.title = `${board.title.slice(0, 113)} (copy)`;
            board.pages.forEach(page => { page.id = mapping.get(page.id); });
            board.filters.forEach(filter => { filter.id = mapping.get(filter.id); });
            board.tiles.forEach(tile => {
                tile.id = mapping.get(tile.id); tile.pageId = mapping.get(tile.pageId);
                tile.mappings.forEach(item => { item.filterId = mapping.get(item.filterId); });
                if (tile.crossFilterId) tile.crossFilterId = mapping.get(tile.crossFilterId);
            });
            validateDashboard(board);
            const next = copy(this.value); next.entries.push(board); await this.commit(next); return copy(board);
        });
    }
    restoreCapture(id, expectedRevision, tileId, snapshotId) {
        return this.update(id, expectedRevision, async board => {
            const tile = board.tiles.find(tile => tile.id === tileId);
            if (!tile || !tile.previousSnapshotIds.includes(snapshotId)) throw fail("DASHBOARD_SNAPSHOT_MISSING", "Choose a previous capture belonging to this tile.");
            await this.snapshot(snapshotId);
            tile.previousSnapshotIds = [tile.snapshotId, ...tile.previousSnapshotIds.filter(id => id !== snapshotId)].filter(Boolean).slice(0, 3);
            tile.snapshotId = snapshotId;
        });
    }
    cleanup() {
        return this.serialize(async () => {
            await this.reload();
            const used = new Set(this.value.entries.flatMap(board => board.tiles.flatMap(tile => [tile.snapshotId, ...tile.previousSnapshotIds])).filter(Boolean));
            const unused = this.value.snapshots.filter(item => !used.has(item.id));
            if (!unused.length) return { removed: 0 };
            const marked = copy(this.value);
            marked.snapshots.forEach(item => { if (!used.has(item.id)) item.deleting = true; });
            await this.commit(marked);
            for (const item of unused) {
                const saved = await this.native.request("store.read", { key: this.snapshotPrefix + item.id });
                await this.writeProtected(this.snapshotPrefix + item.id, saved.revision, null);
            }
            await this.reload();
            const removed = new Set(unused.map(item => item.id));
            const next = copy(this.value); next.snapshots = next.snapshots.filter(item => !removed.has(item.id));
            await this.commit(next); return { removed: unused.length };
        });
    }
}
