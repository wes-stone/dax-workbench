import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartConfig, Run, Snapshot } from "../contracts/workbench";
import type { ArtifactCatalog, ArtifactVisual } from "../contracts/artifacts";
import type { Action } from "./useWorkbench";
import { api, errorMessage, type ExcelOpenReceipt } from "./api";
import { DataGrid, type CellReference, type LoadedRows } from "./Grid";
import { LocalChart, type VisualCapture } from "./Chart";
import { folderPath } from "./artifacts-model";
import { connectionKindLabel, formatDuration, RUNNING, scopeLabel } from "./model";
import { Icon } from "./icons";
import type { DashboardVisual } from "../contracts/dashboards";
import { KeyedComparison, ResultAnalysis } from "./ResultAnalysis";
import { chartForSource, chartSourceKey } from "../shared/chart-data.mjs";
import { emptyPivot, pivotSourceKey } from "../shared/pivot-config.mjs";
import type { PivotConfig } from "../contracts/pivot";

export function ResultsPane({ run, state, action, onContext, onCapabilities, onRun, onReturnToQuery, onArtifactSaved, onArtifactDraftChange, onPinDashboard, focused, onFocusChange }: {
  run: Run | undefined; state: Snapshot; action: Action; onContext: () => void; onCapabilities: () => void; onRun: () => void;
  onArtifactSaved?: (id: string) => void; onArtifactDraftChange?: (dirty: boolean) => void;
  onReturnToQuery?: () => void;
  focused?: boolean; onFocusChange?: (focused: boolean) => void;
  onPinDashboard?: (request: { runId: string; resultSetId: string; title: string; visual: DashboardVisual }) => void;
}) {
  const [tab, setTab] = useState<"grid" | "chart" | "explore" | "compare" | "messages">("grid");
  const [comparisonMode, setComparisonMode] = useState<"keyed" | "ordered">("keyed");
  const pivotViews = useRef(new Map<string, PivotConfig>());
  const [resultId, setResultId] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; data: LoadedRows } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedCount, setLoadedCount] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState("");
  const [sharing, setSharing] = useState(false);
  const [exporting, setExporting] = useState<"xlsx" | "csv" | "json" | null>(null);
  const exportBusy = useRef(false);
  const [exportError, setExportError] = useState("");
  const [downloadFallback, setDownloadFallback] = useState<"xlsx" | "csv" | null>(null);
  const [notice, setNotice] = useState("");
  const [visualDraft, setVisualDraft] = useState<{ visual: ArtifactVisual; title: string } | null>(null);
  const [visualError, setVisualError] = useState("");
  const result = run?.resultSets.find(item => item.id === resultId) ?? run?.resultSets[0];
  const [displayedChart, setDisplayedChart] = useState<{ key: string; config: ChartConfig | null }>();
  const chartKey = `${run?.id}:${result?.id}`;
  const pivotKey = run && result ? pivotSourceKey(run, result) : "";
  const savedPivot = state.pivotLayouts?.find(layout => layout.source === pivotKey)?.config ?? emptyPivot();
  const pivot = pivotViews.current.get(pivotKey) ?? savedPivot;
  const exportKey = useRef(chartKey);
  exportKey.current = chartKey;
  const data = loaded?.key === chartKey ? loaded.data : null;
  const chartDisplayed = useCallback((config: ChartConfig | null) => setDisplayedChart({ key: chartKey, config }), [chartKey]);
  const pinChart = displayedChart?.key === chartKey ? displayedChart.config : null;
  const active = state.documents.find(document => document.id === state.activeDocumentId);
  const demo = active?.connectionId === "demo:contoso";
  const historical = run && (run.documentId !== active?.id || run.connectionId !== active?.connectionId || run.revision !== active?.revision);
  const modelPreview = run?.querySource === "model-preview";
  const running = run && RUNNING.has(run.status);
  const truncated = Boolean(run?.truncated || result?.truncated);
  useEffect(() => {
    onArtifactDraftChange?.(Boolean(visualDraft));
    return () => onArtifactDraftChange?.(false);
  }, [visualDraft, onArtifactDraftChange]);
  useEffect(() => { setResultId(""); setFilter(""); setNotice(""); if (run?.querySource === "model-preview") setTab("grid"); }, [run?.id]);
  useEffect(() => { setNotice(""); setExportError(""); setDownloadFallback(null); }, [chartKey]);
  useEffect(() => {
    const abort = new AbortController();
    setLoaded(null); setLoadError(""); setLoadedCount(0);
    if (!run || !result || !run.retained) { setLoading(false); return; }
    const runId = run.id, resultSetId = result.id;
    setLoading(true);
    void (async () => {
      const rows: LoadedRows["rows"] = [];
      let columns = result.columns;
      let total = result.rowCount;
      do {
        const page = await api.page(runId, resultSetId, rows.length, abort.signal);
        if (abort.signal.aborted) return;
        if (page.offset !== rows.length || page.total !== result.rowCount || rows.length + page.rows.length > page.total
          || JSON.stringify(page.columns) !== JSON.stringify(result.columns))
          throw new Error("Result pages did not match the captured metadata. Reload this retained result.");
        columns = page.columns;
        total = page.total;
        rows.push(...page.rows);
        setLoadedCount(rows.length);
        if (!page.rows.length && rows.length < total) throw new Error("The retained preview is incomplete. Retry after the run finishes.");
      } while (rows.length < total);
      if (!abort.signal.aborted) setLoaded({ key: `${runId}:${resultSetId}`, data: { rows, columns } });
    })().catch(reason => { if (!abort.signal.aborted) setLoadError(errorMessage(reason)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [run?.id, run?.retained, result?.id, result?.rowCount, retry]);
  async function share(selected: CellReference[]) {
    if (!run || !result || !selected.length) return;
    setSharing(true);
    try {
      await action("selection.set", { cells: selected.map(cell => ({ runId: run.id, resultSetId: result.id, ...cell })) });
      setNotice(`${selected.length} cells explicitly shared with Copilot.`);
      onContext();
    } catch (reason) { setNotice(errorMessage(reason)); }
    finally { setSharing(false); }
  }
  async function exportResult(format: "csv" | "json" | "xlsx", downloadOnly = false) {
    if (!run || !result || exportBusy.current) return;
    exportBusy.current = true;
    const key = chartKey;
    setExporting(format); setNotice(""); setExportError(""); setDownloadFallback(null);
    try {
      if (format === "json" || downloadOnly) {
        await api.export(run.id, result.id, format);
        if (exportKey.current === key) setNotice(`${format.toUpperCase()} download requested from the retained ${truncated ? "capped preview" : "result"}. No query was rerun.`);
      } else {
        const output = await api.action<ExcelOpenReceipt>("results.openExcel", { runId: run.id, resultSetId: result.id, format });
        if (exportKey.current === key) {
          const precision = format === "xlsx" ? `${(output.preservedNumbers ?? 0).toLocaleString()} numeric cells kept as exact text.`
            : "Excel may reinterpret CSV numbers and dates; use XLSX to preserve exact values.";
          setNotice(`Opening ${format.toUpperCase()} in desktop Excel (add-ins off): ${output.rowCount.toLocaleString()} ${output.partial ? "partial/capped" : "captured"} rows. ${precision} No query was rerun. Saved at ${output.filePath}`);
        }
      }
    }
    catch (reason) {
      if (exportKey.current === key) {
        setExportError(errorMessage(reason));
        if (format !== "json" && !downloadOnly) setDownloadFallback(format);
      }
    }
    finally { exportBusy.current = false; setExporting(null); }
  }
  function captureVisual(capture: VisualCapture) {
    if (!run || !result) return;
    const { approximate, scope, ...values } = capture;
    const visual: ArtifactVisual = { version: 1, ...values, provenance: {
      description: `Captured from the displayed query result (${run.rowCount.toLocaleString()} retrieved rows). ${scope} ${approximate ? "Saved aggregates use approximate JavaScript arithmetic." : "Captured values retain their original types and precision."} This is a saved snapshot, not a live connection.`,
      runId: run.id, resultSetId: result.id, queryRevision: run.revision, truncated, approximate,
    } };
    if (visual.rows.length > 2000 || new TextEncoder().encode(JSON.stringify(visual)).length > 192 * 1024) {
      setVisualError("This visual exceeds 2,000 captured rows or 192 KiB. Choose an aggregation, or refine the query explicitly. No rows were sampled or saved."); return;
    }
    setVisualError(""); setVisualDraft({ visual, title: `${state.documents.find(document => document.id === run.documentId)?.title ?? "Query result"} - visual`.slice(0, 120) });
  }
  return <section className="results-pane" aria-label="Query output">
    <div className="results-heading">
      <div className="result-tabs" role="tablist" aria-label="Result views">
        {([{ id: "grid", label: "Results", icon: "table" }, { id: "chart", label: "Chart", icon: "chart" }, { id: "explore", label: "Explore", icon: "search" }, { id: "compare", label: "Compare", icon: "compare" }, { id: "messages", label: "Messages", icon: "info" }] as const).map(item => <button role="tab" aria-selected={tab === item.id} key={item.id} className={tab === item.id ? "active-tab" : ""} onClick={() => { setTab(item.id); onFocusChange?.(item.id === "explore"); }}><Icon name={item.icon} size={14}/>{item.label}{item.id === "messages" && (run?.warnings.length || run?.error) ? <span className="count-badge">{(run?.warnings.length ?? 0) + (run?.error ? 1 : 0)}</span> : null}</button>)}
      </div>
      {run && <div className="result-provenance"><span className={`status-dot ${run.status}`}/><span>{run.status}</span><span>{connectionKindLabel(run.connectionKind)}</span><span>rev {run.revision}</span><span>{formatDuration(run.durationMs)}</span></div>}
      {onFocusChange && <button className="button small quiet results-focus" onClick={() => onFocusChange(!focused)} title={focused ? "Restore the editor, model explorer and query builder" : "Use the full workspace for results"}><Icon name={focused ? "restore" : "expand"} size={14}/>{focused ? "Back to query" : "Focus view"}</button>}
    </div>
    {visualError && <div className="inline-alert error" role="alert"><span>{visualError}</span><button className="icon-button" aria-label="Dismiss visual error" onClick={() => setVisualError("")}><Icon name="close" size={12}/></button></div>}
    {visualDraft && <VisualSaveForm draft={visualDraft} action={action} onCancel={() => setVisualDraft(null)} onSaved={id => { setVisualDraft(null); onArtifactSaved?.(id); }}/>}
    <div className="results-capture-source" hidden={Boolean(visualDraft)}>
    {modelPreview ? <div className="model-preview-notice" role="status"><div><strong>{run.previewTitle}</strong>
      <p>Up to 100 rows · other filters not applied · query and builder unchanged.</p>
      <p>Tables: up to 32 visible columns, unspecified row order. Columns: distinct values. See Messages for coverage.</p></div>
      <div className="button-row">{running && <button className="button small" disabled={run.status === "cancelling"} onClick={() => void action("query.cancel", { runId: run.id }).catch(() => {})}>{run.status === "cancelling" ? "Cancelling..." : "Cancel preview"}</button>}
        {onReturnToQuery && <button className="button small" disabled={Boolean(visualDraft)} onClick={onReturnToQuery}>Back to query results</button>}</div></div>
      : historical && <div className="result-notice" role="status">Showing a captured result from revision {run.revision}, not the current editor. Running the query displays a new result.</div>}
    {tab === "compare" ? <div className="result-analysis-stack"><div className="comparison-mode button-row">
      <button className="button" aria-pressed={comparisonMode === "keyed"} onClick={() => setComparisonMode("keyed")}>Business keys</button>
      <button className="button" aria-pressed={comparisonMode === "ordered"} onClick={() => setComparisonMode("ordered")}>Ordered rows</button>
    </div>{comparisonMode === "ordered" ? <Comparison runs={state.runs} currentRun={run} action={action}/> : <KeyedComparison runs={state.runs}/>}</div>
      : tab === "messages" ? <Messages run={run} onCapabilities={onCapabilities} state={state}/>
      : !run ? <div className="empty-state result-welcome"><div className="empty-icon"><Icon name="table" size={30}/></div>
        <h2>{demo ? "Try Contoso in one click" : "Your next result starts here"}</h2>
        <p>{demo ? <>The sample query is already in the editor. Run it to load 36 invented retail rows: Desks, Chairs and Lamps.<br/>Then open Explore: check Product, Revenue and Units to build a pivot.</>
          : <>Choose a connection, write a read-only DAX query, and run it.<br/>Typed results stay local until you choose to share.</>}</p>
        <button className={`button ${demo ? "primary" : ""}`} onClick={onRun} disabled={!active?.connectionId || !state.native.available}><Icon name="play" size={13}/>{demo ? "Run Contoso sample" : "Run query"} <kbd>Ctrl ↵</kbd></button>
        <div className="empty-footnote">{demo ? "Synthetic data only · no model sign-in · nothing runs on open" : `${state.limits.maxRows.toLocaleString()} row preview · ${state.limits.timeoutSeconds}s timeout · no automatic sharing`}</div></div>
      : !run.retained && run.resultSets.length > 0 ? <div className="empty-state"><Icon name="history" size={25}/><h3>Raw results are no longer retained</h3><p>This history entry still contains query and timing metadata. Reopen and run the query explicitly to get fresh rows; pin results to retain them across restarts.</p></div>
      : !result ? <div className="empty-state">{running ? <><span className="query-progress"/><h3>{run.status === "cancelling" ? "Waiting for cancellation" : "Query in progress"}</h3><p>{run.status === "cancelling" ? (run.connectionKind === "powerbi-rest" ? "Stopping the local HTTP wait. Power BI server execution may continue." : "Cancellation has been requested. The native engine must acknowledge it.") : "The native companion is executing the captured query revision."}</p><span className="muted">{run.status} · revision {run.revision}</span></> : <><Icon name={run.error ? "warning" : "table"} size={25}/><h3>{run.error ? "The query did not complete" : "No result sets"}</h3><p>{run.error?.message ?? `This run finished with status “${run.status}” and returned no result sets.`}</p>{run.error && <code className="error-code">{run.error.code}</code>}</>}</div>
      : <div className="result-body">
        <div className="result-tools">
          <div className="result-set-picker"><label className="sr-only" htmlFor="result-set">Result set</label><select id="result-set" value={result.id} onChange={event => { setResultId(event.target.value); setFilter(""); }}>{run.resultSets.map((item, index) => <option key={item.id} value={item.id}>Result {index + 1} · {item.rowCount.toLocaleString()} rows</option>)}</select>{truncated && <span className="scope-badge">Capped preview</span>}{run.status !== "completed" && <span className="scope-badge">Partial · {run.status}</span>}</div>
          {tab === "explore" ? <button className="button small quiet" onClick={() => { setTab("grid"); onFocusChange?.(false); }}>Raw data &amp; exports</button> : <div className="result-actions">
            {onPinDashboard && <button className="button small" disabled={run.status !== "completed" || !data || (tab === "chart" && !pinChart)} onClick={() => onPinDashboard({
              runId: run.id, resultSetId: result.id, title: state.documents.find(document => document.id === run.documentId)?.title ?? "Query result",
              visual: tab === "chart" && pinChart ? { type: pinChart.type, chart: pinChart, units: "" } : { type: "table", units: "" },
            })}><Icon name="pin" size={13}/>Pin to dashboard</button>}
            <button className={`icon-button ${run.pinned ? "is-active" : ""}`} aria-label={run.pinned ? "Unpin results" : "Pin raw results to local disk"} title={run.pinned ? "Unpin raw results" : "Retain raw results on local disk"} aria-pressed={run.pinned} onClick={() => void action("run.pin", { runId: run.id }).catch(() => {})}><Icon name="pin" size={14}/></button>
            <button className="button small" disabled={Boolean(exporting) || !data || Boolean(running)} onClick={() => void exportResult("xlsx")} title="Save all captured rows and open an add-in-free desktop Excel window; ignores local filters, pivots and matrices"><Icon name="download" size={13}/>{exporting === "xlsx" ? "Opening..." : "Open in Excel"}</button>
            <button className="button small quiet" disabled={Boolean(exporting) || Boolean(running)} onClick={() => void exportResult("csv")} title="Save all captured rows as CSV and open an add-in-free Excel window. Excel may reformat numbers and dates."><Icon name="download" size={13}/>{exporting === "csv" ? "Opening CSV..." : "CSV"}</button>
            <button className="button small quiet" disabled={Boolean(exporting) || Boolean(running)} onClick={() => void exportResult("json")} title="Download typed JSON from the retained preview">{exporting === "json" ? "Exporting..." : "JSON"}</button>
          </div>}
        </div>
        {notice && <div className="result-notice result-export-message" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss result notification" onClick={() => setNotice("")}><Icon name="close" size={12}/></button></div>}
        {exportError && <div className="inline-alert error result-export-message" role="alert"><span>{exportError}</span>
          {downloadFallback && <button className="button small" disabled={Boolean(exporting)} onClick={() => void exportResult(downloadFallback, true)}>Download {downloadFallback.toUpperCase()} instead</button>}
          <button className="icon-button" aria-label="Dismiss export error" onClick={() => { setExportError(""); setDownloadFallback(null); }}><Icon name="close" size={12}/></button>
        </div>}
        {loading ? <div className="empty-state"><span className="query-progress"/><h3>Loading retained preview</h3><p>{loadedCount.toLocaleString()} rows retrieved · fetching authenticated pages of up to 1,000 rows</p></div>
          : loadError ? <div className="empty-state"><Icon name="warning" size={24}/><h3>Result preview unavailable</h3><p>{loadError}</p><button className="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button></div>
          : data ? tab === "explore" ? <ResultAnalysis key={`${run.id}:${result.id}`} data={data} run={run} resultSetId={result.id} action={action} truncated={truncated}
            pivot={pivot} savedPivot={savedPivot} onPivotChange={config => {
              pivotViews.current.delete(pivotKey); pivotViews.current.set(pivotKey, config);
              if (pivotViews.current.size > 20) pivotViews.current.delete(pivotViews.current.keys().next().value!);
            }}
            onPin={onPinDashboard && run.status === "completed" ? visual => onPinDashboard({ runId: run.id, resultSetId: result.id, title: "Result matrix", visual }) : undefined}/> : tab === "chart" ? <LocalChart key={`${run.id}:${result.id}`} data={data} truncated={truncated}
              initial={chartForSource(state.chart, state.chartSource, chartSourceKey(run, result))} onDisplayed={chartDisplayed}
              onSave={config => action("chart.set", { config, runId: run.id, resultSetId: result.id })} onCapture={captureVisual}/> : <DataGrid key={`${run.id}:${result.id}`} data={data} truncated={truncated} onShare={share} sharing={sharing} filter={filter} onFilterChange={setFilter} showFullColumnNames={state.resultSettings?.showFullColumnNames ?? false} action={action}/> : null}
      </div>}
    </div>
  </section>;
}

function VisualSaveForm({ draft, action, onCancel, onSaved }: {
  draft: { visual: ArtifactVisual; title: string }; action: Action; onCancel: () => void; onSaved: (id: string) => void;
}) {
  const [title, setTitle] = useState(draft.title), [folder, setFolder] = useState("saved:general");
  const [catalog, setCatalog] = useState<ArtifactCatalog | null>(null), [research, setResearch] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void api.read<ArtifactCatalog>("artifacts.catalog", {}, abort.signal).then(value => { if (!abort.signal.aborted) { setCatalog(value); setError(""); } })
      .catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [retry]);
  return <form className="visual-save-form" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); event.currentTarget.requestSubmit(); }
  }} onSubmit={event => {
    event.preventDefault(); if (!catalog || busy) return;
    setBusy(true); setError("");
    void action<{ id: string }>("artifacts.create", { kind: "visual", expectedRevision: catalog.revision, title, collectionId: folder,
      visual: draft.visual, ...(research ? { researchEntryId: research } : {}) })
      .then(result => onSaved(result.id)).catch(reason => setError(errorMessage(reason))).finally(() => setBusy(false));
  }}>
    <h3>Save visual to Artifacts</h3>
    <p className="field-help">Keeps this captured chart after result eviction or restart. No query is rerun. {draft.visual.rows.length.toLocaleString()} captured rows · source revision {draft.visual.provenance.queryRevision}.</p>
    <label className="field-label">Visual title<input required maxLength={120} value={title} disabled={busy} onChange={event => setTitle(event.target.value)}/></label>
    <label className="field-label">Visual folder<select value={folder} disabled={busy || !catalog} onChange={event => setFolder(event.target.value)}>
      {catalog?.collections.map(item => <option key={item.id} value={item.id}>{folderPath(catalog.collections, item.id).map(part => part.name).join(" / ")}</option>)}
    </select></label>
    <label className="field-label">Attach visual to research<select value={research} disabled={busy || !catalog} onChange={event => setResearch(event.target.value)}><option value="">No attachment</option>
      {catalog?.entries.filter(entry => entry.kind === "research" && !entry.archived).map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
    </select></label>
    {error && <div className="field-error" role="alert">{error} <button type="button" className="text-button" disabled={busy} onClick={() => setRetry(value => value + 1)}>Refresh before retrying</button></div>}
    <div className="button-row"><button className="button primary small" disabled={busy || !catalog || !title.trim()}>{busy ? "Saving..." : "Save visual"}</button><button className="button small" type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}

function Messages({ run, state, onCapabilities }: { run?: Run; state: Snapshot; onCapabilities: () => void }) {
  const connection = state.connections.find(connection => connection.id === run?.connectionId);
  return <div className="messages-panel">
    {!run ? <p className="muted">Execution messages appear here after you run a query.</p> : <>
      <div className="message-entry"><Icon name="info"/><div><strong>Run {run.id}</strong><p>{connection?.name ?? run.connectionId} · {connectionKindLabel(run.connectionKind)} · document revision {run.revision} · {new Date(run.startedAt).toLocaleString()}</p></div></div>
      <div className="message-entry"><Icon name={run.status === "completed" ? "check" : "info"}/><div><strong>{run.status} · {formatDuration(run.durationMs)} client elapsed</strong><p>{scopeLabel(run.truncated, run.rowCount)} · {run.resultSets.length} result sets. Timing is not a native engine trace.</p></div></div>
      {run.error && <div className="message-entry error"><Icon name="warning"/><div><strong>{run.error.code}</strong><p>{run.error.message}</p></div></div>}
      {run.warnings.map((warning, index) => <div className="message-entry warning" key={index}><Icon name="warning"/><p>{warning}</p></div>)}
    </>}
    <div className="message-entry"><Icon name="lens"/><div><strong>No automatic result sharing</strong><p>Results, charts, sorting, and filtering are local. Only explicitly shared cells enter Context Lens.</p></div></div>
    <button className="text-button" onClick={onCapabilities}>View native capabilities and unavailable diagnostics</button>
  </div>;
}

function Comparison({ runs, currentRun, action }: { runs: Run[]; currentRun?: Run; action: Action }) {
  const eligible = runs.filter(run => run.retained && run.resultSets.length && run.status === "completed" && !run.truncated && run.resultSets.every(result => !result.truncated));
  const [left, setLeft] = useState(eligible.find(run => run.id !== currentRun?.id)?.id ?? "");
  const [right, setRight] = useState(eligible.find(run => run.id === currentRun?.id)?.id ?? eligible[0]?.id ?? "");
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="comparison-panel">
    <div className="comparison-intro"><Icon name="compare" size={22}/><div><h3>Compare retained results</h3><p>Exact, ordered comparison of two complete captured results. Capped and partial runs are excluded. No query is rerun.</p></div></div>
    <form className="comparison-form" onSubmit={event => {
      event.preventDefault(); setBusy(true); setError("");
      void action("result.compare", { leftRunId: left, rightRunId: right }).then(setResult).catch(reason => setError(errorMessage(reason))).finally(() => setBusy(false));
    }}>
      <label>Baseline<select value={left} onChange={event => { setLeft(event.target.value); setResult(null); }}><option value="">Choose a run</option>{eligible.map(run => <option key={run.id} value={run.id}>{new Date(run.startedAt).toLocaleTimeString()} · rev {run.revision} · {run.rowCount.toLocaleString()} rows · {run.id.slice(-6)}</option>)}</select></label>
      <Icon name="compare" size={16}/>
      <label>Compare with<select value={right} onChange={event => { setRight(event.target.value); setResult(null); }}><option value="">Choose a run</option>{eligible.map(run => <option key={run.id} value={run.id}>{new Date(run.startedAt).toLocaleTimeString()} · rev {run.revision} · {run.rowCount.toLocaleString()} rows · {run.id.slice(-6)}</option>)}</select></label>
      <button className="button" disabled={busy || !left || !right || left === right}>{busy ? "Comparing…" : "Compare"}</button>
    </form>
    {eligible.length < 2 && <p className="muted">At least two complete retained runs are needed. Run another query or reopen a pinned result. Capped and partial previews cannot establish result equality.</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {result !== null && <section className="comparison-output"><h3>Comparison output</h3><p className="field-help">Server-reported comparison of the selected retained previews. Capped runs cannot establish equality of the full engine result.</p><ComparisonValues value={result}/></section>}
  </div>;
}

function ComparisonValues({ value }: { value: unknown }) {
  if (value === null || typeof value !== "object") return <p>{String(value ?? "No comparison details returned.")}</p>;
  const entries = Object.entries(value);
  return <><dl className="comparison-summary">{entries.filter(([, entry]) => entry === null || typeof entry !== "object").map(([key, entry]) => <div key={key}><dt>{key.replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ")}</dt><dd>{String(entry ?? "—")}</dd></div>)}</dl>{entries.filter(([, entry]) => entry !== null && typeof entry === "object").map(([key, entry]) => <div key={key}><h4>{key.replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ")}</h4><pre className="json-preview">{JSON.stringify(entry, null, 2)}</pre></div>)}</>;
}
