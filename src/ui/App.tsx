import { Children, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelObject, Run } from "../contracts/workbench";
import { useWorkbench, type Action } from "./useWorkbench";
import { DocumentPane, type DocumentCommands } from "./DocumentPane";
import { ModelExplorer, HistoryPanel } from "./Explorer";
import { Drawer, isAuthoringDrawer, type DrawerCommands, type DrawerName } from "./Drawers";
import { ResultsPane } from "./ResultsPane";
import { Icon } from "./icons";
import { connectionKindLabel, RUNNING } from "./model";
import { api, ApiError, errorMessage } from "./api";
import { QueryBuilder, type BuilderCommands } from "./QueryBuilder";
import { setCodeFont, setThemeMode } from "./theme";
import { ArtifactsWorkspace } from "./ArtifactsWorkspace";
import { DashboardWorkspace, type DashboardPinRequest } from "./DashboardWorkspace";
import { ConnectionsWorkspace } from "./ConnectionsWorkspace";

export function App() {
  const { state, latest, fatal, error, setError, connected, action: controllerAction, onAuthoring } = useWorkbench();
  useLayoutEffect(() => { setThemeMode(state?.appearance?.themeMode ?? "system"); }, [state?.appearance?.themeMode]);
  useLayoutEffect(() => { setCodeFont(state?.appearance?.codeFont, state?.appearance?.codeFontSize); }, [state?.appearance?.codeFont, state?.appearance?.codeFontSize]);
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 900);
  const [sideTab, setSideTab] = useState<"model" | "history">("model");
  const [drawer, setDrawer] = useState<DrawerName>(null);
  const drawerCommands = useRef<DrawerCommands | null>(null);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const schemaRefreshPending = useRef(false);
  const [surface, setSurface] = useState<"dashboards" | "queries" | "artifacts" | "connections">("queries");
  const [connectionEditing, setConnectionEditing] = useState(false);
  const [connectionRequest, setConnectionRequest] = useState<{ id: string; sequence: number }>();
  const [dashboardDirty, setDashboardDirty] = useState(false);
  const [dashboardPin, setDashboardPin] = useState<DashboardPinRequest>();
  const clearDashboardPin = useCallback(() => setDashboardPin(undefined), []);
  const [artifactsOpened, setArtifactsOpened] = useState(false);
  const [artifactRequest, setArtifactRequest] = useState<{ id: string; sequence: number }>();
  const [artifactDirty, setArtifactDirty] = useState(false);
  const [visualDraftDirty, setVisualDraftDirty] = useState(false);
  const [libraryEditing, setLibraryEditing] = useState(false);
  const [librarySaveRequest, setLibrarySaveRequest] = useState(0);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [object, setObject] = useState<{ connectionId: string; id: string } | null>(null);
  const [parametersOpen, setParametersOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState("");
  const previewPending = useRef(false);
  const [previewStarting, setPreviewStarting] = useState(false);
  const [insert, setInsert] = useState<{ text: string; sequence: number }>();
  const [split, setSplit] = useState(43);
  const previewLayout = useRef<{ builderOpen: boolean; split: number } | null>(null);
  const [explorerWidth, setExplorerWidth] = useState(242);
  const [builderWidth, setBuilderWidth] = useState(360);
  const [stackedBuilder, setStackedBuilder] = useState(false);
  const [resultsFocused, setResultsFocused] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [renaming, setRenaming] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [closeId, setCloseId] = useState("");
  const [closeError, setCloseError] = useState("");
  const [closing, setClosing] = useState(false);
  const [closingAll, setClosingAll] = useState(false);
  const [tabNotice, setTabNotice] = useState("");
  const closeAllPending = useRef(false);
  const [transitioning, setTransitioning] = useState(false);
  const [authoringId, setAuthoringId] = useState("");
  const authoring = useRef("");
  const initialAuthoringFocus = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const transition = useRef(false);
  const closeDialog = useRef<HTMLDialogElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const queryColumn = useRef<HTMLDivElement>(null);
  const queryWorkarea = useRef<HTMLDivElement>(null);
  const commands = useRef<DocumentCommands | null>(null);
  const builderCommands = useRef<BuilderCommands | null>(null);
  const saveEditor = useCallback(() => commands.current?.save() ?? Promise.resolve(), []);
  const showEditor = useCallback(() => { setResultsFocused(false); requestAnimationFrame(() => commands.current?.focus()); }, []);
  const showParameters = useCallback(() => setParametersOpen(true), []);
  const closeBuilder = useCallback(() => { setBuilderOpen(false); commands.current?.focus(); }, []);
  const showContext = useCallback(() => setDrawer("context"), []);
  const editorSelection = useCallback(() => commands.current?.selection(), []);
  const manualEdit = useCallback(() => builderCommands.current?.editorChanged(), []);
  const action: Action = useCallback(async <T,>(name: string, payload: object = {}) => {
    const changesDocument = ["document.create", "document.select", "document.close", "document.reopen", "connection.select", "run.open", "library.open", "library.entry.open", "pack.import", "dashboards.openQuery", "result.branch"].includes(name);
    if (changesDocument && transition.current) {
      const reason = new Error("A query document is still opening. Wait for it to finish before switching again.");
      setError(reason.message); throw reason;
    }
    const outgoingBuilder = builderCommands.current;
    if (changesDocument) { setResultsFocused(false); transition.current = true; setTransitioning(true); outgoingBuilder?.setAuthoringPaused(true); }
    try {
      if (["document.create", "document.select", "document.reopen", "connection.select", "connection.add", "connections.import", "run.open", "library.open", "library.save", "library.entry.open", "library.entry.save", "pack.import", "builder.generate", "copilot.ask", "dashboards.openQuery", "result.branch"].includes(name)) {
        if (changesDocument) await outgoingBuilder?.prepareNavigation();
        await commands.current?.save();
        await outgoingBuilder?.save();
      }
      return await controllerAction<T>(name, payload);
    } finally {
      if (changesDocument) { outgoingBuilder?.setAuthoringPaused(false); transition.current = false; setTransitioning(false); }
    }
  }, [controllerAction, setError]);
  useLayoutEffect(() => {
    onAuthoring.current = event => {
      if (event.phase === "release" || event.phase === "disconnected") {
        if (authoring.current && (event.phase === "disconnected" || event.requestId === authoring.current)) {
          builderCommands.current?.setAuthoringPaused(false);
          authoring.current = ""; transition.current = false;
          if (root.current) root.current.inert = false;
          setAuthoringId(""); setTransitioning(false);
          if (event.phase === "disconnected") setError("Canvas authoring lost its connection. Local drafts are preserved; reconnect before retrying.");
        }
        return;
      }
      const acknowledge = async (ready: boolean) => {
        try { await api.action("authoring.ack", { requestId: event.requestId, clientId: event.clientId, ready }); }
        catch (reason) {
          // A peer may already have rejected preparation. Keep the operation's useful error.
          if (reason instanceof ApiError && reason.code === "AUTHORING_CONFLICT") return;
          setError(errorMessage(reason));
        }
      };
      if (transition.current || renaming || closeId || artifactDirty || visualDraftDirty || dashboardDirty || libraryEditing || connectionEditing || !commands.current || !builderCommands.current) {
        if (event.phase === "prepare") void acknowledge(false);
        return;
      }
      authoring.current = event.requestId; transition.current = true;
      builderCommands.current.setAuthoringPaused(true);
      if (root.current) root.current.inert = true;
      setAuthoringId(event.requestId); setTransitioning(true);
      if (event.phase === "hold") return;
      void (async () => {
        try {
          await commands.current?.prepareAuthoring();
          await builderCommands.current?.prepareAuthoring();
          await acknowledge(true);
        } catch (reason) { setError(errorMessage(reason)); await acknowledge(false); }
      })();
    };
    return () => { onAuthoring.current = null; };
  }, [onAuthoring, renaming, closeId, artifactDirty, visualDraftDirty, dashboardDirty, libraryEditing, connectionEditing, setError]);
  const active = state?.documents.find(document => document.id === state.activeDocumentId) ?? state?.documents[0];
  const connection = state?.connections.find(connection => connection.id === active?.connectionId);
  const activeRuns = state?.runs.filter(run => run.documentId === active?.id && run.connectionId === active?.connectionId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)) ?? [];
  const schema = state?.schema?.connectionId === active?.connectionId ? state?.schema ?? null : null;
  const schemaRefreshing = state?.schemaLoading === true;
  const schemaUnsupported = connection?.capabilities?.schema?.status === "unsupported";
  const schemaRefreshDisabled = !connection || !connected || !state?.native.available || schemaUnsupported || schemaRefreshing || transitioning;
  const schemaMessage = !connection ? "Choose a model connection to browse fields."
    : schemaUnsupported ? "This is a query-only connection. Model fields require an XMLA or Analysis Services connection."
      : schemaRefreshing ? "Refreshing model fields..."
        : state?.schemaError ? `Model fields are unavailable. ${state.schemaError.message}`
          : !schema ? "Model fields are not loaded. Use Refresh schema to load them." : undefined;
  const selectedRun = state?.runs.find(run => run.id === selectedRunId) ?? activeRuns[0];
  const running = state?.runs.find(run => run.connectionId === active?.connectionId && RUNNING.has(run.status));
  const previewDisabled = !connected || !state?.native.available || !schema || schema.origin === "dictionary"
    || schemaRefreshing || Boolean(running) || previewStarting || transitioning || visualDraftDirty || connection?.kind === "synthetic" || connection?.capabilities?.query?.status === "unsupported";
  const closeDocument = state?.documents.find(document => document.id === closeId);
  const closeAllBlocked = !connected ? "Reconnect before closing query tabs."
    : state?.runs.some(run => state.documents.some(doc => doc.id === run.documentId) && RUNNING.has(run.status))
      ? "Cancel or finish running queries before closing all tabs."
      : artifactDirty || visualDraftDirty || dashboardDirty || libraryEditing ? "Finish the unsaved dashboard, artifact or library edit before closing all tabs."
        : (state?.closedDocuments?.length ?? 0) + (state?.documents.length ?? 0) > 20
          ? "Recoverable tabs are full. Reopen an unwanted tab and use Discard and close to free space." : "";
  const builderSide = state?.layout?.builderSide ?? "right";
  const hasDocument = Boolean(active);
  useLayoutEffect(() => {
    const element = queryWorkarea.current;
    if (!element) return;
    const update = () => setStackedBuilder(element.clientWidth <= 760);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasDocument]);
  async function switchBuilderSide() {
    setSavingLayout(true);
    try { await action("layout.update", { builderSide: builderSide === "right" ? "left" : "right" }); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setSavingLayout(false); }
  }

  function leaveDrawer(next: () => void) {
    if (drawer) drawerCommands.current?.close(next);
    else next();
  }
  function navigate(next: typeof surface) {
    leaveDrawer(() => {
      setDrawer(null); setSurface(next); setSidebar(current => window.innerWidth > 900 && current);
      if (next === "artifacts") setArtifactsOpened(true);
      requestAnimationFrame(() => document.getElementById(`${next}-workspace-tab`)?.focus());
    });
  }
  function openDrawer(next: DrawerName) { leaveDrawer(() => setDrawer(drawer === next ? null : next)); }
  function inspectObject(value: ModelObject) {
    if (!schema) return;
    leaveDrawer(() => {
      setObject({ connectionId: schema.connectionId, id: value.id }); setDrawer("object");
      if (window.innerWidth <= 900) setSidebar(false);
    });
  }
  function inspectToBuilder(value: ModelObject, target: "field" | "filter") {
    setDrawer(null); setBuilderOpen(true);
    if (target === "field") builderCommands.current?.addField(value); else builderCommands.current?.addFilter(value);
  }
  async function previewObject(value: ModelObject) {
    if (previewDisabled || previewPending.current || !active) return;
    previewPending.current = true; setPreviewStarting(true);
    const identity = { documentId: active.id, connectionId: active.connectionId, objectId: value.id };
    try {
      await commands.current?.save();
      await builderCommands.current?.save();
      const current = latest.current?.documents.find(doc => doc.id === identity.documentId);
      if (!current || latest.current?.activeDocumentId !== current.id || current.connectionId !== identity.connectionId)
        throw new Error("The query or model changed. Choose Preview data again.");
      const result = await action<{ runId: string }>("model.preview.start", { ...identity, revision: current.revision });
      if (latest.current?.activeDocumentId !== identity.documentId
        || latest.current?.documents.find(doc => doc.id === identity.documentId)?.connectionId !== identity.connectionId) {
        setTabNotice("Preview started for the previous query. Find it in History; this tab was not changed.");
        return;
      }
      setSelectedRunId(result.runId); setDrawer(null);
      if (window.innerWidth <= 900) {
        previewLayout.current ??= { builderOpen, split };
        setSidebar(false); setBuilderOpen(false); setSplit(24);
      }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { previewPending.current = false; setPreviewStarting(false); }
  }
  function returnToQuery() {
    setSelectedRunId("");
    if (previewLayout.current) {
      setBuilderOpen(previewLayout.current.builderOpen); setSplit(previewLayout.current.split);
      previewLayout.current = null;
    }
  }
  function openConnections() {
    leaveDrawer(() => {
      setDrawer(null); setSurface("connections");
      setConnectionRequest({ id: active?.connectionId ?? "", sequence: Date.now() });
    });
  }
  function openLibrary(save = false) {
    leaveDrawer(() => { setLibrarySaveRequest(save ? Date.now() : 0); setDrawer(drawer === "library" && !save ? null : "library"); });
  }
  async function openQueryExport(destination: "use-query" | "share") {
    try {
      await commands.current?.save();
      await builderCommands.current?.save();
      leaveDrawer(() => { setSurface("queries"); setDrawer(destination); });
    } catch (reason) { setError(errorMessage(reason)); }
  }
  function projectSaved(id: string) {
    setDrawer(null); setArtifactsOpened(true); setSurface("artifacts");
    setArtifactRequest({ id, sequence: Date.now() });
  }
  function openArtifacts(id?: string) {
    leaveDrawer(() => {
      setArtifactsOpened(true); setSurface("artifacts"); setDrawer(null);
      if (id) setArtifactRequest({ id, sequence: Date.now() });
    });
  }
  function toggleBuilder() {
    if (resultsFocused) { setResultsFocused(false); setBuilderOpen(true); return; }
    if (!drawer && builderOpen) { closeBuilder(); return; }
    leaveDrawer(() => {
      setSurface("queries"); setBuilderOpen(true); setSideTab("model");
      setSidebar(window.innerWidth > 900);
    });
  }
  async function refreshSchema() {
    if (schemaRefreshPending.current) return;
    schemaRefreshPending.current = true;
    try { await action("schema.refresh"); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { schemaRefreshPending.current = false; }
  }
  async function closeAllTabs() {
    if (closeAllPending.current || !latest.current) return;
    closeAllPending.current = true; setClosingAll(true); setTabNotice("");
    const { documents, activeDocumentId } = latest.current;
    try {
      // The controller coordinates draft saving across every connected canvas.
      const result = await action<{ closedCount: number }>("document.closeAll", { documentIds: documents.map(doc => doc.id), activeDocumentId });
      setTabNotice(`${result.closedCount} query tab${result.closedCount === 1 ? "" : "s"} closed. Drafts are recoverable with Reopen closed query. A blank query is ready.`);
      requestAnimationFrame(() => commands.current?.focus());
    } catch (reason) { setError(errorMessage(reason)); }
    finally { closeAllPending.current = false; setClosingAll(false); }
  }
  async function flushThen(actionName: string, payload: object = {}) {
    try {
      if (actionName === "document.select" && "id" in payload && payload.id === latest.current?.activeDocumentId) return;
      if (actionName === "document.update") {
        await commands.current?.save();
        await builderCommands.current?.save();
        const id = (payload as { id: string }).id;
        const current = latest.current?.documents.find(document => document.id === id);
        if (current) payload = { ...payload, revision: current.revision };
      }
      await action(actionName, payload);
    }
    catch (reason) { setError(errorMessage(reason)); }
  }
  useEffect(() => { returnToQuery(); }, [active?.id, active?.connectionId, activeRuns[0]?.id]);
  useEffect(() => { if (active?.builder || active?.builderImport || active?.builderWarning || active?.builderProposal) setBuilderOpen(true); }, [active?.id]);
  useEffect(() => {
    if (!active) return;
    if (!initialAuthoringFocus.current) { initialAuthoringFocus.current = true; return; }
    if (!active?.authoringFocus) return;
    setSurface("queries");
    const builder = active.authoringFocus.surface === "builder";
    if (builder) { setBuilderOpen(true); setSideTab("model"); setSidebar(window.innerWidth > 900); }
    else commands.current?.focus();
  }, [active?.id, active?.authoringFocus?.id]);
  useEffect(() => {
    if (!closeId) return;
    const dialog = closeDialog.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [closeId]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.defaultPrevented || closeId) return;
      if (isAuthoringDrawer(drawer)) {
        if (event.key === "Escape") { event.preventDefault(); drawerCommands.current?.close(); }
        if (event.key === "F5" || (event.ctrlKey || event.metaKey) && event.key === "Enter") event.preventDefault();
        return;
      }
      if (surface !== "queries") {
        if (event.key === "F5" || (event.ctrlKey || event.metaKey) && event.key === "Enter") event.preventDefault();
        return;
      }
      if (transition.current) {
        if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && ["enter", "s", "n"].includes(event.key.toLowerCase()))) event.preventDefault();
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      if (event.key === "F5" || (modifier && event.key === "Enter")) { event.preventDefault(); if (!running) commands.current?.run(); }
      else if (modifier && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void (async () => { await commands.current?.save(); await builderCommands.current?.save(); })().catch(reason => setError(errorMessage(reason)));
      }
      else if (modifier && event.altKey && event.key.toLowerCase() === "n") { event.preventDefault(); void flushThen("document.create"); }
      else if (modifier && event.altKey && event.key.toLowerCase() === "c") { event.preventDefault(); setDrawer(current => current === "context" ? null : "context"); }
      else if (event.key === "Escape") {
        if (drawer) setDrawer(null);
        else if (window.innerWidth <= 900 && sidebar) setSidebar(false);
        else if (running && running.status !== "cancelling") void action("query.cancel", { runId: running.id }).catch(() => {});
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [running, drawer, sidebar, action, closeId, surface]);
  function startResize(event: React.PointerEvent, type: "editor" | "explorer" | "builder") {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setResizing(true);
    const move = (pointer: PointerEvent) => {
      const bounds = (type === "editor" ? queryColumn : type === "builder" ? queryWorkarea : workspace).current?.getBoundingClientRect();
      if (!bounds) return;
      if (type === "editor") setSplit(Math.max(20, Math.min(76, ((pointer.clientY - bounds.top) / bounds.height) * 100)));
      else if (type === "builder") setBuilderWidth(Math.max(320, Math.min(640, builderSide === "left" ? pointer.clientX - bounds.left - 32 : bounds.right - pointer.clientX - 32)));
      else setExplorerWidth(Math.max(190, Math.min(390, pointer.clientX - bounds.left)));
    };
    const end = () => { setResizing(false); target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", end); target.removeEventListener("pointercancel", end); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", end); target.addEventListener("pointercancel", end);
  }

  if (fatal) return <main className="startup-screen"><Icon name="warning" size={30}/><h1>Could not open DAX Workbench</h1><p role="alert">{fatal}</p><p className="muted">Reopen the canvas from Copilot to obtain a fresh session credential. Refreshing a URL after its one-time fragment has been cleared may require reopening.</p></main>;
  if (!state) return <main className="startup-screen" aria-busy="true"><Icon name="database" size={32}/><h1>DAX Workbench</h1><span className="query-progress"/><p>Connecting to the local controller…</p></main>;
  return <div ref={root} inert={Boolean(authoringId || state.authoringBusy)} aria-busy={Boolean(authoringId || state.authoringBusy)} className={`workbench ${resizing ? "is-resizing" : ""} ${drawer ? "inspector-open" : ""}`}>
    <header className="app-header" inert={isAuthoringDrawer(drawer)}>
      <div className="app-identity"><span className="app-mark"><Icon name="code" size={19}/></span><h1>DAX <span>Workbench</span></h1></div>
      <div className="connection-control"><Icon name="database" size={15}/><label className="sr-only" htmlFor="connection-picker">Active model connection</label><select id="connection-picker" value={active?.connectionId ?? ""} onChange={event => void flushThen("connection.select", { connectionId: event.target.value })}><option value="" disabled>Select a connection</option>{state.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}{connection.kind === "powerbi-rest" ? " · REST" : connection.model ? ` · ${connection.model}` : ""}</option>)}</select><button className="icon-button" aria-label="Manage connections" title="Connection settings" onClick={openConnections}><Icon name="settings" size={14}/></button></div>
      <div className="header-actions">
        <button className={`button quiet context-button ${drawer === "context" ? "is-active" : ""}`} onClick={() => openDrawer("context")} aria-expanded={drawer === "context"} title="Context Lens (Ctrl+Alt+C)"><Icon name="lens"/><span>Context Lens</span>{state.selections.length > 0 && <span className="count-badge">{state.selections.length}</span>}</button>
      </div>
    </header>
    {state.hostMode === "standalone" && <div className="global-banner" role="status"><Icon name="info" size={14}/><span><strong>Standalone preview.</strong> Queries use this local server. Copilot handoff and workbench agent tools are not connected to this preview.</span></div>}
    {!state.native.available && <div className="global-banner warning" role="status"><Icon name="warning" size={14}/><span><strong>Native companion unavailable.</strong> {state.native.message}</span><button className="text-button" onClick={() => openDrawer("capabilities")}>Details</button></div>}
    {state.native.available && state.schemaError && <div className="global-banner warning" role="status"><Icon name="warning" size={14}/><span><strong>Model metadata unavailable.</strong> {state.schemaError.message} The editor and connection controls remain available.</span><button className="text-button" disabled={schemaRefreshDisabled} onClick={() => void refreshSchema()}>Retry schema</button></div>}
    {connection?.kind === "powerbi-rest" && <div className="global-banner" role="status"><Icon name="info" size={14}/><span><strong>Power BI REST.</strong> Query-only: one result table, inferred JSON types, no model schema or native parameters. This does not use XMLA.</span><button className="text-button" onClick={() => openDrawer("capabilities")}>Limits</button></div>}
    {connection?.id === "demo:contoso" && surface === "queries" && <section className="demo-guide" aria-label="Contoso demo guide" inert={transitioning || isAuthoringDrawer(drawer)}>
      <div><strong>Contoso is ready. No model credentials needed.</strong>
        <span> Explore retail sales of Desks, Chairs and Lamps, or open Library &gt; Try Contoso for summary queries.</span>
        <details><summary>What the demo supports</summary><p>Four fixed recipes: raw sales, monthly performance, December product snapshot and annual revenue ranking, without parameters. The underlying 36 rows are invented, not business results.
          The three summary starters include matching builder selections. Only these shipped recipe shapes execute; arbitrary builder edits, value lookups and model previews require a real model. Pivots, chart filters and formatting work locally.
          Use queries previews files without executing. Exported M and independent Python need your own model; managed Python setup and runs are separate actions.</p></details>
      </div>
      <button className="button small" disabled={!connected || transitioning} onClick={() => void flushThen("document.create", { title: "Contoso sales sample" })} title="Open the supported sample in a new tab without replacing your draft or running it">New sample tab</button>
    </section>}
    {!connected && <div className="global-banner warning" role="status"><Icon name="refresh" size={14}/><span>Live updates disconnected. Reconnecting to the local controller; queries will not be rerun.</span></div>}
    {error && <div className="global-banner error" role="alert"><Icon name="warning" size={14}/><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}><Icon name="close" size={14}/></button></div>}
    <nav className="workspace-toolbar" aria-label="Workspace tools" inert={transitioning}>
      <div className="toolbar-group">
        <div className="workspace-modes" role="tablist" aria-label="Workbench views" onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const views = ["dashboards", "queries", "artifacts", "connections"] as const;
          const next = event.key === "Home" ? views[0] : event.key === "End" ? views.at(-1)!
            : views[(views.indexOf(surface) + (event.key === "ArrowRight" ? 1 : views.length - 1)) % views.length];
          navigate(next);
        }}>
          <button id="dashboards-workspace-tab" role="tab" aria-controls="dashboards-workspace" aria-selected={surface === "dashboards"} tabIndex={surface === "dashboards" ? 0 : -1} onClick={() => navigate("dashboards")}><Icon name="chart" size={15}/>Dashboards</button>
          <button id="queries-workspace-tab" role="tab" aria-controls="queries-workspace" aria-selected={surface === "queries"} tabIndex={surface === "queries" ? 0 : -1} onClick={() => navigate("queries")}><Icon name="code" size={15}/>Queries</button>
          <button id="artifacts-workspace-tab" role="tab" aria-controls="artifacts-workspace" aria-selected={surface === "artifacts"} tabIndex={surface === "artifacts" ? 0 : -1} onClick={() => navigate("artifacts")}><Icon name="folder" size={15}/>Artifacts</button>
          <button id="connections-workspace-tab" role="tab" aria-label="Connection settings" aria-controls="connections-workspace" aria-selected={surface === "connections"} tabIndex={surface === "connections" ? 0 : -1} onClick={() => navigate("connections")}><Icon name="database" size={15}/>Connections</button>
        </div>
        <div className="toolbar-group query-tools" hidden={surface !== "queries"}>
        <button className={`button quiet ${sidebar && !resultsFocused ? "is-active" : ""}`} title="Toggle model explorer" aria-label="Toggle model explorer" aria-expanded={sidebar && !resultsFocused} onClick={() => leaveDrawer(() => { setSideTab("model"); setSidebar(drawer || resultsFocused ? true : !sidebar); setResultsFocused(false); })}><Icon name="panel" size={15}/><span className="responsive-label">Explorer</span></button><span className="toolbar-divider"/>
        <button className="button quiet" aria-label="New query" onClick={() => leaveDrawer(() => { void flushThen("document.create"); })} title="New query (Ctrl+Alt+N)"><Icon name="plus" size={14}/><span>New query</span></button>
        <button className={`button quiet ${builderOpen ? "is-active" : ""}`} aria-label="Builder" title="Toggle query builder" aria-pressed={builderOpen} aria-controls="builder-dock" onClick={toggleBuilder}><Icon name="table" size={15}/><span>Builder</span></button>
        </div>
        <button className="button quiet" aria-label="Library" title="Query library" onClick={() => openLibrary()}><Icon name="book" size={14}/><span>Library</span></button>
        <button className="button" title="Gather this model's starter queries, saved queries and DAX skill context into a reviewed ZIP" onClick={() => void openQueryExport("share")}><Icon name="share" size={14}/><span>Share model</span></button>
        <button className={`button ${drawer === "settings" ? "is-active" : ""}`} aria-label="Workbench settings" aria-expanded={drawer === "settings"} title="Settings: appearance, query limits, and keyboard shortcuts" onClick={() => openDrawer("settings")}><Icon name="settings"/><span>Settings</span></button>
        <button className={`button quiet ${schemaRefreshing ? "spinning" : ""}`} aria-label="Refresh schema" disabled={schemaRefreshDisabled} aria-busy={schemaRefreshing}
          title={!connection ? "Choose a model connection first." : schemaUnsupported ? connection.capabilities?.schema?.reason : "Reload model tables, columns and measures. Does not run DAX or change selections."}
          onClick={() => void refreshSchema()}><Icon name="refresh" size={14}/><span>{schemaRefreshing ? "Refreshing schema..." : "Refresh schema"}</span></button>
      </div>
      <button className="capability-trigger text-button" onClick={() => openDrawer("capabilities")} title="Inspect native and MCP capabilities"><span className={`status-dot ${state.native.available ? "completed" : "unknown"}`}/><span>{state.native.available ? "Native ready" : "Native offline"}</span><Icon name="info" size={13}/></button>
    </nav>
    <div className="workspace-shell" ref={workspace} style={{ "--explorer-width": `${explorerWidth}px`, "--editor-height": `${split}%`, "--builder-width": `${builderWidth}px` } as React.CSSProperties}>
      <div id="queries-workspace" role="tabpanel" aria-labelledby="queries-workspace-tab" className={`query-surface ${resultsFocused ? "results-focused" : ""}`} hidden={surface !== "queries"}>
      {sidebar && <>
        <button className="explorer-backdrop" tabIndex={-1} aria-label="Close model explorer" onClick={() => setSidebar(false)}/>
        <aside className="explorer" aria-label="Model and history" inert={isAuthoringDrawer(drawer)}>
          <div className="explorer-tabs"><button className={sideTab === "model" ? "active-tab" : ""} onClick={() => setSideTab("model")}><Icon name="database" size={14}/>Model</button><button className={sideTab === "history" ? "active-tab" : ""} onClick={() => setSideTab("history")}><Icon name="history" size={14}/>History</button><button className="icon-button close-explorer" aria-label="Close explorer" onClick={() => setSidebar(false)}><Icon name="close" size={13}/></button></div>
          {sideTab === "model" ? <ModelExplorer schema={schema} action={action} refreshing={schemaRefreshing} refreshDisabled={schemaRefreshDisabled} onRefresh={() => void refreshSchema()} hasConnection={Boolean(connection)} capability={connection?.capabilities?.schema} selectedObjects={state.selectedObjects} builderActive={builderOpen} onBuilderField={object => builderCommands.current?.addField(object)} onBuilderFilter={object => builderCommands.current?.addFilter(object)} onConnect={() => { setSidebar(false); openConnections(); }} onInsert={text => { setInsert({ text, sequence: Date.now() }); if (window.innerWidth <= 900) setSidebar(false); }} onInspect={inspectObject} onPreview={value => void previewObject(value)} previewDisabled={previewDisabled}/> : <HistoryPanel runs={[...state.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))} action={action} currentId={selectedRun?.id} onSelect={(run: Run) => { setSelectedRunId(run.id); if (window.innerWidth <= 900) setSidebar(false); }}/>}
        </aside>
        <div className="splitter vertical" role="separator" tabIndex={0} inert={isAuthoringDrawer(drawer)} aria-label="Resize model explorer" aria-orientation="vertical" aria-valuemin={190} aria-valuemax={390} aria-valuenow={explorerWidth} onPointerDown={event => startResize(event, "explorer")} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setExplorerWidth(value => Math.max(190, Math.min(390, value + (event.key === "ArrowRight" ? 12 : -12)))); } }}/>
      </>}
      {transitioning && <span className="sr-only" role="status">Saving the current draft and switching query documents.</span>}
      <main className="main-workspace" inert={transitioning || isAuthoringDrawer(drawer)} aria-hidden={transitioning || isAuthoringDrawer(drawer)} aria-busy={transitioning}>
        <div className="document-tabbar">
        <div className="document-tabs" role="tablist" aria-label="Query documents">
          {state.documents.map(document => <div className={`document-tab ${active?.id === document.id ? "selected-document" : ""}`} key={document.id}>
            {renaming === document.id ? <form onSubmit={event => { event.preventDefault(); void flushThen("document.update", { id: document.id, revision: document.revision, title: newTitle.trim() || document.title }).then(() => setRenaming("")); }}><input aria-label="Query document title" autoFocus value={newTitle} onChange={event => setNewTitle(event.target.value)} onBlur={() => setRenaming("")} onKeyDown={event => { if (event.key === "Escape") setRenaming(""); }} maxLength={100}/></form> : <button role="tab" aria-selected={active?.id === document.id} onClick={() => void flushThen("document.select", { id: document.id })} onDoubleClick={() => { setRenaming(document.id); setNewTitle(document.title); }} title={`${document.title} · revision ${document.revision}\nDouble-click to rename`}><Icon name="code" size={13}/><span>{document.title}</span>{document.proposal && <span className="proposal-dot" title="Proposal awaiting review"/>}</button>}
            <button className="icon-button tab-close" aria-label={`Close query ${document.title}`} title={state.runs.some(run => run.documentId === document.id && RUNNING.has(run.status)) ? "Cancel the active run before closing this query" : `Close query ${document.title}`} disabled={state.runs.some(run => run.documentId === document.id && RUNNING.has(run.status))} onClick={() => { setCloseError(""); setCloseId(document.id); }}><Icon name="close" size={11}/></button>
          </div>)}
          <button className="icon-button new-tab" aria-label="New query document" title="New query document" onClick={() => void flushThen("document.create")}><Icon name="plus" size={14}/></button>
          {!!state.closedDocuments?.length && <button className="button quiet" title="Restore the most recently closed recoverable query, including its saved draft" onClick={() => void flushThen("document.reopen", { id: state.closedDocuments?.at(-1)?.id })}>Reopen closed query</button>}
        </div>
        <button className="button quiet close-all-tabs" disabled={closingAll || transitioning || Boolean(closeAllBlocked) || !state.documents.length}
          title={closeAllBlocked || "Close all query tabs, keep their drafts recoverable, and start a blank query"}
          aria-label="Close all tabs" onClick={() => void closeAllTabs()}><Icon name="close" size={13}/>{closingAll ? "Closing..." : "Close all tabs"}</button>
        </div>
        {tabNotice && <div className="tab-notice" role="status"><span>{tabNotice}</span><button className="icon-button" aria-label="Dismiss tab notice" onClick={() => setTabNotice("")}><Icon name="close" size={13}/></button></div>}
        {active ? <>
          <div className={`query-workarea ${builderOpen ? "builder-is-open" : ""} builder-on-${builderSide}`} ref={queryWorkarea}>
            <DockOrder reverse={builderSide === "left" && !stackedBuilder}>
            <div className="query-results-column" ref={queryColumn} key="query">
              <div className="editor-region">
                <DocumentPane key={active.id} document={active} stateRef={latest} action={action} objects={schema?.objects ?? []} runs={state.runs} commands={commands} insert={insert} onInserted={() => setInsert(undefined)} onLibrary={() => openLibrary(true)} onUseQuery={() => void openQueryExport("use-query")} onShare={() => void openQueryExport("share")} parametersOpen={parametersOpen} setParametersOpen={setParametersOpen} onManualEdit={manualEdit}/>
              </div>
              <div className="splitter horizontal" role="separator" tabIndex={0} aria-label="Resize query and results panes" aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={76} aria-valuenow={Math.round(split)} onPointerDown={event => startResize(event, "editor")} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setSplit(value => Math.max(20, Math.min(76, value + (event.key === "ArrowDown" ? 3 : -3)))); } }}><span/></div>
              <div className="results-region"><ResultsPane run={selectedRun} state={state} action={action} onRun={() => commands.current?.run()} onReturnToQuery={returnToQuery} onContext={() => setDrawer("context")} onCapabilities={() => setDrawer("capabilities")} onArtifactSaved={openArtifacts} onArtifactDraftChange={setVisualDraftDirty}
                focused={resultsFocused} onFocusChange={setResultsFocused}
                onPinDashboard={request => { setDashboardPin({ ...request, sequence: Date.now() }); setSurface("dashboards"); }}/></div>
            </div>
            {builderOpen && <div key="resize" className="splitter vertical builder-resizer" role="separator" tabIndex={0} aria-label="Resize query builder" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={640} aria-valuenow={builderWidth} aria-valuetext={`${builderSide} dock, preferred width ${builderWidth} pixels`} onPointerDown={event => startResize(event, "builder")} onKeyDown={event => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const grows = builderSide === "left" ? event.key === "ArrowRight" : event.key === "ArrowLeft"; setBuilderWidth(value => Math.max(320, Math.min(640, value + (grows ? 12 : -12)))); }
            }}/>}
            <aside key="dock" className="builder-dock" id="builder-dock" aria-label="Query builder panel" hidden={!builderOpen}>
              <div className="builder-dock-header"><h2><Icon name="table" size={14}/>Query builder</h2><div className="toolbar-group">
                <button className="button small quiet" disabled={savingLayout} onClick={() => void switchBuilderSide()} title={`Move query builder to the ${builderSide === "right" ? "left" : "right"}; remember this for this workbench`}>Dock {builderSide === "right" ? "left" : "right"}</button>
                <button className="icon-button" aria-label="Focus DAX editor" title="Focus DAX editor without closing the builder" onClick={showEditor}><Icon name="code" size={14}/></button>
                <button className="icon-button" aria-label="Close query builder" title="Close query builder" onClick={closeBuilder}><Icon name="close" size={14}/></button>
              </div></div>
              <QueryBuilder key={`${active.id}:${active.connectionId}`} document={active} objects={schema?.objects ?? []} hierarchies={schema?.hierarchies} action={action} latest={latest} commands={builderCommands} beforeApply={saveEditor} editorSelection={editorSelection} onEditor={showEditor} onParameters={showParameters} onCopilot={showContext} hidden={!builderOpen} running={Boolean(running)}
                schemaMessage={schemaMessage} refreshDisabled={schemaRefreshDisabled} onRefresh={() => void refreshSchema()}
                onPreview={value => void previewObject(value)} onInspect={inspectObject} previewDisabled={previewDisabled}/>
            </aside>
            <nav key="rail" className="builder-rail" aria-label="Side tools"><button className={builderOpen ? "active-tool" : ""} aria-label="Query builder" aria-expanded={builderOpen} aria-controls="builder-dock" title={builderOpen ? "Close query builder" : "Open query builder beside the editor"} onClick={toggleBuilder}><Icon name="table" size={14}/><span>Query builder</span>{active.builderProposal && <span className="proposal-dot" title="Builder proposal awaiting review"/>}</button></nav>
            </DockOrder>
          </div>
        </> : <div className="empty-state"><Icon name="code" size={30}/><h2>A workspace for your next query</h2><p>Create a document to start editing DAX. No connection is needed to write a query.</p><button className="button primary" onClick={() => void action("document.create").catch(() => {})}>Create query</button></div>}
      </main>
      </div>
      <DashboardWorkspace state={state} action={action} hidden={surface !== "dashboards"} inert={isAuthoringDrawer(drawer)} pinRequest={dashboardPin}
        onPinHandled={clearDashboardPin} onQuery={() => setSurface("queries")} onDirtyChange={setDashboardDirty}/>
      <ConnectionsWorkspace state={state} action={action} connected={connected} hidden={surface !== "connections"} inert={isAuthoringDrawer(drawer)}
        requested={connectionRequest} onDirtyChange={setConnectionEditing}/>
      {!artifactsOpened && <div id="artifacts-workspace" role="tabpanel" aria-labelledby="artifacts-workspace-tab" hidden/>}
      {artifactsOpened && <ArtifactsWorkspace state={state} action={action} connected={connected} hidden={surface !== "artifacts"}
        inert={transitioning || isAuthoringDrawer(drawer)} requested={artifactRequest} onQuery={() => setSurface("queries")} onDirtyChange={setArtifactDirty}/>}
      <Drawer name={drawer} commands={drawerCommands} onClose={closeDrawer} state={state} action={action}
        object={object?.connectionId === schema?.connectionId ? schema?.objects.find(item => item.id === object?.id) ?? null : null}
        onInspect={inspectObject} onBuilder={inspectToBuilder} onPreview={value => void previewObject(value)} previewDisabled={previewDisabled} librarySaveRequest={librarySaveRequest} connected={connected} onArtifacts={openArtifacts} onLibraryEditChange={setLibraryEditing} onProjectSaved={projectSaved}/>
    </div>
    <footer className="status-bar">
      <div><span className={`status-dot ${transitioning || schemaRefreshing ? "queued" : running ? running.status : state.schemaError ? "unknown" : connection ? "completed" : "unknown"}`}/><span>{transitioning ? "Switching query..." : running ? running.status : schemaRefreshing ? "Loading model fields..." : state.schemaError ? "Schema unavailable" : connection ? "Ready" : "Not connected"}</span><span className="status-separator"/><span className="status-connection">{connection ? `${connection.name} · ${connectionKindLabel(connection.kind)}` : "Choose a semantic model"}</span></div>
      <div><span className="limit-status">{state.limits.maxRows.toLocaleString()} rows / {Math.round(state.limits.maxBytes / 1048576)} MiB cap</span><span className="status-separator"/><button className="result-analysis-status" aria-expanded={drawer === "context"} title="Manage Copilot result analysis in Context Lens" onClick={() => openDrawer("context")}><Icon name="lens" size={12}/><span>Result analysis {state.agentResultsEnabled === true ? "on" : "off"}</span>{state.selections.length > 0 && <span className="manual-share-status"> · {state.selections.length} manually shared cells</span>}</button><button className="agent-status" aria-label={`Copilot queries ${state.agentReadEnabled ? "on" : "off"}. Manage query access`} aria-expanded={drawer === "context"} title="Manage Copilot query access in Context Lens" onClick={() => openDrawer("context")}>{state.agentReadEnabled ? "Copilot queries on" : "Copilot queries off"}</button></div>
    </footer>
    {closeId && <dialog ref={closeDialog} className="close-query-dialog" aria-labelledby="close-query-heading" aria-describedby="close-query-warning" onCancel={event => { event.preventDefault(); if (!closing) setCloseId(""); }}>
      <h2 id="close-query-heading">Close “{closeDocument?.title ?? "query"}”?</h2>
      <p id="close-query-warning">This removes the editor document and its draft. Automatic draft saving is not a library copy. Run history and pinned results remain available.</p>
      <p className="muted">Save a library copy first if you want to keep this query. The library opens without closing the document.</p>
      {closeError && <p className="field-error" role="alert">{closeError}</p>}
      <div className="dialog-actions">
        <button className="button" autoFocus disabled={closing} onClick={() => setCloseId("")}>Keep editing</button>
        <button className="button" disabled={closing} onClick={() => {
          setClosing(true);
          void (async () => {
            await commands.current?.save();
            if (active?.id !== closeId) await action("document.select", { id: closeId });
            setCloseId(""); setDrawer("library");
          })().catch(reason => setCloseError(errorMessage(reason))).finally(() => setClosing(false));
        }}>Save a library copy…</button>
        <button className="button danger-text" disabled={closing} onClick={() => {
          setClosing(true);
          void action("document.close", { id: closeId }).then(() => setCloseId("")).catch(reason => setCloseError(errorMessage(reason))).finally(() => setClosing(false));
        }}>{closing ? "Working…" : "Discard and close"}</button>
      </div>
    </dialog>}
  </div>;
}

function DockOrder({ reverse, children }: { reverse: boolean; children: ReactNode }) {
  const panes = Children.toArray(children);
  return reverse ? panes.reverse() : panes;
}
