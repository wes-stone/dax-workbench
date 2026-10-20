import { useEffect, useMemo, useRef, useState } from "react";
import type { Cell, Run } from "../contracts/workbench";
import type { LoadedRows } from "./Grid";
import { api, errorMessage } from "./api";
import { displayCell, isNumeric } from "./model";
import { compareKeyed, matrixResult, numericColumn, profileResult } from "../shared/result-analysis.mjs";
import "./result-analysis.css";
import type { Action } from "./useWorkbench";
import type { DashboardVisual } from "../contracts/dashboards";
import { MatrixTable } from "./ResultMatrix";
import { ResultPivot } from "./ResultPivot";
import type { PivotConfig } from "../contracts/pivot";

type Profile = Awaited<ReturnType<typeof profileResult>>;
type Matrix = ReturnType<typeof matrixResult>;
type Comparison = Awaited<ReturnType<typeof compareKeyed>>;
const shown = (value: Cell | undefined, dataType?: string) => value === undefined ? "(absent)" : value === null ? "(null)" : value === "" ? '""' : displayCell(value, dataType);

export function ResultAnalysis({ data, run, resultSetId, action, truncated, onPin, pivot, savedPivot, onPivotChange }: {
  data: LoadedRows; run: Run; resultSetId: string; action: Action; truncated: boolean; onPin?: (visual: DashboardVisual) => void;
  pivot: PivotConfig; savedPivot: PivotConfig; onPivotChange: (config: PivotConfig) => void;
}) {
  const [pivotDraft, setPivotDraft] = useState(pivot);
  const [mode, setMode] = useState<"pivot" | "profile" | "matrix">("pivot"), [column, setColumn] = useState(data.columns[0]?.id ?? "");
  const [profile, setProfile] = useState<Profile>(), [matrix, setMatrix] = useState<Matrix>(), [error, setError] = useState("");
  const [row, setRow] = useState(data.columns[0]?.id ?? ""), [col, setCol] = useState(data.columns[1]?.id ?? "");
  const [value, setValue] = useState(() => data.columns.find(isNumeric)?.id
    ?? data.columns.find(column => numericColumn(data, column.id).numeric)?.id ?? data.columns.at(-1)?.id ?? "");
  const [aggregation, setAggregation] = useState<"none" | "sum" | "count">("none");
  const interpretation = useMemo(() => numericColumn(data, value), [data, value]);
  const [busy, setBusy] = useState(false), [signs, setSigns] = useState(false);
  const [branchRow, setBranchRow] = useState("1"), [branchColumn, setBranchColumn] = useState(data.columns[0]?.id ?? "");
  const [branching, setBranching] = useState(false);
  const changeMatrix = (change: () => void) => { change(); setMatrix(undefined); setError(""); };
  useEffect(() => {
    if (mode !== "profile") return;
    const abort = new AbortController(); setProfile(undefined); setError(""); setBusy(true);
    void profileResult(data, column, abort.signal).then(result => { if (!abort.signal.aborted) setProfile(result); })
      .catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [data, column, mode]);
  return <section className={`result-analysis ${mode === "pivot" ? "worksheet-exploration" : ""}`} aria-label="Local result exploration">
    <div className="exploration-heading">
    <div className="button-row"><button className="button" aria-pressed={mode === "pivot"} onClick={() => setMode("pivot")}>Pivot</button>
      <button className="button" aria-pressed={mode === "profile"} onClick={() => setMode("profile")}>Column profile</button>
      <button className="button" aria-pressed={mode === "matrix"} onClick={() => setMode("matrix")}>Classic matrix</button></div>
    <span className="exploration-scope" title="Local captured data only. No query runs and nothing is shared.">Run {run.id.slice(-8)} · {data.rows.length.toLocaleString()} rows · {truncated || run.status !== "completed" ? "Partial/capped capture" : "Captured data"}</span>
    </div>
    {mode === "pivot" ? <ResultPivot data={data} initial={pivotDraft} saved={savedPivot} onChange={config => { setPivotDraft(config); onPivotChange(config); }}
      onSave={config => action("pivot.layout.set", { runId: run.id, resultSetId, config })}
      scope={`Run ${run.id}, result ${resultSetId}, revision ${run.revision}. ${truncated || run.status !== "completed" ? "Partial/capped capture." : "Complete capture, not the full model."}`}/>
      : mode === "profile" ? <>
      <label>Profile column<select value={column} onChange={event => setColumn(event.target.value)}>{data.columns.map(item => <option key={item.id} value={item.id}>{item.name} ({item.dataType})</option>)}</select></label>
      {busy && <p role="status">Profiling all retrieved rows...</p>}
      {profile && <>{profile.numericReason && <p className="field-help">{profile.numericReason}</p>}<dl className="comparison-summary">
        {[["Rows", profile.rowCount], ["Nulls", profile.nulls], ["Empty strings", profile.emptyStrings], ["Distinct captured values", profile.distinct],
          ["Identical duplicate rows", profile.duplicateRows], ...(profile.numeric ? [["Minimum", profile.minimum], ["Maximum", profile.maximum],
          ["Sum of retrieved numeric rows", profile.sum]] : [])].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{shown(value)}</dd></div>)}
      </dl><h4>Most frequent values</h4><p>The twenty most frequent values are shown; {profile.omittedDistinct} additional distinct values are not listed. Counts use every retrieved row.</p>
      <table><thead><tr><th>Value</th><th>Rows</th><th>Share of retrieved rows</th></tr></thead><tbody>
        {profile.frequencies.map((item, index) => <tr key={index}><td title={shown(item.value)}>{shown(item.value, data.columns.find(item => item.id === column)?.dataType)}</td><td>{item.count}</td><td>{profile.rowCount ? (100 * item.count / profile.rowCount).toFixed(2) : "0.00"}%</td></tr>)}
      </tbody></table></>}
    </> : <><form className="comparison-form" onSubmit={event => {
      event.preventDefault(); setError(""); setMatrix(undefined);
      try { setMatrix(matrixResult(data, row, col, value, aggregation)); } catch (reason) { setError(errorMessage(reason)); }
    }}>
      <label>Matrix rows<select value={row} onChange={event => changeMatrix(() => setRow(event.target.value))}>{data.columns.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Matrix columns<select value={col} onChange={event => changeMatrix(() => setCol(event.target.value))}>{data.columns.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Matrix value<select value={value} onChange={event => changeMatrix(() => setValue(event.target.value))}>{data.columns.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Aggregation<select value={aggregation} onChange={event => changeMatrix(() => setAggregation(event.target.value as typeof aggregation))}><option value="none">None: one row per cell</option><option value="sum">Sum retrieved rows (explicit)</option><option value="count">Count retrieved rows</option></select></label>
      <button className="button">Build matrix locally</button>
    </form>
      {interpretation.reason && <p className="field-help">{interpretation.reason}</p>}
      <p>Summing is an explicit choice, not a claim that a measure is additive. Missing combinations stay absent; nulls are not zero.</p>
      <label className="dashboard-checkbox"><input type="checkbox" checked={signs} onChange={event => setSigns(event.target.checked)}/>Emphasize negative numeric values (not good/bad judgments)</label>
      {matrix && <><MatrixTable matrix={matrix} emphasizeNegative={signs} numeric={aggregation !== "none" || interpretation.numeric}
        rowType={data.columns.find(item => item.id === row)?.dataType} columnType={data.columns.find(item => item.id === col)?.dataType}
        valueType={aggregation === "none" ? data.columns.find(item => item.id === value)?.dataType : undefined}/>
        {onPin && <button className="button" onClick={() => onPin({ type: "matrix", units: "", matrix: { row, column: col, value, aggregation, emphasizeNegative: signs } })}>Pin this matrix to dashboard</button>}</>}
    </>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <details className="result-branch"><summary>Branch from a captured dimension</summary>
      <p>Opens a new linked builder/editor draft, preserving the original filters and adding this dimension value. Add finer-grain fields there and run explicitly. The original tab is not replaced.</p>
      {!run.sourceBuilder ? <p>This run has no verified executed builder. Freeform DAX filters cannot be safely inferred.</p> :
        <form className="comparison-form" onSubmit={event => {
          event.preventDefault(); setBranching(true); setError("");
          void action("result.branch", { runId: run.id, resultSetId, row: Number(branchRow) - 1, columnId: branchColumn })
            .catch(reason => setError(errorMessage(reason))).finally(() => setBranching(false));
        }}>
          <label>Captured row (1-based)<input type="number" required min={1} max={data.rows.length} step={1} value={branchRow} onChange={event => setBranchRow(event.target.value)}/></label>
          <label>Dimension column<select value={branchColumn} onChange={event => setBranchColumn(event.target.value)}>{data.columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
          <p>Selected value: <code>{shown(data.rows[Number(branchRow) - 1]?.[data.columns.findIndex(column => column.id === branchColumn)])}</code></p>
          <button className="button" disabled={branching || !data.rows.length}>Open filtered query without running</button>
        </form>}
    </details>
  </section>;
}

async function loadResult(run: Run, signal: AbortSignal): Promise<LoadedRows> {
  const set = run.resultSets[0];
  if (run.status !== "completed" || run.truncated || run.resultSets.length !== 1 || set?.truncated || !set || set.rowCount > 20000)
    throw new Error("Choose complete, single-result runs with at most 20,000 rows. Capped and partial results cannot establish changes.");
  const rows: Cell[][] = []; let columns = set.columns;
  do {
    const page = await api.page(run.id, set.id, rows.length, signal);
    if (page.offset !== rows.length || page.total !== set.rowCount || page.truncated || rows.length + page.rows.length > set.rowCount
      || JSON.stringify(page.columns) !== JSON.stringify(set.columns) || (!page.rows.length && rows.length < set.rowCount))
      throw new Error("The captured result changed or became unavailable during comparison.");
    columns = page.columns; rows.push(...page.rows);
  } while (rows.length < set.rowCount);
  return { columns, rows };
}
export function KeyedComparison({ runs }: { runs: Run[] }) {
  const eligible = runs.filter(run => run.status === "completed" && !run.truncated && run.retained
    && run.resultSets.length === 1 && !run.resultSets[0].truncated && run.rowCount <= 20000);
  const [left, setLeft] = useState(""), [right, setRight] = useState(""), [keys, setKeys] = useState<string[]>([]);
  const [result, setResult] = useState<Comparison>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [page, setPage] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const baseline = eligible.find(run => run.id === left), comparison = eligible.find(run => run.id === right);
  useEffect(() => () => abort.current?.abort(), []);
  function reset() { abort.current?.abort(); setResult(undefined); setKeys([]); setError(""); setBusy(false); }
  return <section className="result-analysis" aria-label="Business-key comparison">
    <h3>Compare by business keys</h3><p>Align rows by selected keys, regardless of sort order. Duplicate or null keys are rejected, not paired arbitrarily. Numeric deltas use exact decimal arithmetic.</p>
    <form onSubmit={event => {
      event.preventDefault(); if (!baseline || !comparison) return;
      const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
      setBusy(true); setError(""); setResult(undefined);
      void Promise.all([loadResult(baseline, controller.signal), loadResult(comparison, controller.signal)])
        .then(([a, b]) => compareKeyed(a, b, keys, controller.signal))
        .then(value => { if (!controller.signal.aborted) { setResult(value); setPage(0); } })
        .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }}>
      <div className="comparison-form">{([["Baseline run", left, setLeft], ["Comparison run", right, setRight]] as const).map(([label, value, setter]) =>
        <label key={label}>{label}<select value={value} onChange={event => { reset(); setter(event.target.value); }}>
          <option value="">Choose a run</option>{eligible.map(run => <option key={run.id} value={run.id}>{new Date(run.startedAt).toLocaleString()} · {run.id.slice(-8)} · {run.rowCount} rows</option>)}</select></label>)}</div>
      <fieldset disabled={busy}><legend>Business key columns</legend>{baseline?.resultSets[0].columns.filter(column => comparison?.resultSets[0].columns.some(other => other.name === column.name && other.dataType === column.dataType)).map(column =>
        <label key={column.id} className="dashboard-checkbox"><input type="checkbox" checked={keys.includes(column.name)} onChange={event => { setResult(undefined); setKeys(event.target.checked ? [...keys, column.name] : keys.filter(key => key !== column.name)); }}/>{column.name}</label>)}</fieldset>
      <button className="button" disabled={busy || !keys.length || !baseline || !comparison || left === right}>Compare captured rows</button>
      {busy && <button type="button" className="button" onClick={() => { abort.current?.abort(); setBusy(false); }}>Cancel local comparison</button>}
    </form>
    {baseline && comparison && <details><summary>Compare query and filter scope</summary><p>Different definitions or models may make these results incomparable. No causal attribution is inferred.</p>
      <div className="content-review-diff">{[baseline, comparison].map(run => <div key={run.id}><h4>{run.id.slice(-8)} · {run.connectionId} · rev {run.revision}</h4>
        <pre>{run.query}</pre><pre>{JSON.stringify(run.parameters, null, 2)}</pre></div>)}</div></details>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {result && <><p><strong>{result.changed} changed</strong> · {result.added} added · {result.removed} removed · {result.unchanged} unchanged.</p>
      {(result.addedColumns.length > 0 || result.removedColumns.length > 0) && <p>Added columns: {result.addedColumns.join(", ") || "none"}; removed columns: {result.removedColumns.join(", ") || "none"}.</p>}
      <div className="result-matrix"><table><thead><tr><th>Keys</th><th>Status</th><th>Field</th><th>Before</th><th>After</th><th>Exact delta (after − before)</th></tr></thead><tbody>
        {result.changes.slice(page * 50, page * 50 + 50).flatMap((change, index) => change.cells.length ? change.cells.map((cell, ci) => <tr key={`${index}:${ci}`}>
          <td><code>{JSON.stringify(change.keys)}</code></td><td>{change.status}</td><td>{cell.column}</td><td>{shown(cell.before)}</td><td>{shown(cell.after)}</td><td>{cell.delta ?? "Not evaluated"}</td></tr>)
          : [<tr key={index}><td><code>{JSON.stringify(change.keys)}</code></td><td>{change.status}</td><td colSpan={4}>Key-only row; no value fields</td></tr>])}
      </tbody></table></div><div className="button-row"><button className="button small" disabled={!page} onClick={() => setPage(page - 1)}>Previous changes</button>
        <span>{result.changes.length ? page * 50 + 1 : 0}–{Math.min(page * 50 + 50, result.changes.length)} of {result.changes.length} changed keys</span>
        <button className="button small" disabled={(page + 1) * 50 >= result.changes.length} onClick={() => setPage(page + 1)}>Next changes</button></div></>}
  </section>;
}
