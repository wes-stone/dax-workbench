import { randomUUID } from "node:crypto";
import { fail } from "./policy.mjs";
import { artifactObject, artifactText, noteText } from "./artifacts-validation.mjs";
import { ContentHistory } from "./content-history.mjs";
import { getWritingGuide } from "../shared/writing.mjs";
import { updateLibraryContent } from "./query-library.mjs";

export const contentProposalProperties = {
    shareId: { type: "string", format: "uuid" },
    expectedText: { type: "string", maxLength: 196608 },
    text: { type: "string", maxLength: 196608 },
};
const baseKeys = ["documentId", "connectionId", "revision", "builderRevision", "libraryRevision", "artifactsRevision"];
const editKeys = ["entryId", "field", "noteId", "expectedText", "text", ...baseKeys];
const templates = { documentation: "query", analysis: "research", journal: "journal", note: "note" };
export class ContentReview {
    constructor(wb, onLibraryChange) {
        this.wb = wb; this.onLibraryChange = onLibraryChange; this.proposals = new Map(); this.shares = new Map(); this.version = 0;
    }
    stamp() {
        const doc = this.wb.activeDocument();
        return { documentId: doc.id, connectionId: doc.connectionId, revision: doc.revision,
            builderRevision: doc.builderRevision ?? 0, libraryRevision: this.wb.state.library.revision, artifactsRevision: this.wb.artifacts.revision };
    }
    guard(request) {
        if (this.wb.closed || this.wb.authoring.current) throw fail("CONTENT_BUSY", "Reopen or wait for authoring to finish before reviewing content.");
        const current = this.stamp();
        if (baseKeys.some(key => current[key] !== request[key])) throw fail("REVISION_CONFLICT", "The tab, model or artifacts changed. Preview the exact content again.");
    }
    async preview(entryId) {
        const stamp = this.stamp();
        let title, parts, history;
        if (typeof entryId !== "string") throw fail("INVALID_CONTENT_REVIEW", "Choose a saved artifact.");
        if (entryId.startsWith("artifact:")) {
            const entry = await this.wb.artifacts.get(entryId);
            if (entry.kind !== "note" || entry.archived) throw fail("CONTENT_READ_ONLY", "Restore a managed Markdown note before reviewing it. Uploaded files and visual datasets are not rewritten.");
            title = entry.title; parts = [{ field: "note", label: "Managed note", text: entry.text, template: "note" }];
            history = (entry.previousVersions ?? []).map(version => ({ ...version, field: "note" }));
        } else {
            const entry = this.wb.state.library.entries.find(entry => entry.id === entryId && entry.source === "saved" && !entry.archived);
            if (!entry) throw fail("CONTENT_READ_ONLY", "Choose an active saved query or research artifact.");
            title = entry.title;
            parts = [{ field: "documentation", label: "Query documentation", text: entry.documentation, template: "query" }];
            if (entry.analysis) parts.push({ field: "analysis", label: "Research analysis body", text: entry.analysis.content, template: "research" });
            for (const note of entry.notes ?? []) parts.push({ field: "journal", noteId: note.id,
                label: `${note.correctionOf ? "Correction" : "Journal"}: ${note.createdAt}`, text: note.content, template: "journal" });
            history = structuredClone(entry.contentHistory ?? []);
        }
        this.guard(stamp);
        return { entryId, title, parts, history, ...stamp };
    }
    async checked(request) {
        this.guard(request);
        const preview = await this.preview(request.entryId);
        const part = preview.parts.find(part => part.field === request.field && part.noteId === request.noteId);
        if (!part || part.text !== request.expectedText) throw fail("REVISION_CONFLICT", "The exact original text no longer matches. Nothing was rewritten.");
        return { preview, part };
    }
    async share(request) {
        artifactObject(request, editKeys.filter(key => key !== "text"), ["entryId", "field", "expectedText", ...baseKeys]);
        const { preview, part } = await this.checked(request);
        const grant = { ...structuredClone(request), shareId: randomUUID(), title: preview.title, template: part.template };
        if (Buffer.byteLength(JSON.stringify(grant)) > 96 * 1024) throw fail("CONTENT_SHARE_LIMIT", "This exact section exceeds 96 KiB. Edit it locally; nothing was shortened or shared.");
        for (const [id, value] of this.shares) if (value.expires < Date.now()) this.shares.delete(id);
        if (this.shares.size >= 8) throw fail("CONTENT_SHARE_LIMIT", "Eight content handoffs are pending. Finish them or reopen this workbench before sharing more.");
        this.shares.set(grant.shareId, { request: structuredClone(request), expires: Date.now() + 30 * 60 * 1000 });
        return grant;
    }
    async stage(request, author = "human") {
        artifactObject(request, editKeys, ["entryId", "field", "expectedText", "text", ...baseKeys]);
        const { preview, part } = await this.checked(request);
        if (request.field === "note") noteText(request.text);
        else artifactText(request.text, "Replacement", request.field === "journal" ? 4000 : 16384, { multiline: true, empty: request.field === "documentation" });
        if (this.proposals.size >= 8) throw fail("CONTENT_PROPOSAL_LIMIT", "Apply or dismiss a pending content proposal before adding another.");
        const proposal = { ...structuredClone(request), id: randomUUID(), title: preview.title, template: part.template, author };
        this.proposals.set(proposal.id, proposal); this.version++; this.wb.publish();
        return { proposalId: proposal.id, executed: false, applied: false };
    }
    async propose(request) {
        artifactObject(request, ["shareId", "expectedText", "text", "workbenchId"], ["shareId", "expectedText", "text"]);
        const shared = this.shares.get(request.shareId);
        if (!shared || shared.expires < Date.now() || shared.request.expectedText !== request.expectedText)
            throw fail("CONTENT_HANDOFF_REQUIRED", "Use an unexpired exact-content handoff explicitly shared by the person. No private artifact was read.");
        const result = await this.stage({ ...shared.request, text: request.text }, "copilot");
        this.shares.delete(request.shareId);
        return result;
    }
    async apply(proposalId) {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) throw fail("CONTENT_PROPOSAL_NOT_FOUND", "This proposal is no longer available. Preview and stage again.");
        await this.checked(proposal);
        if (proposal.field === "note") {
            await this.wb.updateReviewedNote({ id: proposal.entryId, expectedRevision: proposal.artifactsRevision, text: proposal.text }, () => this.guard(proposal));
        } else {
            await this.wb.mutate(next => {
                this.guard(proposal);
                updateLibraryContent(next.library, proposal, proposal.author);
                this.onLibraryChange(next, proposal.entryId);
            });
        }
        this.proposals.delete(proposalId); this.version++; this.wb.publish();
        return { applied: true, executed: false, journalAppended: proposal.field === "journal",
            writing: getWritingGuide(proposal.template, proposal.text).validation };
    }
    async action(action, payload) {
        if (action === "content.preview") return this.preview(payload.entryId);
        if (action === "content.share") return this.share(payload);
        if (action === "content.stage") return this.stage(payload);
        if (action === "content.pending") return { proposals: [...this.proposals.values()].filter(item => item.entryId === payload.entryId).map(item => structuredClone(item)) };
        if (action === "content.apply") return this.apply(payload.proposalId);
        if (action === "content.dismiss") {
            if (!this.proposals.delete(payload.proposalId)) throw fail("CONTENT_PROPOSAL_NOT_FOUND", "This proposal is no longer available.");
            this.version++; this.wb.publish(); return { dismissed: true };
        }
        if (action === "content.history") {
            if (payload.entryId?.startsWith("artifact:")) return this.wb.artifacts.noteVersion(payload.entryId, payload.versionId);
            const entry = this.wb.state.library.entries.find(item => item.id === payload.entryId);
            if (!entry) throw fail("CONTENT_HISTORY_NOT_FOUND", "Choose a saved artifact.");
            return new ContentHistory(this.wb.native, this.wb.id).read(entry, payload.versionId);
        }
        throw fail("UNKNOWN_ACTION", "Unknown content review action.");
    }
}
