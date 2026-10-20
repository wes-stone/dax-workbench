import { useEffect, useMemo, useRef, useState } from "react";
import type { BuilderDefinition, BuilderField, BuilderFilter, ModelObject, QueryDocument, Snapshot } from "../contracts/workbench";
import type { Action } from "./useWorkbench";
import { api, errorMessage } from "./api";
import { BuilderFieldBrowser, BuilderPickerDialog } from "./BuilderFieldPicker";
import { BuilderFilterControls } from "./BuilderFilterControls";
import { builderField, fieldLabel, filterSummary, newFilter, replaceCalendarRange } from "./builder-model";
import { Icon } from "./icons";

interface FilterCheck { valid: boolean; issues: Array<{ filterId: string; message: string }> }
export interface FilterControlStart { id?: string; field?: BuilderField }

export function FilterControlPane({ definition, start, objects, document, latest, action, disabled, error, schemaMessage, refreshDisabled, onRefresh,
  parametersSupported, parameterHelp, prepare, onApply, onClose }: {
  definition: BuilderDefinition; start: FilterControlStart; objects: ModelObject[]; document: QueryDocument; latest: React.RefObject<Snapshot | null>; action: Action;
  disabled: boolean; error: string; schemaMessage?: string; refreshDisabled: boolean; onRefresh: () => void;
  parametersSupported: boolean; parameterHelp: string; prepare: () => Promise<void>;
  onApply: (filters: BuilderFilter[], original: BuilderFilter[]) => void; onClose: () => void;
}) {
  const original = useRef(structuredClone(definition.filters));
  const [filters, setFilters] = useState(() => {
    const draft = structuredClone(definition.filters);
    if (start.field && !draft.some(filter => filter.field.id === start.field?.id)) draft.push(newFilter(start.field));
    return draft;
  });
  const [activeId, setActiveId] = useState(() => start.id ?? filters.find(filter => filter.field.id === start.field?.id)?.id ?? filters[0]?.id ?? "");
  const [view, setView] = useState<"browse" | "configure">(start.id || start.field ? "configure" : "browse");
  const [check, setCheck] = useState<(FilterCheck & { key: string }) | null>(null);
  const [checkError, setCheckError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const baseChanged = JSON.stringify(definition.filters) !== JSON.stringify(original.current);
  const draftDefinition = { ...definition, filters };
  const signature = JSON.stringify(draftDefinition);
  const generation = latest.current?.libraryIdentity?.generation;
  const checkKey = `${document.id}:${document.connectionId}:${generation ?? ""}:${parametersSupported}:${signature}`;
  const checked = check?.key === checkKey && !schemaMessage;
  const issues = new Map(checked ? check.issues.map(issue => [issue.filterId, issue.message]) : []);
  const changes = JSON.stringify(filters) !== JSON.stringify(original.current);
  const currentId = filters.some(filter => filter.id === activeId) ? activeId : filters[0]?.id ?? "";
  const available = useMemo(() => {
    const overrides = new Map(definition.fields.filter(field => field.kind === "measure" && field.expression).map(field => [field.id, field]));
    return [...objects.map(object => overrides.has(object.id) ? { ...object, source: "query" } : object),
      ...[...overrides.values()].filter(field => !objects.some(object => object.id === field.id)).map(field => ({ ...field, source: "query" }))];
  }, [objects, definition.fields]);

  useEffect(() => {
    setCheck(null); setCheckError("");
    if (schemaMessage) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void api.read<FilterCheck>("builder.filters.validate", { documentId: document.id, connectionId: document.connectionId, definition: draftDefinition }, abort.signal)
        .then(result => { if (!abort.signal.aborted) setCheck({ ...result, key: checkKey }); })
        .catch(reason => { if (!abort.signal.aborted) setCheckError(errorMessage(reason)); });
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [checkKey, schemaMessage, attempt]);
  useEffect(() => {
    const selector = view === "browse" ? ".field-picker-controls input" : ".filter-control-detail:not([hidden]) h3";
    if (view === "configure") panel.current?.querySelector(".filter-control-editor")?.scrollTo(0, 0);
    panel.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [view, currentId]);

  function update(id: string, change: Partial<BuilderFilter>) {
    setFilters(current => current.map(filter => filter.id === id ? { ...filter, ...change } : filter));
  }
  function choose(object: ModelObject, configure: boolean) {
    const existing = filters.find(filter => filter.field.id === object.id);
    if (existing) {
      if (configure) { setActiveId(existing.id); setView("configure"); }
      else setFilters(current => current.filter(filter => filter.field.id !== object.id));
      return;
    }
    const field = definition.fields.find(field => field.id === object.id) ?? builderField(object);
    if (!field) return;
    const filter = newFilter(field);
    setFilters(current => [...current, filter]); setActiveId(filter.id);
    if (configure) setView("configure");
  }
  function remove(id: string) { setFilters(current => current.filter(filter => filter.id !== id)); }
  function addCondition(filter: BuilderFilter) {
    const added = newFilter(filter.field);
    setFilters(current => [...current, added]); setActiveId(added.id);
  }
  function status(filter: BuilderFilter) {
    return !filter.enabled ? "Disabled" : issues.has(filter.id) ? "Needs attention" : checked ? "Ready" : "Not checked";
  }
  const filterList = <section className="filter-control-list" aria-label="Draft filters">
    <div className="field-picker-list-heading"><h3>Filters <span className="count-badge">{filters.length}</span></h3>
      <button className="text-button" disabled={disabled || !filters.length} onClick={() => setFilters([])}>Clear all</button></div>
    <div className="filter-control-list-scroll">
      {filters.map(filter => <div className={`filter-control-row ${view === "configure" && currentId === filter.id ? "is-selected" : ""}`} key={filter.id}>
        <button className="filter-control-select" aria-label={`Configure filter ${fieldLabel(filter.field)} ${filterSummary(filter)}`} aria-current={view === "configure" && currentId === filter.id ? "true" : undefined}
          onClick={() => { setActiveId(filter.id); setView("configure"); }}>
          <strong>{filter.field.name}</strong><small>{filter.field.table || "Measure"}{filter.field.isCustom || filter.field.expression ? " / query measure" : ""}</small>
          <span title={filterSummary(filter)}>{filterSummary(filter)}</span>
          <small className={issues.has(filter.id) ? "warning-text" : ""}>{status(filter)}</small>
        </button>
        <button className="icon-button" disabled={disabled} aria-label={`Remove draft filter ${fieldLabel(filter.field)}`} onClick={() => remove(filter.id)}><Icon name="close" size={13}/></button>
      </div>)}
      {!filters.length && <div className="field-picker-empty"><Icon name="filter" size={24}/><strong>Choose a field to filter</strong><p>Search the model, then Configure a field to set its condition and values here.</p>
        {view === "configure" && <button className="button small" onClick={() => setView("browse")}>Choose fields</button>}</div>}
    </div>
    <p className="filter-control-scope">All enabled filters must match (AND). Use In / Not in for multiple choices within one column.</p>
  </section>;

  return <BuilderPickerDialog title="Filter controls" description="Choose fields, configure conditions and values, then apply the complete filter set. Your output fields stay unchanged."
    className="filter-control-dialog" closeLabel="Close filter controls" onClose={onClose}
    initialFocus={view === "configure" ? ".filter-control-detail:not([hidden]) h3" : undefined}>
    <div className="filter-control-navigation" role="group" aria-label="Filter workspace">
      <button className={`button quiet ${view === "browse" ? "is-active" : ""}`} aria-pressed={view === "browse"} onClick={() => setView("browse")}><Icon name="plus" size={14}/>Choose fields</button>
      <button className={`button quiet ${view === "configure" ? "is-active" : ""}`} aria-pressed={view === "configure"} onClick={() => setView("configure")}><Icon name="filter" size={14}/>Configure filters <span className="count-badge">{filters.length}</span></button>
      <span className="muted" role="status">{changes ? "Unapplied changes" : "Builder unchanged"}</span>
    </div>
    <div className={`filter-control-workspace ${view === "browse" ? "is-browsing" : "is-configuring"}`} ref={panel}>
      <div className="filter-control-browser" hidden={view !== "browse"}>
        <BuilderFieldBrowser objects={available} selectedIds={new Set(filters.map(filter => filter.field.id))} disabled={disabled}
          schemaMessage={schemaMessage} refreshDisabled={refreshDisabled} onRefresh={onRefresh} onToggle={object => choose(object, false)} onConfigure={object => choose(object, true)}/>
      </div>
      {filterList}
      <div className="filter-control-editor" hidden={view !== "configure"}>
        {!filters.length && <div className="field-picker-empty"><strong>No filters</strong><p>Choose a field, or Apply filters to keep this query unfiltered.</p></div>}
        {filters.map(filter => <section key={filter.id} className="filter-control-detail" hidden={currentId !== filter.id} aria-label={`Configure ${fieldLabel(filter.field)}`}>
          <header><div><h3 tabIndex={-1}>{filter.field.name}</h3><p>{fieldLabel(filter.field)} / {filter.field.dataType ?? "Unknown type"}</p></div>
            <label className="check-field"><input type="checkbox" aria-label={`Enable draft filter ${filter.field.name}`} checked={filter.enabled} disabled={disabled}
              onChange={event => update(filter.id, { enabled: event.target.checked })}/>Enabled</label></header>
          <p className="filter-control-grain">{filter.field.kind === "measure" ? "Measure condition: evaluated against the grouped query result, not individual source rows." : "Column condition: filters this model column before grouping."}</p>
          <BuilderFilterControls filter={filter} document={document} latest={latest} action={action} disabled={disabled} parametersSupported={parametersSupported} parameterHelp={parameterHelp}
            prepare={prepare} staged onChange={change => update(filter.id, change)} onCalendar={range => setFilters(current => replaceCalendarRange(current, range))}/>
          {issues.has(filter.id) && <p className="inline-alert error" role="alert">{issues.get(filter.id)}</p>}
          {!filter.enabled && <p className="field-help">This condition is kept but will not affect the query while disabled.</p>}
          <div className="filter-control-condition-actions"><button className="button small" disabled={disabled} onClick={() => addCondition(filter)}>Add another condition</button>
            <button className="text-button danger-text" disabled={disabled} onClick={() => remove(filter.id)}>Remove condition</button></div>
          {filter.id.startsWith("calendar:") && <p className="field-help">This is the exclusive upper boundary of a calendar range. Both boundaries are shown separately in the filter list.</p>}
        </section>)}
      </div>
    </div>
    {(error || checkError || baseChanged || schemaMessage) && <div className="field-picker-error" role="alert">
      {baseChanged ? "Builder filters changed elsewhere. Cancel and reopen to use the latest filters; your pending choices have not overwritten anything." : error || checkError || schemaMessage}
      {(checkError || schemaMessage) && <button className="button small" disabled={refreshDisabled} onClick={() => { if (schemaMessage) onRefresh(); else setAttempt(value => value + 1); }}>Retry filter check</button>}
    </div>}
    <footer className="field-picker-footer">
      <div className="filter-control-check" role="status">{checked ? check.valid ? `${filters.filter(filter => filter.enabled).length} enabled (AND) / ${filters.filter(filter => !filter.enabled).length} disabled`
        : `${issues.size} condition${issues.size === 1 ? "" : "s"} need attention` : checkError || schemaMessage ? "Filter check unavailable" : "Checking conditions..."}
        <small>Apply does not run DAX. Load/Search values explicitly reads the model.</small></div>
      <div className="button-row"><button className="button" onClick={onClose}>Cancel</button>
        {view === "browse" ? <button className="button primary" onClick={() => setView("configure")}>Configure filters</button>
          : <button className="button primary" disabled={disabled || baseChanged || !changes || !checked || !check.valid}
            onClick={() => onApply(filters, original.current)}>Apply filters</button>}
      </div>
    </footer>
  </BuilderPickerDialog>;
}
