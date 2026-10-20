import { Fragment, useEffect, useRef, useState } from "react";
import type { BuilderFilter, FilterValueOption, FilterValueOrder, FilterValuePage, QueryDocument, Snapshot } from "../contracts/workbench";
import type { Action } from "./useWorkbench";
import { api, errorMessage } from "./api";
import { RUNNING } from "./model";
import { calendarFilters, selectedValueFilter } from "./filter-values";
import { defaultFilterValueOrder, filterValueOrderChoices } from "../shared/filter-value-order.mjs";

const optionKey = (option: FilterValueOption) => JSON.stringify([typeof option.value, option.value]);

export function FilterValues({ filter, document, latest, action, disabled, prepare, onApply, staged = false }: {
  filter: BuilderFilter; document: QueryDocument; latest: React.RefObject<Snapshot | null>; action: Action;
  disabled: boolean; prepare: () => Promise<void>; onApply: (update: Partial<BuilderFilter>) => void; staged?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loadedSearch, setLoadedSearch] = useState("");
  const [order, setOrder] = useState<FilterValueOrder>(() => defaultFilterValueOrder(filter.field));
  const [runId, setRunId] = useState("");
  const [page, setPage] = useState<FilterValuePage | null>(null);
  const [selected, setSelected] = useState<FilterValueOption[]>([]);
  const [exclude, setExclude] = useState(["IsNot", "NotIn", "IsNotBlank"].includes(filter.operator));
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const initial = useRef(true);
  const alive = useRef(true);
  const request = useRef(0);
  const loading = useRef(false);
  const nativeGeneration = latest.current?.libraryIdentity?.generation;
  const previousGeneration = useRef(nativeGeneration);
  const run = latest.current?.runs.find(item => item.id === runId);
  const running = Boolean(run && RUNNING.has(run.status));
  const pending = starting || running || Boolean(run?.status === "completed" && !page && !error);
  const identity = { documentId: document.id, connectionId: document.connectionId, fieldId: filter.field.id };
  const orders = filterValueOrderChoices(filter.field);
  const orderChanged = Boolean(page && page.order !== order);
  const group = (option: FilterValueOption) => {
    if (!page?.order.startsWith("month-")) return "";
    return option.calendarYear === undefined ? "Other values" : String(option.calendarYear);
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  useEffect(() => { setExclude(["IsNot", "NotIn", "IsNotBlank"].includes(filter.operator)); }, [filter.operator]);
  useEffect(() => {
    if (previousGeneration.current === nativeGeneration) return;
    previousGeneration.current = nativeGeneration;
    request.current++;
    setPage(null); setRunId(""); setSelected([]); initial.current = true;
    setError("Model metadata changed. Load values again before making a selection.");
  }, [nativeGeneration]);
  useEffect(() => {
    if (!run || RUNNING.has(run.status)) return;
    if (run.status !== "completed") { setError(run.error?.message ?? `Value lookup ${run.status}. Choose Load values to retry.`); return; }
    const abort = new AbortController();
    void api.read<FilterValuePage>("builder.values.read", { ...identity, runId: run.id }, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setPage(result); setError("");
      if (initial.current) {
        initial.current = false;
        const values = ["In", "NotIn"].includes(filter.operator) ? filter.value.replaceAll("\r", "").split("\n")
          : ["Is", "IsNot"].includes(filter.operator) ? [filter.value] : [];
        setSelected(result.options.filter(option => !option.unavailable && (option.value === null
          ? ["IsBlank", "IsNotBlank"].includes(filter.operator) : values.includes(option.literal ?? ""))));
      }
    }).catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [runId, run?.status, readAttempt, nativeGeneration]);

  async function load() {
    if (loading.current || running) return;
    loading.current = true;
    const ticket = ++request.current;
    setStarting(true); setPage(null); setRunId(""); setError(""); setNotice("");
    try {
      await prepare();
      const current = latest.current?.documents.find(item => item.id === document.id);
      if (!alive.current || ticket !== request.current) return;
      if (!current || latest.current?.activeDocumentId !== current.id || current.connectionId !== document.connectionId)
        throw new Error("The query tab changed. Open the value picker on the intended query.");
      const result = await action<{ runId: string }>("builder.values.start", { ...identity, revision: current.revision, search, order });
      if (alive.current && ticket === request.current) { setRunId(result.runId); setLoadedSearch(search); }
    } catch (reason) { if (alive.current && ticket === request.current) setError(errorMessage(reason)); }
    finally { loading.current = false; if (alive.current) setStarting(false); }
  }
  async function cancel() {
    setCancelling(true); setError("");
    try { await action("query.cancel", { runId }); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setCancelling(false); }
  }
  function toggle(option: FilterValueOption) {
    setNotice("");
    setSelected(current => current.some(item => optionKey(item) === optionKey(option))
      ? current.filter(item => optionKey(item) !== optionKey(option))
      : option.value === null ? [option] : [...current.filter(item => item.value !== null), option]);
  }
  function apply() {
    try { onApply(selectedValueFilter(selected, exclude)); setError(""); setNotice(`${selected.length} value${selected.length === 1 ? "" : "s"} ${staged ? "staged. Choose Apply filters to update the builder." : "applied. The query was not run."}`); }
    catch (reason) { setError(errorMessage(reason)); }
  }
  return <details className="filter-values" open={open} onToggle={event => setOpen(event.currentTarget.open)}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); event.currentTarget.querySelector("summary")?.focus(); } }}>
    <summary>Choose values{selected.length ? ` (${selected.length} selected)` : ""}</summary>
    {open && <div className="filter-values-body">
      <p className="field-help">Values from this model column. Other filters do not apply.</p>
      <div className="filter-value-order"><label>Order<select aria-label={`Value order for ${filter.field.name}`} value={order} disabled={disabled || pending}
        onChange={event => {
          const next = event.target.value;
          if (next === "asc" || next === "desc" || next === "month-asc" || next === "month-desc") setOrder(next);
        }}>{orders.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
        {page && <span className="field-help">Loaded: {orders.find(choice => choice.value === page.order)?.label ?? page.order}</span>}
      </div>
      <div className="filter-values-search"><input aria-label={`Search values for ${filter.field.name}`} placeholder={order.startsWith("month-") ? "Search a year or month" : "Search model values"} maxLength={200} value={search}
        disabled={disabled || pending} onChange={event => setSearch(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!disabled && !pending) void load(); } }}/>
        <button className="button small" disabled={disabled || pending} onClick={() => void load()}>{starting ? "Starting..." : running ? "Loading..." : orderChanged ? "Reload values" : search ? "Search values" : "Load values"}</button></div>
      {orderChanged && <p className="field-help warning-text" role="status">Order changed. Reload values to prepare that order from a fresh bounded lookup.</p>}
      {running && <div className="button-row"><span className="field-help" role="status">Reading model values...</span><button className="text-button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Cancelling..." : "Cancel lookup"}</button></div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {error && order.startsWith("month-") && <p className="field-help">Try searching a specific year. For a simpler model lookup, choose A to Z and load again; your selections are kept.</p>}
      {error && run?.status === "completed" && !page && <button className="text-button" onClick={() => { setError(""); setReadAttempt(value => value + 1); }}>Retry reading captured values</button>}
      {page && <>
        <p className="field-help" role="status">{page.options.length} {page.limited ? "captured values - more may exist; narrow your search." : "values returned."}{loadedSearch && <> Search: "{loadedSearch}".</>}</p>
        {page.order.startsWith("month-") && <p className="field-help">Sorted {page.capturedCount} fully captured labels before the 200-choice limit. English month/year or YYYY-MM, not a model fiscal sort. Unrecognized labels follow.</p>}
        {!page.options.length ? <p className="field-help">No values matched. Change the search and try again.</p> : <div className="filter-value-options" role="group" aria-label={`Available values for ${filter.field.name}`}>
          {page.options.map((option, index) => <Fragment key={optionKey(option)}>
            {group(option) && (index === 0 || group(option) !== group(page.options[index - 1])) && <div className="filter-value-year">{group(option)}</div>}
            <label className="filter-value-option" title={option.unavailable ?? option.label}>
            <input type="checkbox" disabled={disabled || Boolean(option.unavailable) || selected.length >= 200 && !selected.some(item => optionKey(item) === optionKey(option))}
              checked={selected.some(item => optionKey(item) === optionKey(option))} onChange={() => toggle(option)}/>
            <span>{option.label}{option.unavailable && <small>{option.unavailable}</small>}</span>
          </label></Fragment>)}
        </div>}
        {page.options.some(option => option.value === null) && <p className="field-help">Blank is separate from empty text. Choosing Blank clears other selections.</p>}
      </>}
      {!!selected.length && <details className="filter-selected-values"><summary>{selected.length} selected across searches</summary><div className="filter-value-options">{selected.map(option => <button className="text-button" key={optionKey(option)} onClick={() => toggle(option)} disabled={disabled} title={`Remove ${option.label}`}>{option.label} ×</button>)}</div></details>}
      {(page || selected.length > 0) && <div className="filter-value-actions"><select aria-label={`Selection mode for ${filter.field.name}`} value={exclude ? "exclude" : "include"} disabled={disabled || pending} onChange={event => setExclude(event.target.value === "exclude")}><option value="include">Include selected</option><option value="exclude">Exclude selected</option></select>
        <button className="button small primary" disabled={disabled || pending || !selected.length || selected.length > 200} onClick={apply}>Use selection</button>
        <button className="text-button" disabled={disabled || !selected.length} onClick={() => { setSelected([]); initial.current = false; }}>Clear selection</button></div>}
      {notice && <p className="field-help" role="status">{notice}</p>}
      <details className="filter-value-details"><summary>Lookup details{page?.warnings.length ? ` (${page.warnings.length} notices)` : ""}</summary>
        <p className="field-help">Reads the accessible column, without editor filters or parameter bindings. Up to 200 choices; 30 seconds / 64 KiB or your lower limits. Month order captures up to 2,001 distinct labels and requires a complete set of at most 2,000 before sorting locally. It never orders an incomplete alphabetical sample.</p>
        {staged && <p className="field-help">Use selection stages literal values for Apply filters. Closing this panel does not cancel a started lookup; use Cancel lookup here or in History.</p>}
        {page?.warnings.map((warning, index) => <p key={index} className="field-help warning-text">{warning}</p>)}
      </details>
    </div>}
  </details>;
}

export function CalendarRange({ filter, disabled, onApply }: { filter: BuilderFilter; disabled: boolean; onApply: (filters: [BuilderFilter, BuilderFilter]) => void }) {
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [error, setError] = useState("");
  return <details className="filter-values"><summary>Choose date range</summary><div className="filter-values-body">
    <div className="filter-calendar-range"><label className="field-label">From<input type="date" min="1900-01-01" max="9999-12-30" value={from} disabled={disabled} onChange={event => setFrom(event.target.value)}/></label>
      <label className="field-label">Through<input type="date" min={from || "1900-01-01"} max="9999-12-30" value={through} disabled={disabled} onChange={event => setThrough(event.target.value)}/></label></div>
    <p className="field-help">Includes the entire end day in the model's date/time values, without timezone conversion. Creates two visible filters: on/after the start and before the next day.</p>
    <button className="button small" disabled={disabled || !from || !through} onClick={() => {
      try { onApply(calendarFilters(filter, from, through)); setError(""); } catch (reason) { setError(errorMessage(reason)); }
    }}>Use date range</button>
    {error && <p className="field-error" role="alert">{error}</p>}
  </div></details>;
}
