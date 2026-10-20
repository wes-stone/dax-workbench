import { useEffect, useState } from "react";
import type { Snapshot } from "../contracts/workbench";
import type { ArtifactSummary } from "../contracts/artifacts";
import type { Action } from "./useWorkbench";
import { api, errorMessage } from "./api";
import { WritingEditor } from "./WritingEditor";
import { DocumentationReader } from "./DocumentationReader";

type Kind = "query" | "research" | "note" | "journal";
type Part = { field: "documentation" | "analysis" | "note" | "journal"; noteId?: string; label: string; text: string; template: Kind };
type Base = { documentId: string; connectionId: string; revision: number; builderRevision: number; libraryRevision: number; artifactsRevision: number };
type Preview = Base & { entryId: string; title: string; parts: Part[]; history: Array<{ id: string; field: string; updatedAt?: string }> };
type Proposal = Base & { id: string; entryId: string; field: Part["field"]; noteId?: string; title: string; template: Kind; author: string; expectedText: string; text: string };
const stamp = ({ documentId, connectionId, revision, builderRevision, libraryRevision, artifactsRevision }: Base): Base =>
  ({ documentId, connectionId, revision, builderRevision, libraryRevision, artifactsRevision });

export function ContentReview({ state, entries, initialId, action, connected, onClose, onDirtyChange }: {
  state: Snapshot; entries: ArtifactSummary[]; initialId: string; action: Action; connected: boolean;
  onClose: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const eligible = entries.filter(entry => ["query", "research", "note"].includes(entry.kind) && !entry.archived);
  const [entryId, setEntryId] = useState(initialId || eligible[0]?.id || ""), [partIndex, setPartIndex] = useState(0);
  const [preview, setPreview] = useState<Preview>(), [proposals, setProposals] = useState<Proposal[]>([]);
  const [text, setText] = useState(""), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [epoch, setEpoch] = useState(0);
  const part = preview?.parts[partIndex], dirty = editing && text !== part?.text;
  useEffect(() => { onDirtyChange(dirty || busy); return () => onDirtyChange(false); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    if (!entryId || editing) return;
    const abort = new AbortController(); setPreview(undefined); setError("");
    void api.read<Preview>("content.preview", { entryId }, abort.signal).then(value => {
      if (!abort.signal.aborted) { setPreview(value); setPartIndex(index => Math.min(index, value.parts.length - 1)); }
    }).catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [entryId, epoch, editing, state.libraryRevision, state.artifactsRevision, state.activeDocumentId]);
  useEffect(() => {
    if (!entryId) return;
    const abort = new AbortController();
    void api.read<{ proposals: Proposal[] }>("content.pending", { entryId }, abort.signal)
      .then(value => { if (!abort.signal.aborted) setProposals(value.proposals); })
      .catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [entryId, state.contentReviewRevision, epoch]);
  async function perform(operation: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); setEpoch(value => value + 1); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  const request = preview && part ? { ...stamp(preview), entryId, field: part.field, ...(part.noteId ? { noteId: part.noteId } : {}), expectedText: part.text } : null;
  return <section className="content-review" aria-label="Content review and history">
    <h2>Review content &amp; history</h2>
    <p>Review one exact section at a time. Queries, bindings, execution evidence, visual datasets and uploaded files are never rewritten here.</p>
    <div className="button-row">
      <label>Artifact<select value={entryId} disabled={busy || dirty} onChange={event => { setEntryId(event.target.value); setEditing(false); setPartIndex(0); }}>
        <option value="">Choose an artifact</option>{eligible.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
      <button className="button" disabled={busy || dirty} onClick={onClose}>Back to artifacts</button>
      <button className="button quiet" disabled={busy || dirty} onClick={() => { setEditing(false); setEpoch(value => value + 1); }}>Reload content</button>
    </div>
    {error && <p className="inline-alert error" role="alert">{error}</p>}
    {notice && <p className="inline-alert" role="status">{notice}</p>}
    {preview && part && <>
      <label>Section<select value={partIndex} disabled={busy || dirty} onChange={event => { setPartIndex(Number(event.target.value)); setEditing(false); }}>
        {preview.parts.map((item, index) => <option key={`${item.field}:${item.noteId ?? ""}`} value={index}>{item.label}</option>)}</select></label>
      <details open><summary>Exact original text</summary><pre className="content-original">{part.text || "(Empty section)"}</pre></details>
      {part.field === "journal" && <p className="inline-alert">A correction appends a new journal entry linked to this note. The original remains unchanged.</p>}
      {editing ? <>
        <WritingEditor label="Replacement text" value={text} onChange={setText} kind={part.template} disabled={busy}
          maxLength={part.field === "note" ? 196608 : part.field === "journal" ? 4000 : 16384}/>
        <div className="button-row"><button className="button primary" disabled={busy || !dirty || !connected || !request} onClick={() => void perform(async () => {
          await action("content.stage", { ...request, text }); setEditing(false); setNotice("Proposal staged. Review the before/after text below before applying.");
        })}>Stage replacement</button><button className="button" disabled={busy} onClick={() => setEditing(false)}>Discard draft</button></div>
      </> : <div className="button-row">
        <button className="button" disabled={busy || !connected} onClick={() => { setText(part.text); setEditing(true); }}>Edit this section</button>
        <button className="button" disabled={busy || !connected || state.hostMode !== "copilot-canvas" || !request} onClick={() => void perform(async () => {
          await api.action("copilot.reviewContent", request!);
          setNotice("This exact section was shared for one Copilot proposal. No content has been changed. If delivery is uncertain, check the conversation before retrying.");
        })}>Share exact section for proposal</button>
      </div>}
      <details><summary>Earlier text versions ({preview.history.length})</summary>
        <p>Earlier wording is retained for recovery. Restoring stages a new revision; original execution evidence is never rewritten.</p>
        {preview.history.filter(version => version.field === part.field).map(version => <button key={version.id} className="button small" disabled={busy || dirty}
          onClick={() => void perform(async () => {
            const old = await api.read<{ text: string }>("content.history", { entryId, versionId: version.id });
            setText(old.text); setEditing(true); setNotice("Previous text loaded into a draft. Stage and apply to restore it.");
          })}>Load {version.updatedAt ? new Date(version.updatedAt).toLocaleString() : version.id.slice(0, 8)}</button>)}
      </details>
    </>}
    {proposals.map(proposal => <section className="content-proposal" key={proposal.id} aria-label={`Content proposal ${proposal.title}`}>
      <h3>{proposal.field === "journal" ? "Append journal correction" : `Replace ${proposal.field}`} · proposed by {proposal.author}</h3>
      <div className="content-review-diff"><div><h4>Before (exact)</h4><pre>{proposal.expectedText}</pre></div>
        <div><h4>{proposal.field === "journal" ? "New appended correction" : "After"}</h4><DocumentationReader text={proposal.text} kind={proposal.template}/></div></div>
      <details><summary>Exact replacement Markdown</summary><pre>{proposal.text}</pre></details>
      <p>Writing checks describe structure, not factual correctness. Applying an incomplete draft does not mark its checks as passed.</p>
      <div className="button-row"><button className="button primary" disabled={busy || dirty || !connected} onClick={() => void perform(async () => {
        await action("content.apply", { proposalId: proposal.id });
        setNotice(proposal.field === "journal" ? "Correction appended; original journal and evidence preserved." : "Revision saved; earlier text remains recoverable.");
      })}>Apply reviewed revision</button>
        <button className="button" disabled={busy || dirty} onClick={() => void perform(() => action("content.dismiss", { proposalId: proposal.id }))}>Dismiss proposal</button></div>
    </section>)}
    <p className="field-help">Sharing is explicit, scoped to this section and expires after 30 minutes. Proposed drafts are temporary until applied. Archived entries must be restored first.</p>
  </section>;
}
