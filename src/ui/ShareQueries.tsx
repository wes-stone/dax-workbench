import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Snapshot } from "../contracts/workbench";
import type { LibraryCatalog } from "../contracts/query-library";
import type { KnowledgeSearch } from "../contracts/model-context";
import type { ShareModelOptions, SharePreview, ShareRequest, ShareSchemaScope } from "../contracts/query-sharing";
import type { Action } from "./useWorkbench";
import { api, downloadBlob, errorMessage } from "./api";
import { Icon } from "./icons";
import "./query-sharing.css";

export function ShareQueries({ state, action, connected, onDirtyChange, onBusyChange }: {
  state: Snapshot; action: Action; connected: boolean; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void;
}) {
  const active = state.documents.find(item => item.id === state.activeDocumentId)!;
  const connection = state.connections.find(item => item.id === active.connectionId);
  const modelTitle = `${connection?.name ?? "Model"} starter kit`.slice(0, 120);
  const [sourceId] = useState(active.id);
  const [scope, setScope] = useState<"model" | "queries">(connection ? "model" : "queries");
  const [modelOptions, setModelOptions] = useState<ShareModelOptions>({
    starters: true, tabs: true, saved: true, modelContext: true, validatedQueries: true, skill: true,
  });
  const [title, setTitle] = useState(connection ? modelTitle : active.title), [note, setNote] = useState("");
  const [documentIds, setDocumentIds] = useState([active.id]), [entryIds, setEntryIds] = useState<string[]>([]);
  const [noteIds, setNoteIds] = useState<string[]>([]);
  const [schemaScope, setSchemaScope] = useState<ShareSchemaScope>(connection ? "loaded" : "selected");
  const [includeDocumentation, setIncludeDocumentation] = useState(true);
  const [includeResearch, setIncludeResearch] = useState(false), [includeValues, setIncludeValues] = useState(false);
  const [catalog, setCatalog] = useState<LibraryCatalog>(), [knowledge, setKnowledge] = useState<KnowledgeSearch>();
  const [catalogError, setCatalogError] = useState(""), [knowledgeError, setKnowledgeError] = useState("");
  const [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<SharePreview>(), [file, setFile] = useState("");
  const [previewGuard, setPreviewGuard] = useState("");
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const pending = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const identityKey = JSON.stringify(state.libraryIdentity);
  const guard = JSON.stringify({
    documents: state.documents.filter(doc => scope === "model" ? doc.connectionId === active.connectionId : documentIds.includes(doc.id))
      .map(doc => [doc.id, doc.revision, doc.builderRevision, doc.connectionId]),
    closed: scope === "model" ? state.closedDocuments : undefined,
    active: state.activeDocumentId, libraryRevision: state.libraryRevision, identityKey,
    schema: state.schema?.fetchedAt, selection: state.selectedObjects,
  });
  const changedSource = sourceId !== active.id;
  const stale = Boolean(preview && guard !== previewGuard);
  const count = documentIds.length + entryIds.length;
  const selectedFile = preview?.files.find(item => item.name === file) ?? preview?.files[0];
  const saved = catalog?.entries.filter(entry => entry.source === "saved" && !entry.archived) ?? [];
  useLayoutEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useLayoutEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  useEffect(() => { if (preview) { heading.current?.focus(); heading.current?.scrollIntoView({ block: "start" }); } }, [preview]);
  useEffect(() => {
    const abort = new AbortController();
    setCatalogError(""); setCatalog(undefined);
    if (scope !== "queries") return () => abort.abort();
    void api.read<LibraryCatalog>("library.catalog", {}, abort.signal).then(value => { if (!abort.signal.aborted) setCatalog(value); })
      .catch(reason => { if (!abort.signal.aborted) setCatalogError(errorMessage(reason)); });
    return () => abort.abort();
  }, [scope, state.libraryRevision, reload]);
  useEffect(() => {
    const abort = new AbortController();
    setKnowledge(undefined); setKnowledgeError("");
    if (scope === "queries" && state.libraryIdentity) void api.read<KnowledgeSearch>("knowledge.search", { identity: state.libraryIdentity }, abort.signal)
      .then(value => { if (!abort.signal.aborted) setKnowledge(value); })
      .catch(reason => { if (!abort.signal.aborted) setKnowledgeError(errorMessage(reason)); });
    return () => abort.abort();
  }, [scope, identityKey, reload]);
  function changed() { setDirty(true); setPreview(undefined); setNotice(""); setError(""); }
  function changeScope(value: "model" | "queries") {
    setScope(value); setTitle(value === "model" ? modelTitle : active.title);
    setSchemaScope(value === "model" ? "loaded" : "selected"); changed();
  }
  function toggle(values: string[], id: string, checked: boolean) { return checked ? [...values, id] : values.filter(value => value !== id); }
  async function prepare() {
    if (pending.current || changedSource) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const documents = (scope === "model" ? [active.id] : documentIds).map(id => {
        const doc = state.documents.find(doc => doc.id === id);
        if (!doc) throw new Error("A selected tab was closed. Remove it from the bundle or reopen it before sharing.");
        return { id, revision: doc.revision, builderRevision: doc.builderRevision ?? 0 };
      });
      const knowledgeRefs = (scope === "model" ? [] : noteIds).map(id => {
        const entry = knowledge?.entries.find(entry => entry.id === id);
        if (!entry) throw new Error("A selected model note is no longer available. Clear the note selection and choose again.");
        return { id, version: entry.version };
      });
      const request: ShareRequest = {
        documentId: active.id, connectionId: active.connectionId, revision: active.revision, builderRevision: active.builderRevision ?? 0,
        libraryRevision: state.libraryRevision ?? 0, documents, entryIds: scope === "model" ? [] : entryIds, title, note, schemaScope,
        includeDocumentation, includeResearch, includeValues, knowledgeRefs, identity: knowledge?.identity,
        scope, ...(scope === "model" ? { modelOptions } : {}),
      };
      const result = await action<SharePreview>("share.prepare", request);
      setPreview(result); setPreviewGuard(guard); setFile(scope === "model" ? "START-HERE.md" : "README.md");
    } catch (reason) { setPreview(undefined); setError(errorMessage(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function download() {
    if (pending.current || !preview || stale) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const { zipSync, strToU8 } = await import("fflate");
      const reviewed = await action<SharePreview>("share.download", { id: preview.id });
      const bytes = zipSync(Object.fromEntries(reviewed.files.map(file => [file.name, strToU8(file.content)])), { level: 6 });
      downloadBlob(new Blob([new Uint8Array(bytes)], { type: "application/zip" }), reviewed.filename);
      setDirty(false);
      setNotice(`Download started: ${reviewed.filename}. Nothing was uploaded. Extract it to open the queries and context.`);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="share-queries" aria-busy={busy}>
    <div className="share-content">
    <p className="share-intro">Give someone the model starter kit, not just one query. Gather its queries, model knowledge and DAX skill guidance into a ZIP you review before sending. Nothing is uploaded or run.</p>
    {changedSource && <p className="field-error" role="alert">The active tab changed. Close Share queries and reopen it from the query you want to share. Your handoff note has not been discarded.</p>}
    <fieldset className="share-fields" disabled={busy || changedSource}>
      <fieldset className="share-scope">
        <legend>What to share</legend>
        <label className="share-choice"><input type="radio" name="share-scope" checked={scope === "model"} disabled={!connection} onChange={() => changeScope("model")}/><span><strong>Model starter kit</strong><small>Gather available material for {connection?.name || "the selected model"}.</small></span></label>
        <label className="share-choice"><input type="radio" name="share-scope" checked={scope === "queries"} onChange={() => changeScope("queries")}/><span><strong>Selected queries</strong><small>Choose individual queries and a smaller context bundle.</small></span></label>
      </fieldset>
      <label className="field-label">Bundle name<input value={title} maxLength={120} onChange={event => { setTitle(event.target.value); changed(); }}/></label>
      {scope === "model" ? <section className="share-section" aria-labelledby="share-model-heading">
        <h3 id="share-model-heading">Gather from this model</h3>
        <p className="field-help">{connection?.model}. All checked sources are collected when you preview; no need to open each query.</p>
        {([
          ["starters", "Bundled starter queries", "The model's Workbench examples, documentation and builder definitions."],
          ["tabs", "Open and recoverable query tabs", "Nonempty drafts on this connection, including closed starter tabs."],
          ["saved", "Saved model queries", "All non-archived queries saved to this exact connection and model."],
          ["modelContext", "DAX skill model context", "Model overview, full context, dictionary definitions and bundled notes. Structured samples are excluded."],
          ["validatedQueries", "Validated query examples", "Reusable DAX examples from this profile's DAX skill library, without recorded results."],
          ["skill", "DAX query skill workflow", "Your local dax-query SKILL.md, so the recipient gets the workflow too."],
        ] satisfies Array<[keyof ShareModelOptions, string, string]>).map(([key, label, help]) => <label className="share-choice" key={key}>
          <input type="checkbox" checked={modelOptions[key]} onChange={event => { setModelOptions({ ...modelOptions, [key]: event.target.checked }); changed(); }}/><span>{label}<small>{help}</small></span>
        </label>)}
        <p className="field-help">Up to 250 queries / 8 MiB. The preview lists what was found, missing or excluded; nothing is silently truncated. Other models and standalone artifacts are not swept in.</p>
      </section> : <>
      <section className="share-section" aria-labelledby="share-queries-heading">
        <h3 id="share-queries-heading">Queries <span className="muted">{count} of 20</span></h3>
        <label className="share-choice"><input type="checkbox" checked disabled/><span><strong>{active.title}</strong><small>Current query · revision {active.revision}</small></span></label>
        <details><summary>Add open or saved queries</summary>
          <div className="share-query-choices">
            {state.documents.filter(doc => doc.id !== sourceId).map(doc => <label className="share-choice" key={doc.id}>
              <input type="checkbox" checked={documentIds.includes(doc.id)} disabled={count >= 20 && !documentIds.includes(doc.id)} onChange={event => { setDocumentIds(toggle(documentIds, doc.id, event.target.checked)); changed(); }}/>
              <span>{doc.title}<small>Open tab · {state.connections.find(connection => connection.id === doc.connectionId)?.name || "Unbound"}</small></span>
            </label>)}
            {saved.map(entry => <label className="share-choice" key={entry.id}>
              <input type="checkbox" checked={entryIds.includes(entry.id)} disabled={count >= 20 && !entryIds.includes(entry.id)} onChange={event => { setEntryIds(toggle(entryIds, entry.id, event.target.checked)); changed(); }}/>
              <span>{entry.title}<small>Saved query · {entry.connectionName || "Unbound"}</small></span>
            </label>)}
            {documentIds.filter(id => !state.documents.some(doc => doc.id === id) && id !== sourceId).map(id => <label className="share-choice" key={id}><input type="checkbox" checked onChange={() => { setDocumentIds(documentIds.filter(value => value !== id)); changed(); }}/><span>Closed query tab (remove to continue)</span></label>)}
            {entryIds.filter(id => catalog && !saved.some(entry => entry.id === id)).map(id => <label className="share-choice" key={id}><input type="checkbox" checked onChange={() => { setEntryIds(entryIds.filter(value => value !== id)); changed(); }}/><span>Unavailable saved query (remove to continue)</span></label>)}
          </div>
          {!catalog && !catalogError && <p className="field-help" role="status">Loading saved query choices...</p>}
          {catalog && !saved.length && state.documents.length === 1 && <p className="field-help">No additional open or saved queries.</p>}
          {catalogError && <p className="field-error" role="alert">{catalogError} <button className="text-button" onClick={() => setReload(value => value + 1)}>Retry choices</button></p>}
          <p className="field-help">Only checked queries are included. Closed tabs and the rest of your library stay private.</p>
        </details>
      </section>
      </>}
      <section className="share-section" aria-labelledby="share-context-heading">
        <h3 id="share-context-heading">Context</h3>
        <label className="field-label">Model schema<select aria-label="Model schema" value={schemaScope} onChange={event => { setSchemaScope(event.target.value as ShareSchemaScope); changed(); }}>
          <option value="selected">Selected fields and builder references</option><option value="loaded">All loaded model metadata</option><option value="none">No model schema</option>
        </select></label>
        <p className="field-help">For {state.connections.find(connection => connection.id === active.connectionId)?.name || "the active model"} only. Uses already-loaded metadata, not a live refresh. Names and separate builder drafts are always included.</p>
        <label className="share-choice"><input type="checkbox" checked={includeDocumentation} onChange={event => { setIncludeDocumentation(event.target.checked); changed(); }}/><span>Include selected query documentation</span></label>
        <label className="field-label"><span>Handoff note <span className="muted">(optional)</span></span><textarea value={note} maxLength={8000} rows={3} placeholder="Purpose, filters, assumptions, or what to check next" onChange={event => { setNote(event.target.value); changed(); }}/></label>
        <details><summary>Model notes and sensitive extras</summary>
          <div className="share-extras">
            <label className="share-choice"><input type="checkbox" checked={includeValues} onChange={event => { setIncludeValues(event.target.checked); changed(); }}/><span>Include current parameter values and defaults<small>Off by default. Values can identify customers or contain sensitive data.</small></span></label>
            <label className="share-choice"><input type="checkbox" checked={includeResearch} onChange={event => { setIncludeResearch(event.target.checked); changed(); }}/><span>Include saved analysis and journal notes<small>{scope === "model" ? "For saved model queries gathered above" : "Only for explicitly checked saved queries"}, not other artifacts or conversation history. Text can quote data.</small></span></label>
            {scope === "queries" && <>
            <h4>Bundled model notes</h4>
            {knowledge?.entries.filter(entry => entry.kind === "note").map(entry => <label className="share-choice" key={entry.id}>
              <input type="checkbox" checked={noteIds.includes(entry.id)} onChange={event => { setNoteIds(toggle(noteIds, entry.id, event.target.checked)); changed(); }}/><span>{entry.title}<small>{entry.summary}</small></span>
            </label>)}
            {(!state.libraryIdentity || knowledge && !knowledge.entries.some(entry => entry.kind === "note")) && <p className="field-help">No bundled model notes available for this model.</p>}
            {state.libraryIdentity && !knowledge && !knowledgeError && <p className="field-help" role="status">Loading model note choices...</p>}
            {knowledge?.omitted && <p className="field-help">Showing the first available bundled matches, not the full model knowledge collection.</p>}
            {noteIds.some(id => knowledge && !knowledge.entries.some(entry => entry.id === id)) && <button className="text-button" onClick={() => { setNoteIds([]); changed(); }}>Clear unavailable model notes</button>}
            {knowledgeError && <p className="field-error" role="alert">{knowledgeError} <button className="text-button" onClick={() => setReload(value => value + 1)}>Retry notes</button></p>}
            </>}
          </div>
        </details>
      </section>
      <p className="share-boundary"><Icon name="info" size={15}/><span>Plaintext files: query literals, filters and written context are not redacted. Notes and skill text may quote business values or connection details. Connection configuration files and captured results are not collected. Review before sending.</span></p>
      {scope === "queries" && !active.query.trim() && <p className="field-help">Write a query before creating a selected-query bundle. Model kits can be gathered from an empty tab.</p>}
    </fieldset>
    {preview && <section className="share-preview" aria-label="Share bundle preview">
      <h3 ref={heading} tabIndex={-1}>Review your bundle</h3>
      <p className="field-help">{preview.queryCount} {preview.queryCount === 1 ? "query" : "queries"} · {preview.schemaCount} model {preview.schemaCount === 1 ? "object" : "objects"} · {preview.noteCount} model notes · {Math.ceil(preview.bytes / 1024)} KiB before compression</p>
      {preview.scope === "model" && <div className="share-coverage" aria-label="Collection coverage">
        {preview.coverage?.map(item => <div className="share-coverage-row" key={item.source}>
          <span><strong>{item.source}</strong><small>{item.detail}</small></span>
          <span className={item.status === "included" ? "" : "muted"}>{item.status === "included" ? `${item.count} included` : item.status}</span>
        </div>)}
      </div>}
      <label className="field-label">Review file<select aria-label="Review file" value={selectedFile?.name ?? ""} onChange={event => setFile(event.target.value)}>{preview.files.map(file => <option key={file.name}>{file.name}</option>)}</select></label>
      <pre className="share-code" tabIndex={0} aria-label={selectedFile?.name}>{selectedFile?.content}</pre>
      <details><summary>What this bundle excludes</summary>{preview.warnings.map(warning => <p className="field-help" key={warning}>{warning}</p>)}</details>
    </section>}
    </div>
    <div className="share-actions">
      {stale && <p className="field-error" role="alert">The source or context changed. Refresh the preview before downloading.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {notice && <p className="operation-notice" role="status">{notice}</p>}
      <span className="field-help">Local download only. Recipient connects independently.</span>
      <div className="button-row">
        <button className={`button ${preview ? "" : "primary"}`} disabled={busy || changedSource || !connected || !title.trim() || scope === "queries" && !active.query.trim()} onClick={() => void prepare()}>{busy ? "Gathering..." : preview ? "Refresh preview" : scope === "model" ? "Preview model kit" : "Preview bundle"}</button>
        {preview && <button className="button primary" disabled={busy || stale || changedSource || !connected} onClick={() => void download()}><Icon name="download" size={15}/>Download ZIP</button>}
      </div>
    </div>
  </div>;
}
