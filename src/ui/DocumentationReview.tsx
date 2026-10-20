import { useEffect, useRef, useState } from "react";
import type { ArtifactSummary } from "../contracts/artifacts";
import type { DocumentationReviewPreview, DocumentationReviewRequest } from "../contracts/documentation-review";
import type { Snapshot } from "../contracts/workbench";
import { DOCUMENTATION_REVIEW_LIMITS } from "../shared/documentation-review.mjs";
import { api, errorMessage } from "./api";

export function DocumentationReview({ state, entries, libraryRevision, initialId, sharedIds, connected, onClose, onSent }: {
  state: Snapshot; entries: ArtifactSummary[]; libraryRevision: number; initialId: string; connected: boolean;
  sharedIds: Set<string>; onClose: () => void; onSent: (count: number, ids: string[]) => void;
}) {
  const eligible = entries.filter(entry => ["research", "query"].includes(entry.kind) && entry.id.startsWith("saved:")
    && entry.canReviewDocumentation === true);
  const [chosen, setChosen] = useState<string[]>(() => eligible.some(entry => entry.id === initialId) ? [initialId] : []);
  const [preview, setPreview] = useState<{ key: string; request: DocumentationReviewRequest; data: DocumentationReviewPreview }>();
  const [busy, setBusy] = useState<"preview" | "send" | null>(null), [error, setError] = useState("");
  const pending = useRef(false), read = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const unshared = eligible.filter(entry => !sharedIds.has(entry.id));
  const active = state.documents.find(doc => doc.id === state.activeDocumentId);
  const key = JSON.stringify([state.workbenchId, active?.id, active?.connectionId, state.libraryIdentity, libraryRevision, chosen]);
  const latestKey = useRef(key); latestKey.current = key;
  const current = preview?.key === key;
  const available = connected && !state.authoringBusy && Boolean(active?.connectionId && state.libraryIdentity);
  const canSend = available && state.hostMode === "copilot-canvas";
  useEffect(() => { heading.current?.focus(); return () => read.current?.abort(); }, []);
  function choose(ids: string[]) {
    setChosen(ids); setPreview(undefined); setError("");
  }
  async function loadPreview() {
    if (pending.current || !available || !active || !state.libraryIdentity || !chosen.length) return;
    pending.current = true; setBusy("preview"); setError("");
    const controller = new AbortController(); read.current = controller;
    const request: DocumentationReviewRequest = {
      documentId: active.id, connectionId: active.connectionId, libraryRevision, identity: state.libraryIdentity, entryIds: chosen,
    };
    try {
      const data = await api.read<DocumentationReviewPreview>("library.documentation.preview", request, controller.signal);
      if (!controller.signal.aborted && latestKey.current === key) setPreview({ key, request, data });
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      pending.current = false;
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  async function share() {
    if (pending.current || !canSend || !preview || !current) return;
    pending.current = true; setBusy("send"); setError("");
    try {
      const result = await api.action<{ sent: true; count: number }>("copilot.reviewDocumentation", preview.request);
      onSent(result.count, preview.request.entryIds);
    } catch (reason) {
      setError(`${errorMessage(reason)} If delivery is uncertain, check the conversation before retrying to avoid sending twice.`);
    } finally { pending.current = false; setBusy(null); }
  }
  return <section className="documentation-review" aria-labelledby="documentation-review-title">
    <header><h3 id="documentation-review-title" tabIndex={-1} ref={heading}>Review documentation</h3>
      <p>Share saved titles and their <strong>exact documentation</strong> with Copilot, then request a documentation-only rewrite. Preview before sending.</p>
    </header>
    <p className="field-help"><strong>Included:</strong> your selected saved queries and research for the current model.
      {" "}<strong>Not included:</strong> queries, parameter values, results, descriptions, Copilot analysis, journals, notes, visuals or uploaded files.
      Text already written into the selected documentation will be shared.</p>
    {!canSend && <p className="inline-alert" role="status">{!connected ? "Reconnect before previewing or sharing documentation."
      : state.hostMode !== "copilot-canvas" ? "Open this workbench in Copilot to send documentation. This standalone preview cannot send messages."
      : "Wait for canvas authoring to finish and choose a connected model."}</p>}
    <fieldset disabled={Boolean(busy) || !available}>
      <legend>Choose documentation</legend>
      <div className="documentation-review-selection">
        <span>{chosen.length} of {eligible.length} eligible entries selected</span>
        <button className="text-button" type="button" disabled={!unshared.length} onClick={() => choose(unshared.slice(0, DOCUMENTATION_REVIEW_LIMITS.entries).map(entry => entry.id))}>
          Select next {Math.min(unshared.length, DOCUMENTATION_REVIEW_LIMITS.entries)}
        </button>
        <button className="text-button" type="button" onClick={() => choose([])}>Clear selection</button>
      </div>
      <div className="documentation-review-list">
        {eligible.map(entry => <label key={entry.id}>
          <input type="checkbox" checked={chosen.includes(entry.id)}
            disabled={!chosen.includes(entry.id) && chosen.length >= DOCUMENTATION_REVIEW_LIMITS.entries}
            onChange={event => choose(event.target.checked ? [...chosen, entry.id] : chosen.filter(id => id !== entry.id))}/>
          <span>{entry.title}{sharedIds.has(entry.id) && <small>Shared this session, not a review-completion status</small>}</span>
        </label>)}
        {!eligible.length && <p>No editable documentation matches this view. Return to files and adjust your folder, search or model filters.
          Archived entries must be restored before editing; notes and uploaded files are not query documentation.</p>}
      </div>
    </fieldset>
    <p className="field-help">Up to {DOCUMENTATION_REVIEW_LIMITS.entries} entries and 96 KiB per batch. Nothing is truncated.
      {eligible.length > DOCUMENTATION_REVIEW_LIMITS.entries && " Share additional batches separately; sending one batch does not review the remaining entries."}</p>
    {error && <p className="inline-alert error" role="alert">{error}</p>}
    {preview && <section className="documentation-review-preview" aria-label="Documentation sharing preview">
      <h4>What Copilot will receive</h4>
      {!current && <p className="inline-alert" role="status">The selection, tab, model or saved library changed. Preview again before sharing.</p>}
      <p>{preview.data.entries.length} entries · {Math.ceil(preview.data.byteLength / 1024)} KiB · {preview.data.model}</p>
      {preview.data.entries.map(entry => <details key={entry.entryTitle} open>
        <summary>{entry.entryTitle}</summary>
        <pre>{entry.expectedDocumentation || "(No documentation saved; Copilot must report missing context rather than invent it.)"}</pre>
      </details>)}
    </section>}
    <div className="button-row documentation-review-actions">
      <button className="button" disabled={Boolean(busy) || !available || !chosen.length} onClick={() => void loadPreview()}>
        {busy === "preview" ? "Loading preview..." : current ? "Refresh preview" : "Preview selected"}
      </button>
      <button className="button primary" disabled={Boolean(busy) || !canSend || !current} onClick={() => void share()}>
        {busy === "send" ? "Sending..." : "Share and rewrite"}
      </button>
      <button className="button quiet" disabled={busy === "send"} onClick={onClose}>Back to artifacts</button>
    </div>
    <p className="field-help">Sharing sends a message to this conversation; it does not grant ongoing artifact access.
      Copilot applies guarded documentation-only edits and reports any blockers. Clearer wording is not proof of business correctness.</p>
  </section>;
}
