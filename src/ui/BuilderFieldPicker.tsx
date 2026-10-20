import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ModelObject } from "../contracts/workbench";
import { builderField, fieldLabel, fieldSearch } from "./builder-model";
import { Icon } from "./icons";

const PAGE_SIZE = 100;

export function BuilderFieldPicker({ objects, includedIds, disabled, error, schemaMessage, refreshDisabled, onRefresh, onAdd, onClose }: {
  objects: ModelObject[]; includedIds: string[];
  disabled: boolean; error: string; schemaMessage?: string; refreshDisabled: boolean;
  onRefresh: () => void; onAdd: (objects: ModelObject[]) => void; onClose: () => void;
}) {
  const [selected, setSelected] = useState<ModelObject[]>([]);
  const available = useMemo(() => objects.filter(object => builderField(object)), [objects]);
  const included = new Set(includedIds);
  const current = new Map(available.map(object => [object.id, object]));
  const pending = selected.filter(object => !included.has(object.id));
  const selectedIds = new Set(pending.map(object => object.id));
  const missing = pending.some(object => !current.has(object.id));

  function toggle(object: ModelObject) {
    setSelected(items => items.some(item => item.id === object.id) ? items.filter(item => item.id !== object.id) : [...items, object]);
  }

  return <BuilderPickerDialog title="Add output fields"
    description="Choose the columns and measures to include in your query." onClose={onClose}>
    <div className="field-picker-body">
      <BuilderFieldBrowser objects={available} selectedIds={selectedIds} includedIds={included} disabled={disabled} schemaMessage={schemaMessage}
        refreshDisabled={refreshDisabled} onRefresh={onRefresh} onToggle={toggle}/>
      <section className="field-picker-selection" aria-label="Fields to add to output">
        <div className="field-picker-list-heading"><h3>To add <span className="count-badge" role="status">{pending.length}</span></h3>
          <button className="text-button" disabled={!pending.length || disabled} onClick={() => setSelected([])}>Clear</button></div>
        <div className="field-picker-selected-list">
          {pending.length ? pending.map(object => <div className="field-picker-selected-row" key={object.id}>
            <Icon name={object.kind === "measure" ? "measure" : "column"} size={14}/>
            <span className="field-picker-name"><strong>{object.name}</strong><small>{object.table || "No home table"}{!current.has(object.id) ? " / unavailable" : ""}</small></span>
            <button className="icon-button" disabled={disabled} aria-label={`Unselect ${fieldLabel(object)}`} onClick={() => toggle(object)}><Icon name="close" size={13}/></button>
          </div>) : <div className="field-picker-empty"><Icon name="table" size={24}/><strong>Select fields to add</strong><p>Click a field to select it. Keep searching to choose from multiple tables.</p></div>}
        </div>
        <p className="field-picker-destination">Adds to Columns and measures. Verified sort dependencies are included.</p>
      </section>
    </div>
    {missing && <p className="field-picker-error" role="alert">Some selected fields are no longer available. Remove them or refresh the model fields before adding.</p>}
    {error && <p className="field-picker-error" role="alert">{error}</p>}
    <footer className="field-picker-footer"><span className="muted">No query runs. Cancel leaves the builder unchanged.</span><div className="button-row">
      <button className="button" onClick={onClose}>Cancel</button>
      <button className="button primary" disabled={disabled || !pending.length || missing || Boolean(schemaMessage)}
        onClick={() => onAdd(pending.flatMap(object => { const item = current.get(object.id); return item ? [item] : []; }))}>
        Add {pending.length || ""}{pending.length ? " " : ""}{pending.length === 1 ? "field" : "fields"}
      </button>
    </div></footer>
  </BuilderPickerDialog>;
}

export function BuilderPickerDialog({ title, description, onClose, children, className = "", initialFocus, closeLabel = "Close field picker" }: {
  title: string; description: string; onClose: () => void; children: ReactNode; className?: string; initialFocus?: string; closeLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId(), helpId = useId();
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    element?.querySelector<HTMLElement>(initialFocus ?? ".field-picker-controls input")?.focus();
    return () => { element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className={`builder-field-dialog ${className}`} aria-labelledby={headingId} aria-describedby={helpId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "F5" || (event.ctrlKey || event.metaKey) && ["Enter", "s", "S", "n", "N"].includes(event.key)) event.preventDefault();
      if (event.key === "Tab") {
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'))
          .filter(element => element.getClientRects().length > 0 && !element.closest("details:not([open]) > :not(summary)"));
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header className="field-picker-header"><div><h2 id={headingId}>{title}</h2><p id={helpId}>{description}</p></div>
      <button className="icon-button" aria-label={closeLabel} onClick={onClose}><Icon name="close"/></button></header>
    {children}
  </dialog>;
}

export function BuilderFieldBrowser({ objects, selectedIds, includedIds = new Set<string>(), disabled, schemaMessage, refreshDisabled, onRefresh, onToggle, onConfigure }: {
  objects: ModelObject[]; selectedIds: Set<string>; includedIds?: Set<string>; disabled: boolean; schemaMessage?: string; refreshDisabled: boolean;
  onRefresh: () => void; onToggle: (object: ModelObject) => void; onConfigure?: (object: ModelObject) => void;
}) {
  const searchInput = useRef<HTMLInputElement>(null), results = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState(""), [table, setTable] = useState("");
  const [kind, setKind] = useState<"all" | "column" | "measure">("all");
  const [page, setPage] = useState(0);
  const available = useMemo(() => objects.filter(object => builderField(object)), [objects]);
  const tables = useMemo(() => [...new Set(available.flatMap(object => object.table ? [object.table] : []))].sort((a, b) => a.localeCompare(b)), [available]);
  const found = available.filter(object => (!table || object.table === table) && (kind === "all" || object.kind === kind) && fieldSearch(object, search));
  const lastPage = Math.max(0, Math.ceil(found.length / PAGE_SIZE) - 1), visiblePage = Math.min(page, lastPage), start = visiblePage * PAGE_SIZE;
  useEffect(() => { results.current?.scrollTo(0, 0); }, [search, table, kind, visiblePage]);
  return <section className="field-picker-browser" aria-label="Available model fields">
    <div className="field-picker-controls">
      <div className="search-field"><Icon name="search" size={15}/><input ref={searchInput} aria-label="Search builder fields" placeholder="Search fields, tables, or descriptions..." value={search}
        onChange={event => { setSearch(event.target.value); setPage(0); }}/></div>
      <div className="field-picker-filters">
        <label className="field-picker-table">Table<select aria-label="Filter fields by table" value={table} onChange={event => { setTable(event.target.value); setPage(0); }}>
          <option value="">All tables</option>{table && !tables.includes(table) && <option value={table}>{table} (unavailable)</option>}
          {tables.map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
        <div className="field-picker-kinds" role="group" aria-label="Field types">{(["all", "column", "measure"] as const).map(value =>
          <button key={value} className={`button small quiet ${kind === value ? "is-active" : ""}`} aria-pressed={kind === value} onClick={() => { setKind(value); setPage(0); }}>
            {value === "all" ? "All fields" : value === "column" ? "Columns" : "Measures"}</button>)}</div>
      </div>
    </div>
    <div className="field-picker-list-heading"><h3>Model fields</h3><span className="muted" role="status">{found.length.toLocaleString()} {found.length === 1 ? "match" : "matches"}</span></div>
    <div className="field-picker-results" ref={results}>
      {schemaMessage ? <div className="builder-schema-status" role="status"><p>{schemaMessage}</p><button className="button small" disabled={refreshDisabled} onClick={onRefresh}>Refresh model fields</button></div>
        : found.slice(start, start + PAGE_SIZE).map(object => {
          const already = includedIds.has(object.id), checked = already || selectedIds.has(object.id);
          return <div key={object.id} className={`field-picker-row ${checked ? "is-picked" : ""} ${already ? "is-included" : ""}`}>
            <label className="field-picker-choice"><input type="checkbox" aria-label={`${fieldLabel(object)} ${object.kind}`} checked={checked} disabled={already || disabled} onChange={() => onToggle(object)}/>
              <Icon name={object.kind === "measure" ? "measure" : "column"} size={15}/>
              <span className="field-picker-name"><strong>{object.name}</strong><small>{object.table || "No home table"} / {object.source === "query" ? "query measure" : object.kind}{object.dataType ? ` / ${object.dataType}` : ""}{object.isHidden ? " / hidden" : ""}</small></span>
            </label>
            {already && <small className="field-picker-included">Already added</small>}
            {onConfigure && <button className="button small quiet" disabled={disabled} aria-label={`Configure ${fieldLabel(object)}`} onClick={() => onConfigure(object)}>Configure</button>}
          </div>;
        })}
      {!schemaMessage && !found.length && <div className="field-picker-empty"><strong>{available.length ? "No matching fields" : "No model fields available"}</strong>
        <p>{available.length ? "Try another search, table, or field type. Your selections are kept." : "Refresh the model metadata to load columns and measures."}</p>
        {available.length ? <button className="button small" onClick={() => { setSearch(""); setTable(""); setKind("all"); setPage(0); searchInput.current?.focus(); }}>Reset search</button>
          : <button className="button small" disabled={refreshDisabled} onClick={onRefresh}>Refresh model fields</button>}
      </div>}
    </div>
    {!schemaMessage && found.length > PAGE_SIZE && <nav className="field-picker-pages" aria-label="Field result pages">
      <button className="button small" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Previous</button>
      <span>{start + 1}-{Math.min(start + PAGE_SIZE, found.length)} of {found.length.toLocaleString()}</span>
      <button className="button small" disabled={visiblePage === lastPage} onClick={() => setPage(visiblePage + 1)}>Next</button>
    </nav>}
  </section>;
}
