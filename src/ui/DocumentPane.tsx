import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelObject, QueryDocument, Run, Snapshot } from "../contracts/workbench";
import { DaxEditor, ProposalDiff, type EditorCommands } from "./Editor";
import { Icon } from "./icons";
import { parseParameters, RUNNING } from "./model";
import { errorMessage } from "./api";
import type { Action } from "./useWorkbench";

export interface DocumentCommands { run: () => void; save: () => Promise<void>; prepareAuthoring: () => Promise<void>; reviewProposal: () => void; selection: () => { start: number; end: number }; focus: () => void }

export function DocumentPane({ document, stateRef, action, objects, runs, commands, insert, onInserted, onLibrary, onUseQuery, onShare, parametersOpen, setParametersOpen, onManualEdit }: {
  document: QueryDocument; stateRef: React.RefObject<Snapshot | null>; action: Action; objects: ModelObject[];
  runs: Run[]; commands: React.RefObject<DocumentCommands | null>;
  insert?: { text: string; sequence: number }; onInserted: () => void; onLibrary: () => void; onUseQuery: () => void; onShare: () => void;
  parametersOpen: boolean; setParametersOpen: (value: boolean) => void;
  onManualEdit?: () => void;
}) {
  const [query, setQuery] = useState(document.query);
  const [parameters, setParameters] = useState(JSON.stringify(document.parameters, null, 2));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [review, setReview] = useState(false);
  const draft = useRef({ query, parameters, revision: document.revision, dirty: false });
  const inFlight = useRef<Promise<void> | null>(null);
  const selection = useRef({ start: 0, end: 0 });
  const editorCommands = useRef<EditorCommands | null>(null);
  const edit = useCallback((value: string) => {
    draft.current.query = value; draft.current.dirty = true;
    setQuery(value); setDirty(true); setSaveError("");
    onManualEdit?.();
  }, [onManualEdit]);
  const editParameters = (value: string) => {
    draft.current.parameters = value; draft.current.dirty = true;
    setParameters(value); setDirty(true); setSaveError("");
  };
  useEffect(() => {
    if (!draft.current.dirty && !inFlight.current) {
      draft.current = { query: document.query, parameters: JSON.stringify(document.parameters, null, 2), revision: document.revision, dirty: false };
      setQuery(draft.current.query); setParameters(draft.current.parameters); setDirty(false);
    }
  }, [document.revision, document.query, document.parameters]);

  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) { await inFlight.current; if (draft.current.dirty) return save(); return; }
    if (!draft.current.dirty) return;
    const parsed = parseParameters(draft.current.parameters);
    if (!parsed.value) {
      setParametersOpen(true);
      throw new Error(parsed.error ?? "Check the parameter JSON.");
    }
    const captured = { ...draft.current };
    setSaving(true); setSaveError("");
    const promise = (async () => {
      await action("document.update", { id: document.id, revision: captured.revision, query: captured.query, parameters: parsed.value });
      const current = stateRef.current?.documents.find(item => item.id === document.id);
      draft.current.revision = current?.revision ?? captured.revision + 1;
      if (draft.current.query === captured.query && draft.current.parameters === captured.parameters) {
        draft.current.dirty = false; setDirty(false);
      }
    })();
    inFlight.current = promise;
    try { await promise; }
    catch (reason) { setSaveError(errorMessage(reason)); throw reason; }
    finally { inFlight.current = null; setSaving(false); }
  }, [action, document.id, stateRef, setParametersOpen]);

  useEffect(() => {
    if (!dirty || parseParameters(parameters).error || saveError) return;
    const timer = setTimeout(() => { void save().catch(() => {}); }, 650);
    return () => clearTimeout(timer);
  }, [query, parameters, dirty, save, saveError]);

  const run = useCallback(() => {
    void (async () => {
      await save();
      await action("query.run", { documentId: document.id });
    })().catch(reason => setSaveError(errorMessage(reason)));
  }, [save, action, document.id]);
  useLayoutEffect(() => {
    commands.current = { run, save, prepareAuthoring: async () => {
      if (review) throw new Error("Finish reviewing the query proposal before Copilot authors this canvas.");
      await save();
    }, reviewProposal: () => setReview(true), selection: () => selection.current,
      focus: () => { setReview(false); requestAnimationFrame(() => editorCommands.current?.focus()); } };
    return () => { if (commands.current?.save === save) commands.current = null; };
  }, [commands, run, save, edit, review]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draft.current.dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { window.removeEventListener("beforeunload", beforeUnload); };
  }, [commands]);
  const activeRun = runs.find(run => run.connectionId === document.connectionId && RUNNING.has(run.status));
  const parameterError = parseParameters(parameters).error;
  const connectionKind = stateRef.current?.connections.find(connection => connection.id === document.connectionId)?.kind;
  const rest = connectionKind === "powerbi-rest";
  const windowsProvider = connectionKind === "windows-msolap";
  const proposal = document.proposal;
  const stale = proposal ? proposal.baseRevision !== document.revision || dirty : false;
  return <section className="document-pane" aria-label="Query workspace">
    <div className="editor-toolbar">
      <div className="toolbar-group">
        <button className="button primary run-button" onClick={run} disabled={!document.connectionId || Boolean(activeRun) || Boolean(parameterError)} title="Run query (Ctrl+Enter or F5)"><Icon name="play" size={14}/>Run<span className="shortcut">Ctrl ↵</span></button>
        {activeRun && <button className="button danger-text" disabled={activeRun.status === "cancelling"} onClick={() => void action("query.cancel", { runId: activeRun.id }).catch(() => {})}><Icon name="stop" size={13}/>{activeRun.status === "cancelling" ? "Cancelling…" : "Cancel"}</button>}
        <span className="toolbar-divider"/>
        <button className={`button quiet ${parametersOpen ? "is-active" : ""}`} aria-pressed={parametersOpen} onClick={() => setParametersOpen(!parametersOpen)}><span className="code-mark">{`{ }`}</span>Parameters{Object.keys(document.parameters).length > 0 && <span className="count-badge">{Object.keys(document.parameters).length}</span>}</button>
        <button className="button quiet" onClick={() => void save().then(onLibrary).catch(reason => setSaveError(errorMessage(reason)))} title="Save query to library"><Icon name="book"/>Save</button>
        <button className="button project-action" onClick={onUseQuery} title="Choose open or saved queries for a Python project, app, or query pack; also export this query as M or DAX Studio files"><Icon name="code"/>Use queries{stateRef.current?.projectProposal?.documentId === document.id && <span className="proposal-dot" title="Copilot suggested a query destination"/>}</button>
        <button className="button quiet" onClick={onShare} title="Download queries and reviewed context as a portable ZIP"><Icon name="share"/>Share</button>
      </div>
      <div className="editor-revision"><span className={`status-dot ${dirty ? "unsaved" : ""}`}/>{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}<span className="revision-tag">rev {document.revision}</span></div>
    </div>
    {saveError && <div className="inline-alert error" role="alert"><Icon name="warning"/><span>{saveError} Your draft is still in the editor.</span><button className="text-button" onClick={() => {
      const current = stateRef.current?.documents.find(item => item.id === document.id);
      if (current) { draft.current.revision = current.revision; setSaveError(""); }
    }}>Keep draft on latest revision</button></div>}
    {proposal && <div className="proposal-bar"><Icon name="code"/><span><strong>Copilot proposed a query change</strong> · based on rev {proposal.baseRevision}{stale ? " · current query has changed" : ""}</span><button className="button small" onClick={() => setReview(!review)} aria-expanded={review}>{review ? "Back to editor" : "Review diff"}</button></div>}
    {proposal && review ? <div className="proposal-review">
      <div className="proposal-rationale">{proposal.rationale || "Review the complete change before accepting."}</div>
      <ProposalDiff original={query} proposal={proposal}/>
      <div className="proposal-actions"><span>{stale ? "This proposal is stale. Ask for a new proposal based on the current revision." : "Accept replaces the query, never runs it."}</span><button className="button" onClick={() => void action("proposal.reject", { documentId: document.id, proposalId: proposal.id }).then(() => setReview(false)).catch(() => {})}>Reject</button><button className="button primary" disabled={stale} onClick={() => void action("proposal.accept", { documentId: document.id, proposalId: proposal.id }).then(() => setReview(false)).catch(() => {})}><Icon name="check"/>Accept change</button></div>
    </div> : <div className="editor-body">
      <DaxEditor value={query} onChange={edit} objects={objects} onRun={run} onSave={() => void save().catch(reason => setSaveError(errorMessage(reason)))} insert={insert} onInserted={onInserted} onSelectionChange={value => { selection.current = value; }} commands={editorCommands}/>
      {parametersOpen && <div className="parameters-pane">
        <div className="panel-section-heading"><strong>Parameters</strong><button className="icon-button" onClick={() => setParametersOpen(false)} aria-label="Close parameters"><Icon name="close" size={14}/></button></div>
        <label className="sr-only" htmlFor="parameter-json">Parameter values as a JSON object</label>
        <textarea id="parameter-json" spellCheck={false} value={parameters} onChange={event => editParameters(event.target.value)} aria-invalid={Boolean(parameterError)} aria-describedby="parameter-help" placeholder={'{\n  "Year": 2026\n}'}/>
        <p id="parameter-help" className={parameterError ? "field-error" : "muted"}>{parameterError || (document.parameterDefinitions ? "Imported pack parameters: primitive arrays are supported; the backend validates template types. Quote exact numeric values." : rest || windowsProvider ? `${rest ? "Power BI REST" : "Windows MSOLAP"} does not support native @Name bindings in this release. Leave this object empty or use a typed query-pack template.` : "Native @Name bindings are scalar. Arrays are for imported pack list parameters only; the backend validates semantics. Quote exact numeric values.")}</p>
      </div>}
    </div>}
    <div className="editor-footer"><span>DAX{/\bDemo Sales\b/.test(query) && <span className="synthetic-label">Synthetic example query</span>}</span><span>{query.split("\n").length} lines · UTF-8 · Read queries only</span></div>
  </section>;
}
