import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Dashboard, DashboardCatalog, DashboardDetail, DashboardSnapshot, DashboardSource, DashboardTile, DashboardVisual, ResultAssertion, DashboardProposal } from "../contracts/dashboards";
import type { Snapshot } from "../contracts/workbench";
import type { ArtifactCatalog } from "../contracts/artifacts";
import type { Action } from "./useWorkbench";
import { api, errorMessage, downloadBlob } from "./api";
import { LocalChart } from "./Chart";
import { ChartFilters } from "./ChartFilters";
import { DocumentationReader } from "./DocumentationReader";
import { WritingEditor } from "./WritingEditor";
import { Icon } from "./icons";
import { displayCell, isNumeric, formatDuration } from "./model";
import "./dashboards.css";
import { AdvancedVisual } from "./AdvancedVisual";
import { SavedMatrix } from "./ResultMatrix";
import { resolveDashboardVisual } from "../shared/dashboard-visual.mjs";
import { resultColumnLabels } from "../shared/result-columns.mjs";
import "./result-analysis.css";

function capturedVisual(visual: DashboardVisual, snapshot?: DashboardSnapshot) {
  try { return { visual: snapshot ? resolveDashboardVisual(visual, snapshot.columns) : visual, error: "" }; }
  catch (reason) { return { visual, error: errorMessage(reason) }; }
}

type PinRequest = { runId: string; resultSetId: string; title: string; visual: DashboardVisual; sequence: number };
export type DashboardPinRequest = PinRequest;
const editableTile = ({ id, pageId, title, description, width, height, visual, mappings, archived, note, assertions, crossFilterId }: DashboardTile) =>
  ({ id, pageId, title, width, height, visual, mappings, ...(archived === undefined ? {} : { archived }),
    ...(description === undefined ? {} : { description }),
    ...(note === undefined ? {} : { note }), ...(assertions === undefined ? {} : { assertions }), crossFilterId: crossFilterId ?? null });

export function DashboardWorkspace({ state, action, hidden, inert, pinRequest, onPinHandled, onQuery, onDirtyChange }: {
  state: Snapshot; action: Action; hidden: boolean; pinRequest?: PinRequest; onPinHandled: () => void;
  onQuery: () => void; onDirtyChange: (dirty: boolean) => void;
  inert?: boolean;
}) {
  const [catalog, setCatalog] = useState<DashboardCatalog | null>(null), [detail, setDetail] = useState<DashboardDetail | null>(null);
  const [boardId, setBoardId] = useState(""), [pageId, setPageId] = useState("");
  const [draft, setDraft] = useState<Dashboard | null>(null), [tileId, setTileId] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState(""), [creating, setCreating] = useState(false), [showArchived, setShowArchived] = useState(false);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(""), [sourceTile, setSourceTile] = useState("");
  const [artifactCatalog, setArtifactCatalog] = useState<ArtifactCatalog | null>(null), [artifactId, setArtifactId] = useState("");
  const [addingArtifact, setAddingArtifact] = useState(false), [retry, setRetry] = useState(0);
  const [importing, setImporting] = useState(false), [definitionText, setDefinitionText] = useState("");
  const [reviewer, setReviewer] = useState(""), [rebinding, setRebinding] = useState<Record<string, string>>({});
  const [groupBindings, setGroupBindings] = useState<Record<string, string>>({});
  const [cancelBusy, setCancelBusy] = useState(false), [now, setNow] = useState(Date.now);
  const [snapshots, setSnapshots] = useState<Record<string, DashboardSnapshot>>({});
  const [proposals, setProposals] = useState<DashboardProposal[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Pick<Dashboard, "id" | "title" | "revision"> | null>(null);
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState("");
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const dashboardSelect = useRef<HTMLSelectElement>(null), focusAfterDelete = useRef(false);
  const deleteButton = useRef<HTMLButtonElement>(null), restoreDeleteFocus = useRef(false);
  const board = draft ?? detail?.dashboard;
  const page = board?.pages.find(item => item.id === pageId) ?? board?.pages[0];
  const activeTile = draft?.tiles.find(tile => tile.id === tileId);
  const activeSelection = activeTile ? capturedVisual(activeTile.visual, snapshots[activeTile.snapshotId ?? ""]) : undefined;
  const activeVisual = activeSelection?.visual;
  const refresh = detail?.refresh?.status === "running" ? detail.refresh : null;
  useEffect(() => {
    if (!refresh) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [refresh?.id]);
  const dragTile = useRef("");
  const pendingFilters = board?.filters.some(filter => filterValues[filter.id] !== undefined && filterValues[filter.id] !== filter.value);
  const dirty = Boolean(draft) || creating || addingArtifact || Boolean(pinRequest) || importing || Boolean(pendingFilters) || Boolean(deleteTarget);
  const visibleTiles = board?.tiles.filter(tile => !tile.archived) ?? [];
  const refreshable = visibleTiles.filter(tile => tile.source);
  const pageRefreshable = refreshable.filter(tile => tile.pageId === page?.id);
  const unbound = visibleTiles.filter(tile => tile.unboundSource);
  const sourceGroups = new Map<string, { source: DashboardSource; tiles: DashboardTile[] }>();
  for (const tile of unbound) {
    const source = tile.unboundSource;
    if (!source) continue;
    const key = JSON.stringify([source.connectionId, source.connectionKind, source.model]);
    const group = sourceGroups.get(key);
    if (group) group.tiles.push(tile);
    else sourceGroups.set(key, { source, tiles: [tile] });
  }
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!deleteTarget && !hidden && restoreDeleteFocus.current) {
      (focusAfterDelete.current ? dashboardSelect : deleteButton).current?.focus();
      focusAfterDelete.current = false; restoreDeleteFocus.current = false;
    }
    if (!deleteTarget || hidden) return;
    const dialog = deleteDialog.current;
    restoreDeleteFocus.current = true;
    dialog?.showModal();
    return () => dialog?.close();
  }, [deleteTarget?.id, hidden]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (hidden) return;
    const abort = new AbortController();
    void api.read<DashboardCatalog>("dashboards.catalog", {}, abort.signal).then(value => {
      if (abort.signal.aborted) return;
      setCatalog(value);
      setBoardId(current => current && value.entries.some(entry => entry.id === current) ? current : value.homeId ?? value.entries.find(entry => !entry.archived)?.id ?? "");
    }).catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [hidden, state.dashboardsRevision, retry]);
  useEffect(() => {
    if (hidden) return;
    const abort = new AbortController();
    void api.read<DashboardProposal[]>("dashboards.proposals", {}, abort.signal).then(value => {
      if (!abort.signal.aborted) setProposals(value);
    }).catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [hidden, state.dashboardProposalRevision, retry]);
  useEffect(() => {
    if (!boardId || hidden) { if (!boardId) setDetail(null); return; }
    const abort = new AbortController();
    void api.read<DashboardDetail>("dashboards.get", { id: boardId }, abort.signal).then(value => {
      if (!abort.signal.aborted) setDetail(value);
    }).catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [boardId, hidden, state.dashboardsRevision, state.runs, retry]);
  const rememberSnapshot = useCallback((value: DashboardSnapshot) => setSnapshots(current => current[value.id] ? current : { ...current, [value.id]: value }), []);
  async function perform<T>(operation: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setError(""); setNotice("");
    try { const result = await operation(); setRetry(value => value + 1); return result; }
    catch (reason) { setError(errorMessage(reason)); return undefined; }
    finally { setBusy(false); }
  }
  function startEdit() { if (detail) { setDraft(structuredClone(detail.dashboard)); setTileId(""); setFilterValues({}); } }
  function editTile(update: Partial<DashboardTile>) {
    setDraft(current => current ? { ...current, tiles: current.tiles.map(tile => tile.id === tileId ? { ...tile, ...update } : tile) } : current);
  }
  async function saveDraft() {
    if (!draft) return;
    const saved = await perform(() => action<Dashboard>("dashboards.edit", { id: draft.id, expectedRevision: draft.revision,
      title: draft.title, pages: draft.pages, filters: draft.filters, tiles: draft.tiles.map(editableTile) }));
    if (saved) { setDetail({ dashboard: saved, refresh: detail?.refresh ?? null }); setDraft(null); setTileId(""); setNotice("Dashboard saved. No queries were run."); }
  }
  async function refreshPage(all = false, targetTileId?: string) {
    if (!detail) return;
    const current = detail.dashboard;
    await perform(async () => {
      let revision = current.revision;
      const changed = current.filters.some(filter => filterValues[filter.id] !== undefined && filterValues[filter.id] !== filter.value);
      if (changed) {
        const saved = await action<Dashboard>("dashboards.edit", { id: current.id, expectedRevision: revision,
          filters: current.filters.map(filter => ({ ...filter, value: filterValues[filter.id] ?? filter.value })) });
        revision = saved.revision; setDetail({ dashboard: saved, refresh: null }); setFilterValues({});
      }
      const running = await action<DashboardDetail["refresh"]>("dashboards.refresh", { id: current.id, expectedRevision: revision,
        ...(targetTileId ? { tileId: targetTileId } : all ? {} : { pageId: page?.id }) });
      setDetail(previous => previous ? { ...previous, refresh: running } : previous);
    });
  }
  async function cancelRefresh() {
    if (!refresh || !board || cancelBusy) return;
    setCancelBusy(true); setError("");
    try {
      const cancelled = await action<NonNullable<DashboardDetail["refresh"]>>("dashboards.cancel", { id: board.id, refreshId: refresh.id });
      setDetail(current => current?.dashboard.id === board.id ? { ...current, refresh: cancelled } : current);
      setNotice(["completed", "partial"].includes(cancelled.status) ? "The refresh finished before cancellation reached it."
        : "Cancellation requested. Queued tiles will not run; active provider work may take time to stop. Server cancellation is best effort.");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setCancelBusy(false); }
  }
  function switchBoard(id: string) {
    setBoardId(id); setPageId(""); setDetail(null); setFilterValues({}); setSourceTile(""); setExpanded(""); setError(""); setSnapshots({}); setGroupBindings({}); setRebinding({});
  }
  async function deleteDashboard() {
    if (!deleteTarget || deleting) return;
    setDeleting(true); setDeleteError("");
    try {
      const result = await action<{ deletedId: string; catalog: DashboardCatalog }>("dashboards.delete", {
        id: deleteTarget.id, expectedRevision: deleteTarget.revision, confirmed: true,
      });
      setCatalog(result.catalog);
      switchBoard(result.catalog.homeId ?? result.catalog.entries.find(entry => !entry.archived)?.id
        ?? (showArchived ? result.catalog.entries[0]?.id : undefined) ?? "");
      focusAfterDelete.current = true;
      setDeleteTarget(null);
      setNotice(`Deleted "${deleteTarget.title}". Query tabs, saved artifacts and other dashboards were kept.`);
      setRetry(value => value + 1);
    } catch (reason) { setDeleteError(errorMessage(reason)); }
    finally { setDeleting(false); }
  }
  return <section id="dashboards-workspace" role="tabpanel" aria-labelledby="dashboards-workspace-tab" hidden={hidden} inert={inert} className="dashboard-workspace">
    <header className="dashboard-heading">
      <div><h1>Dashboards</h1><p>Your saved views. Opening a dashboard never runs a query.</p></div>
      <div className="button-row">
        <button className="button" disabled={busy || Boolean(draft) || creating || addingArtifact || importing || Boolean(pendingFilters) || Boolean(refresh)} onClick={() => setCreating(true)}><Icon name="plus" size={14}/>New dashboard</button>
        <button className="button" disabled={busy || dirty || Boolean(refresh)} onClick={() => setImporting(true)}>Import definition</button>
        <button className="button quiet" disabled={busy || Boolean(refresh)} onClick={() => setRetry(value => value + 1)} aria-label="Reload dashboard definitions">Reload</button>
      </div>
    </header>
    {error && <div className="inline-alert error" role="alert">{error}</div>}
    {notice && <p className="dashboard-notice" role="status">{notice}</p>}
    {proposals.length > 0 && <section className="dashboard-proposals" aria-label="Dashboard proposals">
      <h2>Review proposed dashboards</h2>
      <p>Nothing has been applied or run. These definitions contain agent-supplied DAX, not verified results. Creation leaves every source unbound; inspect, choose its model and refresh deliberately.</p>
      {proposals.map(proposal => <details key={proposal.id}>
        <summary>{proposal.definition.dashboard.title} · {proposal.definition.dashboard.tiles.length} tiles</summary>
        <p>Review before {new Date(proposal.expiresAt).toLocaleString()}. Pending proposals are not retained across restart.</p>
        {proposal.definition.dashboard.tiles.map(tile => <section key={tile.id} aria-label={`Proposed tile ${tile.title}`}>
          <h3>{tile.title}</h3><p>{tile.visual.type} · units: {tile.visual.units || "Not documented"} · suggested model: {tile.unboundSource?.model ?? "Unspecified"}</p>
          {tile.description && <p>{tile.description}</p>}
          <p>Layout: {tile.width} of 12 columns · {tile.height}px data area</p>
          <pre>{tile.unboundSource?.query}</pre>
          <details><summary>Visual configuration</summary><pre>{JSON.stringify(tile.visual, null, 2)}</pre></details>
        </section>)}
        <div className="button-row">
          <button className="button primary" disabled={busy || dirty || Boolean(refresh) || !catalog}
            onClick={() => void perform(() => action<Dashboard>("dashboards.proposal.apply", { proposalId: proposal.id, expectedRevision: catalog!.revision }))
              .then(created => { if (created) { switchBoard(created.id); setNotice("Dashboard created. Choose a connection in Dashboard model setup, then refresh. No queries ran."); } })}>Create proposed dashboard without running</button>
          <button className="button" disabled={busy} onClick={() => void perform(() => action("dashboards.proposal.dismiss", { proposalId: proposal.id }))}>Dismiss proposal</button>
        </div>
      </details>)}
    </section>}
    {importing && <form className="dashboard-create" onSubmit={event => {
      event.preventDefault(); if (!catalog) return;
      void perform(async () => {
        if (new TextEncoder().encode(definitionText).length > 192 * 1024) throw new Error("Definition transfer supports 192 KiB.");
        let definition: unknown;
        try { definition = JSON.parse(definitionText); } catch { throw new Error("Choose a valid dashboard-definition JSON file."); }
        return action<Dashboard>("dashboards.import", { definition, expectedRevision: catalog.revision });
      }).then(saved => { if (saved) { setImporting(false); setDefinitionText(""); switchBoard(saved.id); setNotice("Definition imported without execution. Inspect each query and explicitly bind its model before refreshing."); } });
    }}>
      <label>Definition JSON file<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; if (!file) return;
        void perform(async () => { if (file.size > 192 * 1024) throw new Error("Definition transfer supports 192 KiB."); setDefinitionText(await file.text()); });
      }}/></label>
      <label>Definition JSON<textarea rows={5} maxLength={196608} value={definitionText} disabled={busy} onChange={event => setDefinitionText(event.target.value)}/></label>
      <p>Imports preserve supplied query text, literal filters, bindings and notes, but contain no result captures or review certification. Every source starts unbound.</p>
      <button className="button primary" disabled={busy || !catalog || !definitionText.trim()}>Import as unbound dashboard</button>
      <button className="button" type="button" disabled={busy} onClick={() => { setImporting(false); setDefinitionText(""); }}>Cancel import</button>
    </form>}
    {creating && <form className="dashboard-create" onSubmit={event => {
      event.preventDefault(); if (!catalog) return;
      void perform(() => action<Dashboard>("dashboards.create", { title: newTitle, expectedRevision: catalog.revision })).then(created => {
        if (created) { switchBoard(created.id); setCreating(false); setNewTitle(""); }
      });
    }}><label>Dashboard name<input autoFocus required maxLength={120} value={newTitle} onChange={event => setNewTitle(event.target.value)}/></label>
      <button className="button primary" disabled={busy || !catalog}>Create dashboard</button><button type="button" className="button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button></form>}
    <div className="dashboard-selector">
      <label>Dashboard<select ref={dashboardSelect} aria-label="Dashboard" value={boardId} disabled={Boolean(draft) || busy || creating || importing || addingArtifact || Boolean(pendingFilters)} onChange={event => switchBoard(event.target.value)}>
        <option value="">Choose a dashboard</option>{catalog?.entries.filter(entry => showArchived || !entry.archived).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title))
          .map(entry => <option key={entry.id} value={entry.id}>{entry.favorite ? "* " : ""}{entry.title}{entry.archived ? " (archived)" : ""}{catalog.homeId === entry.id ? " (home)" : ""}</option>)}
      </select></label>
      <label className="dashboard-checkbox"><input type="checkbox" checked={showArchived} disabled={Boolean(draft)} onChange={event => setShowArchived(event.target.checked)}/>Show archived</label>
      {board && !draft && <div className="button-row">
        <button className="button quiet" disabled={busy} aria-pressed={board.favorite} onClick={() => void perform(() => action("dashboards.edit", { id: board.id, expectedRevision: board.revision, favorite: !board.favorite }))}>{board.favorite ? "Unfavorite" : "Favorite"}</button>
        <button className="button quiet" disabled={busy || board.archived || catalog?.homeId === board.id} onClick={() => void perform(() => action("dashboards.home", { id: board.id, expectedRevision: catalog?.revision }))}>Set as home</button>
        <button className="button quiet" disabled={busy || Boolean(refresh) || Boolean(pendingFilters)} onClick={() => void perform(() => action("dashboards.edit", { id: board.id, expectedRevision: board.revision, archived: !board.archived }))}>{board.archived ? "Restore dashboard" : "Archive dashboard"}</button>
        <button className="button quiet" disabled={busy || Boolean(refresh) || dirty} onClick={() => void perform(() => action<Dashboard>("dashboards.duplicate", { id: board.id, expectedRevision: board.revision })).then(copy => { if (copy) switchBoard(copy.id); })}>Duplicate dashboard</button>
        <button ref={deleteButton} className="button quiet danger-text" disabled={busy || Boolean(refresh) || dirty}
          title={refresh ? "Cancel refresh and wait for it to stop before deleting." : "Permanently remove this dashboard; Archive keeps it recoverable."}
          onClick={() => { setDeleteError(""); setDeleteTarget({ id: board.id, title: board.title, revision: board.revision }); }}>Delete dashboard</button>
      </div>}
    </div>
    {!board ? <div className="dashboard-empty"><Icon name="chart" size={32}/><h2>Your most useful views belong here</h2>
      <p>Create a dashboard, then pin a completed query result or a saved visual. Captures stay available after restarting the workbench.</p>
      <button className="button" onClick={onQuery}>Go to Queries</button></div> : <>
      <div className="dashboard-titlebar">
        {draft ? <label>Dashboard title<input maxLength={120} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label> : <h2>{board.title}</h2>}
        <div className="button-row">
          {draft ? <><button className="button primary" disabled={busy} onClick={() => void saveDraft()}>Save layout</button><button className="button" disabled={busy} onClick={() => { setDraft(null); setTileId(""); }}>Discard layout edits</button></> : <>
            {refresh ? <button className="button" disabled={cancelBusy} onClick={() => void cancelRefresh()}><Icon name="stop" size={13}/>{cancelBusy ? "Requesting cancellation..." : refresh.cancelRequested ? "Retry cancellation" : "Cancel refresh"}</button> : <>
              <button className="button primary" disabled={busy || board.archived || Boolean(board.release) || importing || !pageRefreshable.length}
                title={!pageRefreshable.length ? "This page needs a connected query tile before it can refresh." : undefined}
                onClick={() => void refreshPage()}><Icon name="refresh" size={13}/>{pendingFilters ? "Apply & refresh page" : "Refresh page"}</button>
              <button className="button" disabled={busy || board.archived || Boolean(board.release) || importing || !refreshable.length}
                title={!refreshable.length ? "Connect the dashboard's query tiles to a model before refreshing." : undefined}
                onClick={() => void refreshPage(true)}>Refresh all pages</button>
            </>}
            <button className="button" disabled={busy || Boolean(refresh) || board.archived || Boolean(board.release) || dirty} onClick={startEdit}><Icon name="edit" size={13}/>Edit</button>
          </>}
        </div>
        {board.release && <p className="dashboard-notice" role="status">Frozen reviewed release · {board.release.reviewer} · {new Date(board.release.reviewedAt).toLocaleString()} · source revision {board.release.sourceRevision}. Review is a person-provided label, not a certification of business correctness. This release cannot refresh or change its captures.</p>}
      </div>
      {!draft && !board.archived && !board.release && unbound.length > 0 && <section className="dashboard-setup" aria-label="Dashboard model setup">
        <h3>Connect {unbound.length} query {unbound.length === 1 ? "tile" : "tiles"} before refreshing</h3>
        <p>The model selected in Queries does not connect dashboard tiles. Choose a connection for each source group below.
          Connecting saves the bindings only; Refresh runs the queries.</p>
        {refreshable.length > 0 && <p role="status">{refreshable.length} connected query {refreshable.length === 1 ? "tile can" : "tiles can"} refresh.
          {" "}{unbound.length} unconnected {unbound.length === 1 ? "tile will" : "tiles will"} be skipped until connected.</p>}
        {[...sourceGroups].map(([key, group]) => <form key={key} className="dashboard-setup-group" onSubmit={event => {
          event.preventDefault();
          void perform(() => action<Dashboard>("dashboards.rebind", { id: board.id, expectedRevision: board.revision,
            tileIds: group.tiles.map(tile => tile.id), connectionId: groupBindings[key] })).then(saved => {
              if (saved) {
                setDetail({ dashboard: saved, refresh: null });
                setGroupBindings(current => { const next = { ...current }; delete next[key]; return next; });
                setNotice(`Connected ${group.tiles.length} query tile${group.tiles.length === 1 ? "" : "s"}. Use Refresh page or Refresh all pages to load data. No queries ran.`);
              }
            });
        }}>
          <div><strong>{group.source.connectionName} / {group.source.model ?? "(unspecified model)"}</strong>
            <details><summary>Review {group.tiles.length} included {group.tiles.length === 1 ? "query" : "queries"}</summary>
              {group.tiles.map(tile => <div key={tile.id}><h4>{tile.title}</h4><pre>{tile.unboundSource?.query}</pre>
                <pre>{JSON.stringify(tile.unboundSource?.parameters, null, 2)}</pre></div>)}
            </details>
          </div>
          <label>Connection for {group.source.connectionName}<select value={groupBindings[key] ?? ""} disabled={busy || dirty || Boolean(refresh)}
            onChange={event => setGroupBindings(current => ({ ...current, [key]: event.target.value }))}>
            <option value="">Choose a connection</option>
            {state.connections.map(connection => <option key={connection.id} value={connection.id} disabled={connection.capabilities?.query?.status === "unsupported"}>
              {connection.name} / {connection.model ?? "(unspecified model)"}{connection.capabilities?.query?.status === "unsupported" ? " (query unavailable)" : ""}
            </option>)}
          </select></label>
          <button className="button primary" disabled={busy || dirty || Boolean(refresh) || !groupBindings[key]
            || !state.connections.some(connection => connection.id === groupBindings[key] && connection.capabilities?.query?.status !== "unsupported")}>
            Connect {group.tiles.length} {group.tiles.length === 1 ? "tile" : "tiles"} without running
          </button>
        </form>)}
      </section>}
      {!draft && !refresh && !board.archived && !board.release && !pageRefreshable.length && !unbound.some(tile => tile.pageId === page?.id) &&
        <p className="dashboard-notice" role="status">This page has no query tiles to refresh. Notes and saved-visual snapshots do not run queries.
          {" "}{refreshable.length ? "Use Refresh all pages for connected query tiles on other pages." : "Pin a query result to add a refreshable tile."}</p>}
      <div className="dashboard-pages" aria-label="Dashboard pages">
        {board.pages.map(item => <button key={item.id} className={item.id === page?.id ? "active-tab" : ""} aria-current={item.id === page?.id ? "page" : undefined} onClick={() => { setPageId(item.id); setTileId(""); }}>{item.title}</button>)}
        {draft && <button className="button quiet" disabled={draft.pages.length >= 10} onClick={() => {
          const id = crypto.randomUUID(); setDraft({ ...draft, pages: [...draft.pages, { id, title: `Page ${draft.pages.length + 1}` }] }); setPageId(id);
        }}>+ Page</button>}
      </div>
      {draft && page && <label className="dashboard-page-name">Page name<input value={page.title} maxLength={80} onChange={event => setDraft({ ...draft, pages: draft.pages.map(item => item.id === page.id ? { ...item, title: event.target.value } : item) })}/></label>}
      {!!board.filters.length && <div className="dashboard-filters">
        {board.filters.map(filter => <label key={filter.id}>{filter.label}<input aria-label={`Dashboard filter ${filter.label}`} value={filterValues[filter.id] ?? filter.value} disabled={Boolean(draft) || busy || Boolean(refresh) || Boolean(board.release)}
          onChange={event => setFilterValues({ ...filterValues, [filter.id]: event.target.value })}/><small>{filter.type} · {board.tiles.filter(tile => !tile.archived && tile.mappings.some(mapping => mapping.filterId === filter.id)).length} mapped tiles</small></label>)}
        <p>Changes are pending until Apply &amp; refresh. Unmapped tiles keep their own scope.</p>
        {pendingFilters && <button className="button quiet" disabled={busy || Boolean(refresh)} onClick={() => setFilterValues({})}>Discard pending filters</button>}
      </div>}
      {draft && <details className="dashboard-filter-editor"><summary>Shared filters and mappings</summary>
        <p>Map filters to verified builder columns or matching typed template parameters on each tile. Fixed query restrictions are preserved.</p>
        {draft.filters.map(filter => <div className="dashboard-filter-row" key={filter.id}>
          <input aria-label="Filter label" placeholder="Filter label" maxLength={80} value={filter.label} onChange={event => setDraft({ ...draft, filters: draft.filters.map(item => item.id === filter.id ? { ...item, label: event.target.value } : item) })}/>
          <select aria-label="Filter type" value={filter.type} onChange={event => setDraft({ ...draft, filters: draft.filters.map(item => item.id === filter.id ? { ...item, type: event.target.value as typeof filter.type } : item) })}>
            <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Boolean</option></select>
          <input aria-label="Filter default value" placeholder="Exact default value" value={filter.value} onChange={event => setDraft({ ...draft, filters: draft.filters.map(item => item.id === filter.id ? { ...item, value: event.target.value } : item) })}/>
          <button className="button quiet" onClick={() => setDraft({ ...draft, filters: draft.filters.filter(item => item.id !== filter.id),
            tiles: draft.tiles.map(tile => ({ ...tile, mappings: tile.mappings.filter(mapping => mapping.filterId !== filter.id),
              ...(tile.crossFilterId === filter.id ? { crossFilterId: undefined } : {}) })) })}>Remove filter</button>
        </div>)}
        <button className="button" disabled={draft.filters.length >= 16} onClick={() => setDraft({ ...draft, filters: [...draft.filters, { id: crypto.randomUUID(), label: "New filter", type: "text", value: "" }] })}>Add filter</button>
      </details>}
      {pinRequest && <form className="dashboard-pin-form" onSubmit={event => {
        event.preventDefault();
        void perform(() => action<Dashboard>("dashboards.pin", { id: board.id, expectedRevision: board.revision, pageId: page?.id,
          runId: pinRequest.runId, resultSetId: pinRequest.resultSetId, title: pinRequest.title, visual: pinRequest.visual })).then(saved => {
          if (saved) { setDetail({ dashboard: saved, refresh: null }); onPinHandled(); setNotice("Result pinned with its executed query and exact captured data. No query was rerun."); }
        });
      }}><strong>Pin “{pinRequest.title}” to {board.title} / {page?.title}</strong>
        <p>The saved capture is local. Future refreshes execute this captured query version, not the current editor.</p>
        <button className="button primary" disabled={busy || board.archived || Boolean(draft) || Boolean(board.release)}>Pin result here</button>
        <button className="button" type="button" disabled={busy} onClick={onPinHandled}>Cancel pin</button></form>}
      {!draft && !pinRequest && !board.release && <div className="dashboard-add-tools">
        <button className="button quiet" disabled={busy || board.archived || dirty} onClick={() => { startEdit(); }}>Add a note or edit tiles</button>
        <button className="button quiet" disabled={busy || board.archived || dirty} onClick={() => {
          setAddingArtifact(true); setError("");
          void api.read<ArtifactCatalog>("artifacts.catalog").then(setArtifactCatalog).catch(reason => setError(errorMessage(reason)));
        }}>Add saved visual</button>
        <span>Pin new data tiles from Queries.</span>
      </div>}
      {addingArtifact && <form className="dashboard-pin-form" onSubmit={event => {
        event.preventDefault();
        void perform(() => action<Dashboard>("dashboards.pinArtifact", { id: board.id, expectedRevision: board.revision, pageId: page?.id, artifactId })).then(saved => {
          if (saved) { setDetail({ dashboard: saved, refresh: null }); setAddingArtifact(false); setArtifactId(""); }
        });
      }}><label>Saved visual<select value={artifactId} onChange={event => setArtifactId(event.target.value)}><option value="">Choose a visual</option>
        {artifactCatalog?.entries.filter(entry => entry.kind === "visual" && !entry.archived).map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
        <p>Saved artifacts become snapshot-only tiles. Descriptive provenance is not a verified refreshable query.</p>
        <button className="button primary" disabled={busy || !artifactId}>Add snapshot tile</button><button className="button" type="button" disabled={busy} onClick={() => setAddingArtifact(false)}>Cancel</button>
      </form>}
      {refresh && <p className="dashboard-notice" role="status">{refresh.cancelRequested ? "Stopping refresh." : "Refreshing"} {refresh.tiles.filter(tile => ["completed", "failed", "cancelled"].includes(tile.status)).length} of {refresh.tiles.length} tiles finished.
        {" "}Queries on the same connection run one at a time; queued tiles have not started. Opening pages does not start more queries.</p>}
      {detail?.refresh?.status === "partial" && <p className="inline-alert" role="status">Refresh finished with {detail.refresh.tiles.filter(tile => tile.status === "failed").length} failed tiles. Failed tiles retain their prior captures; inspect the errors below.</p>}
      <div className={`dashboard-content ${activeTile ? "dashboard-inspecting" : ""}`}>
        <div className="dashboard-grid">
          {board.tiles.filter(tile => tile.pageId === page?.id && (draft || !tile.archived)).map(tile => {
            const status = detail?.refresh?.tiles.find(item => item.tileId === tile.id);
            return <article key={tile.id} className={`dashboard-tile ${expanded === tile.id ? "dashboard-tile-expanded" : ""} ${tile.archived ? "dashboard-tile-archived" : ""}`}
              style={{ "--tile-span": tile.width, "--tile-height": `${tile.height}px` } as CSSProperties} aria-label={tile.title}
              onDragOver={event => { if (draft) event.preventDefault(); }} onDrop={event => {
                event.preventDefault(); if (!draft || !dragTile.current || dragTile.current === tile.id) return;
                const tiles = [...draft.tiles], from = tiles.findIndex(item => item.id === dragTile.current), to = tiles.findIndex(item => item.id === tile.id);
                if (from < 0 || to < 0) return;
                const [moved] = tiles.splice(from, 1); tiles.splice(to, 0, moved); setDraft({ ...draft, tiles }); dragTile.current = "";
              }}>
              <header className="dashboard-tile-heading">
                {draft && <button className="icon-button" draggable onDragStart={() => { dragTile.current = tile.id; }} onDragEnd={() => { dragTile.current = ""; }} aria-label={`Drag ${tile.title}`} title="Drag to reorder; Edit tile also provides keyboard controls"><Icon name="grip" size={14}/></button>}
                <h3>{tile.title}</h3>
                <button className="icon-button" aria-label={`${expanded === tile.id ? "Collapse" : "Expand"} ${tile.title}`} onClick={() => setExpanded(expanded === tile.id ? "" : tile.id)}><Icon name="expand" size={14}/></button>
                {draft && <button className="button small" onClick={() => setTileId(tile.id)}>Edit tile</button>}
              </header>
              {tile.description && <p className="dashboard-tile-description">{tile.description}</p>}
              {status?.status === "queued" && <p className="dashboard-tile-status" role="status">Queued - waiting for earlier tiles or a free connection.</p>}
              {status?.status === "running" && <p className="dashboard-tile-status" role="status">{refresh?.cancelRequested ? "Cancellation requested" : "Running"}
                {status.startedAt ? ` - ${Math.max(0, Math.floor((now - Date.parse(status.startedAt)) / 1000))}s elapsed` : ""}. Previous captured data remains visible until success.</p>}
              {detail?.captureStatus?.[tile.id] === "changed" && <p className="dashboard-tile-status" role="status">Source, filters or checks changed. This visual still shows its previous executed scope; refresh to apply.</p>}
              {tile.note !== undefined ? <div className="dashboard-tile-note"><DocumentationReader text={tile.note} kind="note"/></div> :
                <DashboardTileData boardId={board.id} tile={tile} onSnapshot={rememberSnapshot} retry={retry}
                  onSelectCategory={!board.release && !draft && !refresh && tile.crossFilterId ? value => {
                    setFilterValues(current => ({ ...current, [tile.crossFilterId!]: String(value) }));
                    setNotice("Chart selection staged a shared filter. Review it above; Apply & refresh is still required. No query ran.");
                  } : undefined}/>}
              {tile.crossFilterId && !board.release && <p className="dashboard-tile-status">Click a chart category to stage {board.filters.find(filter => filter.id === tile.crossFilterId)?.label}. Apply &amp; refresh runs mapped tiles.</p>}
              {tile.unboundSource && <form className="dashboard-unbound" onSubmit={event => {
                event.preventDefault(); void perform(() => action("dashboards.rebind", { id: board.id, expectedRevision: board.revision, tileId: tile.id, connectionId: rebinding[tile.id] }));
              }}>
                <p>Unbound query. Original model: {tile.unboundSource.model ?? "(unspecified)"}. Review its literal scope before choosing the destination. Binding does not run it.</p>
                <details><summary>Inspect imported source</summary><pre>{tile.unboundSource.query}</pre><pre>{JSON.stringify(tile.unboundSource.parameters, null, 2)}</pre></details>
                <label>Bind {tile.title} to model<select value={rebinding[tile.id] ?? ""} disabled={busy || Boolean(draft)} onChange={event => setRebinding({ ...rebinding, [tile.id]: event.target.value })}>
                  <option value="">Choose explicitly</option>{state.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} / {connection.model ?? "(unspecified model)"}</option>)}
                </select></label><button className="button small" disabled={busy || dirty || Boolean(refresh) || board.archived || Boolean(board.release) || !rebinding[tile.id]}>Bind source without running</button>
              </form>}
              <footer className="dashboard-tile-footer">
                <span>{tile.source ? `${tile.source.connectionName}${tile.source.model ? ` / ${tile.source.model}` : ""}` : tile.unboundSource ? "Model not connected" : tile.note !== undefined ? "Local note" : "Snapshot only"}</span>
                {tile.visual.units && <span>{tile.visual.units}</span>}
                {tile.source && <button className="text-button" disabled={busy || Boolean(refresh) || Boolean(draft) || board.archived || Boolean(board.release)} onClick={() => void refreshPage(false, tile.id)}>Refresh tile</button>}
                {tile.source && <button className="text-button" disabled={busy || Boolean(draft)} onClick={() => void perform(() => action("dashboards.openQuery", { id: board.id, tileId: tile.id })).then(result => { if (result) onQuery(); })}>Explore query</button>}
                {tile.note === undefined && <button className="text-button" onClick={() => setSourceTile(sourceTile === tile.id ? "" : tile.id)}>Scope &amp; evidence</button>}
                {!draft && <button className="text-button" disabled={busy || Boolean(refresh) || board.archived || Boolean(board.release)} onClick={() => void perform(() => action("dashboards.duplicate", { id: board.id, expectedRevision: board.revision, tileId: tile.id }))}>Duplicate tile</button>}
              </footer>
              {status?.status === "running" || status?.status === "queued" ? <p className="dashboard-tile-status" role="status">{status.status} · previous capture remains visible</p> :
                status?.error ? <p className="field-error" role="alert">{status.error}</p> : null}
              {sourceTile === tile.id && <TileEvidence tile={tile} snapshot={tile.snapshotId ? snapshots[tile.snapshotId] : undefined}
                canShare={state.hostMode === "copilot-canvas" && !busy && !draft && !refresh}
                onOffice={format => void perform(() => action("copilot.officeHandoff", { id: board.id, expectedRevision: board.revision,
                  tileId: tile.id, snapshotId: tile.snapshotId, format })).then(sent => {
                    if (sent) setNotice("The exact capture was shared for a new Office document. Creation continues in the conversation; no document completion is claimed here.");
                  })}/>}
              {tile.snapshotId && snapshots[tile.snapshotId]?.checks && <details className="dashboard-checks">
                <summary>Captured assertions: {snapshots[tile.snapshotId].checks!.status}</summary>
                <p>Checks apply only to this captured run and these rules. A pass is not proof of business correctness.</p>
                <ul>{snapshots[tile.snapshotId].checks!.results.map(result => <li key={result.id}><strong>{result.status}</strong> · {result.actual === undefined ? "" : `${result.actual} · `}{result.message}</li>)}</ul>
                <pre>{JSON.stringify(snapshots[tile.snapshotId].checks!.rules, null, 2)}</pre>
              </details>}
              {sourceTile === tile.id && Boolean(tile.previousSnapshotIds.length) && <CaptureHistory board={board} tile={tile}
                disabled={busy || Boolean(draft) || Boolean(refresh) || Boolean(board.release)} onRestore={id => perform(() => action("dashboards.restoreCapture", { id: board.id, expectedRevision: board.revision, tileId: tile.id, snapshotId: id }))}/>}
            </article>;
          })}
          {!board.tiles.some(tile => tile.pageId === page?.id && !tile.archived) && <div className="dashboard-empty"><h3>No visuals on this page yet</h3><p>Run a query and choose Pin to dashboard, or add an existing saved visual.</p><button className="button" onClick={onQuery}>Open Queries</button></div>}
          {draft && page && <button className="dashboard-add-note" onClick={() => {
            const id = crypto.randomUUID(); setDraft({ ...draft, tiles: [...draft.tiles, { id, pageId: page.id, title: "Notes", width: 6, height: 240,
              note: "", visual: { type: "table", units: "" }, mappings: [], previousSnapshotIds: [] }] }); setTileId(id);
          }}><Icon name="plus" size={18}/>Add note</button>}
        </div>
        <details className="dashboard-storage"><summary>Definition transfer &amp; reviewed release</summary>
          <p>Definition JSON includes saved query text, literal bindings, filters and notes. It excludes result rows and connection credentials. Review the file before sharing it outside this workspace.</p>
          <button className="button" disabled={busy || dirty} onClick={() => void perform(() => action("dashboards.export", { id: board.id, expectedRevision: board.revision }))
            .then(definition => { if (definition) downloadBlob(new Blob([JSON.stringify(definition)], { type: "application/json" }), "dashboard-definition.json"); })}>Download definition with saved scope</button>
          {!board.release && <form onSubmit={event => {
            event.preventDefault();
            void perform(() => action<Dashboard>("dashboards.freeze", { id: board.id, expectedRevision: board.revision, reviewer }))
              .then(saved => { if (saved) { switchBoard(saved.id); setReviewer(""); } });
          }}>
            <p>Freeze the current layout, notes and captures as an immutable reviewed copy. Existing captures remain protected from cleanup. This does not prove the analysis is correct.</p>
            <label>Review attribution<input required maxLength={120} value={reviewer} disabled={busy} onChange={event => setReviewer(event.target.value)}/></label>
            <button className="button" disabled={busy || dirty || Boolean(refresh) || !reviewer.trim()}>Freeze reviewed release</button>
          </form>}
        </details>
        {activeTile && draft && <aside className="dashboard-inspector" aria-label="Edit dashboard tile">
          <div className="dashboard-titlebar"><h3>Edit tile</h3><button className="icon-button" aria-label="Close tile editor" onClick={() => setTileId("")}><Icon name="close" size={14}/></button></div>
          <label>Title<input maxLength={120} value={activeTile.title} onChange={event => editTile({ title: event.target.value })}/></label>
          <label>Explanation<textarea rows={3} maxLength={600} value={activeTile.description ?? ""} onChange={event => editTile({ description: event.target.value })}/></label>
          <label>Page<select value={activeTile.pageId} onChange={event => editTile({ pageId: event.target.value })}>{draft.pages.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <label>Width<select value={activeTile.width} onChange={event => editTile({ width: Number(event.target.value) })}><option value={4}>One third</option><option value={6}>Half</option><option value={8}>Two thirds</option><option value={12}>Full width</option></select></label>
          <label>Height<select value={activeTile.height} onChange={event => editTile({ height: Number(event.target.value) })}>{[160, 240, 360, 480, 600].map(height => <option key={height} value={height}>{height} pixels</option>)}</select></label>
          {activeTile.note !== undefined ? <WritingEditor label="Note Markdown" kind="note" rows={10} maxLength={16000} value={activeTile.note} onChange={note => editTile({ note })}/> : <>
            <label>Visual<select value={activeTile.visual.type} onChange={event => {
              const type = event.target.value as DashboardVisual["type"], columns = snapshots[activeTile.snapshotId ?? ""]?.columns ?? [];
              editTile({ ...(!["bar", "line"].includes(type) ? { crossFilterId: undefined } : {}), visual: { units: activeTile.visual.units, type, ...(["bar", "line", "scatter"].includes(type) ? { chart: {
                type: type as "bar" | "line" | "scatter", x: columns[0]?.id ?? "", y: columns.find(isNumeric)?.id ?? "", aggregation: "none" as const } } : {}),
                ...(["waterfall", "small-multiples"].includes(type) ? { advanced: { type: type as "waterfall" | "small-multiples",
                  x: columns[0]?.id ?? "", y: columns.find(isNumeric)?.id ?? "", group: columns[1]?.id ?? "", start: "0" } } : {}),
                ...(type === "matrix" ? { matrix: { row: columns[0]?.id ?? "", column: columns[1]?.id ?? "", value: columns.find(isNumeric)?.id ?? columns[0]?.id ?? "",
                  aggregation: "none" as const, emphasizeNegative: false } } : {}) } });
            }}>{["table", "indicator", "bar", "line", "scatter", "matrix", "waterfall", "small-multiples"].map(type => <option key={type} value={type}>{type}</option>)}</select></label>
            {activeSelection?.error && <p className="field-error" role="alert">{activeSelection.error}</p>}
            {activeTile.visual.matrix && <>
              {(["row", "column", "value"] as const).map(field => <label key={field}>Matrix {field} field
                <select value={activeVisual?.matrix?.[field] ?? ""} onChange={event => {
                  if (activeTile.visual.matrix) editTile({ visual: { ...activeTile.visual, matrix: { ...activeTile.visual.matrix, [field]: event.target.value } } });
                }}><option value="">Choose a field</option>{snapshots[activeTile.snapshotId ?? ""]?.columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select>
              </label>)}
              <label>Matrix aggregation<select value={activeTile.visual.matrix.aggregation} onChange={event => {
                if (activeTile.visual.matrix) editTile({ visual: { ...activeTile.visual, matrix: { ...activeTile.visual.matrix, aggregation: event.target.value as "none" | "sum" | "count" } } });
              }}><option value="none">None: one row per cell</option><option value="sum">Exact sum of retrieved rows</option><option value="count">Count retrieved rows</option></select></label>
              <label className="dashboard-checkbox"><input type="checkbox" checked={activeTile.visual.matrix.emphasizeNegative} onChange={event => {
                if (activeTile.visual.matrix) editTile({ visual: { ...activeTile.visual, matrix: { ...activeTile.visual.matrix, emphasizeNegative: event.target.checked } } });
              }}/>Emphasize negative numeric values</label>
            </>}
            {["bar", "line"].includes(activeTile.visual.type) && <label>Chart category stages shared filter<select value={activeTile.crossFilterId ?? ""} onChange={event => editTile({ crossFilterId: event.target.value || undefined })}>
              <option value="">No cross-filter action</option>{draft.filters.map(filter => <option key={filter.id} value={filter.id}>{filter.label} ({filter.type})</option>)}
            </select></label>}
            {activeTile.visual.advanced && <>
              {(["x", "y", ...(activeTile.visual.type === "small-multiples" ? ["group" as const] : [])] as const).map(field => <label key={field}>
                {field === "x" ? "Category field" : field === "y" ? "Numeric value field" : "Grouping field"}
                <select value={activeVisual?.advanced?.[field] ?? ""} onChange={event => {
                  if (activeTile.visual.advanced) editTile({ visual: { ...activeTile.visual, advanced: { ...activeTile.visual.advanced, [field]: event.target.value } } });
                }}><option value="">Choose a field</option>{snapshots[activeTile.snapshotId ?? ""]?.columns.filter(column => field !== "y" || isNumeric(column)).map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select>
              </label>)}
              {activeTile.visual.type === "waterfall" && <label>Starting amount<input maxLength={1000} value={activeTile.visual.advanced.start} onChange={event => {
                if (activeTile.visual.advanced) editTile({ visual: { ...activeTile.visual, advanced: { ...activeTile.visual.advanced, start: event.target.value } } });
              }}/></label>}
              <p>Waterfall treats all returned rows as signed changes. Small multiples require unique categories within each of at most eight groups. No hidden aggregation or sampling.</p>
            </>}
            <label>Units<input maxLength={120} value={activeTile.visual.units} placeholder="e.g. USD; verify the source measure" onChange={event => editTile({ visual: { ...activeTile.visual, units: event.target.value } })}/></label>
            {activeTile.visual.type === "indicator" && <label>Value column<select value={activeVisual?.valueColumn ?? ""} onChange={event => editTile({ visual: { ...activeTile.visual, valueColumn: event.target.value } })}><option value="">Choose a column</option>
              {snapshots[activeTile.snapshotId ?? ""]?.columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>}
            {activeTile.visual.type === "indicator" && <label>Context column<select value={activeVisual?.contextColumn ?? ""} onChange={event => {
              const visual = { ...activeTile.visual };
              if (event.target.value) visual.contextColumn = event.target.value; else delete visual.contextColumn;
              editTile({ visual });
            }}><option value="">No supporting context</option>{snapshots[activeTile.snapshotId ?? ""]?.columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>}
            {activeTile.visual.chart && ["bar", "line", "scatter"].includes(activeTile.visual.type) && (["x", "y"] as const).map(axis => <label key={axis}>{axis.toUpperCase()} field<select value={activeVisual?.chart?.[axis] ?? ""} onChange={event => {
              if (activeTile.visual.chart) editTile({ visual: { ...activeTile.visual, chart: { ...activeTile.visual.chart, [axis]: event.target.value } } });
            }}><option value="">Choose a field</option>{snapshots[activeTile.snapshotId ?? ""]?.columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>)}
            {activeTile.visual.chart && <label>Legend / series<select value={activeVisual?.chart?.legend ?? ""} onChange={event => {
              if (!activeTile.visual.chart) return;
              const { legend: _legend, hiddenSeries: _hidden, ...chart } = activeTile.visual.chart;
              editTile({ visual: { ...activeTile.visual, chart: { ...chart, ...(event.target.value ? { legend: event.target.value } : {}) } } });
            }}><option value="">One series</option>{snapshots[activeTile.snapshotId ?? ""]?.columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>}
            {activeTile.visual.chart && <label>Aggregation<select value={activeTile.visual.chart.aggregation} disabled={activeTile.visual.type === "scatter"} onChange={event => {
              if (activeTile.visual.chart) editTile({ visual: { ...activeTile.visual, chart: { ...activeTile.visual.chart,
                aggregation: event.target.value as "none" | "sum" | "average" | "count" } } });
            }}><option value="none">None: individual rows</option><option value="sum">Sum by X</option><option value="average">Average by X</option><option value="count">Count by X</option></select></label>}
            {activeTile.visual.chart && snapshots[activeTile.snapshotId ?? ""] && <ChartFilters data={snapshots[activeTile.snapshotId ?? ""]}
              filters={activeVisual?.chart?.filters ?? []} onChange={filters => {
                if (activeTile.visual.chart) editTile({ visual: { ...activeTile.visual, chart: { ...activeTile.visual.chart, filters } } });
              }}/>}
            {activeTile.visual.chart?.hiddenSeries?.length ? <button className="button quiet small" onClick={() => {
              if (activeTile.visual.chart) editTile({ visual: { ...activeTile.visual, chart: { ...activeTile.visual.chart, hiddenSeries: [] } } });
            }}>Restore all saved series</button> : null}
            <h4>Shared filter mappings</h4>
            {!detail?.filterTargets?.[activeTile.id]?.length && <p>This source has no verified builder fields or typed template parameters. It remains independent of shared filters.</p>}
            {(detail?.filterTargets?.[activeTile.id] ?? []).map(target => <label key={target.name}>{target.label} ({target.type})<select value={activeTile.mappings.find(mapping => mapping.parameter === target.name)?.filterId ?? ""} onChange={event => editTile({
              mappings: [...activeTile.mappings.filter(mapping => mapping.parameter !== target.name), ...(event.target.value ? [{ parameter: target.name, filterId: event.target.value }] : [])],
            })}><option value="">Keep source scope</option>{draft.filters.filter(filter => filter.type === target.type).map(filter => <option key={filter.id} value={filter.id}>{filter.label}</option>)}</select></label>)}
            {(activeTile.source || activeTile.unboundSource) && <>
              <h4>Result assertions</h4><p>Saving rules runs nothing. The next explicit refresh evaluates them against its complete capture. Capped results are not evaluated.</p>
              {(activeTile.assertions ?? []).map((rule, index) => {
                const update = (next: ResultAssertion) => editTile({ assertions: activeTile.assertions!.map(item => item.id === rule.id ? next : item) });
                const columns = snapshots[activeTile.snapshotId ?? ""]?.columns ?? [];
                return <fieldset className="dashboard-assertion" key={rule.id}><legend>Assertion {index + 1}</legend>
                  <label>Assertion type<select value={rule.type} onChange={event => {
                    const type = event.target.value as ResultAssertion["type"];
                    update({ id: rule.id, type, ...(type === "row-count" ? {} : { columnId: columns[0]?.id ?? "" }),
                      ...(["row-count", "sum-range"].includes(type) ? { min: "0" } : {}),
                      ...(type === "schema-type" ? { expectedType: columns[0]?.dataType ?? "String" } : {}) });
                  }}>
                    <option value="row-count">Row count range</option><option value="non-null">No nulls</option><option value="unique">Unique column values</option>
                    <option value="sum-range">Exact sum range</option><option value="schema-type">Provider column type</option>
                  </select></label>
                  {rule.type !== "row-count" && <label>Assertion column{columns.length ? <select value={rule.columnId ?? ""} onChange={event => update({ ...rule, columnId: event.target.value })}>
                    <option value="">Choose a field</option>{columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select>
                    : <input value={rule.columnId ?? ""} maxLength={512} onChange={event => update({ ...rule, columnId: event.target.value })}/>}</label>}
                  {["row-count", "sum-range"].includes(rule.type) && (["min", "max"] as const).map(bound => <label key={bound}>{bound === "min" ? "Minimum (inclusive)" : "Maximum (inclusive)"}
                    <input value={rule[bound] ?? ""} maxLength={1000} placeholder="No bound" onChange={event => {
                      const next = { ...rule }; if (event.target.value === "") delete next[bound]; else next[bound] = event.target.value; update(next);
                    }}/></label>)}
                  {rule.type === "schema-type" && <label>Expected provider type<input maxLength={80} value={rule.expectedType ?? ""} onChange={event => update({ ...rule, expectedType: event.target.value })}/></label>}
                  <button className="button quiet" onClick={() => editTile({ assertions: activeTile.assertions!.filter(item => item.id !== rule.id) })}>Remove assertion</button>
                </fieldset>;
              })}
              <button className="button" disabled={(activeTile.assertions?.length ?? 0) >= 20} onClick={() => editTile({
                assertions: [...(activeTile.assertions ?? []), { id: crypto.randomUUID(), type: "row-count", min: "1" }],
              })}>Add assertion</button>
            </>}
          </>}
          <div className="button-row">{[-1, 1].map(direction => <button className="button" key={direction} onClick={() => {
            const tiles = [...draft.tiles], index = tiles.findIndex(tile => tile.id === tileId), target = index + direction;
            if (target < 0 || target >= tiles.length) return;
            [tiles[index], tiles[target]] = [tiles[target], tiles[index]]; setDraft({ ...draft, tiles });
          }}>{direction < 0 ? "Move earlier" : "Move later"}</button>)}</div>
          <button className="button" onClick={() => editTile({ archived: !activeTile.archived })}>{activeTile.archived ? "Restore tile" : "Archive tile"}</button>
        </aside>}
      </div>
    </>}
    <details className="dashboard-storage"><summary>Saved captures and storage</summary><p>Each tile retains its current and three previous captures. Snapshots are bounded to 10,000 rows / 1.2 MB; nothing is silently sampled. Unreferenced captures can be removed without changing current or previous tile data.</p>
      <button className="button" disabled={busy || Boolean(refresh) || dirty} onClick={() => void perform(() => action<{ removed: number }>("dashboards.cleanup")).then(result => { if (result) setNotice(`Removed ${result.removed} unreferenced captures.`); })}>Remove unused captures</button>
    </details>
    {deleteTarget && <dialog ref={deleteDialog} className="close-query-dialog dashboard-delete-dialog" aria-labelledby="delete-dashboard-heading"
      aria-describedby="delete-dashboard-warning" onCancel={event => { event.preventDefault(); if (!deleting) setDeleteTarget(null); }}>
      <h2 id="delete-dashboard-heading">Delete "{deleteTarget.title}"?</h2>
      <p id="delete-dashboard-warning">Permanently remove this dashboard, including its pages, tiles, notes and saved refresh settings. This cannot be undone.</p>
      <p>Query tabs, saved artifacts and other dashboards stay intact, including any copies or reviewed releases. Captures they use are kept.</p>
      <p className="muted">Use Archive instead if you may want this dashboard back. Unreferenced capture data remains until you choose Remove unused captures.</p>
      {deleteError && <p className="field-error" role="alert">{deleteError}</p>}
      <div className="dialog-actions">
        <button className="button" autoFocus disabled={deleting} onClick={() => setDeleteTarget(null)}>Keep dashboard</button>
        <button className="button danger-text" disabled={deleting || Boolean(refresh)} onClick={() => void deleteDashboard()}>
          {deleting ? "Deleting..." : "Delete permanently"}
        </button>
      </div>
    </dialog>}
  </section>;
}

function CaptureHistory({ board, tile, disabled, onRestore }: {
  board: Dashboard; tile: DashboardTile; disabled: boolean; onRestore: (id: string) => Promise<unknown>;
}) {
  const [selected, setSelected] = useState(""), [snapshot, setSnapshot] = useState<DashboardSnapshot>(), [error, setError] = useState("");
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController(); setSnapshot(undefined); setError("");
    void api.read<DashboardSnapshot>("dashboards.snapshot", { id: board.id, tileId: tile.id, snapshotId: selected }, abort.signal)
      .then(value => { if (!abort.signal.aborted) setSnapshot(value); })
      .catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [board.id, tile.id, selected]);
  return <details className="dashboard-evidence"><summary>Previous captures ({tile.previousSnapshotIds.length})</summary>
    <label>Capture<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose a previous capture</option>
      {tile.previousSnapshotIds.map((id, index) => <option key={id} value={id}>{index + 1}: {id.slice(0, 8)}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}
    {snapshot && <><p>{new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.rows.length} rows{snapshot.truncated ? " · Truncated" : ""}</p>
      <div className="dashboard-history-data"><SnapshotTable snapshot={snapshot}/></div><TileEvidence tile={tile} snapshot={snapshot}/>
      <button className="button" disabled={disabled || !tile.previousSnapshotIds.includes(selected)} onClick={() => void onRestore(selected).then(() => { setSelected(""); setSnapshot(undefined); })}>Restore this capture</button>
      <p>No query will run. Restoring changes the displayed capture, not the saved source or pending filters.</p></>}
  </details>;
}

function DashboardTileData({ boardId, tile, onSnapshot, retry, onSelectCategory }: { boardId: string; tile: DashboardTile; onSnapshot: (snapshot: DashboardSnapshot) => void; retry: number;
  onSelectCategory?: (value: string | number | boolean | null) => void }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController(); setError(""); setSnapshot(null);
    if (tile.snapshotId) void api.read<DashboardSnapshot>("dashboards.snapshot", { id: boardId, tileId: tile.id, snapshotId: tile.snapshotId }, abort.signal)
      .then(value => { if (!abort.signal.aborted) { setSnapshot(value); onSnapshot(value); } })
      .catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [boardId, tile.id, tile.snapshotId, retry, onSnapshot]);
  if (error) return <p className="field-error" role="alert">{error}</p>;
  if (!snapshot) return <div className={`dashboard-tile-body${tile.unboundSource ? " dashboard-tile-pending" : ""}`}><p>{tile.snapshotId ? "Loading saved capture..."
    : tile.unboundSource ? "No data loaded. Use Dashboard model setup above, or connect this source below, then refresh."
    : tile.source ? "No saved capture. Refresh explicitly to retrieve data."
    : "No data was imported for this visual-only tile. Add its saved visual again, then archive this placeholder."}</p></div>;
  const { visual, error: visualError } = capturedVisual(tile.visual, snapshot);
  const index = snapshot.columns.findIndex(column => column.id === visual.valueColumn);
  const contextIndex = snapshot.columns.findIndex(column => column.id === visual.contextColumn);
  return <>
    <p className="dashboard-captured">Captured {new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.rows.length.toLocaleString()} rows{snapshot.truncated ? " · CAPPED SOURCE" : ""}
      {snapshot.durationMs !== undefined ? ` · Last query ${formatDuration(snapshot.durationMs)} (excludes queue)` : ""}</p>
    <div className="dashboard-tile-body">
      {visualError ? <p className="field-error" role="alert">{visualError}</p> : visual.type === "table" ? <SnapshotTable snapshot={snapshot}/> : visual.type === "indicator" ?
        snapshot.rows.length === 1 && index >= 0 ? <div className="dashboard-indicator"><strong>{snapshot.rows[0][index] === null ? "No data" : displayCell(snapshot.rows[0][index])}</strong>
          <span title={snapshot.columns[index].name}>{contextIndex >= 0 && visual.units ? visual.units : resultColumnLabels(snapshot.columns)[index]}</span>
          {contextIndex >= 0 && <p className="dashboard-indicator-context">{snapshot.rows[0][contextIndex] === null ? "Supporting context unavailable." : displayCell(snapshot.rows[0][contextIndex])}</p>}</div>
          : <p className="field-error">An indicator requires exactly one result row and a selected value column. No totals are inferred.</p>
        : visual.matrix ? <SavedMatrix data={snapshot} config={visual.matrix}/>
        : visual.advanced ? <AdvancedVisual data={snapshot} config={visual.advanced}/>
        : visual.chart ? <LocalChart key={`${snapshot.id}:${JSON.stringify(visual.chart)}`} data={snapshot} truncated={snapshot.truncated} initial={visual.chart} onSave={() => {}} readOnly onSelectCategory={onSelectCategory}/> : <p>Choose chart fields in Edit tile.</p>}
    </div>
    {tile.visual.type !== "table" && <details className="dashboard-exact-data"><summary>Exact captured data</summary><SnapshotTable snapshot={snapshot}/></details>}
  </>;
}
export function SnapshotTable({ snapshot }: { snapshot: Pick<DashboardSnapshot, "columns" | "rows"> }) {
  const [offset, setOffset] = useState(0);
  const labels = resultColumnLabels(snapshot.columns);
  return <div className="dashboard-table"><div className="dashboard-table-scroll"><table><thead><tr>{snapshot.columns.map((column, index) => <th key={column.id} title={`${column.name} (${column.dataType})`}>{labels[index]}</th>)}</tr></thead>
    <tbody>{snapshot.rows.slice(offset, offset + 50).map((row, index) => <tr key={offset + index}>{row.map((cell, column) => <td key={column} className={isNumeric(snapshot.columns[column]) ? "numeric" : ""} title={cell === null ? "BLANK" : String(cell)}>{cell === null ? <span className="muted">BLANK</span> : displayCell(cell)}</td>)}</tr>)}</tbody></table></div>
    <div className="dashboard-pagination"><span>{snapshot.rows.length ? offset + 1 : 0}-{Math.min(offset + 50, snapshot.rows.length)} of {snapshot.rows.length}</span>
      <button className="text-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button className="text-button" disabled={offset + 50 >= snapshot.rows.length} onClick={() => setOffset(offset + 50)}>Next</button></div></div>;
}
function TileEvidence({ tile, snapshot, canShare, onOffice }: { tile: DashboardTile; snapshot?: DashboardSnapshot;
  canShare?: boolean; onOffice?: (format: "excel" | "powerpoint") => void }) {
  return <div className="dashboard-evidence"><h4>Captured scope</h4>
    <p>{snapshot?.origin === "artifact" ? "Imported visual: provenance is descriptive, not verified execution evidence." : "Captured query inputs are shown below. No full-model freshness claim is made."}</p>
    <table><thead><tr><th>Scope</th><th>Value</th></tr></thead><tbody>
      <tr><td>Model</td><td>{snapshot?.source?.model ?? tile.source?.model ?? "Unverified"}</td></tr>
      <tr><td>Query revision</td><td>{snapshot?.source?.queryRevision ?? "Not recorded"}</td></tr>
      <tr><td>Units</td><td>{tile.visual.units || "Not documented"}</td></tr>
      <tr><td>Source model refresh</td><td>Unknown</td></tr>
      <tr><td>Completeness</td><td>{snapshot ? snapshot.truncated ? "Capped captured result" : "Complete returned result; not necessarily the full population" : "No capture"}</td></tr>
    </tbody></table>
    <h4>Executed filter mappings</h4>{snapshot?.executedFilters.length ? <table><thead><tr><th>Filter</th><th>Parameter</th><th>Exact value</th></tr></thead><tbody>{snapshot.executedFilters.map(filter =>
      <tr key={filter.parameter}><td>{filter.label}</td><td><code>{filter.parameter}</code></td><td><code>{JSON.stringify(filter.value)}</code></td></tr>)}</tbody></table> : <p>No dashboard filter mappings were used for this capture. Fixed restrictions may be present in the source query.</p>}
    {snapshot?.source && <details><summary>Executed source and parameters</summary><pre>{snapshot.source.query}</pre><pre>{JSON.stringify(snapshot.source.parameters, null, 2)}</pre></details>}
    {tile.source && <details><summary>Saved refresh source</summary><pre>{tile.source.query}</pre></details>}
    {snapshot && <button className="button small" onClick={() => downloadBlob(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }), "dashboard-capture.json")}>Download exact capture</button>}
    {snapshot && onOffice && <details className="dashboard-office"><summary>Create an Office document with Copilot</summary>
      <p>This explicitly sends all {snapshot.rows.length.toLocaleString()} captured rows, visual settings, units, mapped filter values and capture checks/provenance to the conversation. Source query and full binding fields are excluded. Limit: 2,000 rows / 96 KiB; nothing is sampled. Copilot then attempts to create a new local document; this action does not upload or publish it.</p>
      <div className="button-row"><button className="button small" disabled={!canShare} onClick={() => onOffice("excel")}>Share this capture for Excel</button>
        <button className="button small" disabled={!canShare} onClick={() => onOffice("powerpoint")}>Share this capture for PowerPoint</button></div>
      {!canShare && <p>Requires a connected Copilot canvas and no active layout edit or refresh.</p>}
    </details>}
  </div>;
}
