import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../contracts/workbench";
import type { LibraryCatalog } from "../contracts/query-library";
import type { ProjectPreview, ProjectTarget } from "../contracts/query-projects";
import type { Action } from "./useWorkbench";
import { api, downloadBlob, errorMessage } from "./api";
import { Icon } from "./icons";
import "./query-projects.css";

const choices: Array<{ id: ProjectTarget; title: string; description: string }> = [
  { id: "python", title: "Python project", description: "Select queries for a runner, notebook, and uv-managed environment." },
  { id: "streamlit", title: "Streamlit app", description: "A local app for selected queries, with explicit refresh." },
  { id: "pack", title: "Query pack", description: "Selected queries, a portable manifest, Python runner, and app." },
  { id: "power-query", title: "Power Query M", description: "A refreshable query for Excel or Power BI." },
  { id: "example", title: "Reusable example", description: "Save to Library with matching run evidence." },
  { id: "studio", title: "DAX Studio files", description: "Paired DAX and verified builder selections." },
];
export function UseQuery({ state, action, onSaved, onDirtyChange, onBusyChange }: {
  state: Snapshot; action: Action; onSaved: (id: string) => void; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void;
}) {
  const active = state.documents.find(item => item.id === state.activeDocumentId)!;
  const [source] = useState({ documentId: active.id, connectionId: active.connectionId, revision: active.revision,
    builderRevision: active.builderRevision ?? 0, libraryRevision: state.libraryRevision ?? 0, title: active.title });
  const proposal = state.projectProposal?.documentId === source.documentId && state.projectProposal.revision === source.revision ? state.projectProposal : null;
  const [target, setTarget] = useState<ProjectTarget | null>(proposal?.target ?? null);
  const [title, setTitle] = useState(active.title);
  const [directory, setDirectory] = useState("");
  const directoryEdited = useRef(false);
  const [collection, setCollection] = useState("saved:general");
  const [includeValues, setIncludeValues] = useState(false);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [previewGuard, setPreviewGuard] = useState("");
  const [server, setServer] = useState(""), [database, setDatabase] = useState("");
  const [catalog, setCatalog] = useState<LibraryCatalog>();
  const [catalogError, setCatalogError] = useState(""), [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<ProjectPreview>();
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const pending = useRef(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const multiple = target === "python" || target === "streamlit" || target === "pack";
  const selectionGuard = JSON.stringify(documentIds.map(id => {
    const doc = state.documents.find(item => item.id === id);
    return doc ? [doc.id, doc.connectionId, doc.revision, doc.builderRevision ?? 0] : [id, "closed"];
  }));
  const stale = source.documentId !== active.id || source.connectionId !== active.connectionId || source.revision !== active.revision
    || source.builderRevision !== (active.builderRevision ?? 0) || source.libraryRevision !== (state.libraryRevision ?? 0)
    || Boolean(preview && multiple && previewGuard !== selectionGuard);
  const count = 1 + documentIds.length + entryIds.length;
  const saved = catalog?.entries.filter(item => item.source === "saved" && !item.archived) ?? [];
  const selectedFile = preview?.files.find(item => item.name === file) ?? preview?.files[0];
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => { if (preview) { previewHeading.current?.focus(); previewHeading.current?.scrollIntoView({ block: "start" }); } }, [preview]);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogError(""); setCatalog(undefined);
    void api.read<LibraryCatalog>("library.catalog", {}, controller.signal).then(value => {
      if (!controller.signal.aborted) setCatalog(value);
    }).catch(reason => {
      if (!controller.signal.aborted) setCatalogError(errorMessage(reason));
    });
    return () => controller.abort();
  }, [reload]);
  function changed() { setDirty(true); setPreview(undefined); setNotice(""); }
  async function prepare() {
    if (pending.current || !target) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const documents = (multiple ? documentIds : []).map(id => {
        const doc = state.documents.find(item => item.id === id);
        if (!doc) throw new Error("A selected query tab was closed. Remove it from the selection or reopen it before previewing.");
        return { id, connectionId: doc.connectionId, revision: doc.revision, builderRevision: doc.builderRevision ?? 0 };
      });
      const result = await action<ProjectPreview>("projects.prepare", { ...source, title, target, documents,
        entryIds: multiple ? entryIds : [], includeValues, server, database });
      setPreview(result); setPreviewGuard(selectionGuard); setFile(result.files[0]?.name ?? ""); setDirty(true);
      if (!directoryEdited.current) setDirectory(result.suggestedDirectories?.[0] ?? "");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function create() {
    if (pending.current || !preview) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const receipt = await action<{ id: string }>("projects.create", { previewId: preview.id, directory, collectionId: collection });
      setDirty(false); onDirtyChange(false); onBusyChange(false); onSaved(receipt.id);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="use-query">
    <p className="muted">Build a project from open tabs and saved queries, or export this query. You choose what to include; creating files never runs DAX.</p>
    <div className="project-source"><strong>{source.title}</strong><span>{state.connections.find(item => item.id === source.connectionId)?.name ?? "Unbound model"} · editor revision {source.revision}</span></div>
    {proposal && <p className="operation-notice">{proposal.rationale} This is a suggestion, not a created project.</p>}
    {stale && <p className="field-error" role="alert">A selected query or the library changed. Close this panel and reopen Use queries for a fresh source; your editor is unchanged.</p>}
    {!target ? <div className="use-query-choices">
      {choices.map((choice, index) => <div key={choice.id}>{index === 0 || index === 3 ? <h3>{index === 0 ? "Build with queries" : "Use this query"}</h3> : null}
        <button className="use-query-choice" onClick={() => { setTarget(choice.id); setError(""); }}>
          <Icon name={choice.id === "power-query" ? "table" : choice.id === "example" ? "book" : "code"} size={18}/>
          <span><strong>{choice.title}</strong><small>{choice.description}</small></span><Icon name="chevron" size={14}/>
        </button></div>)}
    </div> : <>
      <button className="text-button" disabled={busy} onClick={() => { setTarget(null); setPreview(undefined); }}>Back to destinations</button>
      <h3>{choices.find(choice => choice.id === target)?.title}</h3>
      <fieldset disabled={busy || stale} className="project-fields">
        <label className="field-label">Name<input value={title} maxLength={target === "example" ? 120 : 180} onChange={event => { setTitle(event.target.value); changed(); }}/></label>
        <label className="project-checkbox"><input type="checkbox" checked={includeValues} onChange={event => { setIncludeValues(event.target.checked); changed(); }}/>Include current parameter values and defaults</label>
        <p className="field-help">Query literals remain part of the DAX. Result rows and credentials are never included.</p>
        {target === "power-query" && <>
          <label className="field-label">Analysis Services / XMLA endpoint<input value={server} onChange={event => { setServer(event.target.value); changed(); }} placeholder="Leave empty for an unbound template" maxLength={2048}/></label>
          <label className="field-label">Model / database<input value={database} onChange={event => { setDatabase(event.target.value); changed(); }} maxLength={512}/></label>
          <p className="field-help">Paste M into a blank query in Excel or Power BI Power Query Editor. Output columns get short, unique headers such as Fiscal Month and ARR. DAX and values stay unchanged. Generation does not install or refresh a workbook query.</p>
        </>}
        {multiple && <fieldset className="project-query-selection"><legend>Queries to include</legend>
          <p className="field-help" role="status">{count} of 21 queries selected. Only checked queries are included.</p>
          <label className="project-checkbox"><input type="checkbox" checked disabled/><span><strong>{source.title}</strong><small>Current query · included</small></span></label>
          <div className="project-query-list">
          <h4>Other open tabs</h4>
          {state.documents.filter(item => item.id !== source.documentId).map(item =>
            <label className="project-checkbox" key={item.id}><input type="checkbox" checked={documentIds.includes(item.id)}
              disabled={count >= 21 && !documentIds.includes(item.id)} onChange={event => {
                setDocumentIds(values => event.target.checked ? [...values, item.id] : values.filter(id => id !== item.id)); changed();
              }}/><span>{item.title}<small>{state.connections.find(connection => connection.id === item.connectionId)?.name || "Unbound model"} · revision {item.revision}</small></span></label>)}
          {state.documents.length === 1 && <p className="field-help">No other open query tabs.</p>}
          {documentIds.filter(id => !state.documents.some(item => item.id === id)).map(id =>
            <label className="project-checkbox" key={id}><input type="checkbox" checked onChange={() => { setDocumentIds(values => values.filter(value => value !== id)); changed(); }}/><span>Closed query tab (remove to continue)</span></label>)}
          <h4>Saved Library queries</h4>
          {!catalog && !catalogError && <p className="field-help">Loading saved query choices...</p>}
          {catalog && !saved.length && <p className="field-help">No saved queries yet. Other open tabs can be included without saving them to Library first.</p>}
          {saved.map(item =>
            <label className="project-checkbox" key={item.id}><input type="checkbox" checked={entryIds.includes(item.id)} disabled={count >= 21 && !entryIds.includes(item.id)} onChange={event => {
              setEntryIds(values => event.target.checked ? [...values, item.id] : values.filter(id => id !== item.id)); changed();
            }}/><span>{item.title}<small>{item.connectionName || "Unbound connection"}</small></span></label>)}
          </div>
          <p className="field-help">Each query keeps its own model. Running a project executes one selected query, never the whole selection automatically.</p>
        </fieldset>}
        <button className="button primary" onClick={() => void prepare()} disabled={!title.trim()}>{busy ? "Preparing..." : "Preview output"}</button>
      </fieldset>
      {preview && <section className="project-preview" aria-label="Output preview">
        <h3 ref={previewHeading} tabIndex={-1}>Review before creating</h3>
        <table className="project-source-table"><thead><tr><th>Source</th><th>Model</th><th>Evidence</th></tr></thead><tbody>
          {preview.sources.map(source => <tr key={source.id}><td>{source.title}<small>revision {source.revision}</small></td><td>{source.connectionName}</td><td>{source.evidence.truncated ? "Partial" : source.evidence.status}</td></tr>)}
        </tbody></table>
        {preview.warnings.map(warning => <p className="field-help" key={warning}>{warning}</p>)}
        <label className="field-label">File preview<select value={selectedFile?.name ?? ""} onChange={event => setFile(event.target.value)}>{preview.files.map(file => <option key={file.name}>{file.name}</option>)}</select></label>
        <pre className="project-code" tabIndex={0}>{selectedFile?.content}</pre>
        {target === "power-query" && <div className="button-row">
          <button className="button" onClick={() => void navigator.clipboard.writeText(selectedFile?.content ?? "").then(() => setNotice("M code copied. Configure authentication in the destination application.")).catch(reason => setError(errorMessage(reason)))}>Copy M</button>
          <button className="button" onClick={() => selectedFile && downloadBlob(new Blob([selectedFile.content], { type: "text/plain" }), selectedFile.name)}>Save .pq</button>
        </div>}
        {target !== "example" && <label className="field-label">New project folder<input value={directory} list="project-directory-suggestions" placeholder={"C:\\Analysis\\my-query-project"} onChange={event => { setDirectory(event.target.value); directoryEdited.current = true; setDirty(true); }} maxLength={2048}/>
          <datalist id="project-directory-suggestions">{(preview.suggestedDirectories ?? []).map(item => <option key={item} value={item}/>)}</datalist>
          <small>{preview.suggestedDirectories?.length ? "Suggested from your recent project folders and home folder; pick another suggestion or edit it." : "Its parent must exist."} Workbench creates a new folder and never overwrites existing files.</small></label>}
        <label className="field-label">Artifacts collection<select value={collection} onChange={event => { setCollection(event.target.value); setDirty(true); }}>
          {(catalog?.collections.filter(item => item.source === "saved") ?? [{ id: "saved:general", name: "General" }]).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <button className="button primary" disabled={busy || stale || !catalog || (target !== "example" && !directory.trim())} onClick={() => void create()}>
          {busy ? "Creating..." : target === "example" ? "Save reusable example" : "Create project"}
        </button>
      </section>}
    </>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {catalogError && <p className="field-error" role="alert">Could not load saved queries and collections: {catalogError} <button className="text-button" onClick={() => setReload(value => value + 1)}>Retry choices</button></p>}
    {notice && <p className="operation-notice" role="status">{notice}</p>}
  </div>;
}
