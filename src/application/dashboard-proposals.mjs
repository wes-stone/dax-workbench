import { randomUUID } from "node:crypto";
import { dashboardDefinition, dashboardFingerprint, dashboardObject, dashboardText } from "./dashboards.mjs";
import { fail, validateQuery } from "./policy.mjs";
import { chartConfigSchema } from "../shared/chart-data.mjs";

const text = maxLength => ({ type: "string", maxLength });
const field = () => ({ ...text(512), description: "Exact returned column name (including DAX brackets when present), or a known result column ID. Names resolve after explicit refresh; do not guess positional IDs." });
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
export const dashboardProposalProperties = {
    documentId: text(128), connectionId: text(512), revision: { type: "integer", minimum: 0 },
    title: text(120),
    tiles: { type: "array", minItems: 1, maxItems: 12, items: object({
        title: text(120), description: text(600), query: text(100000),
        width: { type: "integer", enum: [4, 6, 8, 12], description: "Explicit span in the twelve-column dashboard grid; default 6." },
        height: { type: "integer", enum: [160, 240, 360, 480, 600], description: "Data area height in pixels; 160 for compact indicators, larger for plots/tables. Default 360." },
        visual: object({
            type: { enum: ["table", "indicator", "bar", "line", "scatter", "matrix", "waterfall", "small-multiples"] },
            units: text(120), valueColumn: field(), contextColumn: field(),
            chart: { ...chartConfigSchema, properties: { ...chartConfigSchema.properties, x: field(), y: field(), legend: field() } },
            advanced: object({ type: { enum: ["waterfall", "small-multiples"] }, x: field(), y: field(), group: field(), start: text(1000) }),
            matrix: object({ row: field(), column: field(), value: field(), aggregation: { enum: ["none", "sum", "count"] }, emphasizeNegative: { type: "boolean" } }),
        }, ["type", "units"]),
    }, ["title", "query", "visual"]) },
};
export const dashboardProposalRequired = Object.keys(dashboardProposalProperties);

export class DashboardProposals {
    constructor(workbench) { this.workbench = workbench; this.pending = new Map(); this.version = 0; }
    clear() { this.pending.clear(); this.version++; }
    prune() {
        for (const [id, proposal] of this.pending)
            if (proposal.expiresAt <= Date.now()) { this.pending.delete(id); this.version++; }
    }
    guard(payload) {
        const wb = this.workbench, doc = wb.activeDocument(), connection = wb.state.connections.find(item => item.id === doc.connectionId);
        if (!connection || wb.closed || doc.id !== payload.documentId || doc.connectionId !== payload.connectionId || doc.revision !== payload.revision)
            throw fail("REVISION_CONFLICT", "The active query/model changed. Read fresh builder context before proposing a dashboard.");
        return connection;
    }
    propose(payload) {
        dashboardObject(payload, [...dashboardProposalRequired, "workbenchId"], dashboardProposalRequired);
        const connection = this.guard(payload);
        dashboardText(payload.title, "Dashboard title");
        if (!Array.isArray(payload.tiles) || !payload.tiles.length || payload.tiles.length > 12)
            throw fail("DASHBOARD_PROPOSAL_LIMIT", "Propose one to twelve supplied query tiles.");
        this.prune();
        if (this.pending.size >= 8) throw fail("DASHBOARD_PROPOSAL_LIMIT", "Review or dismiss existing proposals first. At most eight may be pending.");
        const pageId = randomUUID();
        const definition = dashboardDefinition({ id: randomUUID(), title: payload.title, revision: 0, favorite: false, archived: false,
            pages: [{ id: pageId, title: "Overview" }], filters: [], tiles: payload.tiles.map(tile => {
                dashboardObject(tile, ["title", "description", "query", "visual", "width", "height"], ["title", "query", "visual"]); validateQuery(tile.query);
                if (/\{\{/.test(tile.query)) throw fail("INVALID_DASHBOARD", "Supply self-contained read-only DAX, not unresolved template bindings.");
                const source = { version: 1, connectionId: connection.id, connectionName: connection.name, model: connection.model ?? null,
                    connectionKind: connection.kind, query: tile.query, parameters: {}, queryRevision: payload.revision };
                return { id: randomUUID(), pageId, title: tile.title, ...(tile.description === undefined ? {} : { description: tile.description }),
                    width: tile.width === undefined ? 6 : tile.width, height: tile.height === undefined ? 360 : tile.height, mappings: [], previousSnapshotIds: [],
                    visual: structuredClone(tile.visual), source: { ...source, fingerprint: dashboardFingerprint(source) } };
            }) });
        const proposal = { id: randomUUID(), expiresAt: Date.now() + 30 * 60 * 1000, definition,
            scope: { documentId: payload.documentId, connectionId: payload.connectionId, revision: payload.revision },
            identity: dashboardFingerprint(this.workbench.knowledgeIdentity()) };
        if (Buffer.byteLength(JSON.stringify(proposal)) > 96 * 1024) throw fail("DASHBOARD_PROPOSAL_LIMIT", "Propose at most 96 KiB of definition text. Nothing was shortened.");
        this.pending.set(proposal.id, proposal); this.version++; this.workbench.publish();
        return { proposalId: proposal.id, tileCount: payload.tiles.length, expiresAt: proposal.expiresAt, applied: false, executed: false };
    }
    async action(action, payload) {
        this.prune();
        if (action === "dashboards.proposals") {
            dashboardObject(payload, []);
            return [...this.pending.values()].map(({ scope, identity, ...proposal }) => structuredClone(proposal));
        }
        dashboardObject(payload, action === "dashboards.proposal.apply" ? ["proposalId", "expectedRevision"] : ["proposalId"]);
        const proposal = this.pending.get(payload.proposalId);
        if (!proposal) throw fail("DASHBOARD_PROPOSAL_EXPIRED", "This proposal expired or was dismissed. Request a new proposal; nothing was applied.");
        if (action === "dashboards.proposal.dismiss") {
            this.pending.delete(proposal.id); this.version++; this.workbench.publish(); return { dismissed: true };
        }
        if (action !== "dashboards.proposal.apply") throw fail("INVALID_DASHBOARD", "Unknown dashboard proposal operation.");
        this.guard(proposal.scope);
        if (dashboardFingerprint(this.workbench.knowledgeIdentity()) !== proposal.identity)
            throw fail("REVISION_CONFLICT", "Model metadata or connection identity changed. Request a fresh proposal.");
        const board = await this.workbench.dashboards.importDefinition(proposal.definition, payload.expectedRevision);
        this.pending.delete(proposal.id); this.version++; this.workbench.publish(); return board;
    }
}
