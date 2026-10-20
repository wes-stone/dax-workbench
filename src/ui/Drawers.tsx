import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Limits, ModelObject, SafeContext, Snapshot } from "../contracts/workbench";
import type { Action } from "./useWorkbench";
import { api, downloadBlob, errorMessage } from "./api";
import { Icon } from "./icons";
import { connectionKindLabel, displayCell } from "./model";
import { MAX_LIMITS } from "../contracts/limits.mjs";
import { ResultNameSetting } from "./ResultNameSetting";
import { QueryLibrary } from "./QueryLibrary";
import { LibrarySession } from "./library-cache";
import { ModelNotes } from "./ModelNotes";
import { AppearanceSetting } from "./AppearanceSetting";
import { UseQuery } from "./UseQuery";
import { ShareQueries } from "./ShareQueries";
import { ModelInspector } from "./ModelInspector";

export type DrawerName = "context" | "settings" | "library" | "object" | "capabilities" | "use-query" | "share" | null;
export const isAuthoringDrawer = (name: DrawerName) => name === "library" || name === "use-query" || name === "share";
export interface DrawerCommands { close: (afterClose?: () => void) => void }

export function Drawer({ name, onClose, state, action, object, onInspect, onBuilder, onPreview, previewDisabled, librarySaveRequest = 0, connected, onArtifacts, onLibraryEditChange, commands, onProjectSaved }: {
  name: DrawerName; onClose: () => void; state: Snapshot; action: Action;
  object: ModelObject | null; librarySaveRequest?: number; connected: boolean;
  onInspect: (object: ModelObject) => void; onBuilder: (object: ModelObject, target: "field" | "filter") => void;
  onPreview: (object: ModelObject) => void; previewDisabled: boolean;
  onArtifacts?: (id: string) => void;
  onLibraryEditChange?: (editing: boolean) => void;
  commands: React.RefObject<DrawerCommands | null>;
  onProjectSaved: (id: string) => void;
}) {
  const [librarySession] = useState(() => new LibrarySession());
  const panel = useRef<HTMLElement>(null);
  const [libraryDirty, setLibraryDirty] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  useEffect(() => {
    onLibraryEditChange?.(isAuthoringDrawer(name) && (libraryDirty || libraryBusy));
    return () => onLibraryEditChange?.(false);
  }, [name, libraryDirty, libraryBusy, onLibraryEditChange]);
  const [libraryExpanded, setLibraryExpanded] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [confirmClose, setConfirmClose] = useState<{ afterClose?: () => void } | null>(null);
  const [navigationError, setNavigationError] = useState("");
  const discardPrompt = useRef<HTMLDivElement>(null);
  const initialSharedAnalysis = useRef(state.sharedAnalysisId);
  const [analysisResetError, setAnalysisResetError] = useState("");
  useEffect(() => {
    if (!initialSharedAnalysis.current) return;
    initialSharedAnalysis.current = null;
    void action("library.analysis.clear", {}).catch(reason => setAnalysisResetError(errorMessage(reason)));
  }, [action]);
  const libraryDirtyChanged = useCallback((dirty: boolean) => setLibraryDirty(dirty), []);
  const libraryBusyChanged = useCallback((busy: boolean) => setLibraryBusy(busy), []);
  const close = useCallback((afterClose?: () => void) => {
    setNavigationError("");
    if (isAuthoringDrawer(name) && libraryBusy) {
      setNavigationError("This panel is saving or preparing files. Wait for it to finish, then choose your destination again.");
      return;
    }
    if (isAuthoringDrawer(name) && libraryDirty) setConfirmClose({ afterClose });
    else { setConfirmClose(null); onClose(); afterClose?.(); }
  }, [name, libraryBusy, libraryDirty, onClose]);
  useLayoutEffect(() => { commands.current = { close }; return () => { commands.current = null; }; }, [commands, close]);
  useEffect(() => { if (confirmClose) discardPrompt.current?.focus(); }, [confirmClose]);
  useEffect(() => {
    setPreviewExpanded(false);
    if (!name) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => previous?.focus();
  }, [name]);
  if (!name) return null;
  const titles: Record<Exclude<DrawerName, null>, string> = { context: "Context Lens", settings: "Workbench settings", library: "Query library", object: "Object details", capabilities: "Capabilities", "use-query": "Use queries", share: "Share queries" };
  return <>
    <button className={`drawer-backdrop ${name === "library" ? "library-backdrop" : ""}`} onClick={() => close()} tabIndex={-1} aria-label="Close inspector"/>
    <aside className={`inspector ${name === "library" ? `library-inspector ${libraryExpanded || previewExpanded ? "is-expanded" : ""}` : name === "use-query" ? "use-query-inspector" : name === "share" ? "share-inspector" : ""}`} role={isAuthoringDrawer(name) ? "dialog" : undefined} ref={panel} tabIndex={-1} aria-label={titles[name]} onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (confirmClose) setConfirmClose(null);
        else if (name === "library" && previewExpanded) {
          setPreviewExpanded(false);
          panel.current?.querySelector<HTMLButtonElement>(".library-expand-preview")?.focus({ preventScroll: true });
        } else if (name === "library" && libraryExpanded) setLibraryExpanded(false);
        else close();
      }
      if (isAuthoringDrawer(name) && (event.key === "F5" || (event.ctrlKey || event.metaKey) && event.key === "Enter")) { event.preventDefault(); event.stopPropagation(); }
      if ((name === "use-query" || name === "share") && event.key === "Tab") {
        const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0 && !element.closest("details:not([open]) > :not(summary)"));
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="inspector-title"><h2>{titles[name]}</h2><div className="inspector-title-actions">
        {name === "library" && <button className="button quiet small" aria-label={libraryExpanded || previewExpanded ? "Restore library size" : "Expand library"} aria-expanded={libraryExpanded || previewExpanded}
          title={libraryExpanded || previewExpanded ? "Restore library size" : "Use the full workbench width"} onClick={() => {
            if (libraryExpanded || previewExpanded) { setLibraryExpanded(false); setPreviewExpanded(false); }
            else setLibraryExpanded(true);
          }}><Icon name={libraryExpanded || previewExpanded ? "restore" : "expand"} size={14}/><span>{libraryExpanded || previewExpanded ? "Restore" : "Expand"}</span></button>}
        <button className="icon-button" onClick={() => close()} disabled={isAuthoringDrawer(name) && libraryBusy} aria-label={`Close ${titles[name]}`}><Icon name="close"/></button>
      </div></div>
      {analysisResetError && <p className="field-error" role="alert">Could not clear the previous analysis share: {analysisResetError}</p>}
      {navigationError && <p className="field-error" role="alert">{navigationError}</p>}
      {isAuthoringDrawer(name) && confirmClose && <div ref={discardPrompt} tabIndex={-1} className="library-discard" role="alert"><p>Discard unsaved {name === "library" ? "library" : name === "share" ? "sharing" : "project preparation"} details? Your query draft will stay in its tab.</p><div className="button-row"><button className="button small" onClick={() => { const afterClose = confirmClose.afterClose; setConfirmClose(null); setLibraryDirty(false); onClose(); afterClose?.(); }}>Discard details</button><button className="button small primary" onClick={() => setConfirmClose(null)}>Keep editing</button></div></div>}
      <div className="inspector-scroll">
        {name === "use-query" && <UseQuery state={state} action={action} onDirtyChange={libraryDirtyChanged} onBusyChange={libraryBusyChanged} onSaved={onProjectSaved}/>}
        {name === "share" && <ShareQueries state={state} action={action} connected={connected} onDirtyChange={libraryDirtyChanged} onBusyChange={libraryBusyChanged}/>}
        {name === "context" && <ContextPanel state={state} action={action} session={librarySession} connected={connected}/>}
        {name === "settings" && <SettingsPanel state={state} action={action}/>}
        {name === "capabilities" && <Capabilities state={state} action={action}/>}
        {name === "object" && object && state.schema && <><ModelInspector key={`${state.schema.connectionId}:${object.id}`} object={object} schema={state.schema} state={state} action={action} onInspect={onInspect} onBuilder={onBuilder} onPreview={onPreview} previewDisabled={previewDisabled}/>
          {state.libraryIdentity && <ModelNotes identity={state.libraryIdentity} session={librarySession} field={object}/>}</>}
        {name === "object" && !object && <p className="field-help">This object is no longer in the active model metadata. Choose a field in Model explorer.</p>}
        {name === "library" && <QueryLibrary state={state} action={action} saveRequest={librarySaveRequest} session={librarySession} connected={connected}
          previewExpanded={previewExpanded} onPreviewExpandedChange={setPreviewExpanded}
          onDirtyChange={libraryDirtyChanged} onBusyChange={libraryBusyChanged} onOpen={onClose} onArtifacts={onArtifacts} files={<LocalFilesPanel state={state} action={action}/>}/>}
      </div>
    </aside>
  </>;
}

function ContextPanel({ state, action, session, connected }: { state: Snapshot; action: Action; session: LibrarySession; connected: boolean }) {
  const [context, setContext] = useState<SafeContext | null>(null);
  const [error, setError] = useState("");
  const [contextError, setContextError] = useState("");
  const [showJson, setShowJson] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [clearingAnalysis, setClearingAnalysis] = useState(false);
  const [updatingPermission, setUpdatingPermission] = useState<"queries" | "results" | null>(null);
  const [permissionError, setPermissionError] = useState("");
  const [handoff, setHandoff] = useState("");
  const active = state.documents.find(document => document.id === state.activeDocumentId);
  const connection = state.connections.find(item => item.id === active?.connectionId);
  const [contextDirectory, setContextDirectory] = useState("");
  const contextConnection = connection?.name ?? "";
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState("");
  const resultsEnabled = state.agentResultsEnabled === true;
  const resultReads = (state.agentResultReads ?? []).slice(-20).reverse();
  async function updatePermission(permission: "queries" | "results", enabled: boolean) {
    setUpdatingPermission(permission); setPermissionError("");
    try { await action(permission === "queries" ? "agent.enable" : "agent.results.enable", { enabled }); }
    catch (reason) { setPermissionError(`Could not save ${permission === "queries" ? "query" : "result analysis"} access. Your previous choice is unchanged. Try again. ${errorMessage(reason)}`); }
    finally { setUpdatingPermission(null); }
  }
  useEffect(() => {
    let current = true;
    void api.context().then(value => { if (current) { setContext(value); setContextError(""); } }).catch(reason => { if (current) setContextError(errorMessage(reason)); });
    return () => { current = false; };
  }, [state.version]);
  return <>
    <div className="privacy-banner"><Icon name="lens" size={20}/><div><strong>{resultsEnabled ? "Copilot can analyze result pages" : "Result analysis is off"}</strong><p>{resultsEnabled ? "Copilot can request bounded result pages when needed for analysis. You do not need to select cells first. Result rows are never attached automatically." : "Only cells you manually add to Context Lens are shared. Copilot cannot request result pages while result analysis is off."}</p><p>The editor, saved builder selections (including literal filters), and selected schema metadata are visible. Parameter bindings are not included in this context.</p></div></div>
    <section className="drawer-section copilot-access"><h3>Copilot access</h3>
      <label className="toggle-row"><span><strong id="copilot-query-label">Allow Copilot to run queries</strong><small id="copilot-query-help">Remembered for this workbench. Query access and result analysis are separate choices.</small></span><input type="checkbox" role="switch" aria-labelledby="copilot-query-label" aria-describedby="copilot-query-help" checked={state.agentReadEnabled} disabled={Boolean(updatingPermission) || !connected} onChange={event => void updatePermission("queries", event.target.checked)}/></label>
      <p className="field-help">Read-only queries use the configured time, row, and size limits. Opening a tab never runs a query. Turning this off blocks future Copilot runs, not a query already running. Model changes and administrative actions remain blocked.</p>
      <label className="toggle-row"><span><strong id="copilot-results-label">Allow Copilot to analyze results</strong><small id="copilot-results-help">Shares requested result pages with Copilot. Your choice is remembered across tabs, connections, and refreshes.</small></span><input type="checkbox" role="switch" aria-labelledby="copilot-results-label" aria-describedby="copilot-results-help" checked={resultsEnabled} disabled={Boolean(updatingPermission) || !connected} onChange={event => void updatePermission("results", event.target.checked)}/></label>
      <p className="field-help">Each request shares at most 200 rows and 64 KiB from an eligible completed run for the active query and model. Older cached results may need a rerun. Turning this off blocks new reads and pending replies, but cannot recall data Copilot already received. You can still select cells and use Add to Context.</p>
      {updatingPermission && <p className="field-help" role="status">Saving {updatingPermission === "queries" ? "query" : "result analysis"} access…</p>}
      {permissionError && <p className="field-error" role="alert">{permissionError}</p>}
    </section>
    {(error || contextError) && <p className="field-error" role="alert">{error || contextError}</p>}
    <section className="drawer-section agent-result-activity"><h3>Copilot result reads</h3>
      {resultReads.length ? <><p>Last read: {resultReads[0].rowCount.toLocaleString()} rows · <time dateTime={resultReads[0].readAt}>{new Date(resultReads[0].readAt).toLocaleString()}</time></p>
        <details><summary>Recent result reads ({resultReads.length})</summary><ol className="result-read-list">{resultReads.map((read, index) => <li key={`${read.readAt}:${index}`}><strong>{read.rowCount.toLocaleString()} rows · offset {read.offset.toLocaleString()}</strong><time dateTime={read.readAt}>{new Date(read.readAt).toLocaleString()}</time><span>Run: {read.runId}</span><span>Result set: {read.resultSetId}</span></li>)}</ol></details>
      </> : <p className="muted">No result pages read by Copilot in this session.</p>}
      <p className="field-help">Shows the last 20 on-demand reads in this controller session, not their values. This activity is separate from cells you manually share below.</p>
    </section>
    <section className="drawer-section"><div className="section-heading"><h3>Manually shared cells</h3><span className="count-badge">{state.selections.length}</span></div>
      {state.selections.length ? <><div className="shared-values">{state.selections.map((cell, index) => <div key={`${cell.runId}:${cell.resultSetId}:${cell.row}:${cell.columnId}:${index}`}><span>Row {cell.row + 1} · {cell.columnId}</span><code title={displayCell(cell.value)}>{displayCell(cell.value)}</code></div>)}</div><button className="button small" onClick={() => void action("selection.set", { cells: [] }).catch(reason => setError(errorMessage(reason)))}>Clear shared cells</button></> : <p className="muted">No cells manually shared. Select cells in the grid, then choose Add to Context. Copy never shares them.</p>}
    </section>
    <section className="drawer-section"><h3>Shared Copilot analysis</h3>
      {state.sharedAnalysisId ? <><p role="status">One saved analysis is shared with Copilot.</p><p className="field-help">Only the selected analysis text and safe run evidence are included, not its saved parameter bindings or result rows. Sharing clears on reload, query-tab or model changes, a saved-entry edit, or a query revision change. {context?.sharedAnalysis && context.sharedAnalysis.entryId === state.sharedAnalysisId && (context.sharedAnalysis.matchesActiveQuery ? "Matches the active query and bindings; this is not a correctness check." : "Historical note: does not match the active query and bindings.")}</p>
        <button className="button small" disabled={clearingAnalysis || !connected} onClick={() => {
          setClearingAnalysis(true); setError("");
          void action("library.analysis.clear", {}).catch(reason => setError(errorMessage(reason))).finally(() => setClearingAnalysis(false));
        }}>{clearingAnalysis ? "Stopping sharing…" : "Stop sharing analysis"}</button>
      </> : <p className="muted">No saved analysis shared. Use Share analysis with Copilot in a library preview to include one explicitly.</p>}
    </section>
    <section className="drawer-section"><h3>Selected schema</h3>{context?.schema.length ? <ul className="plain-list">{context.schema.map(object => <li key={object.id}><Icon name={object.kind === "table" ? "table" : object.kind === "measure" ? "measure" : "column"} size={13}/><span>{object.table ? `${object.table} · ` : ""}{object.name}</span></li>)}</ul> : <p className="muted">Use the lens icon beside a model object to include its metadata.</p>}</section>
    {context?.builder && <section className="drawer-section"><h3>Saved query builder</h3><p>{context.builder.definition.fields.length} output fields · {context.builder.definition.filters.length} filters · {context.builder.definition.orderBy.length} sort fields · revision {context.builder.builderRevision}</p><p className="field-help">Copilot can propose changes for you to review. Accepting selections never runs DAX or replaces the editor. Inspect the exact definition in the outgoing payload below.</p></section>}
    {context?.knowledge && <section className="drawer-section"><h3>Model knowledge available to Copilot</h3>
      <p className="field-help">Only bundled guidance and starters are discoverable. Private My queries and their notes are not automatically published; analysis is included only when explicitly shared.</p>
      {context.knowledge.entries.length ? <details onToggle={event => setShowKnowledge(event.currentTarget.open)}><summary>Inspect bundled model notes</summary>
        {showKnowledge && <ModelNotes identity={context.knowledge.identity} session={session}/>}</details> : <p className="field-help">No bundled knowledge for this model.</p>}
    </section>}
    <section className="drawer-section"><h3>Import MCP model context</h3><form onSubmit={event => {
      event.preventDefault(); setImporting(true); setImportNotice("");
      void action<{ matched?: number | unknown[]; unmatched?: number | unknown[]; warnings?: string[] }>("context.import", { directory: contextDirectory.trim(), connectionName: contextConnection }).then(result => {
        const count = (value: number | unknown[] | undefined) => Array.isArray(value) ? value.length : value;
        const matched = count(result?.matched), unmatched = count(result?.unmatched);
        setImportNotice(`${matched === undefined ? "Model context processed." : `${matched} native objects matched${unmatched === undefined ? "." : `; ${unmatched} unmatched entries.`}`} Native metadata remains authoritative.${result?.warnings?.length ? ` ${result.warnings.join(" ")}` : ""}`);
      }).catch(reason => setImportNotice(errorMessage(reason))).finally(() => setImporting(false));
    }}><label className="field-label">Context bundle directory<input value={contextDirectory} onChange={event => setContextDirectory(event.target.value)} placeholder={"C:\\Data\\model-context"} required spellCheck={false}/></label><label className="field-label">Active connection name<input value={contextConnection} readOnly placeholder="Select a connection first" required/></label><button className="button small" disabled={importing || !connection || !contextDirectory.trim() || !contextConnection}>{importing ? "Importing context…" : "Import model context"}</button><p className="field-help">The bundle must match the exact active connection. The backend imports names and types only, matched against native metadata. Freeform descriptions and result values are not included.</p>{importNotice && <p className="operation-notice" role="status">{importNotice}</p>}</form></section>
    <section className="drawer-section"><h3>Exact outgoing context</h3><p className="field-help">Inspect the context exposed to Copilot. It contains no automatic result rows. On-demand result pages are separate tool replies, not part of this payload.</p><button className="button small" onClick={() => setShowJson(!showJson)} aria-expanded={showJson}>{showJson ? "Hide payload" : "Inspect payload"}</button>{showJson && <pre className="json-preview">{context ? JSON.stringify(context, null, 2) : "Loading safe context…"}</pre>}</section>
    <section className="drawer-section"><h3>Ask Copilot</h3><form onSubmit={event => {
      event.preventDefault(); setSending(true); setHandoff("");
      void action<{ available?: boolean; sent?: boolean; supported?: boolean; message?: string }>("copilot.ask", { prompt: prompt.trim() }).then(result => {
        if (result?.available === false || result?.sent === false || result?.supported === false) {
          setHandoff(result.message ?? "Copilot handoff is unavailable in this runtime. Open this workbench in the Copilot canvas to send your question.");
          return;
        }
        setPrompt(""); setHandoff(result?.message ?? "Sent to the current Copilot conversation with the safe Context Lens payload.");
      }).catch(reason => setHandoff(errorMessage(reason))).finally(() => setSending(false));
    }}><label className="field-label">Question about this query<textarea rows={3} value={prompt} maxLength={8000} onChange={event => setPrompt(event.target.value)} placeholder="Suggest a clearer way to write this query…" required/></label><button className="button" type="submit" disabled={sending || !prompt.trim()}><Icon name="lens" size={14}/>{sending ? "Sending…" : "Ask in Copilot"}</button><p className="field-help">Continues in your existing conversation with the context shown above. No result pages are attached automatically.{resultsEnabled ? " Copilot can request pages separately while result analysis is on." : " Use Add to Context to share selected cells."}</p>{handoff && <p className="operation-notice" role="status">{handoff}</p>}</form></section>
  </>;
}

export function ConnectionForm({ state, action, mode, onSaved, onDirtyChange }: {
  state: Snapshot; action: Action; mode: "browse" | "add" | "import";
  onSaved: (id?: string) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("msolap");
  const [workspaceId, setWorkspaceId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [connectionString, setConnectionString] = useState("");
  const [directory, setDirectory] = useState("");
  const [bundleName, setBundleName] = useState("");
  const [bundleKind, setBundleKind] = useState("msolap");
  const [authMode, setAuthMode] = useState("connection-string");
  const [bundleAuthMode, setBundleAuthMode] = useState("connection-string");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState(false);
  const dirty = Boolean(name || workspaceId || datasetId || tenantId || connectionString || directory || bundleName || busy);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  function reset() { setName(""); setWorkspaceId(""); setDatasetId(""); setTenantId(""); setConnectionString(""); setDirectory(""); setBundleName(""); setNotice(""); }
  const rest = kind === "powerbi-rest";
  const windowsProvider = kind === "windows-msolap";
  const guidPattern = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
  async function perform(label: string, command: string, payload: object) {
    setBusy(label); setNotice(""); setFailure(false);
    try {
      const result = await action<Snapshot>(command, payload);
      reset();
      onSaved(result.connections?.find(item => !state.connections.some(old => old.id === item.id))?.id);
    }
    catch (reason) { setFailure(true); setNotice(errorMessage(reason)); }
    finally { setBusy(""); }
  }
  return <>
    <p className="drawer-intro">Configured DAX MCP profiles already appear in the list. Add only a new profile; credentials are saved in the protected native registry, not browser storage or Copilot context.</p>
    <section className="drawer-section" hidden={mode !== "add"}><h3>Add a connection</h3><form onSubmit={event => {
      event.preventDefault();
      void perform("Connection saved", "connection.add", rest
        ? { kind, name: name.trim(), workspaceId: workspaceId.trim(), datasetId: datasetId.trim(), ...(tenantId.trim() ? { tenantId: tenantId.trim() } : {}), authMode: "azure-cli" }
        : { name: name.trim(), connectionString, ...(windowsProvider ? { kind, authMode: "connection-string" } : { authMode }) });
    }}>
      <label className="field-label">Query transport<select value={kind} onChange={event => setKind(event.target.value)} disabled={Boolean(busy)}><option value="msolap">XMLA / Analysis Services</option><option value="windows-msolap">Windows MSOLAP / OLE DB</option><option value="powerbi-rest">Power BI REST (limited queries)</option></select></label>
      <label className="field-label">Display name<input value={name} onChange={event => setName(event.target.value)} required maxLength={120} placeholder="Finance semantic model" autoComplete="off"/></label>
      {rest ? <>
        <label className="field-label">Workspace ID<input value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} required pattern={guidPattern} maxLength={36} title="Workspace GUID from the Power BI service URL" autoComplete="off" spellCheck={false}/></label>
        <label className="field-label">Semantic model ID<input value={datasetId} onChange={event => setDatasetId(event.target.value)} required pattern={guidPattern} maxLength={36} title="Semantic model (dataset) GUID from Power BI" autoComplete="off" spellCheck={false}/></label>
        <label className="field-label">Tenant ID (optional)<input value={tenantId} onChange={event => setTenantId(event.target.value)} pattern={guidPattern} maxLength={36} title="Tenant GUID, or leave blank for the Azure CLI default tenant" autoComplete="off" spellCheck={false}/></label>
        <p className="field-help">Authentication: current signed-in Azure CLI account. Uses the public Power BI Execute Queries API, never XMLA or a fallback. Requires model Read/Build access and the tenant's Execute Queries setting.</p>
        <p className="field-help">One EVALUATE / result table, no native @parameters or schema discovery. Types are inferred from JSON, not model metadata. Service limits: 100,000 rows, 1 million values, 15 MB. Cancel stops the local wait; server execution may continue.</p>
      </> : <>
      <label className="field-label">Connection string<input type="password" value={connectionString} onChange={event => setConnectionString(event.target.value)} required placeholder="Data Source=…;Initial Catalog=…" autoComplete="new-password" spellCheck={false}/></label>
      {windowsProvider ? <p className="field-help">Uses the installed Windows MSOLAP provider through a separate .NET Framework companion, matching the native provider used by DAX MCP. Results stay in this workbench; no MCP data tools are called. Native @parameters are not supported in this release.</p> : <label className="field-label">Authentication<select value={authMode} onChange={event => setAuthMode(event.target.value)}><option value="connection-string">Connection string / integrated identity</option><option value="azure-cli">Azure CLI (current signed-in account)</option></select></label>}
      <p className="field-help">Use a trusted Analysis Services or XMLA endpoint. Prefer integrated or interactive identity over embedded passwords.</p>
      </>}
      <button className="button primary" type="submit" disabled={Boolean(busy) || !name.trim() || (rest ? !workspaceId.trim() || !datasetId.trim() : !connectionString.trim()) || !state.native.available}>{busy === "Connection saved" ? "Saving…" : "Save connection"}</button>
    </form></section>
    <section className="drawer-section" hidden={mode !== "import"}><h3>Import connection bundle</h3><form onSubmit={event => { event.preventDefault(); void perform("Import", "connections.import", { directory: directory.trim(), connectionName: bundleName.trim(), ...(bundleKind === "windows-msolap" ? { kind: bundleKind, authMode: "connection-string" } : { authMode: bundleAuthMode }) }); }}><label className="field-label">Local bundle directory<input value={directory} onChange={event => setDirectory(event.target.value)} placeholder={"C:\\Data\\connections"} required spellCheck={false}/></label><label className="field-label">Connection name (optional)<input value={bundleName} onChange={event => setBundleName(event.target.value)} maxLength={200} placeholder="my_connection" spellCheck={false}/></label><label className="field-label">Bundle native provider<select value={bundleKind} onChange={event => setBundleKind(event.target.value)}><option value="msolap">XMLA / ADOMD</option><option value="windows-msolap">Windows MSOLAP / OLE DB</option></select></label>{bundleKind === "windows-msolap" ? <p className="field-help">Uses the installed Windows provider and its existing identity. This is an explicit provider choice, not an automatic authentication fallback.</p> : <label className="field-label">Bundle authentication<select value={bundleAuthMode} onChange={event => setBundleAuthMode(event.target.value)}><option value="connection-string">Connection string / integrated identity</option><option value="azure-cli">Azure CLI (current signed-in account)</option></select></label>}<p className="field-help">Use a filename without .yaml or .yml to import only that connection. Leave blank to import all connection bundles; data-dictionary sidecars are excluded. Credentials remain in the native registry.</p><button className="button primary" disabled={Boolean(busy) || !directory.trim() || !state.native.available}>Import bundle</button></form></section>
    <p className="field-help">Azure CLI is opt-in for public-cloud Power BI and Azure Analysis Services only. Sign in with az login yourself if needed. Tokens stay in the native worker; the workbench never starts a login, changes accounts, or saves tokens.</p>
    {!state.native.available && <div className="inline-alert warning"><Icon name="warning"/><span>{state.native.message} Start or repair the native companion to add live connections.</span></div>}
    {dirty && <button className="button quiet" disabled={Boolean(busy)} onClick={reset}>Discard connection draft</button>}
    {notice && <p className={failure ? "field-error" : "operation-notice"} role={failure ? "alert" : "status"}>{notice}</p>}
  </>;
}

function SettingsPanel({ state, action }: { state: Snapshot; action: Action }) {
  const [limits, setLimits] = useState<Limits>(state.limits);
  const [saved, setSaved] = useState("");
  const [density, setDensity] = useState(document.documentElement.dataset.density ?? "comfortable");
  return <>
    <section className="drawer-section"><h3>Appearance</h3>
      <AppearanceSetting appearance={state.appearance} action={action}/>
      <label className="field-label">Control density<select value={density} onChange={event => { setDensity(event.target.value); document.documentElement.dataset.density = event.target.value; }}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><p className="field-help">Density applies to this panel only.</p>
    </section>
    <p className="drawer-intro">Limits bound the returned preview, not the engine’s compute cost. Changes apply to future runs.</p>
    <form onSubmit={event => { event.preventDefault(); void action("settings.update", { limits }).then(() => setSaved("Defaults saved.")).catch(reason => setSaved(errorMessage(reason))); }}>
      <section className="drawer-section"><h3>Query limits</h3>
        <label className="field-label">Timeout · seconds<input type="number" min={1} max={MAX_LIMITS.timeoutSeconds} step={1} required value={limits.timeoutSeconds} onChange={event => setLimits({ ...limits, timeoutSeconds: Number(event.target.value) })}/></label>
        <label className="field-label">Maximum preview rows<input type="number" min={1} max={MAX_LIMITS.maxRows} step={1} required value={limits.maxRows} onChange={event => setLimits({ ...limits, maxRows: Number(event.target.value) })}/></label>
        <label className="field-label">Maximum preview size · MiB<input type="number" min={1} max={MAX_LIMITS.maxBytes / 1048576} step={1} required value={limits.maxBytes / 1048576} onChange={event => setLimits({ ...limits, maxBytes: Number(event.target.value) * 1048576 })}/></label>
        <p className="field-help">Defaults: 120 seconds, 50,000 rows, 50 MiB. The backend enforces policy ceilings and one active query per connection.</p>
        <button type="submit" className="button primary">Save defaults</button>{saved && <p className="operation-notice" role="status">{saved}</p>}
      </section>
    </form>
    <section className="drawer-section"><h3>Result table and exports</h3><ResultNameSetting showFullColumnNames={state.resultSettings?.showFullColumnNames ?? false} action={action}/><p className="field-help">Short headers such as Fiscal Month are the default in the table and Excel/CSV exports. Enable full names to show Calendar[Fiscal Month]. Original names remain in header tooltips, Excel details and raw JSON; query text and cell identity never change.</p></section>
    <section className="drawer-section"><h3>Keyboard shortcuts</h3><dl className="shortcut-list"><dt>Run query</dt><dd><kbd>Ctrl</kbd> <kbd>Enter</kbd> / <kbd>F5</kbd></dd><dt>Save draft</dt><dd><kbd>Ctrl</kbd> <kbd>S</kbd></dd><dt>New document</dt><dd><kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>N</kbd></dd><dt>Context Lens</dt><dd><kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>C</kbd></dd><dt>Close inspector / cancel run</dt><dd><kbd>Esc</kbd></dd><dt>Resize split</dt><dd>Focus divider, use arrow keys</dd></dl></section>
  </>;
}

function Capabilities({ state, action }: { state: Snapshot; action: Action }) {
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  async function check(reconnect: boolean) {
    setChecking(true); setNotice("");
    try {
      const result = await action<{ message: string }>(reconnect ? "integration.reconnect" : "integration.check");
      setNotice(result.message);
    } catch (reason) { setNotice(errorMessage(reason)); }
    finally { setChecking(false); }
  }
  const active = state.documents.find(document => document.id === state.activeDocumentId);
  const connection = state.connections.find(item => item.id === active?.connectionId);
  const capabilities = connection?.capabilities ?? {};
  return <>
    <p className="drawer-intro">Capabilities describe this connection and runtime. Missing native diagnostics are not reported as successful query profiling.</p>
    <div className="capability-row"><span>Native companion</span><strong className={state.native.available ? "success-text" : "warning-text"}>{state.native.available ? "Available" : "Unavailable"}</strong><p>{state.native.message}{state.native.version ? ` · ${state.native.version}` : ""}</p></div>
    <div className="capability-row"><span>DAX MCP integration</span><strong className={state.integration.available ? "success-text" : "warning-text"}>{state.integration.available ? "Available" : "Unavailable"}</strong><p>{state.integration.message}</p></div>
    <div className="toolbar-group"><button className="button small" disabled={checking} onClick={() => void check(false)}>Check DAX MCP</button><button className="button small" disabled={checking} onClick={() => void check(true)}>Reconnect DAX MCP</button></div>
    <p className="field-help">Reconnect restarts only an unhealthy configured DAX MCP server in this session. Unsaved MCP workstation entries may be lost; workbench drafts and results are preserved. No model query is executed.</p>
    {notice && <p className="operation-notice" role="status">{notice}</p>}
    {Object.entries(capabilities).map(([name, capability]) => <div className="capability-row" key={name}><span>{name.replace(/[_-]/g, " ")}</span><strong className={capability.status === "supported" ? "success-text" : "muted"}>{capability.status}</strong><p>{capability.reason}</p></div>)}
    {!Object.keys(capabilities).length && <p className="muted">Select a connection to inspect native capability metadata.</p>}
    <section className="drawer-section"><h3>Not included in this release</h3><p className="muted">Server Timings, query plans, trace sessions, cache clearing, VPAX, and Model Analyzer are not implemented. Grid durations are client-observed elapsed time, not Formula Engine or Storage Engine timings.</p><p className="muted">Use DAX Studio for these diagnostics. Model writes are outside this workbench’s read-query scope.</p></section>
  </>;
}

interface LibraryEntry { name?: string; title?: string; path?: string; description?: string }
function LocalFilesPanel({ state, action }: { state: Snapshot; action: Action }) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [path, setPath] = useState("");
  const [directory, setDirectory] = useState("");
  const active = state.documents.find(document => document.id === state.activeDocumentId);
  const [name, setName] = useState(active?.title ?? "query");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const result = await action<unknown>("library.list", directory.trim() ? { directory: directory.trim() } : {});
      const list = Array.isArray(result) ? result : (result as { entries?: unknown[]; queries?: unknown[] })?.entries ?? (result as { queries?: unknown[] })?.queries ?? [];
      setEntries(list.map(entry => typeof entry === "string" ? { name: entry.split(/[\\/]/).pop(), path: entry } : entry as LibraryEntry));
    } catch (reason) { setNotice(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function perform(command: string, payload: object, message: string) {
    setBusy(true); setNotice("");
    try { await action(command, payload); setNotice(message); }
    catch (reason) { setNotice(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  return <>
    <p className="drawer-intro">Reuse local DAX queries and compatible query packs. File paths are resolved by the backend within permitted library roots.</p>
    <section className="drawer-section"><div className="section-heading"><h3>Saved queries</h3><button className="icon-button" disabled={busy} onClick={() => void load()} aria-label="Refresh query library"><Icon name="refresh" size={14}/></button></div>
      {entries.length ? <div className="library-list">{entries.map((entry, index) => <button key={entry.path ?? index} disabled={!entry.path || busy} onClick={() => void perform("library.open", { path: entry.path }, "Query opened as a document.")}><Icon name="code" size={14}/><span><strong>{entry.name ?? entry.title ?? entry.path}</strong>{entry.description && <small>{entry.description}</small>}</span></button>)}</div> : <p className="muted">{busy ? "Loading library…" : "No local library entries found. Open a query by path or save the active document below."}</p>}
    </section>
    <section className="drawer-section"><h3>Open query or import pack</h3><label className="field-label">Local file path<input value={path} onChange={event => setPath(event.target.value)} placeholder={"C:\\Data\\queries\\sales.dax"} spellCheck={false}/></label><div className="button-row"><button className="button small" disabled={busy || !path.trim()} onClick={() => void perform("library.open", { path }, "Query opened as a document.")}>Open .dax</button><button className="button small" disabled={busy || !path.trim()} onClick={() => void perform("pack.import", { path }, "Query pack imported.")}>Import pack</button></div><p className="field-help">For packs, provide the compatible pack.yaml file or supported pack path.</p></section>
    <section className="drawer-section"><h3>Save active query to a folder</h3><label className="field-label">Library directory<input value={directory} onChange={event => setDirectory(event.target.value)} placeholder={"C:\\Data\\query-library"} spellCheck={false}/></label><label className="field-label">Query name<input value={name} onChange={event => setName(event.target.value)} maxLength={120}/></label><button className="button" disabled={busy || !directory.trim() || !name.trim() || !active} onClick={() => void perform("library.save", { directory, name }, "Query saved to the local folder.")}>Save to folder</button></section>
    <section className="drawer-section"><h3>Download active document</h3><div className="button-row"><button className="button small" disabled={!active} onClick={() => { if (active) downloadBlob(new Blob([active.query], { type: "text/plain;charset=utf-8" }), `${active.title.replace(/[^\w.-]/g, "_") || "query"}.dax`); }}><Icon name="download" size={13}/>.dax</button><button className="button small" disabled={!active} onClick={() => { if (active) downloadBlob(new Blob([JSON.stringify({ title: active.title, query: active.query, parameters: active.parameters, ...(active.parameterDefinitions ? { parameterDefinitions: active.parameterDefinitions } : {}) }, null, 2)], { type: "application/json" }), `${active.title.replace(/[^\w.-]/g, "_") || "query"}.json`); }}><Icon name="download" size={13}/>Query + parameters</button></div><p className="field-help">Downloads contain the saved query and, for JSON, parameter values and imported type definitions. No raw result rows are included.</p></section>
    {notice && <p className="operation-notice" role="status">{notice}</p>}
  </>;
}
