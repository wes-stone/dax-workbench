import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { DISTRIBUTION_PROFILE } from "../shared/distribution-profile.mjs";
import { ACTIVE_STATUSES, DEFAULT_LIMITS, fail, requireId, validateLimits, validateParameters, validateQuery, safeError } from "./policy.mjs";
import { removeBuilderBlock, updateBuilderBlock } from "./builder-editor.mjs";
import { normalizeBuilder, validateBuilderSchema, generateBuilderQuery, searchBuilderSchema, builderReference } from "../integrations/query-builder.mjs";
import { AuthoringCoordinator } from "./authoring.mjs";
import { QUERY_AUTHORING_GUIDANCE } from "../contracts/authoring.mjs";
import { NativeResults } from "./native-results.mjs";
import { CONTEXT_VERSION, searchKnowledge, getKnowledge } from "./model-context.mjs";
import {
    createQueryLibrary, restoreQueryLibrary, libraryCatalog, libraryPreview, createLibraryCollection,
    saveLibraryEntry, findLibraryEntry, libraryReference, libraryConnection, ensureLibraryCollectionPath,
    organizeLibraryEntry, updateLibraryCollection, appendLibraryResearch,
    updateLibraryDocumentation, validateDocumentationRevision, documentationConflict, previewDocumentationReview,
} from "./query-library.mjs";
import { captureAnalysis, queryFingerprint, sharedAnalysisProjection, validateResearchRequest, validateAppendResearch } from "./research.mjs";
import { boundedResultPage, validateResultRead } from "./agent-results.mjs";
import { ArtifactsStore } from "./artifacts.mjs";
import { validateSaveArtifact } from "./artifacts-validation.mjs";
import { getWritingGuide } from "../shared/writing.mjs";
import { DashboardStore, DASHBOARD_LIMITS, dashboardId, dashboardObject, dashboardFingerprint, dashboardTargets, tileExecution, dashboardDefinition } from "./dashboards.mjs";
import { DashboardProposals } from "./dashboard-proposals.mjs";
import { evaluateAssertions } from "../shared/result-assertions.mjs";
import { resolveDashboardVisual } from "../shared/dashboard-visual.mjs";
import { ContentHistory } from "./content-history.mjs";
import { ContentReview } from "./content-review.mjs";
import { QueryProjects } from "./query-projects.mjs";
import { QuerySharing } from "./query-sharing.mjs";
import { chartSourceKey, validateChartConfig } from "../shared/chart-data.mjs";
import { PIVOT_LIMITS, pivotLayoutOnly, pivotSourceKey, restorePivotLayouts, validatePivotFields } from "../shared/pivot-config.mjs";
import { FILTER_VALUE_LIMITS, FILTER_MONTH_VALUE_LIMITS, filterValuesQuery, filterValueOption } from "./filter-values.mjs";
import { defaultFilterValueOrder, monthLabelKey } from "../shared/filter-value-order.mjs";
import { MODEL_PREVIEW_LIMITS, modelPreviewQuery } from "./model-preview.mjs";
import { CODE_FONTS, DEFAULT_CODE_FONT, DEFAULT_CODE_FONT_SIZE, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE } from "../shared/code-fonts.mjs";

const clone = value => structuredClone(value);
export function writingGuide(payload = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).some(key => !["template", "text"].includes(key))
        || (payload.template !== undefined && !["query", "research", "note", "journal"].includes(payload.template))
        || (payload.text !== undefined && (typeof payload.text !== "string" || payload.text.length > 196608)))
        throw fail("INVALID_WRITING_GUIDE", "Choose query, research, note or journal and supply at most 196608 characters of text. Only supplied text is reviewed.");
    return getWritingGuide(payload.template ?? "query", payload.text ?? "");
}
function validateLayout(layout) {
    if (!layout || typeof layout !== "object" || Array.isArray(layout)
        || Object.keys(layout).some(key => key !== "builderSide") || !["left", "right"].includes(layout.builderSide))
        throw fail("INVALID_LAYOUT", "Choose left or right for the query builder dock.");
    return { builderSide: layout.builderSide };
}
function validateResultSettings(settings) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)
        || Object.keys(settings).some(key => key !== "showFullColumnNames") || typeof settings.showFullColumnNames !== "boolean")
        throw fail("INVALID_RESULT_SETTINGS", "Choose whether to show full result column names.");
    return { showFullColumnNames: settings.showFullColumnNames };
}
function validateAppearance(appearance, current = { themeMode: "system", codeFont: DEFAULT_CODE_FONT, codeFontSize: DEFAULT_CODE_FONT_SIZE }) {
    if (!appearance || typeof appearance !== "object" || Array.isArray(appearance)
        || !Object.keys(appearance).length || Object.keys(appearance).some(key => !["themeMode", "codeFont", "codeFontSize"].includes(key)))
        throw fail("INVALID_APPEARANCE", "Choose a workbench theme, code font, or code font size.");
    const next = { ...current, ...appearance };
    if (!["system", "light", "dark"].includes(next.themeMode))
        throw fail("INVALID_APPEARANCE", "Choose System, Light, or Dark for the workbench theme.");
    if (typeof next.codeFont !== "string" || !Object.hasOwn(CODE_FONTS, next.codeFont))
        throw fail("INVALID_APPEARANCE", "Choose a code font from the available options.");
    if (!Number.isInteger(next.codeFontSize) || next.codeFontSize < MIN_CODE_FONT_SIZE || next.codeFontSize > MAX_CODE_FONT_SIZE)
        throw fail("INVALID_APPEARANCE", `Choose a whole-number code font size from ${MIN_CODE_FONT_SIZE} to ${MAX_CODE_FONT_SIZE} pixels.`);
    return { themeMode: next.themeMode, codeFont: next.codeFont, codeFontSize: next.codeFontSize };
}
function validateAgentReads(enabled) {
    if (typeof enabled !== "boolean")
        throw fail("INVALID_AGENT_PERMISSION", "Choose whether Copilot can run read-only queries.");
    return enabled;
}
function validateAgentResults(enabled) {
    if (typeof enabled !== "boolean")
        throw fail("INVALID_AGENT_RESULTS_PERMISSION", "Choose whether Copilot can analyze query results.");
    return enabled;
}
const makeDocument = (title = "Untitled query") => ({
    id: randomUUID(), title, query: "EVALUATE 'Demo Sales'", revision: 0,
    connectionId: "demo:contoso", parameters: {}, proposal: null,
});

export class Workbench extends EventEmitter {
    constructor({ id, native, artifactsRoot, integration = null, results }) {
        super(); this.id = requireId(id); this.native = native; this.artifactsRoot = artifactsRoot; this.integration = integration;
        this.dashboardProposals = new DashboardProposals(this);
        const document = makeDocument(DISTRIBUTION_PROFILE.id === "generic" ? "Contoso sales sample" : "Sales overview");
        this.state = {
            workbenchId: id, hostMode: integration ? "copilot-canvas" : "standalone", version: 0, activeDocumentId: document.id, documents: [document], closedDocuments: [], connections: [], schema: null,
            runs: [], limits: { ...DEFAULT_LIMITS }, selections: [], selectedObjects: [], agentReadEnabled: DISTRIBUTION_PROFILE.agentReadEnabled, schemaError: null, schemaLoading: false,
            agentResultsEnabled: DISTRIBUTION_PROFILE.agentResultsEnabled, agentResultReads: [], resultAccessRevision: 0,
            layout: { builderSide: "right" },
            resultSettings: { showFullColumnNames: false },
            pivotLayouts: [],
            appearance: { themeMode: "system", codeFont: DEFAULT_CODE_FONT, codeFontSize: DEFAULT_CODE_FONT_SIZE },
            library: createQueryLibrary(),
            chart: null, native: { available: false, message: "Connecting to the native companion..." },
            integration: { available: false, message: "No DAX MCP integration discovered. Local query files remain available." },
        };
        this.results = results ?? native.createResultStore?.({ id, artifactsRoot }) ?? new NativeResults({ native, id, artifactsRoot });
        this.artifacts = new ArtifactsStore({ native, artifactsRoot, id });
        this.projects = new QueryProjects(this);
        this.sharing = new QuerySharing(this);
        this.dashboards = new DashboardStore({ native, id });
        this.dashboardRefreshes = new Map();
        this.dashboardDeletions = new Set();
        this.contentReview = new ContentReview(this, (next, id) => this.#syncDocumentationReferences(next, id));
        this.cachedRuns = new Set(); this.cacheErrors = new Map(); this.resultLeases = new Map();
        this.running = new Map(); this.resultLoads = new Map(); this.storeRevision = 0; this.runVersions = new Map(); this.queue = Promise.resolve();
        this.libraryDirectory = null; this.initializing = null; this.initialized = false;
        this.sharedAnalysis = null;
        this.identitySession = randomUUID(); this.registryGeneration = 0; this.providerGeneration = 0;
        this.metadataGeneration = 0; this.schemaRequestGeneration = 0; this.schemaProvenance = null; this.closed = false;
        this.authoring = new AuthoringCoordinator();
        this.onNotification = notification => this.#notification(notification);
        this.onUnavailable = error => {
            this.#invalidateSchema("provider");
            this.state.native = { available: false, message: safeError(error).message };
            this.state.selections = [];
            for (const run of this.state.runs) if (ACTIVE_STATUSES.has(run.status)) run.status = "interrupted";
            this.publish();
        };
        this.onNativeStatus = status => {
            this.#invalidateSchema("provider");
            this.state.native = { available: status?.available === true,
                ...(typeof status?.version === "string" ? { version: status.version } : {}),
                message: status?.available === true ? "Native companion reconnected. Refresh model metadata before authoring." : "Native companion unavailable." };
            this.state.selections = []; this.publish();
        };
        this.onRegistryInvalidated = () => {
            this.#invalidateSchema("registry");
            this.state.selections = []; this.publish();
        };
        this.onRegistryReplaced = connections => {
            this.#invalidateSchema("registry");
            this.state.connections = clone(connections);
            if (this.native.connectionDiscovery) this.state.connectionDiscovery = clone(this.native.connectionDiscovery);
            this.state.selections = []; this.publish();
        };
        native.on("notification", this.onNotification); native.on("unavailable", this.onUnavailable); native.on("status", this.onNativeStatus);
        native.on("workbench.registry.invalidated", this.onRegistryInvalidated); native.on("workbench.registry.replaced", this.onRegistryReplaced);
    }
    async initialize() {
        if (this.initialized) return;
        if (this.initializing) return this.initializing;
        this.initializing = this.#initialize();
        try { await this.initializing; } finally { this.initializing = null; }
    }
    async #initialize() {
        try {
            await this.native.start();
            const health = await this.native.request("health");
            if (this.results.nativeCache && (health.engine !== "rust" || health.capabilities?.resultCache !== 1))
                throw fail("ENGINE_MISMATCH", "This canvas requires the matching Rust engine. Rebuild and reinstall the workbench.");
            this.#invalidateSchema("provider");
            this.state.native = { available: true, version: health.version, message: this.results.nativeCache ? "Rust engine connected. Microsoft model adapters ready." : "Native companion connected." };
            const saved = await this.native.request("store.read", { key: `workbench:${this.id}` });
            this.storeRevision = saved.revision;
            if (saved.value) {
                this.state.agentReadEnabled = false; this.state.agentResultsEnabled = false;
                if (saved.value.schemaVersion !== 1) throw fail("STATE_VERSION", "This saved workbench version is not supported.");
                const { documents, activeDocumentId, limits, chart, selectedObjects, runIds } = saved.value;
                if (!Array.isArray(documents) || !documents.length) throw fail("STATE_CORRUPT", "Saved workbench documents are invalid.");
                this.state.documents = documents; this.state.activeDocumentId = activeDocumentId;
                this.state.closedDocuments = saved.value.closedDocuments ?? [];
                this.state.limits = validateLimits(limits); this.state.chart = chart; this.state.selectedObjects = selectedObjects ?? [];
                this.state.chartSource = saved.value.chartSource ?? null;
                this.state.pivotLayouts = restorePivotLayouts(saved.value.pivotLayouts ?? []);
                if (saved.value.layout !== undefined) this.state.layout = validateLayout(saved.value.layout);
                if (saved.value.resultSettings !== undefined) this.state.resultSettings = validateResultSettings(saved.value.resultSettings);
                if (saved.value.appearance !== undefined) this.state.appearance = validateAppearance(saved.value.appearance);
                this.state.agentReadEnabled = saved.value.agentReadEnabled === undefined ? DISTRIBUTION_PROFILE.agentReadEnabled : validateAgentReads(saved.value.agentReadEnabled);
                this.state.agentResultsEnabled = saved.value.agentResultsEnabled === undefined
                    ? this.state.agentReadEnabled : validateAgentResults(saved.value.agentResultsEnabled);
                this.state.library = restoreQueryLibrary(saved.value.library);
                for (const runId of (runIds ?? []).slice(0, 100)) {
                    requireId(runId);
                    const savedRun = await this.native.request("store.read", { key: `run:${this.id}:${runId}` });
                    if (!savedRun.value) throw fail("STATE_CORRUPT", "A saved run manifest is missing.");
                    const run = savedRun.value;
                    this.runVersions.set(run.id, { revision: savedRun.revision, hash: this.#hash(run) });
                    if (ACTIVE_STATUSES.has(run.status)) run.status = "interrupted";
                    run.retained = false;
                    if (run.pinned) {
                        try {
                            const file = this.#resultPath(run.id);
                            const info = await stat(file);
                            if (info.size > 150 * 1024 * 1024) throw fail("RESULT_TOO_LARGE", "The pinned result exceeds the supported snapshot size.");
                            run.retained = true;
                        } catch (error) {
                            run.warnings.push(`Pinned result could not be restored: ${safeError(error).message}`);
                        }
                    }
                    this.state.runs.push(run);
                }
            }
            await this.artifacts.initialize();
            await this.projects.initialize();
            await this.dashboards.initialize();
            this.state.version = this.storeRevision;
            this.state.connections = (await this.native.request("connections.list")).connections;
            this.#invalidateSchema("registry");
            if (this.integration) {
                try { this.state.integration = await this.integration.describe(); }
                catch { this.state.integration = { available: false, message: "Runtime DAX MCP discovery failed; use explicit local bundle/library import." }; }
                if (typeof this.integration.connectionDirectory === "function")
                    await this.#refreshConfiguredConnections().catch(error => this.emit("operationError", safeError(error)));
            }
            const connectionId = this.activeDocument().connectionId;
            if (this.state.connections.some(c => c.id === connectionId)) {
                await this.refreshSchema().catch(error => this.emit("operationError", safeError(error)));
            }
            this.initialized = true;
        } catch (error) {
            this.#invalidateSchema("provider");
            this.state.native = { available: false, message: safeError(error).message };
            this.publish();
            throw error;
        }
    }
    activeDocument() {
        const document = this.state.documents.find(d => d.id === this.state.activeDocumentId);
        if (!document) throw fail("DOCUMENT_NOT_FOUND", "The active query document no longer exists.");
        return document;
    }
    snapshot() {
        const { library, resultAccessRevision, ...visible } = this.state;
        return clone({ ...visible, libraryRevision: library.revision, artifactsRevision: this.artifacts.revision, dashboardsRevision: this.dashboards.revision,
            projectsRevision: this.projects.revision, projectProposal: this.projects.proposal,
            contentReviewRevision: this.contentReview.version, dashboardProposalRevision: this.dashboardProposals.version, libraryIdentity: this.knowledgeIdentity(),
            sharedAnalysisId: this.#sharedAnalysisEntry()?.id ?? null, authoringBusy: Boolean(this.authoring.current) });
    }
    publish() {
        this.#sharedAnalysisEntry();
        this.emit("change");
        if (this.listenerCount("state")) this.emit("state", this.snapshot());
    }
    #hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
    #resultPath(runId) { return path.join(this.artifactsRoot, "results", this.id, `${requireId(runId)}.json`); }
    async #save(next) {
        if (await new ContentHistory(this.native, this.id).prepare(this.state.library, next.library)) restoreQueryLibrary(next.library);
        const persisted = {
            schemaVersion: 1, documents: next.documents, closedDocuments: next.closedDocuments, activeDocumentId: next.activeDocumentId,
            limits: next.limits, chart: next.chart, chartSource: next.chartSource, selectedObjects: next.selectedObjects,
            pivotLayouts: next.pivotLayouts,
            layout: next.layout,
            resultSettings: next.resultSettings,
            appearance: next.appearance,
            agentReadEnabled: next.agentReadEnabled,
            agentResultsEnabled: next.agentResultsEnabled,
            library: next.library,
            runIds: next.runs.map(r => r.id),
        };
        // Match native store.rs before writing any manifests. This also leaves
        // room for the request/response envelope within NativeClient's 2 MiB lines.
        if (Buffer.byteLength(JSON.stringify(persisted), "utf8") > 1_500_000)
            throw fail("STORE_TOO_LARGE", "The workbench drafts and query library exceed the native 1.5 MB saved-state limit. Reduce saved content before retrying.");
        for (const run of next.runs) {
            const hash = this.#hash(run), current = this.runVersions.get(run.id);
            if (current?.hash === hash) continue;
            const result = await this.native.request("store.write", {
                key: `run:${this.id}:${run.id}`, expectedRevision: current?.revision ?? 0, value: run,
            });
            this.runVersions.set(run.id, { revision: result.revision, hash });
        }
        const saved = await this.native.request("store.write", { key: `workbench:${this.id}`, expectedRevision: this.storeRevision, value: persisted });
        this.storeRevision = saved.revision; next.version = saved.revision;
    }
    async mutate(fn) {
        const operation = this.queue.then(async () => {
            const previousConnection = this.activeDocument().connectionId;
            const native = this.state.native, connections = this.state.connections, metadataGeneration = this.metadataGeneration;
            // Metadata is replaced atomically, never edited inside a draft. Keep its
            // identity so Rust's schema index survives ordinary saves/tab changes.
            const { schema, ...mutable } = this.state;
            const next = { ...clone(mutable), schema };
            const result = await fn(next);
            if (next.activeDocumentId !== this.state.activeDocumentId
                || next.documents.find(document => document.id === next.activeDocumentId)?.connectionId !== previousConnection)
                next.resultAccessRevision++;
            if (next.documents.find(document => document.id === next.activeDocumentId)?.connectionId !== previousConnection) next.schemaError = null;
            await this.#save(next);
            if (this.state.native !== native) next.native = this.state.native;
            if (this.state.connections !== connections) next.connections = this.state.connections;
            next.connectionDiscovery = this.state.connectionDiscovery;
            if (next.schema === schema && next.documents.find(document => document.id === next.activeDocumentId)?.connectionId === this.activeDocument().connectionId) {
                next.schema = this.state.schema; next.schemaError = this.state.schemaError;
                next.schemaLoading = this.state.schemaLoading;
            }
            if (this.metadataGeneration !== metadataGeneration) {
                const sameConnection = next.documents.find(document => document.id === next.activeDocumentId)?.connectionId === this.activeDocument().connectionId;
                next.schema = sameConnection ? this.state.schema : null;
                next.schemaError = sameConnection ? this.state.schemaError : null;
                next.schemaLoading = sameConnection && this.state.schemaLoading;
                next.selections = []; next.selectedObjects = [];
            }
            if (next.documents.find(document => document.id === next.activeDocumentId)?.connectionId !== previousConnection) {
                this.schemaRequestGeneration++;
                this.schemaProvenance = null;
                next.schemaLoading = false;
            }
            // Provider progress is not queued behind disk writes. Merge its latest
            // counters so an in-flight save cannot rewind a cached row stream.
            for (const run of next.runs) {
                const live = this.state.runs.find(item => item.id === run.id);
                if (!live || !ACTIVE_STATUSES.has(run.status) || !ACTIVE_STATUSES.has(live.status)) continue;
                if (run.status !== "cancelling") run.status = live.status;
                run.resultSets = clone(live.resultSets); run.rowCount = live.rowCount;
                run.warnings = clone(live.warnings); run.retained = live.retained;
            }
            next.agentResultReads = this.state.agentResultReads;
            this.state = next; this.publish();
            return result ?? this.snapshot();
        });
        this.queue = operation.then(() => {}, () => {});
        return operation;
    }
    async refreshSchema({ background = false } = {}) {
        const document = clone(this.activeDocument());
        const connectionId = document.connectionId;
        this.#invalidateSchema();
        const request = this.schemaRequestGeneration;
        const identity = this.knowledgeIdentity(), connectionKey = this.#connectionKey();
        const current = () => !this.closed && request === this.schemaRequestGeneration
            && this.activeDocument().connectionId === connectionId
            && this.knowledgeIdentity().generation === identity.generation
            && this.#connectionKey() === connectionKey;
        this.state.schemaLoading = true; this.publish();
        try {
            const capability = this.state.connections.find(connection => connection.id === connectionId)?.capabilities?.schema;
            if (capability?.status === "unsupported") {
                const schema = { connectionId, objects: [], fetchedAt: new Date().toISOString(), warnings: [capability.reason] };
                if (current()) {
                    this.state.schema = schema; this.state.schemaError = null; this.state.schemaLoading = false;
                    this.state.selectedObjects = []; this.publish();
                    await this.#restoreBuilderImport(document, schema, current);
                }
                return schema;
            }
            const schema = { ...await this.native.request("schema.get", { connectionId }, 60_000), origin: "native" };
            if (schema.connectionId !== connectionId) throw fail("SCHEMA_CONNECTION_MISMATCH", "Native metadata belongs to a different connection.");
            if (current()) {
                this.state.schema = schema; this.state.schemaError = null; this.state.schemaLoading = false;
                if (!this.state.native.available) this.state.native = { ...this.state.native, available: true, message: "Native companion connected." };
                this.schemaProvenance = { schema, connectionKey, generation: identity.generation, nativeKey: this.#hash(this.state.native) };
                this.publish();
                await this.#restoreBuilderImport(document, schema, current);
            }
            return schema;
        } catch (error) {
            if (current()) {
                this.#invalidateSchema(); this.state.schemaError = safeError(error); this.publish();
                if (background) {
                    try { this.emit("operationError", safeError(error)); } catch { /* schemaError preserves the failure if a diagnostic listener throws. */ }
                }
            }
            // Background failures are surfaced for the current model above; obsolete requests cannot report over a newer tab.
            if (!background) throw error;
        }
    }
    async #restoreBuilderImport(document, schema, currentRequest = () => true) {
        if (!document.builderImport || schema.connectionId !== document.connectionId || !currentRequest()) return;
        const { resolveBuilderImport } = await import("../integrations/libraries.mjs");
        let builder, warning;
        try {
            builder = resolveBuilderImport(document.builderImport, schema);
            warning = "Studio hierarchies were expanded to verified model columns. The paired DAX is unchanged; review the generated query before applying. Auto Update remains off.";
        } catch (error) {
            warning = `Builder import could not be restored: ${safeError(error).message}`;
            this.emit("operationError", safeError(error));
        }
        await this.mutate(next => {
            if (!currentRequest()) return;
            const current = next.documents.find(item => item.id === document.id);
            if (!current || next.activeDocumentId !== document.id || current.connectionId !== document.connectionId
                || (current.builderRevision ?? 0) !== (document.builderRevision ?? 0)
                || !current.builderImport || this.#hash(current.builderImport) !== this.#hash(document.builderImport)) return;
            current.builderWarning = warning;
            current.builderAutoUpdate = false;
            if (builder) {
                current.builder = builder; current.builderImport = undefined;
                current.builderRevision = (current.builderRevision ?? 0) + 1;
            }
        });
    }
    #document(state, id) {
        const document = state.documents.find(d => d.id === (id ?? state.activeDocumentId));
        if (!document) throw fail("DOCUMENT_NOT_FOUND", "Query document not found.");
        return document;
    }
    #libraryModel(state = this.state) {
        return state.connections.find(connection => connection.id === this.#document(state).connectionId);
    }
    #connectionKey(state = this.state) {
        const connection = this.#libraryModel(state);
        return connection ? this.#hash(connection) : null;
    }
    #resultAccessScope() {
        return `${this.identitySession}:${this.registryGeneration}:${this.providerGeneration}`;
    }
    #invalidateSchema(reason) {
        if (reason === "registry") this.registryGeneration++;
        if (reason === "provider") this.providerGeneration++;
        this.metadataGeneration++; this.schemaRequestGeneration++; this.schemaProvenance = null;
        this.state.schema = null; this.state.schemaError = null; this.state.schemaLoading = false; this.state.selectedObjects = [];
    }
    async #replaceConnections(load) {
        // Multiple workbenches share one native registry. Invalidate every loaded view, not just the caller.
        this.native.emit("workbench.registry.invalidated");
        const registry = this.registryGeneration, provider = this.providerGeneration;
        const connections = await load();
        if (!this.closed && registry === this.registryGeneration && provider === this.providerGeneration) {
            // A refresh may have started while the registry request was pending.
            this.native.emit("workbench.registry.replaced", connections);
        }
        return this.snapshot();
    }
    async #refreshConfiguredConnections() {
        if (typeof this.integration?.connectionDirectory !== "function")
            throw fail("MCP_UNAVAILABLE", "Automatic profile discovery requires the Copilot MCP host.");
        try {
            const { directory, source, warning } = await this.integration.connectionDirectory();
            if (typeof directory !== "string" || !path.isAbsolute(directory))
                throw fail("MCP_DIRECTORY_INVALID", "DAX MCP must provide an absolute local profile folder.");
            return await this.#replaceConnections(async () => {
                const result = await this.native.request("connections.import", { directory, source: "dax-query" }, 60_000);
                if (!result.discovery || !Array.isArray(result.connections))
                    throw fail("NATIVE_UPDATE_REQUIRED", "Install a matching native companion for automatic DAX MCP connection discovery.");
                this.native.connectionDiscovery = { ...result.discovery, source, ...(warning ? { warning } : {}) };
                this.state.connectionDiscovery = clone(this.native.connectionDiscovery);
                return result.connections;
            });
        } catch (error) {
            this.state.connectionDiscovery = {
                status: "unavailable", loaded: this.state.connectionDiscovery?.loaded ?? 0, issues: [],
                errorCode: safeError(error).code,
                warning: `Could not refresh DAX MCP connections. ${safeError(error).message} Previously loaded connections were not removed.`,
            };
            this.publish();
            throw error;
        }
    }
    #eligibleSchema(state = this.state, connectionId = this.#document(state).connectionId) {
        const provenance = this.schemaProvenance;
        return Boolean(provenance && state.native.available && state.schema === provenance.schema
            && state.schema.origin === "native" && state.schema.connectionId === connectionId
            && this.#document(state).connectionId === connectionId && this.#connectionKey(state) === provenance.connectionKey
            && this.knowledgeIdentity(state).generation === provenance.generation && this.#hash(state.native) === provenance.nativeKey);
    }
    knowledgeIdentity(state = this.state) {
        const connection = this.#libraryModel(state);
        return { workbenchId: this.id, connectionId: this.#document(state).connectionId || null, model: connection?.model ?? null,
            generation: `${this.identitySession}:${this.registryGeneration}:${this.providerGeneration}:${this.metadataGeneration}`,
            contextVersion: CONTEXT_VERSION };
    }
    #knowledgeScope() { return { identity: this.knowledgeIdentity(), connection: this.#libraryModel() }; }
    searchKnowledge(payload) { return searchKnowledge(this.#knowledgeScope(), payload); }
    getKnowledge(payload) { return getKnowledge(this.#knowledgeScope(), payload); }
    #run(id) {
        const run = this.state.runs.find(r => r.id === id);
        if (!run) throw fail("RUN_NOT_FOUND", "Run not found in this workbench.");
        return run;
    }
    async propose({ query, rationale = "", documentId }) {
        validateQuery(query);
        if (typeof rationale !== "string" || rationale.length > 2000) throw fail("INVALID_PROPOSAL", "Proposal rationale is too long.");
        return this.mutate(next => {
            const doc = this.#document(next, documentId);
            doc.proposal = { id: randomUUID(), baseRevision: doc.revision, query, rationale };
            return { proposalId: doc.proposal.id, documentId: doc.id, baseRevision: doc.revision };
        });
    }
    async action(action, payload = {}, source = "ui") {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw fail("INVALID_INPUT", "Action payload must be an object.");
        const agentAllowed = new Set(["query.run", "query.cancel", "results.read", "knowledge.search", "knowledge.get"]);
        if (source !== "ui" && !agentAllowed.has(action)) throw fail("USER_ACTION_REQUIRED", "This action requires an explicit person-initiated canvas interaction.");
        if (this.authoring.current && !["builder.preview", "query.cancel", "dashboards.cancel", "knowledge.search", "knowledge.get"].includes(action)
            && !(this.authoring.current.phase === "prepare" && ["document.update", "builder.update"].includes(action)))
            throw fail("AUTHORING_BUSY", "Copilot is preparing a canvas draft. Wait for authoring to finish before changing it.");
        if (action === "dashboards.proposals" || action.startsWith("dashboards.proposal.")) return this.dashboardProposals.action(action, payload);
        if (action.startsWith("dashboards.")) return this.dashboardAction(action, payload);
        if (action.startsWith("content.")) return this.contentReview.action(action, payload);
        if (action.startsWith("projects.")) return this.projects.action(action, payload);
        if (action.startsWith("share.")) return this.sharing.action(action, payload);
        switch (action) {
            case "result.branch": return this.branchResult(payload);
            case "artifacts.catalog": {
                const catalog = await this.#artifactOperation(() => this.artifacts.catalog(libraryCatalog(this.state.library, this.#libraryModel(), this.state.connections, this.knowledgeIdentity())), false);
                return { ...catalog, projectsRevision: this.projects.revision, entries: [...catalog.entries, ...this.projects.catalog()] };
            }
            case "artifacts.get": return this.artifacts.get(payload.id);
            case "artifacts.checkWriting":
                return this.#artifactOperation(() => this.artifacts.checkWriting(payload), false);
            case "artifacts.create":
            case "artifacts.update": {
                const captured = clone(payload);
                return this.#artifactOperation(() => {
                    const guard = () => this.#artifactUserAdmission(source);
                    guard();
                    return action === "artifacts.create" ? this.artifacts.create(captured, this.state.library, guard)
                        : this.artifacts.update(captured, this.state.library, guard);
                });
            }
            case "knowledge.search": return this.searchKnowledge(payload);
            case "knowledge.get": return this.getKnowledge(payload);
            case "document.create": return this.mutate(next => {
                if (next.documents.length >= 10) throw fail("DOCUMENT_LIMIT", "Save a query to the library before creating more than 10 open documents.");
                const doc = makeDocument(String(payload.title ?? "Untitled query").slice(0, 100)); doc.connectionId = this.activeDocument().connectionId;
                if (doc.connectionId !== "demo:contoso") doc.query = "";
                next.documents.push(doc); next.activeDocumentId = doc.id;
                next.selections = [];
            });
            case "document.close": {
              await this.mutate(next => {
                const doc = this.#document(next, payload.id);
                if (next.runs.some(run => run.documentId === doc.id && ACTIVE_STATUSES.has(run.status))) throw fail("RUNNING", "Cancel or finish this document's query before closing it.");
                next.documents = next.documents.filter(item => item.id !== doc.id);
                if (!next.documents.length) {
                    const replacement = makeDocument();
                    replacement.connectionId = doc.connectionId;
                    if (replacement.connectionId !== "demo:contoso") replacement.query = "";
                    next.documents.push(replacement);
                }
                if (next.activeDocumentId === doc.id) {
                    next.activeDocumentId = next.documents[0].id;
                    if (next.schema?.connectionId !== next.documents[0].connectionId) next.schema = null;
                    next.selections = [];
                }
              });
              if (this.activeDocument().connectionId && this.state.schema?.connectionId !== this.activeDocument().connectionId)
                  void this.refreshSchema({ background: true });
              return this.snapshot();
            }
            case "document.closeAll": {
                const { documentIds, activeDocumentId } = payload;
                if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > 10
                    || documentIds.some(id => typeof id !== "string" || !id) || new Set(documentIds).size !== documentIds.length
                    || typeof activeDocumentId !== "string")
                    throw fail("INVALID_INPUT", "Provide the current open query IDs and active document before closing all tabs.");
                const ids = [...documentIds];
                const assertTabs = state => {
                    if (state.activeDocumentId !== activeDocumentId || state.documents.length !== ids.length
                        || state.documents.some((doc, index) => doc.id !== ids[index]))
                        throw fail("REVISION_CONFLICT", "The open tabs changed. Review the tab strip and retry Close all tabs; no tabs were closed.");
                };
                assertTabs(this.state);
                return this.authoring.perform(() => this.mutate(next => {
                    assertTabs(next);
                    const active = this.#document(next);
                    this.#retainClosedDocuments(next, next.documents);
                    const replacement = makeDocument();
                    replacement.query = ""; replacement.connectionId = active.connectionId;
                    next.documents = [replacement];
                    this.#focusDocument(next, replacement, "editor");
                    return { closedCount: ids.length };
                }));
            }
            case "document.select":
                if (payload.id === this.state.activeDocumentId) return this.snapshot();
                await this.mutate(next => {
                    const doc = this.#document(next, payload.id);
                    next.activeDocumentId = doc.id; next.selections = [];
                    if (next.schema?.connectionId !== doc.connectionId) next.schema = null;
                });
                if (this.state.schema?.connectionId === this.activeDocument().connectionId)
                    await this.#restoreBuilderImport(clone(this.activeDocument()), this.state.schema);
                else if (this.activeDocument().connectionId) void this.refreshSchema({ background: true });
                return this.snapshot();
            case "document.reopen":
                await this.mutate(next => this.#reopenDocument(next, payload.id));
                if (this.activeDocument().connectionId && this.state.schema?.connectionId !== this.activeDocument().connectionId)
                    void this.refreshSchema({ background: true });
                return this.snapshot();
            case "document.update": return this.mutate(next => {
                const doc = this.#document(next, payload.id);
                if (payload.revision !== doc.revision) throw fail("REVISION_CONFLICT", "This query changed elsewhere. Reload the document before applying this edit.");
                if (payload.query !== undefined) {
                    if (typeof payload.query !== "string" || payload.query.length > 100_000) throw fail("INVALID_QUERY", "Query text exceeds 100,000 characters.");
                    doc.query = payload.query;
                }
                if (payload.title !== undefined) doc.title = String(payload.title).slice(0, 100);
                if (payload.parameters !== undefined) doc.parameters = validateParameters(payload.parameters, !!doc.parameterDefinitions);
                doc.revision++;
            });
            case "proposal.accept": return this.mutate(next => {
                const doc = this.#document(next, payload.documentId);
                if (!doc.proposal || doc.proposal.id !== payload.proposalId) throw fail("PROPOSAL_NOT_FOUND", "This proposal no longer exists.");
                if (doc.proposal.baseRevision !== doc.revision) throw fail("REVISION_CONFLICT", "The editor changed after this proposal. Request a new proposal; your draft has been preserved.");
                doc.query = doc.proposal.query; doc.revision++; doc.proposal = null;
            });
            case "proposal.reject": return this.mutate(next => {
                const doc = this.#document(next, payload.documentId);
                if (doc.proposal?.id !== payload.proposalId) throw fail("PROPOSAL_NOT_FOUND", "This proposal no longer exists.");
                doc.proposal = null;
            });
            case "builder.proposal.accept":
            case "builder.proposal.reject": return this.mutate(next => {
                const doc = this.#document(next, payload.documentId), proposal = doc.builderProposal;
                if (next.activeDocumentId !== doc.id) throw fail("REVISION_CONFLICT", "Switch to this query document before reviewing its builder proposal.");
                if (!proposal || proposal.id !== payload.proposalId) throw fail("PROPOSAL_NOT_FOUND", "This builder proposal no longer exists.");
                if (action === "builder.proposal.reject") { doc.builderProposal = null; return; }
                if (proposal.connectionId !== doc.connectionId || proposal.baseRevision !== doc.revision
                    || proposal.baseBuilderRevision !== (doc.builderRevision ?? 0))
                    throw fail("REVISION_CONFLICT", "The query, model or builder changed. Request a new builder proposal; your edits are preserved.");
                if (doc.builderImport) throw fail("BUILDER_IMPORT_PENDING", "Resolve or discard the pending import before accepting a builder proposal.");
                const built = this.#buildProposal(proposal.definition, next, doc);
                if (built.query !== proposal.query || this.#hash(built.builder) !== this.#hash(proposal.definition))
                    throw fail("BUILDER_SCHEMA_MISMATCH", "Model metadata or query generation changed since this proposal. Request a fresh proposal before accepting.");
                doc.builder = built.builder; doc.builderRevision = (doc.builderRevision ?? 0) + 1;
                doc.builderProposal = null; doc.builderAutoUpdate = false;
                doc.builderWarning = undefined;
                return { definition: clone(doc.builder), builderRevision: doc.builderRevision };
            });
            case "connections.discover":
                return this.#replaceConnections(async () => (await this.native.request("connections.discover", {}, 60_000)).connections);
            case "connection.details": {
                if (Object.keys(payload).some(key => key !== "connectionId")
                    || typeof payload.connectionId !== "string" || !this.state.connections.some(item => item.id === payload.connectionId))
                    throw fail("CONNECTION_NOT_FOUND", "Choose a configured connection to inspect.");
                if (!this.state.native.available) throw fail("NATIVE_UNAVAILABLE", "Reconnect the native companion before inspecting connection settings.");
                const registryRevision = this.#connectionRegistryRevision();
                const details = await this.native.request("connection.details", { connectionId: payload.connectionId });
                if (registryRevision !== this.#connectionRegistryRevision())
                    throw fail("CONNECTIONS_CHANGED", "The connection configuration changed. Reload its details.");
                if (details.connectionId !== payload.connectionId) throw fail("CONNECTIONS_CHANGED", "Connection details did not match the selected profile. Reload its details.");
                return details;
            }
            case "connection.open": {
                if (Object.keys(payload).some(key => key !== "connectionId"))
                    throw fail("INVALID_CONNECTION_SELECTION", "Choose a configured connection to open a query.");
                const { version, activeDocumentId, registryRevision } = this.connectionsContext();
                return this.selectConnection({ connectionId: payload.connectionId, version, activeDocumentId, registryRevision });
            }
            case "connections.refresh":
                if (this.running.size || this.dashboardRefreshes.size)
                    throw fail("QUERY_BUSY", "Wait for running queries and dashboard refreshes before refreshing connection profiles.");
                return this.#refreshConfiguredConnections();
            case "connections.import": {
                if (typeof payload.directory !== "string" || !path.isAbsolute(payload.directory)) throw fail("INVALID_PATH", "Choose an absolute local connection-bundle directory.");
                if (payload.connectionName !== undefined && (typeof payload.connectionName !== "string" || payload.connectionName.length > 200)) throw fail("INVALID_CONNECTION", "The optional connection name must be text of at most 200 characters.");
                if (payload.kind !== undefined && !["msolap", "windows-msolap"].includes(payload.kind)) throw fail("INVALID_CONNECTION", "Choose an ADOMD or Windows MSOLAP provider for native bundles.");
                if (payload.authMode !== undefined && !["connection-string", "azure-cli"].includes(payload.authMode)) throw fail("INVALID_AUTH_MODE", "Choose a supported authentication mode.");
                if (payload.kind === "windows-msolap" && payload.authMode === "azure-cli") throw fail("INVALID_AUTH_MODE", "Windows MSOLAP uses the installed provider's identity, not Azure CLI.");
                return this.#replaceConnections(async () => (await this.native.request("connections.import", { directory: payload.directory, authMode: payload.authMode ?? "connection-string", ...(payload.connectionName?.trim() ? { connectionName: payload.connectionName.trim() } : {}), ...(payload.kind !== undefined ? { kind: payload.kind } : {}) }, 60_000)).connections);
            }
            case "connection.add": {
                if (typeof payload.name !== "string" || !payload.name.trim() || payload.name.length > 200 || /[\u0000-\u001f\u007f]/.test(payload.name)) throw fail("INVALID_CONNECTION", "A connection name of 1 to 200 printable characters is required.");
                if (payload.kind === "powerbi-rest") {
                    const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
                    for (const key of ["workspaceId", "datasetId", ...(payload.tenantId === undefined ? [] : ["tenantId"])]) {
                        if (typeof payload[key] !== "string" || !guid.test(payload[key])) throw fail("INVALID_CONNECTION", `${key} must be a GUID, not a name or URL.`);
                    }
                    if (payload.authMode !== "azure-cli") throw fail("INVALID_AUTH_MODE", "Power BI REST requires explicit Azure CLI authentication.");
                    if (payload.connectionString !== undefined) throw fail("INVALID_CONNECTION", "Power BI REST uses workspace and semantic model IDs, not a connection string.");
                } else {
                    if (payload.kind !== undefined && !["msolap", "windows-msolap"].includes(payload.kind)) throw fail("INVALID_CONNECTION", "Choose an ADOMD, Windows MSOLAP, or Power BI REST connection.");
                    if (typeof payload.connectionString !== "string" || payload.connectionString.length > 16_384) throw fail("INVALID_CONNECTION", "A bounded connection string is required.");
                }
                if (payload.authMode !== undefined && !["connection-string", "azure-cli"].includes(payload.authMode)) throw fail("INVALID_AUTH_MODE", "Choose a supported authentication mode.");
                if (payload.kind === "windows-msolap" && payload.authMode === "azure-cli") throw fail("INVALID_AUTH_MODE", "Windows MSOLAP uses the installed provider's identity, not Azure CLI.");
                return this.#replaceConnections(async () => {
                    await this.native.request("connection.add", payload, 60_000);
                    return (await this.native.request("connections.list")).connections;
                });
            }
            case "connection.select":
                if (!this.state.connections.some(c => c.id === payload.connectionId)) throw fail("CONNECTION_NOT_FOUND", "Select a known connection.");
                await this.mutate(next => {
                    const doc = this.#document(next);
                    if (doc.connectionId !== payload.connectionId) {
                        doc.connectionId = payload.connectionId; doc.revision++;
                        doc.builder = undefined; doc.builderWarning = undefined; doc.builderAutoUpdate = false; doc.builderRevision = (doc.builderRevision ?? 0) + 1;
                        doc.builderProposal = null;
                    }
                    next.schema = null; next.selections = []; next.selectedObjects = [];
                });
                return this.refreshSchema();
            case "schema.refresh": return this.refreshSchema();
            case "integration.check":
            case "integration.reconnect": {
                if (!this.integration) throw fail("MCP_UNAVAILABLE", "This standalone preview is not connected to the Copilot session MCP host.");
                try {
                    const status = await (action === "integration.reconnect" ? this.integration.reconnect() : this.integration.diagnostics());
                    this.state.integration = { available: status.available, message: status.message }; this.publish();
                    return status;
                } catch (error) {
                    this.state.integration = { available: false, message: safeError(error).message }; this.publish();
                    throw error;
                }
            }
            case "query.run": return this.runQuery(payload.documentId, source, payload.revision);
            case "builder.values.start": return this.startFilterValues(payload);
            case "builder.values.read": return this.readFilterValues(payload);
            case "model.preview.start": return this.startModelPreview(payload);
            case "results.read": return this.readResults(payload);
            case "query.cancel": {
                const run = this.#run(payload.runId);
                if (!ACTIVE_STATUSES.has(run.status)) throw fail("NOT_RUNNING", "This query is no longer running.");
                await this.mutate(next => {
                    const current = next.runs.find(r => r.id === run.id);
                    if (!current || !ACTIVE_STATUSES.has(current.status)) throw fail("NOT_RUNNING", "This query finished before cancellation was requested.");
                    current.status = "cancelling";
                });
                return this.native.request("query.cancel", { runId: run.id });
            }
            case "agent.enable": {
                const enabled = validateAgentReads(payload.enabled);
                return this.mutate(next => { next.agentReadEnabled = enabled; });
            }
            case "agent.results.enable": {
                const enabled = validateAgentResults(payload.enabled);
                return this.mutate(next => {
                    if (next.agentResultsEnabled !== enabled) next.resultAccessRevision++;
                    next.agentResultsEnabled = enabled;
                });
            }
            case "settings.update": return this.mutate(next => { next.limits = validateLimits(payload.limits); });
            case "layout.update": {
                const layout = validateLayout(payload);
                return this.mutate(next => { next.layout = layout; });
            }
            case "result-settings.update": {
                const settings = validateResultSettings(payload);
                return this.mutate(next => { next.resultSettings = settings; });
            }
            case "appearance.update": {
                return this.mutate(next => { next.appearance = validateAppearance(payload, next.appearance); });
            }
            case "context.objects": return this.mutate(next => {
                if (!Array.isArray(payload.ids) || payload.ids.length > 30) throw fail("INVALID_SELECTION", "Select at most 30 model objects.");
                const known = new Set(next.schema?.objects.map(o => o.id) ?? []);
                if (payload.ids.some(id => !known.has(id))) throw fail("STALE_SELECTION", "One or more selected model objects are unavailable.");
                next.selectedObjects = [...new Set(payload.ids)];
            });
            case "selection.set": return this.mutate(async next => {
                if (!Array.isArray(payload.cells) || payload.cells.length > 100) throw fail("INVALID_SELECTION", "Share at most 100 cells at a time.");
                const active = this.#document(next);
                const selected = payload.cells.map(cell => {
                    const run = this.#run(cell.runId);
                    if (run.connectionId !== active.connectionId || run.documentId !== active.id) throw fail("STALE_SELECTION", "Share cells only from the active document and connection.");
                    const result = run.resultSets.find(s => s.id === cell.resultSetId);
                    const index = result?.columns.findIndex(c => c.id === cell.columnId) ?? -1;
                    if (!Number.isInteger(cell.row) || cell.row < 0 || cell.row >= (result?.rowCount ?? 0) || index < 0 || !this.cachedRuns.has(run.id))
                        throw fail("INVALID_SELECTION", "The selected result cell is unavailable.");
                    return { runId: run.id, resultSetId: result.id, row: cell.row, columnId: cell.columnId, column: index };
                });
                const values = await this.#withResults([...new Set(selected.map(cell => cell.runId))], () => this.results.select(selected));
                next.selections = selected.map(({ column, ...cell }, index) => ({ ...cell, value: values[index] }));
                if (Buffer.byteLength(JSON.stringify(next.selections)) > 16_384) throw fail("CONTEXT_TOO_LARGE", "Selected values exceed the 16 KiB sharing limit.");
            });
            case "pivot.layout.set": return this.mutate(next => {
                const run = next.runs.find(item => item.id === payload.runId);
                const result = run?.resultSets.find(item => item.id === payload.resultSetId);
                const active = this.#document(next);
                if (!run || !result || run.documentId !== active.id || run.connectionId !== active.connectionId)
                    throw fail("INVALID_PIVOT", "The pivot's document or connection changed. Return to its query before saving the layout.");
                const config = pivotLayoutOnly(payload.config);
                if (JSON.stringify(config) !== JSON.stringify(payload.config))
                    throw fail("INVALID_PIVOT", "Pivot layout storage accepts fields and display settings only, not captured filter values or member keys.");
                validatePivotFields(config, result.columns);
                const source = pivotSourceKey(run, result);
                next.pivotLayouts = [{ source, config }, ...next.pivotLayouts.filter(layout => layout.source !== source)].slice(0, PIVOT_LIMITS.layouts);
            });
            case "chart.set": return this.mutate(next => {
                next.chart = payload.config === null ? null : validateChartConfig(payload.config);
                next.chartSource = null;
                if (payload.runId !== undefined || payload.resultSetId !== undefined) {
                    const run = next.runs.find(item => item.id === payload.runId);
                    const result = run?.resultSets.find(item => item.id === payload.resultSetId);
                    if (!run || !result) throw fail("INVALID_CHART", "The chart's captured result is no longer available. Reopen a retained result.");
                    next.chartSource = chartSourceKey(run, result);
                }
            });
            case "run.pin": return this.pin(payload.runId);
            case "run.open": return this.mutate(next => {
                const run = this.#run(payload.runId);
                if (next.documents.length >= 10) throw fail("DOCUMENT_LIMIT", "At most 10 query documents can be open.");
                const doc = { ...makeDocument("Saved run"), query: run.templateQuery ?? run.query, parameters: run.parameters, parameterDefinitions: run.parameterDefinitions, connectionId: run.connectionId };
                next.documents.push(doc); next.activeDocumentId = doc.id; next.schema = null; next.selections = [];
            });
            case "result.compare": return this.compare(payload.leftRunId, payload.rightRunId);
            case "builder.update": {
                const { validateBuilderDraft } = await import("../integrations/query-builder.mjs");
                const definition = validateBuilderDraft(payload.definition);
                return this.mutate(next => {
                    const doc = this.#document(next, payload.documentId);
                    if (payload.connectionId !== doc.connectionId) throw fail("REVISION_CONFLICT", "The builder's connection changed. Your local selections have been preserved.");
                    if (payload.builderRevision !== (doc.builderRevision ?? 0)) throw fail("REVISION_CONFLICT", "This builder changed in another panel. Your local selections have been preserved.");
                    if (doc.builderImport) throw fail("BUILDER_IMPORT_PENDING", "Restore or discard the imported selections before editing this builder.");
                    doc.builder = definition; doc.builderRevision = (doc.builderRevision ?? 0) + 1; doc.builderWarning = undefined;
                    if (payload.autoUpdate !== undefined) {
                        if (typeof payload.autoUpdate !== "boolean") throw fail("INVALID_BUILDER", "Auto Update must be a boolean.");
                        doc.builderAutoUpdate = payload.autoUpdate;
                    }
                    return { builderRevision: doc.builderRevision };
                });
            }
            case "builder.import.resolve": {
                const doc = this.#document(this.state, payload.documentId);
                if (doc.id !== this.state.activeDocumentId || doc.connectionId !== payload.connectionId
                    || (doc.builderRevision ?? 0) !== payload.builderRevision) throw fail("REVISION_CONFLICT", "The active model or builder changed. Retry from the current document.");
                if (!doc.builderImport) throw fail("INVALID_BUILDER", "This document has no pending builder import.");
                if (!this.state.connections.some(connection => connection.id === doc.connectionId)) throw fail("CONNECTION_NOT_FOUND", "Select the intended model connection before restoring these selections.");
                await this.refreshSchema();
                return this.snapshot();
            }
            case "builder.reset": return this.mutate(next => {
                const doc = this.#document(next, payload.documentId);
                if (doc.revision !== payload.revision || doc.connectionId !== payload.connectionId || (doc.builderRevision ?? 0) !== payload.builderRevision) throw fail("REVISION_CONFLICT", "The query or builder changed. Nothing was cleared.");
                const pendingImport = Boolean(doc.builderImport);
                doc.builder = { version: 2, fields: [], filters: [], orderBy: [] }; doc.builderRevision = (doc.builderRevision ?? 0) + 1;
                doc.builderImport = undefined; doc.builderWarning = undefined;
                doc.builderProposal = null;
                if (pendingImport) doc.builderAutoUpdate = false;
                if (payload.removeGenerated === true && !pendingImport) {
                    const query = removeBuilderBlock(doc.query);
                    if (query !== doc.query) { doc.query = query; doc.revision++; doc.proposal = null; }
                }
                return { builderRevision: doc.builderRevision };
            });
            case "builder.filters.validate": {
                if (typeof payload.documentId !== "string" || !payload.documentId || typeof payload.connectionId !== "string" || !payload.connectionId)
                    throw fail("INVALID_BUILDER", "Filter checks require the exact active document and connection.");
                if (Object.keys(payload).some(key => !["documentId", "connectionId", "definition"].includes(key)))
                    throw fail("INVALID_BUILDER", "Filter checks accept only the active document, connection and supplied definition.");
                const doc = this.#document(this.state, payload.documentId);
                if (doc.id !== this.state.activeDocumentId || doc.connectionId !== payload.connectionId)
                    throw fail("REVISION_CONFLICT", "The active query or connection changed. Reopen filter controls.");
                if (doc.builderImport) throw fail("BUILDER_IMPORT_PENDING", "Restore or discard imported selections before configuring filters.");
                const schema = this.state.schema;
                if (!schema || schema.connectionId !== doc.connectionId)
                    throw fail("INVALID_BUILDER", "Refresh model metadata before checking filters.");
                const connection = this.state.connections.find(item => item.id === doc.connectionId);
                const supported = !["windows-msolap", "powerbi-rest"].includes(connection?.kind)
                    && (connection?.capabilities?.parameters?.status === "supported" || connection?.kind === "msolap" && connection?.capabilities?.parameters?.status !== "unsupported");
                const { validateFilterControls } = await import("./filter-controls.mjs");
                if (schema !== this.state.schema || doc.id !== this.state.activeDocumentId || doc.connectionId !== this.activeDocument().connectionId)
                    throw fail("REVISION_CONFLICT", "The model changed while checking filters. Retry with the current model.");
                return validateFilterControls(payload.definition, schema.objects, supported);
            }
            case "builder.preview":
            case "builder.apply":
            case "builder.run":
            case "builder.generate":
            case "builder.save": {
                const library = await import("../integrations/libraries.mjs");
                const engine = await import("../integrations/query-builder.mjs");
                const doc = this.#document(this.state, payload.documentId);
                if (doc.builderImport) throw fail("BUILDER_IMPORT_PENDING", "Restore or discard the imported selections before using the builder. The DAX editor is unchanged.");
                const schema = this.state.schema;
                if (!schema || schema.connectionId !== doc.connectionId || (payload.connectionId !== undefined && payload.connectionId !== doc.connectionId)) throw fail("INVALID_BUILDER", "Refresh model metadata for this document before building a query.");
                let input = payload;
                if (payload.definition) {
                    input = engine.normalizeBuilder(payload.definition);
                    input = engine.validateBuilderSchema(input, schema.objects);
                } else {
                    const table = schema.objects.find(o => o.kind === "table" && o.name === payload.table);
                    if (!table || !Array.isArray(payload.columns)) throw fail("INVALID_BUILDER", "Choose a table from the current model.");
                    const columns = schema.objects.filter(o => o.table === table.name && o.kind === "column").map(o => o.name);
                    if (payload.columns.some(c => !columns.includes(c))) throw fail("INVALID_BUILDER", "Choose columns from the current table.");
                    if (payload.measure && !schema.objects.some(o => o.kind === "measure" && o.name === payload.measure)) throw fail("INVALID_BUILDER", "Choose a measure from the current model.");
                }
                const built = library.generateBuilderQuery(input);
                validateQuery(built.query);
                if (action === "builder.preview") return built;
                if (action === "builder.run") {
                    if (doc.id !== this.state.activeDocumentId || doc.revision !== payload.revision || (doc.builderRevision ?? 0) !== payload.builderRevision) throw fail("REVISION_CONFLICT", "The query or builder changed. Review it before running.");
                    const multipleTables = new Set(input.fields?.filter(field => field.kind === "column").map(field => field.table));
                    if (multipleTables.size > 1 && !input.fields.some(field => field.kind === "measure") && payload.confirmCrossjoin !== true)
                        throw fail("CROSSJOIN_CONFIRMATION_REQUIRED", "Grouping columns from multiple tables without a measure can create a large crossjoin. Add a measure or explicitly confirm the run.");
                    const names = payload.definition ? engine.collectBuilderParameters(input) : [];
                    const connection = this.state.connections.find(item => item.id === doc.connectionId);
                    if (names.length && (["windows-msolap", "powerbi-rest"].includes(connection?.kind) || connection?.capabilities?.parameters?.status === "unsupported"))
                        throw fail("UNSUPPORTED_PARAMETERS", "This transport cannot bind native builder parameters. Use literal filters or an ADOMD connection; parameters are never silently rewritten.");
                    const parameters = Object.fromEntries(names.map(name => {
                        if (!Object.hasOwn(doc.parameters, name)) throw fail("INVALID_PARAMETERS", `Provide a value for builder parameter @${name} in Parameters before running.`);
                        return [name, doc.parameters[name]];
                    }));
                    return this.runQuery(doc.id, source, payload.revision, { query: built.query, parameters, builderRevision: doc.builderRevision ?? 0, definition: input });
                }
                if (action === "builder.apply") return this.mutate(next => {
                    const current = this.#document(next, doc.id);
                    if (current.revision !== payload.revision || current.connectionId !== doc.connectionId || next.activeDocumentId !== doc.id) throw fail("REVISION_CONFLICT", "The active query changed while the builder was applying. Your editor was not replaced.");
                    if ((current.builderRevision ?? 0) !== payload.builderRevision) throw fail("REVISION_CONFLICT", "The builder changed in another panel. Generate again before applying.");
                    current.query = updateBuilderBlock(current.query, built.query, payload.selection); current.revision++;
                    current.proposal = null;
                    current.builder = engine.validateBuilderDraft(input); current.builderWarning = undefined;
                    return { revision: current.revision, query: current.query };
                });
                if (action === "builder.save") {
                    built.builder.connection_name = this.state.connections.find(c => c.id === doc.connectionId)?.name;
                    return library.saveQueryBuilder({ directory: payload.directory, name: payload.name ?? doc.title, query: built.query, builder: built.builder });
                }
                await this.propose({ documentId: doc.id, query: built.query, rationale: "Generated from selected model fields, filters, and sorting." }); return built;
            }
            case "context.import": {
                const identity = this.knowledgeIdentity(), connectionKey = this.#connectionKey();
                const { loadContextBundle } = await import("../integrations/libraries.mjs");
                const connection = this.state.connections.find(c => c.id === this.activeDocument().connectionId);
                if (!connection || payload.connectionName !== connection.name) throw fail("CONTEXT_CONNECTION_MISMATCH", "Import the dictionary for the currently selected named connection.");
                const bundle = await loadContextBundle(payload.directory, payload.connectionName);
                if (this.closed || this.#connectionKey() !== connectionKey || this.knowledgeIdentity().generation !== identity.generation
                    || this.activeDocument().connectionId !== identity.connectionId)
                    throw fail("CONTEXT_CONNECTION_MISMATCH", "The selected model or metadata generation changed during import. No dictionary metadata was applied.");
                const key = object => [object.kind, object.table ?? "", object.name].join("\0").toLowerCase();
                const nativeObjects = new Set((this.state.schema?.objects ?? []).map(key));
                const matched = bundle.objects.filter(object => nativeObjects.has(key(object))).length;
                if (!this.state.schema || this.state.schema.connectionId !== connection.id) {
                    this.schemaProvenance = null;
                    this.state.schema = {
                        connectionId: connection.id, objects: bundle.objects,
                        origin: "dictionary",
                        fetchedAt: new Date().toISOString(),
                        warnings: ["Imported dictionary metadata; live engine shape has not been verified.", ...bundle.warnings],
                    };
                } else {
                    this.state.schema.warnings = [
                        ...this.state.schema.warnings,
                        `Imported dictionary: ${matched} matching objects; ${bundle.objects.length - matched} unmatched. Native names and types remain authoritative.`,
                        ...bundle.warnings,
                    ];
                }
                this.publish();
                return { matched, unmatched: bundle.objects.length - matched, overview: bundle.overview, warnings: bundle.warnings };
            }
            case "library.catalog": return libraryCatalog(this.state.library, this.#libraryModel(), this.state.connections, this.knowledgeIdentity());
            case "library.get": return libraryPreview(this.state.library, payload.id, this.#libraryModel(), this.state.connections);
            case "library.documentation.preview": {
                const doc = this.activeDocument(), connection = this.state.connections.find(item => item.id === doc.connectionId);
                return previewDocumentationReview(this.state.library, payload, doc, connection, this.knowledgeIdentity());
            }
            case "library.analysis.share": {
                const doc = this.activeDocument(), entry = this.state.library.entries.find(item => item.id === payload.id);
                const connection = this.state.connections.find(item => item.id === doc.connectionId);
                if (!entry?.analysis || !connection || entry.connectionId !== connection.id || entry.model !== connection.model)
                    throw fail("RESEARCH_SHARE_SCOPE", "Choose a saved analysis for this exact model and connection.");
                sharedAnalysisProjection(entry);
                this.sharedAnalysis = { entryId: entry.id, entryVersion: this.#hash(entry), documentId: doc.id,
                    revision: doc.revision, libraryRevision: this.state.library.revision, identity: JSON.stringify(this.knowledgeIdentity()) };
                this.publish();
                return { shared: true, entryId: entry.id };
            }
            case "library.analysis.clear":
                return this.clearSharedAnalysis();
            case "library.collection.create": return this.mutate(next => {
                if (this.authoring.current) throw fail("AUTHORING_BUSY", "Wait for canvas authoring to finish before changing the library.");
                return createLibraryCollection(next.library, payload, this.#libraryModel(next), next.connections, this.knowledgeIdentity(next));
            });
            case "library.documentation.update": {
                const request = clone(payload);
                return this.mutate(next => {
                    if (this.authoring.current) throw fail("AUTHORING_BUSY", "Wait for canvas authoring to finish before revising documentation.");
                    const result = updateLibraryDocumentation(next.library, request);
                    this.#syncDocumentationReferences(next, result.id);
                    return libraryCatalog(next.library, this.#libraryModel(next), next.connections, this.knowledgeIdentity(next));
                });
            }
            case "library.collection.update":
            case "library.entry.organize":
            case "library.research.append": return this.mutate(next => {
                if (this.authoring.current) throw fail("AUTHORING_BUSY", "Wait for canvas authoring to finish before managing research.");
                const connection = this.#libraryModel(next), identity = this.knowledgeIdentity(next);
                if (action === "library.collection.update") return updateLibraryCollection(next.library, payload, connection, next.connections, identity);
                if (action === "library.research.append") return appendLibraryResearch(next.library, payload, "human", connection, next.connections, identity);
                const result = organizeLibraryEntry(next.library, payload, connection, next.connections, identity);
                const entry = findLibraryEntry(next.library, payload.id);
                for (const document of [...next.documents, ...next.closedDocuments])
                    if (document.libraryRef?.entryId === entry.id) document.libraryRef = libraryReference(entry);
                return result;
            });
            case "library.entry.save": {
                requireId(payload.documentId);
                return this.mutate(next => {
                    if (this.authoring.current) throw fail("AUTHORING_BUSY", "Wait for canvas authoring to finish before saving a library entry.");
                    const doc = this.#document(next, payload.documentId);
                    if (next.activeDocumentId !== doc.id)
                        throw fail("REVISION_CONFLICT", "The active query changed. Save from the intended query tab; no library entry was changed.");
                    const result = saveLibraryEntry(next.library, payload, doc, next.connections, this.knowledgeIdentity(next));
                    doc.libraryRef = libraryReference(findLibraryEntry(next.library, result.id));
                    return result;
                });
            }
            case "library.entry.open": {
                let openedId;
                const result = await this.mutate(next => {
                    if (this.authoring.current) throw fail("AUTHORING_BUSY", "Wait for canvas authoring to finish before opening a library entry.");
                    if (next.documents.length >= 10) throw fail("DOCUMENT_LIMIT", "At most 10 query documents can be open.");
                    const entry = findLibraryEntry(next.library, payload.id, this.#libraryModel(next));
                    const connectionId = libraryConnection(entry, next.connections, this.#document(next).connectionId);
                    if (entry.source === "starter" && entry.builder) {
                        if (!this.#eligibleSchema(next, connectionId))
                            throw fail("LIBRARY_MODEL_UNVERIFIED", "Refresh the selected model's native metadata in Explorer before opening this model starter.");
                        entry.builder = validateBuilderSchema(entry.builder, next.schema.objects);
                        validateQuery(generateBuilderQuery(entry.builder).query);
                        entry.query = updateBuilderBlock("", entry.query);
                    }
                    const doc = {
                        ...makeDocument(entry.title), query: entry.query, connectionId,
                        parameters: entry.parameters ?? {}, parameterDefinitions: entry.parameterDefinitions,
                        builder: entry.builder, builderImport: entry.builderImport, builderRevision: 0, builderAutoUpdate: false,
                        libraryRef: libraryReference(entry),
                        builderWarning: !connectionId
                            ? entry.source === "starter"
                                ? "No model connection is selected. This synthetic example is unbound; choose a connection before running. No query has been executed."
                                : "The saved model connection is missing or ambiguous. This query is unbound; choose the intended model before running or editing model selections. No query has been executed."
                            : entry.builder || entry.builderImport
                                ? "Saved editor text and builder selections were restored independently. Auto Update is off. Review their model compatibility and generated DAX before applying or running."
                                : undefined,
                    };
                    next.documents.push(doc);
                    this.#focusDocument(next, doc, entry.builder ? "builder" : "editor");
                    openedId = doc.id;
                    next.selections = []; next.selectedObjects = [];
                    if (!this.#eligibleSchema(next, connectionId)) next.schema = null;
                    return { documentId: doc.id };
                }).catch(error => {
                    if (openedId && this.state.documents.some(document => document.id === openedId)) return { documentId: openedId };
                    throw error;
                });
                if (this.activeDocument().id === result.documentId && this.activeDocument().connectionId) {
                    try {
                        if (this.#eligibleSchema()) await this.#restoreBuilderImport(clone(this.activeDocument()), this.state.schema);
                        else await this.refreshSchema();
                    } catch (error) {
                        // The tab is already durably committed. Metadata/import diagnostics must not turn Open into a retryable failed mutation.
                        try { this.emit("operationError", safeError(error)); } catch { /* Diagnostic listeners do not roll back a committed tab. */ }
                    }
                }
                return result;
            }
            case "library.list": {
                const { listLibrary } = await import("../integrations/libraries.mjs");
                const directory = payload.directory ?? this.libraryDirectory;
                if (!directory) return { entries: [], message: "Choose a local query library directory." };
                const entries = await listLibrary(directory); this.libraryDirectory = directory;
                return { entries };
            }
            case "library.open": {
                const { readQueryFile, parameterDefaults } = await import("../integrations/libraries.mjs");
                const item = await readQueryFile(payload.path);
                validateQuery(item.query);
                await this.mutate(next => {
                    if (next.documents.length >= 10) throw fail("DOCUMENT_LIMIT", "At most 10 query documents can be open.");
                    const matches = next.connections.filter(c => c.name === item.connectionName);
                    const connection = matches.find(c => c.id === this.activeDocument().connectionId) ?? (matches.length === 1 ? matches[0] : undefined);
                    const doc = {
                        ...makeDocument(item.name), query: item.query, parameterDefinitions: item.parameters,
                        parameters: parameterDefaults(item.parameters ?? {}), connectionId: item.unbound ? "" : item.connectionName ? connection?.id ?? "" : this.activeDocument().connectionId,
                        builder: item.builderState, builderImport: item.builderImport, builderRevision: 0,
                        builderWarning: item.builderWarning, builderAutoUpdate: false,
                    };
                    next.documents.push(doc); next.activeDocumentId = doc.id;
                    next.selections = []; next.schema = null;
                });
                if (this.activeDocument().connectionId) await this.refreshSchema();
                return { name: item.name, documentId: this.state.activeDocumentId, builderWarning: item.builderWarning };
            }
            case "library.save": {
                const { saveQueryFile } = await import("../integrations/libraries.mjs");
                const doc = this.activeDocument();
                if (!doc.parameterDefinitions && Object.values(doc.parameters).some(value => value === null)) throw fail("PARAMETER_EXPORT_UNSUPPORTED", "Null native parameters cannot be represented by the query-pack parameter schema. Save the DAX text separately or provide explicit typed defaults.");
                const definitions = doc.parameterDefinitions ?? Object.fromEntries(Object.entries(doc.parameters).map(([name, value]) => [
                    name, { type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : Array.isArray(value) ? "list[text]" : "text", default: value },
                ]));
                return saveQueryFile({ directory: payload.directory, name: payload.name ?? doc.title, query: doc.query, parameters: definitions, connectionName: this.state.connections.find(c => c.id === doc.connectionId)?.name });
            }
            case "pack.import": {
                const { importPack, parameterDefaults } = await import("../integrations/libraries.mjs");
                const pack = await importPack(payload.path);
                if (pack.entries.length + this.state.documents.length > 10) throw fail("DOCUMENT_LIMIT", "This pack would exceed 10 open documents. Open individual queries from the library instead.");
                await this.mutate(next => {
                    for (const entry of pack.entries) {
                        const match = next.connections.find(c => c.name === entry.connectionName);
                        const doc = { ...makeDocument(entry.name), query: entry.query, parameterDefinitions: entry.parameters, parameters: parameterDefaults(entry.parameters ?? {}), connectionId: match?.id ?? "" };
                        next.documents.push(doc);
                    }
                    if (pack.entries.length) next.activeDocumentId = next.documents.at(-1).id;
                    next.selections = []; next.schema = null;
                });
                return { name: pack.name, count: pack.entries.length };
            }
            default: throw fail("UNKNOWN_ACTION", "This workbench action is not supported.");
        }
    }
    #previewGuard(payload, execute = false) {
        const doc = this.activeDocument();
        if (this.closed || doc.id !== payload.documentId || doc.connectionId !== payload.connectionId || doc.revision !== payload.revision)
            throw fail("REVISION_CONFLICT", "The active document/model changed. Read fresh builder context before previewing supplied DAX.");
        if (execute && !this.state.agentReadEnabled) throw fail("READ_GRANT_REQUIRED", "Copilot query execution is disabled.");
        return doc;
    }
    #previewMetadata(run, includeDiagnostics = false) {
        const active = ACTIVE_STATUSES.has(run.status);
        return { runId: run.id, title: run.previewTitle, status: run.status, connectionId: run.connectionId,
            querySha256: createHash("sha256").update(run.query).digest("hex"), startedAt: run.startedAt,
            elapsedMs: active ? Math.max(0, Date.now() - Date.parse(run.startedAt)) : run.wallDurationMs,
            durationMs: active ? null : run.providerDurationMs ?? null, limits: clone(run.executionLimits),
            rowCount: run.rowCount, truncated: run.truncated, resultSets: run.resultSets.map(set => ({
                id: set.id, rowCount: set.rowCount, truncated: set.truncated,
                columns: set.columns.map(column => ({ id: column.id, name: column.name, dataType: column.dataType })),
            })),
            ...(run.error ? { error: { code: run.error.code,
                message: includeDiagnostics ? run.error.message.slice(0, 2000) : "Preview failed. Review the local diagnostic in the canvas.",
                ...(includeDiagnostics ? { diagnosticTruncated: run.error.message.length > 2000 } : {}) } } : {}),
            warnings: run.warnings.length ? ["Review provider warnings in the canvas. Server cancellation is best effort."] : [],
            message: "Supplied DAX preview only. Editor, builder, bindings and dashboards were not changed. Timing is one observed run, not an ETA or business validation." };
    }
    async previewQuery(payload) {
        dashboardObject(payload, ["workbenchId", "documentId", "connectionId", "revision", "title", "query", "timeoutSeconds"],
            ["documentId", "connectionId", "revision", "title", "query"]);
        this.#previewGuard(payload, true);
        if (this.authoring.current) throw fail("AUTHORING_BUSY", "Wait for draft authoring to finish before previewing.");
        if (typeof payload.title !== "string" || !payload.title.trim() || payload.title.length > 120
            || typeof payload.query !== "string" || payload.query.length > 100000
            || payload.timeoutSeconds !== undefined && (!Number.isInteger(payload.timeoutSeconds) || payload.timeoutSeconds < 1 || payload.timeoutSeconds > 120))
            throw fail("INVALID_PREVIEW", "Supply a title, self-contained DAX under 100,000 characters and an optional 1-120 second timeout.");
        validateQuery(payload.query);
        const limits = { timeoutSeconds: Math.min(payload.timeoutSeconds ?? 60, this.state.limits.timeoutSeconds),
            maxRows: Math.min(DASHBOARD_LIMITS.snapshotRows, this.state.limits.maxRows),
            maxBytes: Math.min(DASHBOARD_LIMITS.snapshotBytes, this.state.limits.maxBytes) };
        const started = await this.runQuery(payload.documentId, "agent", payload.revision, undefined, undefined,
            { query: payload.query, title: payload.title, limits });
        return this.#previewMetadata(this.#run(started.runId));
    }
    async previewStatus(payload) {
        dashboardObject(payload, ["workbenchId", "documentId", "connectionId", "revision", "runId", "waitSeconds", "includeDiagnostics"],
            ["documentId", "connectionId", "revision", "runId"]);
        this.#previewGuard(payload);
        if (payload.waitSeconds !== undefined && (!Number.isInteger(payload.waitSeconds) || payload.waitSeconds < 0 || payload.waitSeconds > 20))
            throw fail("INVALID_PREVIEW", "Wait at most 20 seconds for preview status.");
        if (payload.includeDiagnostics !== undefined && typeof payload.includeDiagnostics !== "boolean")
            throw fail("INVALID_PREVIEW", "Explicitly choose whether to read this preview's diagnostic.");
        const guard = () => {
            this.#previewGuard(payload);
            if (payload.includeDiagnostics && !this.state.agentResultsEnabled)
                throw fail("RESULT_READ_GRANT_REQUIRED", "Copilot result analysis is disabled. Review the diagnostic locally.");
            const run = this.#run(payload.runId), connection = this.state.connections.find(item => item.id === payload.connectionId);
            if (run.querySource !== "preview" || run.documentId !== `preview:${payload.documentId}` || run.connectionId !== payload.connectionId
                || run.revision !== payload.revision || !connection || run.resultConnectionKey !== this.#hash(connection)
                || run.resultAccessScope !== this.#resultAccessScope())
                throw fail("PREVIEW_SCOPE_CHANGED", "Use a known preview run from this document, revision and connection session. Saved dashboard runs are not exposed.");
            return run;
        };
        guard();
        const task = this.running.get(payload.runId);
        if (task && payload.waitSeconds) {
            let timer;
            try { await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, payload.waitSeconds * 1000); })]); }
            finally { clearTimeout(timer); }
        }
        return this.#previewMetadata(guard(), payload.includeDiagnostics === true);
    }
    async startModelPreview(payload) {
        dashboardObject(payload, ["documentId", "connectionId", "revision", "objectId"]);
        const doc = this.activeDocument();
        if (payload.documentId !== doc.id || payload.connectionId !== doc.connectionId)
            throw fail("PREVIEW_SCOPE_CHANGED", "The active query or model changed. Choose Preview data again.");
        if (!this.#eligibleSchema()) throw fail("PREVIEW_SCHEMA_UNAVAILABLE", "Refresh native model metadata before previewing data.");
        if (!Number.isSafeInteger(payload.revision) || payload.revision !== doc.revision)
            throw fail("REVISION_CONFLICT", "The query changed. Wait for the draft to save, then preview again.");
        const object = this.state.schema.objects.find(item => item.id === payload.objectId);
        const preview = modelPreviewQuery(object, this.state.schema.objects);
        return this.runQuery(doc.id, "ui", payload.revision, undefined, undefined, {
            ...preview, limits: MODEL_PREVIEW_LIMITS, modelObjectId: object.id,
        });
    }
    #filterValuesField(payload) {
        if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen DAX Workbench before loading filter values.");
        const doc = this.activeDocument();
        if (payload.documentId !== doc.id || payload.connectionId !== doc.connectionId)
            throw fail("FILTER_SCOPE_CHANGED", "The query tab or model changed. Open the value picker again.");
        if (!this.#eligibleSchema())
            throw fail("FILTER_SCHEMA_UNAVAILABLE", "Refresh native model metadata before loading filter values.");
        const field = this.state.schema.objects.find(object => object.id === payload.fieldId && object.kind === "column" && object.table);
        if (!field) throw fail("INVALID_FILTER_FIELD", "This column is not in the active native model schema.");
        return { doc, field };
    }
    async startFilterValues(payload) {
        dashboardObject(payload, ["documentId", "connectionId", "revision", "fieldId", "search", "order"], ["documentId", "connectionId", "revision", "fieldId"]);
        const { doc, field } = this.#filterValuesField(payload);
        if (!Number.isSafeInteger(payload.revision) || payload.revision !== doc.revision)
            throw fail("REVISION_CONFLICT", "The query changed. Wait for the draft to save, then load values again.");
        const order = payload.order === undefined ? defaultFilterValueOrder(field) : payload.order;
        return this.runQuery(doc.id, "ui", payload.revision, undefined, undefined, {
            query: filterValuesQuery(field, payload.search, order), title: `Filter values: ${field.table} / ${field.name}`,
            limits: order.startsWith("month-") ? FILTER_MONTH_VALUE_LIMITS : FILTER_VALUE_LIMITS, filterFieldId: field.id, filterValueOrder: order,
        });
    }
    async readFilterValues(payload) {
        dashboardObject(payload, ["documentId", "connectionId", "fieldId", "runId"]);
        const guard = () => {
            const { doc, field } = this.#filterValuesField(payload), run = this.#run(payload.runId);
            if (run.querySource !== "filter-values" || run.documentId !== `filter:${doc.id}`
                || run.connectionId !== doc.connectionId || run.filterFieldId !== field.id
                || run.resultAccessScope !== this.#resultAccessScope() || run.resultConnectionKey !== this.#connectionKey()
                || run.metadataFingerprint !== this.#hash(this.state.schema.objects))
                throw fail("FILTER_SCOPE_CHANGED", "These values belong to an earlier model or metadata session. Load values again.");
            if (run.status !== "completed") throw fail("FILTER_VALUES_NOT_READY", "Wait for the value lookup to complete, or retry a failed lookup.");
            if (run.resultSets.length !== 1 || run.resultSets[0].columns.length !== 1)
                throw fail("INVALID_FILTER_RESULT", "The provider did not return the expected filter values.");
            return { run, set: run.resultSets[0], field };
        };
        const { run, set, field } = guard();
        const monthly = run.filterValueOrder?.startsWith("month-");
        const incomplete = () => fail("FILTER_MONTH_ORDER_INCOMPLETE",
            "Month ordering needs a complete set of labels, but this lookup reached a row or byte limit. Search a specific year, or choose A to Z and load again.");
        if (monthly && (run.truncated || set.truncated || set.rowCount >= Math.min(run.executionLimits?.maxRows ?? FILTER_MONTH_VALUE_LIMITS.maxRows, FILTER_MONTH_VALUE_LIMITS.maxRows)))
            throw incomplete();
        const rows = [];
        let captureBytes = 0, truncated = false;
        do {
            const page = await this.page(run.id, set.id, rows.length, 200);
            guard();
            if (page.offset !== rows.length || page.total !== set.rowCount || page.rows.length > 200
                || page.rows.some(row => row.length !== 1) || rows.length + page.rows.length > set.rowCount
                || (!page.rows.length && rows.length < set.rowCount))
                throw fail("INVALID_FILTER_RESULT", "The captured values changed. Load them again.");
            truncated ||= page.truncated;
            if (monthly && truncated) throw incomplete();
            captureBytes += Buffer.byteLength(JSON.stringify(page.rows), "utf8");
            if (monthly && captureBytes > FILTER_MONTH_VALUE_LIMITS.maxBytes) throw incomplete();
            rows.push(...page.rows);
        } while (monthly && rows.length < set.rowCount);
        const ordered = rows.map((row, index) => ({ option: filterValueOption(row[0], field), key: monthly ? monthLabelKey(row[0]) : null, index }));
        if (monthly) ordered.sort((a, b) => a.key === null || b.key === null
            ? a.key === null && b.key === null ? a.index - b.index : a.key === null ? 1 : -1
            : (a.key - b.key) * (run.filterValueOrder === "month-desc" ? -1 : 1) || a.index - b.index);
        const response = { runId: run.id, order: run.filterValueOrder ?? "asc", options: [], capturedCount: rows.length,
            limited: Boolean(truncated || set.rowCount > Math.min(rows.length, 200)), warnings: [...run.warnings] };
        let bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
        if (bytes > FILTER_VALUE_LIMITS.maxBytes) throw fail("FILTER_VALUE_TOO_LARGE", "The provider's lookup metadata exceeds 64 KiB. Review the run in History.");
        for (const { option, key } of ordered.slice(0, 200)) {
            if (key !== null) option.calendarYear = Math.floor(key / 100);
            const size = Buffer.byteLength(JSON.stringify(option), "utf8") + 1;
            if (bytes + size > FILTER_VALUE_LIMITS.maxBytes) {
                if (!response.options.length) throw fail("FILTER_VALUE_TOO_LARGE", "A value exceeds the picker's 64 KiB response limit. Use an exact literal filter instead.");
                response.limited = true; break;
            }
            response.options.push(option); bytes += size;
        }
        return response;
    }
    async runQuery(documentId, source = "ui", expectedRevision, builderRun, dashboardRun, previewRun, projectRun) {
        if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen DAX Workbench before running a query.");
        if (source !== "ui" && !this.state.agentReadEnabled) throw fail("READ_GRANT_REQUIRED", "Copilot queries are turned off. Use Context Lens > Allow Copilot to run queries to enable them.");
        if (!this.state.native.available) throw fail("NATIVE_UNAVAILABLE", "The query engine is unavailable. Reconnect before running a query.");
        const providerGeneration = this.providerGeneration, registryGeneration = this.registryGeneration;
        if (projectRun) {
            if (source !== "ui" || builderRun || dashboardRun || previewRun) throw fail("USER_ACTION_REQUIRED", "Managed projects run only through their explicit person-started process.");
            this.projects.assertRun(projectRun);
        }
        const doc = projectRun ? { ...clone(projectRun.source), id: `${projectRun.id}:${projectRun.source.id}` }
            : dashboardRun ? { ...clone(dashboardRun.source), id: `dashboard:${dashboardRun.dashboardId}:${dashboardRun.tileId}`, revision: dashboardRun.source.queryRevision }
            : previewRun ? { ...clone(this.#document(this.state, documentId)), query: previewRun.query, parameters: {}, parameterDefinitions: undefined, builder: undefined }
                : this.#document(this.state, documentId);
        if (expectedRevision !== undefined && expectedRevision !== doc.revision) throw fail("REVISION_CONFLICT", "The query changed before execution. Review the current editor and run again.");
        let query = builderRun?.query ?? doc.query, nativeParameters = builderRun?.parameters ?? doc.parameters, recordedParameters = nativeParameters;
        validateParameters(nativeParameters, !builderRun && !!doc.parameterDefinitions);
        const templated = !builderRun && !!doc.parameterDefinitions && Object.keys(doc.parameterDefinitions).length > 0 && /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.test(query);
        if (templated) {
            const { renderQueryTemplate } = await import("../integrations/libraries.mjs");
            const rendered = renderQueryTemplate({ query, definitions: doc.parameterDefinitions, values: doc.parameters });
            query = rendered.query; recordedParameters = rendered.values;
            nativeParameters = {};
        } else validateParameters(nativeParameters);
        validateQuery(query);
        const connection = this.state.connections.find(c => c.id === doc.connectionId);
        if (!connection) throw fail("CONNECTION_NOT_FOUND", "Choose a connection before running.");
        if (connection.capabilities?.query?.status === "unsupported") throw fail("UNSUPPORTED_CONNECTION", connection.capabilities.query.reason);
        if (this.state.runs.some(r => r.connectionId === doc.connectionId && ACTIVE_STATUSES.has(r.status))) throw fail("CONNECTION_BUSY", "One query is already active on this connection. Cancel it or wait.");
        if (this.state.runs.filter(r => ACTIVE_STATUSES.has(r.status)).length >= 2) throw fail("WORKBENCH_BUSY", "At most two connections can run concurrently in this workbench. Wait or cancel a run.");
        let sourceBuilder = builderRun?.definition, builderCaptureWarning;
        if (!dashboardRun && !projectRun && !sourceBuilder && doc.builder && !doc.builderImport && !doc.parameterDefinitions) {
            try {
                const built = generateBuilderQuery(doc.builder);
                if (built.query.trim() === query.trim() || updateBuilderBlock("", built.query).trim() === query.trim()) sourceBuilder = doc.builder;
            } catch (error) { builderCaptureWarning = `Builder scope was not captured; the executed DAX remains authoritative. ${safeError(error).message}`; }
        }
        const run = {
            id: randomUUID(), documentId: previewRun ? `${previewRun.filterFieldId ? "filter" : previewRun.modelObjectId ? "model" : "preview"}:${doc.id}` : doc.id, revision: doc.revision, connectionId: doc.connectionId, connectionKind: connection.kind,
            resultAccessScope: this.#resultAccessScope(), resultConnectionKey: this.#hash(connection),
            sourceQueryFingerprint: queryFingerprint(builderRun
                ? { ...doc, query: builderRun.query, parameters: nativeParameters, parameterDefinitions: undefined } : doc),
            ...(builderRun ? { querySource: "builder", builderRevision: builderRun.builderRevision } : {}),
            ...(previewRun ? { querySource: previewRun.filterFieldId ? "filter-values" : previewRun.modelObjectId ? "model-preview" : "preview", previewTitle: previewRun.title,
                ...(previewRun.modelObjectId ? { modelObjectId: previewRun.modelObjectId } : {}),
                ...(previewRun.filterFieldId ? { filterFieldId: previewRun.filterFieldId, filterValueOrder: previewRun.filterValueOrder } : {}), executionLimits: clone(previewRun.limits) } : {}),
            ...(projectRun ? { querySource: "project", projectId: projectRun.id } : {}),
            query, parameters: clone(recordedParameters), parameterDefinitions: builderRun ? undefined : doc.parameterDefinitions, templateQuery: templated ? doc.query : undefined,
            metadataFingerprint: this.state.schema?.connectionId === doc.connectionId ? this.#hash(this.state.schema.objects) : null,
            schemaFetchedAt: this.state.schema?.connectionId === doc.connectionId ? this.state.schema.fetchedAt : null,
            startedAt: new Date().toISOString(), durationMs: 0,
            status: "queued", resultSets: [], rowCount: 0, truncated: false, warnings: [...(builderCaptureWarning ? [builderCaptureWarning] : []), ...(previewRun?.warnings ?? [])], pinned: false, retained: true,
            ...(sourceBuilder ? { sourceBuilder: clone(sourceBuilder) } : {}),
            ...(dashboardRun ? { dashboardId: dashboardRun.dashboardId, tileId: dashboardRun.tileId } : {}),
        };
        await this.mutate(next => {
            if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen DAX Workbench before running a query.");
            if (!this.state.native.available || this.providerGeneration !== providerGeneration || this.registryGeneration !== registryGeneration)
                throw fail("CONNECTION_CHANGED", "The query connection changed before execution. Review the current connection and run again.");
            if (projectRun) this.projects.assertRun(projectRun);
            else if (dashboardRun) {
                const board = this.dashboards.get(dashboardRun.dashboardId), tile = board.tiles.find(item => item.id === dashboardRun.tileId);
                if (!tile || board.archived || dashboardRun.batch.cancelled || tileExecution(board, tile).fingerprint !== dashboardRun.fingerprint)
                    throw fail("REVISION_CONFLICT", "The dashboard changed or its refresh was cancelled. No query was run.");
            } else {
                const current = this.#document(next, doc.id);
                if (current.revision !== doc.revision || current.connectionId !== doc.connectionId) throw fail("REVISION_CONFLICT", "The query changed before execution. No query was run.");
                if ((previewRun?.filterFieldId || previewRun?.modelObjectId) && (next.activeDocumentId !== doc.id || !this.#eligibleSchema()
                    || this.#hash(this.state.schema.objects) !== run.metadataFingerprint))
                    throw fail(previewRun.modelObjectId ? "PREVIEW_SCOPE_CHANGED" : "FILTER_SCOPE_CHANGED", "The active model metadata changed. No preview or value lookup was run.");
                if (builderRun && (current.builderRevision ?? 0) !== builderRun.builderRevision) throw fail("REVISION_CONFLICT", "Builder selections changed before execution. No query was run.");
            }
            if (source !== "ui" && (!next.agentReadEnabled || next.activeDocumentId !== doc.id)) throw fail("READ_GRANT_REQUIRED", "The active document's read permission changed before execution.");
            if (next.runs.some(r => r.connectionId === doc.connectionId && ACTIVE_STATUSES.has(r.status))) throw fail("CONNECTION_BUSY", "One query is already active on this connection. Cancel it or wait.");
            if (next.runs.filter(r => ACTIVE_STATUSES.has(r.status)).length >= 2) throw fail("WORKBENCH_BUSY", "At most two connections can run concurrently.");
            if (previewRun) for (const key of ["timeoutSeconds", "maxRows", "maxBytes"])
                run.executionLimits[key] = Math.min(run.executionLimits[key], next.limits[key]);
            next.runs.unshift(run); next.runs = next.runs.slice(0, 100);
            if (!dashboardRun && !previewRun && !projectRun) next.selections = [];
        });
        if (dashboardRun || projectRun) this.resultLeases.set(run.id, (this.resultLeases.get(run.id) ?? 0) + 1);
        const task = this.#execute(run, { ...(run.executionLimits ?? this.state.limits) }, nativeParameters, { providerGeneration, registryGeneration });
        this.running.set(run.id, task);
        void task.finally(() => this.running.delete(run.id)).catch(error => {
            this.emit("operationError", safeError(error));
        });
        return { runId: run.id, status: "queued" };
    }
    async #execute(run, limits, nativeParameters, admission) {
        let outcome;
        try {
            if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen DAX Workbench before running a query.");
            if (!this.state.native.available || this.providerGeneration !== admission.providerGeneration || this.registryGeneration !== admission.registryGeneration)
                throw fail("CONNECTION_CHANGED", "The query connection changed before execution. Review the current connection and run again.");
            outcome = await this.native.request("query.execute", {
                runId: run.id, workbenchId: this.id, cacheResults: this.results.nativeCache,
                connectionId: run.connectionId, query: run.query, parameters: nativeParameters, ...limits,
            }, (limits.timeoutSeconds + 30) * 1000);
        } catch (error) {
            outcome = { status: "failed", error: safeError(error) };
        }
        if (this.cacheErrors.has(run.id)) {
            outcome = { ...outcome, status: "failed", error: this.cacheErrors.get(run.id) };
            this.cacheErrors.delete(run.id);
        }
        await this.mutate(next => {
            const current = next.runs.find(r => r.id === run.id);
            if (!current) return;
            for (const key of ["status", "resultSets", "rowCount", "durationMs", "truncated", "error"]) if (outcome[key] !== undefined) current[key] = outcome[key];
            if (outcome.warnings) current.warnings = [...new Set([...current.warnings, ...outcome.warnings])];
            if (outcome.unreadResultSets) current.warnings.push("Result reading did not finish; this preview may omit rows or result sets.");
            if (outcome.error) current.error = outcome.error;
            current.wallDurationMs = Math.max(0, Date.now() - Date.parse(current.startedAt));
            if (current.querySource === "preview" && Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0)
                current.providerDurationMs = outcome.durationMs;
        });
        await this.#trimCache([run.id]);
    }
    #dashboardSource(run) {
        const connection = this.state.connections.find(item => item.id === run.connectionId);
        if (!connection || run.resultConnectionKey !== this.#hash(connection))
            throw fail("CONNECTION_CHANGED", "The result's connection identity changed. Run on the intended connection before pinning.");
        const source = {
            version: 1, connectionId: connection.id, connectionName: connection.name, model: connection.model ?? null,
            connectionKind: connection.kind, query: run.templateQuery ?? run.query, parameters: clone(run.parameters),
            ...(run.parameterDefinitions ? { parameterDefinitions: clone(run.parameterDefinitions) } : {}),
            ...(run.sourceBuilder ? { builder: clone(run.sourceBuilder) } : {}),
            documentId: run.documentId, queryRevision: run.revision,
        };
        return { ...source, fingerprint: dashboardFingerprint(source) };
    }
    async branchResult(payload) {
        dashboardObject(payload, ["runId", "resultSetId", "row", "columnId"]);
        const run = this.#run(payload.runId), set = run.resultSets.find(set => set.id === payload.resultSetId);
        if (!run.sourceBuilder || run.status !== "completed" || !set)
            throw fail("BRANCH_SOURCE_UNAVAILABLE", "Branching requires a completed run with a verified executed builder. Freeform DAX is never rewritten by guessing filters.");
        const source = this.#dashboardSource(run), column = set.columns.find(column => column.id === payload.columnId);
        if (!column || !Number.isSafeInteger(payload.row) || payload.row < 0 || payload.row >= set.rowCount)
            throw fail("INVALID_BRANCH_CELL", "Choose an existing captured row and column.");
        const fields = source.builder.fields.filter(field => field.kind === "column"
            && [builderReference(field), `${field.table}[${field.name}]`, `[${field.name.replaceAll("]", "]]")}]`].includes(column.name));
        if (fields.length !== 1) throw fail("BRANCH_FIELD_AMBIGUOUS", "This output column does not uniquely identify a builder dimension. Choose an unambiguous dimension, not a measure.");
        const generation = this.providerGeneration, registry = this.registryGeneration;
        const connection = this.state.connections.find(item => item.id === source.connectionId), connectionKey = this.#hash(connection);
        const guard = () => {
            const current = this.state.connections.find(item => item.id === source.connectionId);
            if (this.closed || !current || this.#hash(current) !== connectionKey || generation !== this.providerGeneration || registry !== this.registryGeneration)
                throw fail("CONNECTION_CHANGED", "The source connection changed. Nothing was branched.");
        };
        const value = await this.#withResults([run.id], async () => {
            await this.#restoreRows(run);
            const page = await this.results.page(run, set, payload.row, 1);
            if (page.offset !== payload.row || page.rows.length !== 1 || page.total !== set.rowCount)
                throw fail("RESULT_CORRUPT", "The selected captured cell is no longer available.");
            return page.rows[0][set.columns.findIndex(item => item.id === column.id)];
        });
        const definition = clone(source.builder);
        definition.filters.push({ id: randomUUID(), field: { ...clone(fields[0]), dataType: column.dataType },
            operator: value === null ? "IsBlank" : "Is", value: value === null ? "" : String(value), enabled: true });
        const schema = await this.native.request("schema.get", { connectionId: source.connectionId });
        guard();
        if (schema.connectionId !== source.connectionId) throw fail("CONNECTION_CHANGED", "The returned schema belongs to another model.");
        validateBuilderSchema(definition, schema.objects);
        const built = generateBuilderQuery(definition);
        await this.mutate(next => {
            guard();
            if (next.documents.length >= 10) throw fail("DOCUMENT_LIMIT", "Close a query tab before branching this result.");
            const doc = { ...makeDocument(`Branch: ${fields[0].name}`), connectionId: source.connectionId,
                query: updateBuilderBlock("", built.query), parameters: clone(run.parameters),
                builder: definition, builderRevision: 0, builderAutoUpdate: true, authoringFocus: { id: randomUUID(), surface: "builder" } };
            next.documents.push(doc); next.activeDocumentId = doc.id; next.selections = [];
        });
        await this.refreshSchema().catch(error => this.emit("operationError", safeError(error)));
        return this.snapshot();
    }
    async #dashboardRows(run, set) {
        if (run.status !== "completed") throw fail("DASHBOARD_INCOMPLETE", "Only completed query results can be captured.");
        if (set.rowCount > DASHBOARD_LIMITS.snapshotRows || set.columns.length > DASHBOARD_LIMITS.snapshotColumns)
            throw fail("DASHBOARD_SNAPSHOT_LIMIT", "Dashboard captures support 10,000 rows and 64 columns. Refine the query; no rows are sampled.");
        return this.#withResults([run.id], async () => {
            await this.#restoreRows(run);
            const rows = []; let size = 0;
            while (rows.length < set.rowCount) {
                const page = await this.results.page(run, set, rows.length, 500);
                if (page.offset !== rows.length || !page.rows.length || page.total !== set.rowCount)
                    throw fail("RESULT_CORRUPT", "The result changed during capture. No dashboard snapshot was saved.");
                size += Buffer.byteLength(JSON.stringify(page.rows));
                if (size > DASHBOARD_LIMITS.snapshotBytes) throw fail("DASHBOARD_SNAPSHOT_LIMIT", "This capture exceeds 1.2 MB. Refine the query; no rows are sampled.");
                rows.push(...page.rows);
            }
            return rows;
        });
    }
    async dashboardAction(action, payload) {
        if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen the workbench before using dashboards.");
        const store = this.dashboards;
        if (action === "dashboards.catalog") { await store.reload(); return store.catalog(); }
        if (action === "dashboards.get") {
            await store.reload();
            const batch = this.dashboardRefreshes.get(payload.id);
            const dashboard = store.get(payload.id);
            return { dashboard, captureStatus: store.captureStatus(dashboard),
                filterTargets: Object.fromEntries(dashboard.tiles.map(tile => [tile.id, dashboardTargets(tile.source ?? tile.unboundSource)])),
                refresh: batch ? this.#dashboardRefreshStatus(batch) : null };
        }
        if (action === "dashboards.snapshot") {
            await store.reload(); const board = store.get(payload.id), tile = board.tiles.find(item => item.id === payload.tileId);
            if (!tile || ![tile.snapshotId, ...tile.previousSnapshotIds].includes(payload.snapshotId))
                throw fail("DASHBOARD_SNAPSHOT_MISSING", "Choose a capture belonging to this tile.");
            return store.snapshot(payload.snapshotId);
        }
        if (action === "dashboards.officeShare") {
            dashboardObject(payload, ["id", "expectedRevision", "tileId", "snapshotId", "format"]);
            if (!["excel", "powerpoint"].includes(payload.format)) throw fail("INVALID_DASHBOARD", "Choose Excel or PowerPoint for the explicit handoff.");
            await store.reload(); const board = store.get(payload.id), tile = board.tiles.find(tile => tile.id === payload.tileId);
            if (board.revision !== payload.expectedRevision || !tile || tile.snapshotId !== payload.snapshotId)
                throw fail("REVISION_CONFLICT", "The displayed capture changed. Inspect it again before sharing.");
            const snapshot = await store.snapshot(payload.snapshotId);
            await store.reload();
            if (store.get(board.id).revision !== payload.expectedRevision)
                throw fail("REVISION_CONFLICT", "The dashboard changed while preparing the handoff. Nothing was shared.");
            const handoff = { version: 1, format: payload.format, title: tile.title, units: tile.visual.units || "Not documented",
                visual: resolveDashboardVisual(tile.visual, snapshot.columns), capturedAt: snapshot.capturedAt, truncated: snapshot.truncated, origin: snapshot.origin,
                columns: clone(snapshot.columns), rows: clone(snapshot.rows), source: {
                    model: snapshot.source?.model ?? null, runId: snapshot.runId ?? null, resultSetId: snapshot.resultSetId ?? null,
                    queryRevision: snapshot.source?.queryRevision ?? null, mappedFilters: clone(snapshot.executedFilters),
                    ...(snapshot.sourceDescription ? { description: snapshot.sourceDescription } : {}),
                }, ...(snapshot.checks ? { checks: clone(snapshot.checks) } : {}) };
            if (snapshot.rows.length > 2000 || Buffer.byteLength(JSON.stringify(handoff)) > 96 * 1024)
                throw fail("OFFICE_HANDOFF_LIMIT", "Share at most 2,000 rows and 96 KiB. This capture was not shortened or shared; use its explicit data download instead.");
            return handoff;
        }
        if (action === "dashboards.create") {
            dashboardObject(payload, ["title", "expectedRevision"]);
            const board = await store.create(payload.title, payload.expectedRevision); this.publish(); return board;
        }
        if (action === "dashboards.delete") {
            dashboardObject(payload, ["id", "expectedRevision", "confirmed"]);
            dashboardId(payload.id);
            if (payload.confirmed !== true) throw fail("DELETE_CONFIRMATION_REQUIRED", "Confirm deletion of this dashboard in the canvas.");
            if (this.dashboardDeletions.has(payload.id)) throw fail("RUNNING", "This dashboard is already being deleted.");
            const guard = () => {
                if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen the workbench before deleting a dashboard.");
                if (this.dashboardRefreshes.get(payload.id)?.status === "running"
                    || this.state.runs.some(run => run.dashboardId === payload.id && ACTIVE_STATUSES.has(run.status)))
                    throw fail("RUNNING", "Cancel this dashboard's refresh and wait for it to stop before deleting.");
            };
            guard(); this.dashboardDeletions.add(payload.id);
            try {
                const result = await store.remove(payload.id, payload.expectedRevision, guard);
                this.dashboardRefreshes.delete(payload.id);
                this.publish(); return result;
            } finally { this.dashboardDeletions.delete(payload.id); }
        }
        if (action === "dashboards.export") {
            dashboardObject(payload, ["id", "expectedRevision"]);
            await store.reload(); const board = store.get(payload.id);
            if (board.revision !== payload.expectedRevision) throw fail("REVISION_CONFLICT", "Reload before exporting the saved definition.");
            return dashboardDefinition(board);
        }
        if (action === "dashboards.import") {
            dashboardObject(payload, ["definition", "expectedRevision"]);
            const board = await store.importDefinition(payload.definition, payload.expectedRevision);
            this.publish(); return board;
        }
        if (action === "dashboards.freeze") {
            dashboardObject(payload, ["id", "expectedRevision", "reviewer"]);
            if (this.dashboardRefreshes.get(payload.id)?.status === "running") throw fail("RUNNING", "Wait for refresh to finish before reviewing a release.");
            const board = await store.freeze(payload.id, payload.expectedRevision, payload.reviewer);
            this.publish(); return board;
        }
        if (action === "dashboards.rebind") {
            dashboardObject(payload, ["id", "expectedRevision", "tileId", "tileIds", "connectionId"], ["id", "expectedRevision", "connectionId"]);
            if (Object.hasOwn(payload, "tileId") === Object.hasOwn(payload, "tileIds"))
                throw fail("INVALID_DASHBOARD", "Choose one tile or an explicit group of unbound tiles.");
            const tileIds = Object.hasOwn(payload, "tileIds") ? payload.tileIds : [payload.tileId];
            if (!Array.isArray(tileIds) || !tileIds.length || tileIds.length > DASHBOARD_LIMITS.tiles || new Set(tileIds).size !== tileIds.length)
                throw fail("INVALID_DASHBOARD", "Choose a nonempty group of distinct unbound tiles.");
            tileIds.forEach(dashboardId);
            const connection = this.state.connections.find(item => item.id === payload.connectionId);
            if (!connection) throw fail("CONNECTION_CHANGED", "Explicitly choose an available connection.");
            const connectionKey = this.#hash(connection), generation = this.providerGeneration, registry = this.registryGeneration;
            const board = await store.update(payload.id, payload.expectedRevision, async board => {
                if (board.archived || board.release) throw fail("INVALID_DASHBOARD", "Choose an editable, unarchived dashboard before connecting its tiles.");
                if (this.dashboardRefreshes.get(board.id)?.status === "running")
                    throw fail("RUNNING", "Wait for refresh to finish before connecting tiles.");
                const tiles = tileIds.map(id => board.tiles.find(item => item.id === id));
                if (tiles.some(tile => !tile?.unboundSource || tile.archived))
                    throw fail("INVALID_DASHBOARD", "Only visible unbound query tiles can be connected. Reload the dashboard and review the selection.");
                const original = tiles[0].unboundSource;
                if (tiles.some(({ unboundSource: source }) => source.connectionId !== original.connectionId
                    || source.connectionKind !== original.connectionKind || source.model !== original.model))
                    throw fail("INVALID_DASHBOARD", "Connect each original model group separately; mixed source models cannot be bound together.");
                let schema;
                for (const tile of tiles) {
                    const source = { ...clone(tile.unboundSource), connectionId: connection.id, connectionName: connection.name,
                        model: connection.model ?? null, connectionKind: connection.kind };
                    delete source.documentId; delete source.fingerprint;
                    if (source.builder) {
                        schema ??= await this.native.request("schema.get", { connectionId: connection.id });
                        if (schema.connectionId !== connection.id) throw fail("CONNECTION_CHANGED", "The selected schema belongs to another connection.");
                        validateBuilderSchema(source.builder, schema.objects);
                    }
                    tile.source = { ...source, fingerprint: dashboardFingerprint(source) }; delete tile.unboundSource;
                }
                const current = this.state.connections.find(item => item.id === connection.id);
                if (this.closed || !current || connectionKey !== this.#hash(current) || generation !== this.providerGeneration || registry !== this.registryGeneration)
                    throw fail("CONNECTION_CHANGED", "The selected connection changed while rebinding.");
                if (this.dashboardRefreshes.get(board.id)?.status === "running")
                    throw fail("RUNNING", "A refresh started while connecting tiles. Wait for it to finish and try again.");
            });
            this.publish(); return board;
        }
        if (action === "dashboards.home") {
            dashboardObject(payload, ["id", "expectedRevision"]);
            const result = await store.setHome(payload.id, payload.expectedRevision); this.publish(); return result;
        }
        if (action === "dashboards.cleanup") {
            dashboardObject(payload, []);
            if ([...this.dashboardRefreshes.values()].some(batch => batch.status === "running"))
                throw fail("RUNNING", "Wait for dashboard refreshes before removing unused captures.");
            const result = await store.cleanup(); this.publish(); return result;
        }
        if (action === "dashboards.refresh") return this.#startDashboardRefresh(payload);
        if (action === "dashboards.duplicate" || action === "dashboards.restoreCapture") {
            dashboardObject(payload, action === "dashboards.duplicate"
                ? ["id", "expectedRevision", "tileId"] : ["id", "expectedRevision", "tileId", "snapshotId"],
            action === "dashboards.duplicate" ? ["id", "expectedRevision"] : ["id", "expectedRevision", "tileId", "snapshotId"]);
            const board = action === "dashboards.duplicate" ? await store.duplicate(payload.id, payload.expectedRevision, payload.tileId)
                : await store.restoreCapture(payload.id, payload.expectedRevision, payload.tileId, payload.snapshotId);
            this.publish(); return board;
        }
        if (action === "dashboards.cancel") {
            dashboardObject(payload, ["id", "refreshId"]);
            const batch = this.dashboardRefreshes.get(payload.id);
            if (!batch || batch.id !== payload.refreshId) throw fail("REVISION_CONFLICT", "This refresh is no longer active.");
            if (batch.status !== "running") return this.#dashboardRefreshStatus(batch);
            batch.cancelled = true;
            const active = this.state.runs.filter(run => run.dashboardId === batch.dashboardId && ACTIVE_STATUSES.has(run.status)).map(run => run.id);
            for (const tile of batch.tiles) if (tile.status === "queued") tile.status = "cancelled";
            if (!active.length) batch.status = "cancelled";
            this.publish();
            await Promise.all(active.map(async runId => {
                if (!ACTIVE_STATUSES.has(this.#run(runId).status)) return;
                try { await this.action("query.cancel", { runId }); }
                catch (error) { if (error.code !== "NOT_RUNNING") throw error; }
            }));
            this.publish(); return this.#dashboardRefreshStatus(batch);
        }
        if (action === "dashboards.openQuery") {
            await store.reload(); const board = store.get(payload.id), tile = board.tiles.find(item => item.id === payload.tileId);
            if (!tile?.source) throw fail("DASHBOARD_SNAPSHOT_ONLY", "This tile has no saved query source.");
            const execution = tileExecution(board, tile);
            await this.mutate(next => {
                if (next.documents.length >= 10) throw fail("DOCUMENT_LIMIT", "Close a query tab before exploring this tile.");
                const source = execution.source;
                const doc = { ...makeDocument(tile.title), query: source.query, connectionId: source.connectionId,
                    parameters: clone(source.parameters), ...(source.parameterDefinitions ? { parameterDefinitions: clone(source.parameterDefinitions) } : {}) };
                next.documents.push(doc); next.activeDocumentId = doc.id; next.selections = [];
            });
            if (this.state.connections.some(connection => connection.id === execution.source.connectionId))
                await this.refreshSchema().catch(error => this.emit("operationError", safeError(error)));
            return this.snapshot();
        }
        if (action === "dashboards.pin") {
            dashboardObject(payload, ["id", "expectedRevision", "pageId", "runId", "resultSetId", "title", "visual"]);
            const run = this.#run(payload.runId), set = run.resultSets.find(item => item.id === payload.resultSetId);
            if (!set) throw fail("RESULT_NOT_FOUND", "Choose a result set to pin.");
            const source = this.#dashboardSource(run), rows = await this.#dashboardRows(run, set);
            const tile = { id: randomUUID(), pageId: payload.pageId, title: payload.title, width: 6, height: 360,
                source, visual: payload.visual, mappings: [], previousSnapshotIds: [] };
            const board = await store.capture(payload.id, tile.id, { version: 1, id: randomUUID(), capturedAt: run.startedAt,
                runId: run.id, resultSetId: set.id, source, columns: set.columns, rows, executedFilters: [],
                truncated: run.truncated || set.truncated, origin: "run", durationMs: run.durationMs }, tileExecution(store.get(payload.id), tile).fingerprint,
                { expectedRevision: payload.expectedRevision, tile });
            this.publish(); return board;
        }
        if (action === "dashboards.pinArtifact") {
            dashboardObject(payload, ["id", "expectedRevision", "pageId", "artifactId"]);
            const artifact = await this.artifacts.get(payload.artifactId);
            if (!artifact.visual) throw fail("INVALID_DASHBOARD", "Choose a saved visual artifact.");
            const visual = artifact.visual, tile = { id: randomUUID(), title: artifact.title, pageId: payload.pageId,
                width: 6, height: 360, visual: { type: visual.config.type, chart: visual.config, units: "" }, mappings: [], previousSnapshotIds: [] };
            const board = await store.capture(payload.id, tile.id, { version: 1, id: randomUUID(), capturedAt: new Date().toISOString(),
                columns: visual.columns, rows: visual.rows, executedFilters: [], truncated: visual.provenance.truncated,
                origin: "artifact", sourceDescription: visual.provenance.description }, undefined, { expectedRevision: payload.expectedRevision, tile });
            this.publish(); return board;
        }
        if (action === "dashboards.edit") {
            dashboardObject(payload, ["id", "expectedRevision", "title", "favorite", "archived", "pages", "filters", "tiles"], ["id", "expectedRevision"]);
            const board = await store.update(payload.id, payload.expectedRevision, board => {
                for (const key of ["title", "favorite", "archived", "pages", "filters"]) if (payload[key] !== undefined) board[key] = clone(payload[key]);
                if (payload.tiles) {
                    if (!Array.isArray(payload.tiles)) throw fail("INVALID_DASHBOARD", "Supply a tile list.");
                    board.tiles = payload.tiles.map(edit => {
                        dashboardObject(edit, ["id", "pageId", "title", "description", "width", "height", "visual", "mappings", "archived", "note", "assertions", "crossFilterId"],
                            ["id", "pageId", "title", "width", "height", "visual", "mappings"]);
                        const old = board.tiles.find(item => item.id === edit.id);
                        if (!old && edit.note === undefined) throw fail("INVALID_DASHBOARD", "Pin a completed query or saved visual to add a data tile.");
                        const updated = { ...(old ?? { previousSnapshotIds: [] }), ...clone(edit) };
                        if (updated.crossFilterId === null) delete updated.crossFilterId;
                        return updated;
                    });
                    if (this.dashboards.get(payload.id).tiles.some(old => !board.tiles.some(tile => tile.id === old.id)))
                        throw fail("INVALID_DASHBOARD", "Archive tiles to keep them recoverable rather than dropping them.");
                }
            });
            this.publish(); return board;
        }
        throw fail("UNKNOWN_ACTION", "This dashboard action is not supported.");
    }
    #dashboardRefreshStatus(batch) {
        return clone({ id: batch.id, dashboardId: batch.dashboardId, status: batch.status, cancelRequested: batch.cancelled,
            startedAt: batch.startedAt, tiles: batch.tiles });
    }
    #waitDashboardCapacity(connectionId, batch, deadline) {
        return new Promise((resolve, reject) => {
            const finish = error => { clearTimeout(timer); this.off("change", check); error ? reject(error) : resolve(); };
            const check = () => {
                if (this.closed || batch.cancelled) return finish(fail("CANCELLED", "Dashboard refresh cancelled."));
                const active = this.state.runs.filter(run => ACTIVE_STATUSES.has(run.status));
                if (active.length < 2 && !active.some(run => run.connectionId === connectionId)) finish();
            };
            const timer = setTimeout(() => finish(fail("DASHBOARD_QUEUE_TIMEOUT", "No query slot became available within the configured query timeout. The previous capture remains visible.")), Math.max(0, deadline - Date.now()));
            this.on("change", check); check();
        });
    }
    async #startDashboardRefresh(payload) {
        dashboardObject(payload, ["id", "expectedRevision", "pageId", "tileId"], ["id", "expectedRevision"]);
        await this.dashboards.reload(); const board = this.dashboards.get(payload.id);
        if (this.dashboardDeletions.has(board.id)) throw fail("RUNNING", "This dashboard is being deleted. Reload the dashboard list.");
        if (board.revision !== payload.expectedRevision || board.archived) throw fail("REVISION_CONFLICT", "Reload this dashboard before refreshing.");
        if (board.release) throw fail("DASHBOARD_FROZEN", "A reviewed release never refreshes. Refresh the original dashboard instead.");
        if (this.dashboardRefreshes.get(board.id)?.status === "running") throw fail("RUNNING", "This dashboard already has a refresh in progress.");
        if (payload.pageId && !board.pages.some(page => page.id === payload.pageId)) throw fail("INVALID_DASHBOARD", "Choose an existing page.");
        if (payload.tileId && !board.tiles.some(tile => tile.id === payload.tileId)) throw fail("INVALID_DASHBOARD", "Choose an existing tile.");
        const scope = board.tiles.filter(tile => !tile.archived && (!payload.pageId || tile.pageId === payload.pageId) && (!payload.tileId || tile.id === payload.tileId));
        const selected = scope.filter(tile => tile.source);
        if (!selected.length) {
            const unbound = scope.filter(tile => tile.unboundSource).length;
            if (unbound) throw fail("DASHBOARD_UNBOUND", `Connect a model for ${unbound} unbound query tile${unbound === 1 ? "" : "s"} in Dashboard model setup, then refresh. Selecting a model in Queries does not connect dashboard tiles.`);
            throw fail("DASHBOARD_SNAPSHOT_ONLY", "This selection has no query tiles to refresh. Notes and saved-visual snapshots do not run queries; pin a query result to add a refreshable tile.");
        }
        const executions = new Map(selected.map(tile => [tile.id, tileExecution(board, tile)]));
        const batch = { id: randomUUID(), dashboardId: board.id, status: "running", cancelled: false, startedAt: new Date().toISOString(),
            tiles: selected.map(tile => ({ tileId: tile.id, status: "queued" })) };
        this.dashboardRefreshes.set(board.id, batch); this.publish();
        batch.task = (async () => {
            const reused = new Map();
            for (const item of batch.tiles) {
                if (batch.cancelled || this.closed) { item.status = "cancelled"; continue; }
                const execution = executions.get(item.tileId);
                let runId;
                try {
                    await this.dashboards.reload();
                    const current = this.dashboards.get(board.id), tile = current.tiles.find(tile => tile.id === item.tileId);
                    if (!tile || tileExecution(current, tile).fingerprint !== execution.fingerprint) throw fail("REVISION_CONFLICT", "Filters or source changed before this tile refreshed.");
                    const connection = this.state.connections.find(connection => connection.id === execution.source.connectionId);
                    if (!connection || (connection.model ?? null) !== execution.source.model || connection.kind !== execution.source.connectionKind)
                        throw fail("CONNECTION_CHANGED", "The tile's original model/transport is unavailable. Its previous visual remains visible.");
                    if (execution.source.builder) {
                        const generation = this.providerGeneration, registry = this.registryGeneration;
                        const schema = await this.native.request("schema.get", { connectionId: connection.id });
                        if (this.closed || generation !== this.providerGeneration || registry !== this.registryGeneration || schema.connectionId !== connection.id)
                            throw fail("CONNECTION_CHANGED", "The model changed while verifying dashboard fields. No tile query was run.");
                        validateBuilderSchema(execution.source.builder, schema.objects);
                    }
                    const generation = this.providerGeneration, registry = this.registryGeneration, connectionKey = this.#hash(connection);
                    const checkPublication = () => {
                        if (batch.cancelled || this.closed) throw fail("CANCELLED", "Dashboard refresh cancelled; the prior capture was preserved.");
                        const currentConnection = this.state.connections.find(item => item.id === connection.id);
                        if (generation !== this.providerGeneration || registry !== this.registryGeneration
                            || !currentConnection || connectionKey !== this.#hash(currentConnection))
                            throw fail("CONNECTION_CHANGED", "The provider changed during refresh. The previous capture was preserved.");
                    };
                    let snapshot = reused.get(execution.fingerprint);
                    if (!snapshot) {
                        const deadline = Date.now() + this.state.limits.timeoutSeconds * 1000;
                        let started;
                        while (!started) {
                            await this.#waitDashboardCapacity(connection.id, batch, deadline);
                            checkPublication();
                            try {
                                started = await this.runQuery(undefined, "ui", undefined, undefined,
                                    { ...execution, dashboardId: board.id, tileId: item.tileId, batch });
                            } catch (error) {
                                if (!["CONNECTION_BUSY", "WORKBENCH_BUSY"].includes(error.code) || Date.now() >= deadline) throw error;
                            }
                        }
                        runId = started.runId; item.runId = runId; item.status = "running"; item.startedAt = new Date().toISOString(); this.publish();
                        await this.running.get(runId);
                        const run = this.#run(runId), set = run.resultSets[0];
                        item.durationMs = run.durationMs;
                        if (run.status !== "completed" || !set) throw fail("DASHBOARD_REFRESH_FAILED", run.error?.message ?? `The tile query ${run.status}; its previous capture is unchanged.`);
                        if (run.resultSets.length !== 1) throw fail("DASHBOARD_MULTIPLE_RESULTS", "A dashboard refresh requires one result set. Refine this tile's query.");
                        snapshot = { version: 1, id: randomUUID(), capturedAt: run.startedAt, runId, resultSetId: set.id,
                            source: execution.source, executedFilters: execution.executedFilters, columns: set.columns,
                            rows: await this.#dashboardRows(run, set), truncated: run.truncated || set.truncated, origin: "run", durationMs: run.durationMs };
                        if (tile.assertions?.length) snapshot.checks = await evaluateAssertions(snapshot, tile.assertions, !snapshot.truncated);
                        reused.set(execution.fingerprint, snapshot);
                    }
                    if (batch.cancelled || this.closed) { item.status = "cancelled"; continue; }
                    checkPublication();
                    await this.dashboards.capture(board.id, item.tileId, { ...snapshot, id: randomUUID() }, execution.fingerprint, undefined, checkPublication);
                    item.status = "completed";
                    item.durationMs = snapshot.durationMs;
                } catch (error) { item.status = batch.cancelled ? "cancelled" : "failed"; item.error = safeError(error).message; }
                finally {
                    item.finishedAt = new Date().toISOString();
                    if (runId) {
                        const leases = (this.resultLeases.get(runId) ?? 1) - 1;
                        if (leases > 0) this.resultLeases.set(runId, leases); else this.resultLeases.delete(runId);
                    }
                    this.publish();
                }
            }
            batch.status = batch.cancelled || this.closed ? "cancelled" : batch.tiles.some(tile => tile.status === "failed") ? "partial" : "completed"; this.publish();
        })().catch(error => { batch.status = "cancelled"; this.emit("operationError", safeError(error)); this.publish(); });
        return this.#dashboardRefreshStatus(batch);
    }
    #notification(event) {
        if (event.event === "native.status") { this.onNativeStatus(event); return; }
        const run = this.state.runs.find(r => r.id === event.runId);
        if (!run || !ACTIVE_STATUSES.has(run.status)) return;
        if (event.event === "query.progress") {
            if (run.status !== "cancelling" && ACTIVE_STATUSES.has(event.status)) run.status = event.status;
        } else if (event.event === "query.resultset") {
            if (!Array.isArray(event.columns)) return;
            run.resultSets.push({ id: event.resultSetId, columns: event.columns, rowCount: 0, truncated: false });
            this.results.beginSet(event); this.cachedRuns.add(run.id);
        } else if (event.event === "query.cacheError") {
            if (!this.cacheErrors.has(run.id)) run.warnings.push("Result caching failed. This preview cannot be used as a complete result.");
            this.cacheErrors.set(run.id, event.error ?? { code: "RESULT_CORRUPT", message: "The native result cache rejected this stream." });
            run.retained = false; this.cachedRuns.delete(run.id);
        } else if (event.event === "query.rows" || event.event === "query.rows.cached") {
            const set = run.resultSets.find(s => s.id === event.resultSetId);
            try {
                const chunk = event.event === "query.rows.cached" ? event : this.results.append(event);
                if (!set || !Number.isSafeInteger(chunk.count) || chunk.count < 0
                    || chunk.offset !== set.rowCount || chunk.total !== set.rowCount + chunk.count)
                    throw fail("RESULT_CORRUPT", "Result streaming sequence was invalid; cancel this run and reconnect.");
                set.rowCount = chunk.total; run.rowCount += chunk.count;
            } catch (error) {
                this.cacheErrors.set(run.id, safeError(error)); run.retained = false;
                this.cachedRuns.delete(run.id); run.warnings.push(safeError(error).message);
            }
        }
        this.publish();
    }
    async #restoreRows(run) {
        if (!run.resultSets.length || this.cachedRuns.has(run.id)) return;
        if (!run.pinned) throw fail("RESULT_NOT_RETAINED", "These results were not retained. Explicitly rerun the query to fetch current data.");
        if (!this.resultLoads.has(run.id)) {
            const load = (async () => {
                await this.results.restore(run);
                this.cachedRuns.add(run.id);
                run.retained = true;
            })();
            this.resultLoads.set(run.id, load);
        }
        try { await this.resultLoads.get(run.id); } finally { this.resultLoads.delete(run.id); }
    }
    async #withResults(ids, operation) {
        for (const id of ids) this.resultLeases.set(id, (this.resultLeases.get(id) ?? 0) + 1);
        try { return await operation(); }
        finally {
            for (const id of ids) {
                const remaining = this.resultLeases.get(id) - 1;
                if (remaining) this.resultLeases.set(id, remaining); else this.resultLeases.delete(id);
            }
        }
    }
    async #trimCache(protectedIds = []) {
        const cached = this.state.runs.filter(run => this.cachedRuns.has(run.id));
        const keep = new Set([...protectedIds, ...this.resultLeases.keys(), ...cached.filter(r => ACTIVE_STATUSES.has(r.status)).map(r => r.id)]);
        for (const id of protectedIds) {
            const lookup = this.state.runs.find(run => run.id === id && ["filter-values", "model-preview"].includes(run.querySource));
            if (!lookup) continue;
            const queryResult = cached.find(run => run.documentId === lookup.documentId.slice(lookup.documentId.indexOf(":") + 1) && run.connectionId === lookup.connectionId);
            if (queryResult) keep.add(queryResult.id);
        }
        for (const run of cached) if (keep.size < 3) keep.add(run.id);
        let changed = false;
        for (const run of cached) {
            if (keep.has(run.id)) continue;
            this.cachedRuns.delete(run.id);
            run.retained = run.pinned;
            changed = true;
        }
        const knownIds = new Set(this.state.runs.map(r => r.id));
        for (const id of this.cachedRuns) if (!knownIds.has(id)) this.cachedRuns.delete(id);
        await this.results.trim([...keep]);
        if (changed) this.publish();
    }
    async page(runId, resultSetId, offset = 0, limit = 500) {
        const run = this.#run(runId), set = run.resultSets.find(s => s.id === resultSetId);
        if (!set) throw fail("RESULT_NOT_FOUND", "This result set does not exist.");
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw fail("INVALID_PAGE", "Result pages contain 1 to 1,000 rows.");
        return this.#withResults([run.id], async () => {
            await this.#restoreRows(run);
            const page = await this.results.page(run, set, offset, limit);
            await this.#trimCache([run.id]);
            return { ...page, columns: set.columns, truncated: run.truncated || set.truncated };
        });
    }
    async readResults(input) {
        if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen DAX Workbench before reading results.");
        if (!this.state.agentResultsEnabled)
            throw fail("RESULT_READ_GRANT_REQUIRED", "Result analysis is turned off. Use Context Lens > Allow Copilot to analyze results, or explicitly share selected cells.");
        const request = validateResultRead(input);
        const accessRevision = this.state.resultAccessRevision, scope = this.#resultAccessScope();
        const checkScope = () => {
            if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen DAX Workbench before reading results.");
            if (!this.state.agentResultsEnabled || this.state.resultAccessRevision !== accessRevision)
                throw fail("RESULT_READ_GRANT_REQUIRED", "Result access changed during this request. Read fresh context before trying again.");
            const doc = this.activeDocument(), run = this.state.runs.find(item => item.id === request.runId);
            if (doc.id !== request.documentId || doc.connectionId !== request.connectionId || doc.revision !== request.revision)
                throw fail("RESULT_SCOPE_CHANGED", "The active query or connection changed. Read fresh context before requesting results.");
            if (!run) throw fail("RUN_NOT_FOUND", "This run is not available in the selected workbench.");
            if (run.documentId !== doc.id || run.connectionId !== doc.connectionId
                || run.resultAccessScope !== scope || this.#resultAccessScope() !== scope
                || run.resultConnectionKey !== this.#connectionKey())
                throw fail("RESULT_SCOPE_CHANGED", "These results belong to a different document or an earlier connection session. Select the intended query and explicitly rerun it.");
            if (run.status !== "completed")
                throw fail("RESULT_NOT_READY", "Only completed query results can be analyzed. Check the run status in Context Lens.");
            const set = run.resultSets.find(item => item.id === request.resultSetId);
            if (!set) throw fail("RESULT_NOT_FOUND", "This completed run does not contain the requested result set.");
            if (request.offset > set.rowCount) throw fail("INVALID_RESULT_READ", "The offset is beyond the captured result rows.");
            return { run, set };
        };
        const { run, set } = checkScope();
        let page;
        try {
            page = await this.page(run.id, set.id, request.offset, request.limit);
        } catch (error) {
            checkScope();
            this.emit("operationError", safeError(error));
            if (error?.code === "RESULT_NOT_RETAINED")
                throw fail("RESULT_NOT_RETAINED", "These rows are no longer retained. Explicitly rerun the intended query.");
            if (error?.code === "PAGE_TOO_LARGE")
                throw fail("RESULT_ROW_TOO_LARGE", "A row exceeds the native page limit. Query a smaller projection or aggregate.");
            throw fail("RESULT_READ_FAILED", "The retained results could not be read. Review local diagnostics or explicitly rerun the intended query.");
        }
        checkScope();
        const response = boundedResultPage({ workbenchId: this.id, run, set, page, offset: request.offset, limit: request.limit });
        this.state.agentResultReads = [{
            runId: run.id, resultSetId: set.id, offset: request.offset, rowCount: response.returnedRowCount,
            readAt: new Date().toISOString(),
        }, ...this.state.agentResultReads].slice(0, 20);
        this.publish();
        return response;
    }
    async pin(runId) {
        const run = this.#run(runId);
        if (ACTIVE_STATUSES.has(run.status)) throw fail("RUNNING", "Wait for this run to finish before pinning it.");
        if (!run.resultSets.length) throw fail("NO_RESULTS", "This run has no results to pin.");
        if (!this.cachedRuns.has(run.id)) throw fail("RESULT_NOT_RETAINED", "This result is no longer available to pin.");
        return this.#withResults([run.id], async () => {
            await this.results.pin(run);
            return this.mutate(next => { next.runs.find(r => r.id === run.id).pinned = true; });
        });
    }
    async compare(leftId, rightId) {
        const left = this.#run(leftId), right = this.#run(rightId);
        if ([left, right].some(r => r.status !== "completed" || r.truncated || r.resultSets.some(s => s.truncated))) throw fail("INCOMPLETE_COMPARISON", "Only complete, uncapped successful runs can prove result equality.");
        return this.#withResults([left.id, right.id], async () => {
            await Promise.all([this.#restoreRows(left), this.#restoreRows(right)]);
            const equal = await this.results.compare(left, right);
            await this.#trimCache([left.id, right.id]);
            return { equal, mode: "Exact ordered comparison; zero numeric tolerance", leftRunId: left.id, rightRunId: right.id, sameConnection: left.connectionId === right.connectionId, message: equal ? "All returned schemas and ordered values match exactly." : "The complete ordered results differ. This is not an unordered or key-based comparison." };
        });
    }
    #buildProposal(definition, state, doc) {
        if (!state.schema || state.schema.connectionId !== doc.connectionId || state.schema.origin === "dictionary")
            throw fail("BUILDER_SCHEMA_MISMATCH", "Refresh the intended model's native metadata before authoring builder selections.");
        const canonical = validateBuilderSchema(definition, state.schema.objects);
        const built = generateBuilderQuery(canonical);
        validateQuery(built.query);
        return built;
    }
    #connectionRegistryRevision() {
        return this.#hash({ scope: this.#resultAccessScope(), connections: this.state.connections });
    }
    connectionsContext(payload = {}) {
        if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen this workbench before listing connections.");
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
            throw fail("INVALID_CONNECTION_LIST", "Supply connection-list pagination as an object.");
        const { offset = 0, limit = 50, registryRevision } = payload;
        if (Object.keys(payload).some(key => !["offset", "limit", "registryRevision"].includes(key))
            || !Number.isSafeInteger(offset) || offset < 0 || offset > this.state.connections.length
            || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw fail("INVALID_CONNECTION_LIST", "Use the returned nextOffset and a page size of 1 to 100 connections.");
        const currentRevision = this.#connectionRegistryRevision();
        if (registryRevision !== undefined && registryRevision !== currentRevision)
            throw fail("CONNECTIONS_CHANGED", "The connection registry changed. Start again with list_connections.");
        const connections = [];
        for (const connection of this.state.connections.slice(offset, offset + limit)) {
            const item = { id: connection.id, name: connection.name, kind: connection.kind, model: connection.model ?? null,
                capabilities: { query: connection.capabilities?.query?.status ?? "unknown", schema: connection.capabilities?.schema?.status ?? "unknown" } };
            if (Buffer.byteLength(JSON.stringify([...connections, item])) > 60 * 1024) {
                if (!connections.length) throw fail("CONNECTION_METADATA_TOO_LARGE", "A connection descriptor exceeds the metadata page limit. Review its name/model in Connections.");
                break;
            }
            connections.push(item);
        }
        const end = offset + connections.length;
        return {
            workbenchId: this.id, version: this.state.version, activeDocumentId: this.state.activeDocumentId,
            activeConnectionId: this.activeDocument().connectionId, registryRevision: currentRevision,
            nativeAvailable: this.state.native.available, connections, total: this.state.connections.length,
            offset, nextOffset: end < this.state.connections.length ? end : null,
        };
    }
    async selectConnection(payload) {
        const { version, activeDocumentId, registryRevision, connectionId, title, surface } = payload ?? {};
        if (!payload || Object.keys(payload).some(key => !["version", "activeDocumentId", "registryRevision", "connectionId", "title", "surface"].includes(key))
            || !Number.isSafeInteger(version) || version < 0
            || typeof registryRevision !== "string" || !/^[a-f0-9]{64}$/.test(registryRevision)
            || typeof connectionId !== "string" || connectionId.length < 1 || connectionId.length > 256 || /[\u0000-\u001f\u007f]/.test(connectionId)
            || (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)))
            || (surface !== undefined && !["builder", "editor"].includes(surface)))
            throw fail("INVALID_CONNECTION_SELECTION", "Use an exact connection ID and current version, activeDocumentId and registryRevision from list_connections.");
        requireId(activeDocumentId);
        const guard = state => {
            if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen this workbench before selecting a model.");
            if (state.version !== version || state.activeDocumentId !== activeDocumentId)
                throw fail("REVISION_CONFLICT", "Tabs or saved drafts changed. Read list_connections and current context again; no connection selection was applied.");
            if (registryRevision !== this.#connectionRegistryRevision())
                throw fail("CONNECTIONS_CHANGED", "Connections or the provider changed. Read list_connections again; no connection selection was applied.");
            if (!state.native.available) throw fail("NATIVE_UNAVAILABLE", "The native companion is unavailable. Repair or reopen it before selecting a model.");
            const connection = state.connections.find(item => item.id === connectionId);
            if (!connection) throw fail("CONNECTION_NOT_FOUND", "Select an exact ID returned by this workbench's list_connections, not a guessed name or MCP identifier.");
            if (connection.capabilities?.query?.status === "unsupported")
                throw fail("UNSUPPORTED_CONNECTION", "This profile cannot execute DAX in the native reader. Choose a supported profile; no transport fallback was attempted.");
            return connection;
        };
        guard(this.state);
        return this.authoring.perform(async () => {
            guard(this.state);
            let result = { documentId: activeDocumentId, createdDocument: false };
            if (this.activeDocument().connectionId !== connectionId) {
                result = await this.mutate(next => {
                    const connection = guard(next);
                    if (next.documents.length >= 10)
                        throw fail("DOCUMENT_LIMIT", "At most 10 query tabs can be open. Close a tab explicitly before selecting another model; existing drafts were preserved.");
                    const doc = makeDocument(title?.trim() ?? `${connection.name} query`.slice(0, 100));
                    doc.query = ""; doc.connectionId = connection.id;
                    next.documents.push(doc);
                    this.#focusDocument(next, doc, surface ?? (connection.capabilities?.schema?.status === "unsupported" ? "editor" : "builder"));
                    return { documentId: doc.id, createdDocument: true };
                });
                if (registryRevision === this.#connectionRegistryRevision()) {
                    try { await this.refreshSchema(); }
                    catch (error) { this.emit("operationError", safeError(error)); }
                }
            }
            const changed = registryRevision !== this.#connectionRegistryRevision();
            const unsupported = this.state.connections.find(item => item.id === connectionId)?.capabilities?.schema?.status === "unsupported";
            const schemaStatus = changed ? "stale" : unsupported ? "unsupported"
                : this.#eligibleSchema() ? "available" : "unavailable";
            return {
                workbenchId: this.id, ...result, connectionId, version: this.state.version,
                registryRevision: this.#connectionRegistryRevision(), selected: true, executed: false,
                schema: { status: schemaStatus, ...(this.state.schemaError ? { errorCode: this.state.schemaError.code } : {}) },
                message: schemaStatus === "available"
                    ? "Connection selected. Read fresh builder context and resolve native fields before authoring. Existing drafts were preserved; nothing executed."
                    : "Connection selected, but native schema is not available for authoring. Read fresh connection/context metadata and review the canvas diagnostic; do not assume model fields. Existing drafts were preserved; nothing executed.",
            };
        });
    }
    documentsContext() {
        const metadata = doc => ({
            documentId: doc.id, title: doc.title, connectionId: doc.connectionId, revision: doc.revision,
            builderRevision: doc.builderRevision ?? 0, hasBuilder: Boolean(doc.builder), pendingImport: Boolean(doc.builderImport),
        });
        return {
            workbenchId: this.id, version: this.state.version, activeDocumentId: this.state.activeDocumentId,
            documents: this.state.documents.map(metadata), closedDocuments: this.state.closedDocuments.map(metadata),
        };
    }
    #focusDocument(next, doc, surface) {
        if (next.activeDocumentId !== doc.id) {
            next.activeDocumentId = doc.id; next.selections = [];
            if (next.schema?.connectionId !== doc.connectionId) next.schema = null;
        }
        doc.authoringFocus = { id: randomUUID(), surface: surface ?? (doc.builder ? "builder" : "editor") };
    }
    #reopenDocument(next, id, surface) {
        if (next.documents.length >= 10) throw fail("DOCUMENT_LIMIT", "At most 10 query documents can be open.");
        const doc = next.closedDocuments.find(item => item.id === id);
        if (!doc) throw fail("DOCUMENT_NOT_FOUND", "This closed query is no longer available.");
        next.closedDocuments = next.closedDocuments.filter(item => item.id !== id);
        next.documents.push(doc); this.#focusDocument(next, doc, surface);
        return doc;
    }
    #retainClosedDocuments(next, documents) {
        const ids = new Set(documents.map(doc => doc.id));
        if (next.runs.some(run => ids.has(run.documentId) && ACTIVE_STATUSES.has(run.status)))
            throw fail("RUNNING", "Cancel or finish running queries before closing their tabs. No tabs were closed.");
        if (next.closedDocuments.length + documents.length > 20)
            throw fail("CLOSED_DOCUMENT_LIMIT", "Only twenty recoverable tabs can be retained. Reopen an unwanted tab and use Discard and close to free space; no tabs were closed.");
        next.closedDocuments.push(...documents);
    }
    async manageDocuments({ operation, version, activeDocumentId, documentId, title, surface }) {
        if (!["create", "select", "rename", "close", "reopen"].includes(operation)
            || !Number.isSafeInteger(version) || version < 0)
            throw fail("INVALID_AUTHORING", "Choose a supported tab operation and use the version from list_documents.");
        requireId(activeDocumentId);
        if (operation !== "create") requireId(documentId);
        if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)))
            throw fail("INVALID_AUTHORING", "Use a printable query title of 1 to 100 characters.");
        if (operation === "rename" && title === undefined) throw fail("INVALID_AUTHORING", "Provide the new query title.");
        if (surface !== undefined && !["builder", "editor"].includes(surface)) throw fail("INVALID_AUTHORING", "Choose the builder or editor surface.");
        return this.authoring.perform(async () => {
            const result = await this.mutate(next => {
                if (next.version !== version || next.activeDocumentId !== activeDocumentId)
                    throw fail("REVISION_CONFLICT", "Tabs or saved drafts changed. Read list_documents and the current context again; no tab change was applied.");
                let doc;
                if (operation === "create") {
                    if (next.documents.length >= 10) throw fail("DOCUMENT_LIMIT", "At most 10 query documents can be open.");
                    doc = makeDocument(title?.trim()); doc.query = ""; doc.connectionId = this.#document(next).connectionId;
                    next.documents.push(doc); this.#focusDocument(next, doc, surface);
                } else if (operation === "reopen") doc = this.#reopenDocument(next, documentId, surface);
                else {
                    doc = this.#document(next, documentId);
                    if (operation === "rename") { doc.title = title.trim(); doc.revision++; }
                    if (operation === "select") this.#focusDocument(next, doc, surface);
                    if (operation === "close") {
                        this.#retainClosedDocuments(next, [doc]);
                        next.documents = next.documents.filter(item => item.id !== doc.id);
                        if (!next.documents.length) {
                            const replacement = makeDocument(); replacement.query = ""; replacement.connectionId = doc.connectionId;
                            next.documents.push(replacement);
                        }
                        if (next.activeDocumentId === doc.id) this.#focusDocument(next, next.documents[0]);
                    }
                }
                return { documentId: doc.id, operation };
            });
            if (this.state.schema?.connectionId !== this.activeDocument().connectionId) await this.refreshSchema();
            return { ...result, ...this.documentsContext(), executed: false };
        });
    }
    async populateBuilder({ documentId, connectionId, revision, builderRevision, definition, autoUpdate = true, surface = "builder", rationale = "" }) {
        requireId(documentId);
        if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(builderRevision) || builderRevision < 0
            || typeof autoUpdate !== "boolean" || !["builder", "editor"].includes(surface)
            || typeof rationale !== "string" || rationale.length > 2000)
            throw fail("INVALID_AUTHORING", "Use current query/builder revisions, a valid surface and a bounded authoring rationale.");
        const captured = normalizeBuilder(definition);
        return this.authoring.perform(() => this.mutate(next => {
            const doc = this.#document(next, documentId);
            if (next.activeDocumentId !== doc.id || doc.connectionId !== connectionId || doc.revision !== revision
                || (doc.builderRevision ?? 0) !== builderRevision)
                throw fail("REVISION_CONFLICT", "The active query, model or builder changed. Read fresh context and preserve those edits before populating.");
            if (doc.builderImport) throw fail("BUILDER_IMPORT_PENDING", "Resolve or discard the pending Studio import before populating the builder.");
            if (doc.query.trim() && removeBuilderBlock(doc.query) === doc.query)
                throw fail("EDITOR_NOT_BUILDER_OWNED", "This tab contains freeform DAX, not a generated builder block. Create a new tab or propose a text change; the existing draft was preserved.");
            const built = this.#buildProposal(captured, next, doc);
            doc.query = updateBuilderBlock(doc.query, built.query); doc.revision++;
            doc.builder = built.builder; doc.builderRevision = (doc.builderRevision ?? 0) + 1;
            doc.builderAutoUpdate = autoUpdate; doc.builderWarning = undefined; doc.builderProposal = null; doc.proposal = null;
            this.#focusDocument(next, doc, surface);
            return {
                documentId, revision: doc.revision, builderRevision: doc.builderRevision, definition: clone(doc.builder),
                query: doc.query, autoUpdate, surface, executed: false,
                containsAdditionalDax: Boolean(removeBuilderBlock(doc.query).trim()),
                message: "Builder and generated editor block populated together. Surrounding DAX was preserved. No query was executed.",
            };
        }));
    }
    #artifactUserAdmission(source) {
        if (source !== "ui") throw fail("USER_ACTION_REQUIRED", "Artifact browsing and file imports require an explicit person-initiated canvas interaction.");
        if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen the workbench before changing artifacts.");
        if (this.authoring.current) throw fail("AUTHORING_BUSY", "Wait for canvas authoring to finish before changing artifacts.");
    }
    #artifactOperation(operation, publish = true) {
        const pending = this.queue.then(async () => {
            if (this.closed) throw fail("WORKBENCH_CLOSED", "Reopen the workbench before changing artifacts.");
            const result = await operation();
            if (publish) this.publish();
            return result;
        });
        this.queue = pending.then(() => {}, () => {});
        return pending;
    }
    updateReviewedNote(payload, guard) {
        return this.#artifactOperation(() => {
            guard();
            return this.artifacts.update(payload, this.state.library, guard);
        });
    }
    async uploadArtifact(payload, bytes, source = "ui") {
        this.#artifactUserAdmission(source);
        const captured = clone(payload);
        return this.#artifactOperation(() => {
            const guard = () => this.#artifactUserAdmission(source);
            guard();
            return this.artifacts.upload(captured, bytes, this.state.library, guard);
        });
    }
    async artifactContent(id, inline = false, source = "ui") {
        if (source !== "ui") throw fail("USER_ACTION_REQUIRED", "Arbitrary-file artifact reads are not available to agents.");
        return this.artifacts.content(id, inline);
    }
    async saveArtifact(payload) {
        const request = validateSaveArtifact(payload);
        const identity = JSON.stringify(this.knowledgeIdentity()), connectionKey = this.#connectionKey();
        return this.authoring.perform(() => this.#artifactOperation(async () => {
            const guard = (libraryRevision = request.libraryRevision) => {
                const doc = this.activeDocument();
                if (doc.id !== request.documentId || doc.connectionId !== request.connectionId || doc.revision !== request.revision
                    || (doc.builderRevision ?? 0) !== request.builderRevision || this.state.library.revision !== libraryRevision
                    || identity !== JSON.stringify(this.knowledgeIdentity()) || connectionKey !== this.#connectionKey())
                    throw fail("REVISION_CONFLICT", "The active document, model, builder or library changed. Read fresh builder context before saving an artifact.");
                if (!this.state.connections.some(connection => connection.id === doc.connectionId))
                    throw fail("CONNECTION_NOT_FOUND", "Choose the intended model before saving an artifact.");
                if (doc.builderImport) throw fail("BUILDER_IMPORT_PENDING", "Resolve the pending Studio import before saving an artifact.");
                this.artifacts.assertRevision(request.artifactsRevision);
            };
            guard();
            const originalLibrary = this.state.library, library = clone(originalLibrary);
            const collectionId = ensureLibraryCollectionPath(library, request.collectionPath, request.libraryRevision);
            const create = {
                expectedRevision: request.artifactsRevision, collectionId, title: request.title, kind: request.kind,
                ...(request.description === undefined ? {} : { description: request.description }),
                ...(request.text === undefined ? {} : { text: request.text }),
                ...(request.visual === undefined ? {} : { visual: request.visual }),
                ...(request.researchEntryId === undefined ? {} : { researchEntryId: request.researchEntryId }),
                ...(request.session === undefined ? {} : { session: request.session }),
            };
            let foldersSaved = false;
            try {
                const result = await this.artifacts.create(create, library, async () => {
                    guard();
                    if (library.revision !== originalLibrary.revision) {
                        const next = { ...this.state, library };
                        await this.#save(next);
                        this.state = next; foldersSaved = true;
                        guard(library.revision);
                    }
                });
                return { ...result, collectionId, libraryRevision: this.state.library.revision, executed: false };
            } catch (error) {
                // Native CAS is per key, not a multi-key transaction. Compensate
                // only this operation's new empty folders; never rewrite research.
                if (foldersSaved && error.code !== "ARTIFACT_COMMIT_UNCERTAIN") {
                    try {
                        const rollback = { ...this.state, library: originalLibrary };
                        await this.#save(rollback); this.state = rollback; this.publish();
                    } catch {
                        this.publish();
                        throw fail("ARTIFACT_SAVE_FAILED", "The artifact was not saved. Newly created empty folders may remain because folder rollback also failed; existing research and artifacts were preserved.");
                    }
                }
                throw error;
            }
        }));
    }
    #syncDocumentationReferences(state, id) {
        const entry = state.library.entries.find(item => item.id === id);
        for (const document of [...state.documents, ...state.closedDocuments]) {
            if (document.libraryRef?.entryId !== id) continue;
            document.libraryRef.documentation = entry.documentation;
            document.libraryRef.description = entry.description;
        }
    }
    async reviseDocumentation(payload) {
        const request = validateDocumentationRevision(payload);
        const identity = JSON.stringify(this.knowledgeIdentity()), connectionKey = this.#connectionKey();
        return this.authoring.perform(() => this.mutate(next => {
            const doc = next.documents.find(item => item.id === request.documentId);
            if (!doc || next.activeDocumentId !== doc.id || doc.connectionId !== request.connectionId || doc.revision !== request.revision
                || (doc.builderRevision ?? 0) !== request.builderRevision || next.library.revision !== request.libraryRevision
                || identity !== JSON.stringify(this.knowledgeIdentity(next)) || connectionKey !== this.#connectionKey(next))
                throw documentationConflict();
            const connection = next.connections.find(item => item.id === doc.connectionId);
            if (!connection || this.closed) throw documentationConflict();
            const matches = next.library.entries.filter(entry => entry.source === "saved" && entry.title === request.entryTitle
                && entry.connectionId === connection.id && entry.model === connection.model);
            if (matches.length !== 1 || matches[0].archived) throw documentationConflict();
            const result = updateLibraryDocumentation(next.library, {
                id: matches[0].id, expectedRevision: request.libraryRevision,
                expectedDocumentation: request.expectedDocumentation, documentation: request.documentation,
                ...(request.description === undefined ? {} : { expectedDescription: request.expectedDescription, description: request.description }),
            });
            this.#syncDocumentationReferences(next, result.id);
            return { ...result, executed: false };
        }));
    }
    async saveResearch(payload) {
        const request = validateResearchRequest(payload);
        return this.authoring.perform(() => this.mutate(next => {
            const doc = this.#document(next, request.documentId);
            if (next.activeDocumentId !== doc.id || doc.connectionId !== request.connectionId || doc.revision !== request.revision
                || (doc.builderRevision ?? 0) !== request.builderRevision || next.library.revision !== request.libraryRevision)
                throw fail("REVISION_CONFLICT", "The query, builder, model or library changed. Read fresh builder context before saving research.");
            if (doc.builderImport) throw fail("BUILDER_IMPORT_PENDING", "Resolve the pending Studio import before saving research.");
            if (!next.connections.some(connection => connection.id === doc.connectionId))
                throw fail("CONNECTION_NOT_FOUND", "Choose the intended model before saving research.");
            if (!doc.query.trim()) throw fail("INVALID_RESEARCH", "Populate the research query before saving its analysis.");
            const analysis = captureAnalysis(request.analysis, doc, next.runs, request.runIds);
            const collectionId = ensureLibraryCollectionPath(next.library, request.collectionPath, request.libraryRevision);
            const result = saveLibraryEntry(next.library, {
                collectionId, title: request.title, description: request.description, documentation: request.documentation,
                expectedRevision: next.library.revision,
            }, doc, next.connections, this.knowledgeIdentity(next), analysis, request.session);
            doc.libraryRef = libraryReference(findLibraryEntry(next.library, result.id));
            return { entryId: result.id, collectionId, libraryRevision: next.library.revision, evidenceCount: analysis.evidence.length, executed: false };
        }));
    }
    async appendResearch(payload) {
        const request = validateAppendResearch(payload);
        return this.authoring.perform(() => this.mutate(next => {
            const doc = this.#document(next, request.documentId);
            if (next.activeDocumentId !== doc.id || doc.connectionId !== request.connectionId || doc.revision !== request.revision
                || (doc.builderRevision ?? 0) !== request.builderRevision || next.library.revision !== request.libraryRevision)
                throw fail("REVISION_CONFLICT", "The query, builder, model or library changed. Read fresh builder context before appending research.");
            if (doc.builderImport) throw fail("BUILDER_IMPORT_PENDING", "Resolve the pending Studio import before appending research.");
            const entry = next.library.entries.find(item => item.id === request.entryId);
            const connection = next.connections.find(item => item.id === doc.connectionId);
            if (!entry?.analysis || !connection || entry.connectionId !== connection.id || entry.model !== connection.model
                || queryFingerprint(entry) !== queryFingerprint(doc))
                throw fail("RESEARCH_SOURCE_MISMATCH", "Append requires the known saved artifact's query, bindings and model to match the active tab. Save a new research copy for a different query.");
            appendLibraryResearch(next.library, {
                id: entry.id, expectedRevision: request.libraryRevision, content: request.content,
                ...(request.session ? { session: request.session } : {}),
            }, "copilot", connection, next.connections, this.knowledgeIdentity(next));
            return { entryId: entry.id, noteId: entry.notes.at(-1).id, noteCount: entry.notes.length,
                libraryRevision: next.library.revision, executed: false };
        }));
    }
    #sharedAnalysisEntry() {
        if (!this.sharedAnalysis) return null;
        const selected = this.sharedAnalysis, doc = this.activeDocument();
        const entry = this.state.library.entries.find(item => item.id === selected.entryId);
        if (selected.documentId !== doc.id || selected.revision !== doc.revision || !entry?.analysis
            || selected.identity !== JSON.stringify(this.knowledgeIdentity())
            || (selected.libraryRevision !== this.state.library.revision && selected.entryVersion !== this.#hash(entry))) {
            this.sharedAnalysis = null;
            return null;
        }
        selected.libraryRevision = this.state.library.revision;
        return entry;
    }
    clearSharedAnalysis() {
        if (this.sharedAnalysis) {
            this.sharedAnalysis = null;
            this.publish();
        }
        return { shared: false };
    }
    async proposeBuilder({ documentId, connectionId, revision, builderRevision, definition, rationale = "" }) {
        requireId(documentId);
        if (typeof connectionId !== "string" || !connectionId.length || connectionId.length > 128 || /[\u0000-\u001f\u007f]/.test(connectionId))
            throw fail("INVALID_PROPOSAL", "Use the connection identity returned by this workbench.");
        if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(builderRevision) || builderRevision < 0)
            throw fail("INVALID_PROPOSAL", "Read the current query and builder revisions before proposing changes.");
        if (typeof rationale !== "string" || rationale.length > 2000) throw fail("INVALID_PROPOSAL", "Builder rationale must be text of at most 2,000 characters.");
        const captured = normalizeBuilder(definition);
        return this.mutate(next => {
            const doc = this.#document(next, documentId);
            if (next.activeDocumentId !== doc.id || doc.connectionId !== connectionId || doc.revision !== revision
                || (doc.builderRevision ?? 0) !== builderRevision)
                throw fail("REVISION_CONFLICT", "The active query, model or builder changed. Read its context again before proposing.");
            if (doc.builderImport) throw fail("BUILDER_IMPORT_PENDING", "Resolve or discard the pending Studio import before proposing a builder.");
            const built = this.#buildProposal(captured, next, doc);
            doc.builderProposal = {
                id: randomUUID(), connectionId, baseRevision: revision, baseBuilderRevision: builderRevision,
                definition: built.builder, query: built.query, rationale,
            };
            return { proposalId: doc.builderProposal.id, documentId, baseRevision: revision, baseBuilderRevision: builderRevision,
                query: built.query, message: "Review and accept selections in the Query builder. The editor, current builder and execution grants are unchanged. No query was run." };
        });
    }
    builderContext() {
        const doc = this.activeDocument();
        return {
            workbenchId: this.id, documentId: doc.id, connection: clone(this.state.connections.find(item => item.id === doc.connectionId) ?? null),
            authoringGuidance: QUERY_AUTHORING_GUIDANCE,
            revision: doc.revision, builderRevision: doc.builderRevision ?? 0,
            libraryRevision: this.state.library.revision,
            artifactsRevision: this.artifacts.revision,
            definition: normalizeBuilder(doc.builder ?? { version: 2, fields: [], filters: [], orderBy: [] }),
            autoUpdate: doc.builderAutoUpdate ?? false, pendingImport: Boolean(doc.builderImport),
            proposal: doc.builderProposal ? { id: doc.builderProposal.id, baseRevision: doc.builderProposal.baseRevision, baseBuilderRevision: doc.builderProposal.baseBuilderRevision } : null,
            schemaAvailable: this.state.schema?.connectionId === doc.connectionId && this.state.schema.origin !== "dictionary",
            schemaCoverage: clone(this.state.schema?.connectionId === doc.connectionId ? this.state.schema.coverage ?? null : null),
            privacy: { automaticRows: false, agentReadEnabled: this.state.agentReadEnabled, agentResultsEnabled: this.state.agentResultsEnabled },
        };
    }
    context() {
        const doc = this.activeDocument();
        const run = this.state.runs.find(r => r.documentId === doc.id && r.connectionId === doc.connectionId);
        const metadata = run ? { ...run } : null;
        if (metadata) {
            delete metadata.query; delete metadata.parameters; delete metadata.parameterDefinitions; delete metadata.templateQuery;
            delete metadata.sourceBuilder;
            delete metadata.sourceQueryFingerprint;
            delete metadata.resultAccessScope; delete metadata.resultConnectionKey;
            metadata.warnings = metadata.warnings.length ? ["See the canvas for local run warnings."] : [];
            if (metadata.error) metadata.error = { code: metadata.error.code, message: "Run failed. Review the local diagnostic in the canvas." };
        }
        const sharedAnalysis = this.#sharedAnalysisEntry();
        return {
            workbenchId: this.id, documentId: doc.id, revision: doc.revision, artifactsRevision: this.artifacts.revision, query: doc.query,
            connection: this.state.connections.find(c => c.id === doc.connectionId) ?? null,
            ...(this.state.connectionDiscovery ? { connectionDiscovery: {
                status: this.state.connectionDiscovery.status, loaded: this.state.connectionDiscovery.loaded,
                issueCount: this.state.connectionDiscovery.issues.length,
                ...(this.state.connectionDiscovery.errorCode ? { errorCode: this.state.connectionDiscovery.errorCode } : {}),
            } } : {}),
            schema: (this.state.schema?.objects ?? []).filter(o => this.state.selectedObjects.includes(o.id)),
            builder: this.builderContext(),
            resultMetadata: metadata, selectedValues: clone(this.state.selections), privacy: { automaticRows: false },
            ...(sharedAnalysis ? { sharedAnalysis: {
                ...sharedAnalysisProjection(sharedAnalysis),
                matchesActiveQuery: sharedAnalysis.analysis.source.queryFingerprint === queryFingerprint(doc),
            } } : {}),
            knowledge: (() => {
                const { identity, entries } = this.searchKnowledge({ identity: this.knowledgeIdentity() });
                return { identity, entries: entries.filter(entry => entry.kind === "note") };
            })(),
        };
    }
    searchSchema(term, limit = 30) {
        if (typeof term !== "string" || term.length > 200) throw fail("INVALID_SEARCH", "Schema search is limited to 200 characters.");
        return searchBuilderSchema(this.state.schema?.objects ?? [], term, limit);
    }
    async exportResult(runId, setId, format, options) {
        const run = this.#run(runId), set = run.resultSets.find(s => s.id === setId);
        if (!set) throw fail("RESULT_NOT_RETAINED", "This result is not available for export.");
        if (ACTIVE_STATUSES.has(run.status)) throw fail("RUNNING", "Wait for this run to finish before exporting.");
        if (!["csv", "json", "xlsx"].includes(format)) throw fail("INVALID_EXPORT", "Choose XLSX, CSV or JSON.");
        const fullColumnNames = this.state.resultSettings?.showFullColumnNames ?? false;
        return this.#withResults([run.id], async () => {
            await this.#restoreRows(run);
            await this.#trimCache([run.id]);
            const details = { rowCount: set.rowCount, partial: Boolean(run.truncated || set.truncated || run.status !== "completed") };
            if (format === "xlsx") {
                const { createResultWorkbook, EXCEL_CELL_LIMIT, EXCEL_MIME } = await import("../shared/result-excel.mjs");
                if ((set.rowCount + 1) * set.columns.length > EXCEL_CELL_LIMIT)
                    throw fail("EXPORT_TOO_LARGE", "Excel export supports up to 1,000,000 cells including headers. Use CSV/JSON or refine the query explicitly; no rows were sampled.");
                const rows = [];
                while (rows.length < set.rowCount) {
                    const page = await this.results.page(run, set, rows.length, 1000);
                    if (page.offset !== rows.length || page.total !== set.rowCount || !Array.isArray(page.rows)
                        || !page.rows.length || rows.length + page.rows.length > set.rowCount)
                        throw fail("RESULT_PROTOCOL_MISMATCH", "Captured result pages changed during Excel export. No workbook was created.");
                    rows.push(...page.rows);
                }
                const output = await createResultWorkbook({ columns: set.columns, rows }, run, set.id, { fullColumnNames });
                return { contentType: EXCEL_MIME, content: output.bytes, preservedNumbers: output.preservedNumbers, ...details };
            }
            const { resultColumnLabels } = await import("../shared/result-columns.mjs");
            const labels = resultColumnLabels(set.columns, fullColumnNames);
            const exportedSet = format === "csv" ? { ...set, columns: set.columns.map((column, index) => ({ ...column, name: labels[index] })) } : set;
            return { ...await this.results.export(run, exportedSet, format, options), ...details };
        });
    }
    async close() {
        this.closed = true; this.schemaRequestGeneration++; this.schemaProvenance = null; this.state.schemaLoading = false;
        this.sharing.clear();
        this.contentReview.shares.clear(); this.contentReview.proposals.clear();
        this.dashboardProposals.clear();
        for (const batch of this.dashboardRefreshes.values()) batch.cancelled = true;
        this.publish();
        await this.queue;
        await this.projects.close();
        await this.artifacts.close();
        this.sharedAnalysis = null;
        this.state.resultAccessRevision++;
        for (const run of this.state.runs) if (ACTIVE_STATUSES.has(run.status)) {
            try { await this.native.request("query.cancel", { runId: run.id }); }
            catch (error) { this.emit("operationError", safeError(error)); }
        }
        await Promise.all([...this.dashboardRefreshes.values()].map(batch => batch.task));
        await this.dashboards.queue;
        this.native.off("notification", this.onNotification); this.native.off("unavailable", this.onUnavailable); this.native.off("status", this.onNativeStatus);
        this.native.off("workbench.registry.invalidated", this.onRegistryInvalidated); this.native.off("workbench.registry.replaced", this.onRegistryReplaced);
    }
}
