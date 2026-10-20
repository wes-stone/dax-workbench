import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import type { Cell } from "../contracts/workbench";
import type { PivotAggregation, PivotConfig } from "../contracts/pivot";
import type { LoadedRows } from "./Grid";
import { isNumeric, isVariant } from "../shared/result-numbers.mjs";
import { resultColumnLabels } from "../shared/result-columns.mjs";
import { PIVOT_AGGREGATIONS, PIVOT_LIMITS, pivotFieldKey } from "../shared/pivot-config.mjs";
import { pivotDisplayLabel, pivotLabel } from "../shared/result-pivot.mjs";
import { errorMessage } from "./api";
import { Icon } from "./icons";
import { PivotPopover } from "./PivotPopover";
import { PivotFormatControls } from "./PivotFormatControls";
import { placePivotField, type PivotDrag, type PivotShelf } from "./pivot-worksheet-model";

const areas: { id: PivotShelf; label: string; icon: "filter" | "column" | "table" | "measure" }[] = [
  { id: "filters", label: "Filters", icon: "filter" }, { id: "columns", label: "Columns", icon: "column" },
  { id: "rows", label: "Rows", icon: "table" }, { id: "values", label: "Values", icon: "measure" },
];
const fieldsIn = (config: PivotConfig, shelf: PivotShelf) => config[shelf].map(item => typeof item === "string" ? item : item.field);
const key = (value: Cell) => JSON.stringify(value);
const valueLabel = (value: Cell, dataType?: string) => `${pivotDisplayLabel(value, dataType)}${typeof value === "number" ? " (number)" : typeof value === "boolean" ? " (boolean)" : ""}`;

export function PivotValueCaption({ label }: { label: string }) {
  const split = label.lastIndexOf(" ");
  return <span className="pivot-value-caption"><span>{split < 0 ? "" : label.slice(0, split)}</span><span>{label.slice(split + 1)}</span></span>;
}

export function PivotFields({ data, config, onChange, onClose, onError }: {
  data: LoadedRows; config: PivotConfig; onChange: (config: PivotConfig) => void; onClose: () => void; onError: (message: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [drag, setDrag] = useState<PivotDrag | null>(null);
  const [drop, setDrop] = useState<{ shelf: PivotShelf; index: number } | null>(null);
  const [menu, setMenu] = useState<{ field: string; shelf?: PivotShelf; anchor: HTMLElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const captions = useMemo(() => resultColumnLabels(data.columns), [data.columns]);
  const labels = new Map(data.columns.map((column, index) => [pivotFieldKey(column), captions[index]]));
  function place(source: PivotDrag, shelf: PivotShelf, index: number) {
    const column = data.columns.find(column => pivotFieldKey(column) === source.field);
    if (!column) { onError("That field is no longer available. Choose a current result field."); return; }
    try { onChange(placePivotField(config, source, shelf, index, isNumeric(column) || isVariant(column))); closeMenu(); }
    catch (reason) { onError(errorMessage(reason)); }
  }
  function remove(field: string, shelf?: PivotShelf) {
    const next = structuredClone(config);
    for (const area of areas.filter(area => !shelf || area.id === shelf)) {
      if (area.id === "rows" || area.id === "columns") next[area.id] = next[area.id].filter(item => item !== field);
      else if (area.id === "values") next.values = next.values.filter(item => item.field !== field);
      else next.filters = next.filters.filter(item => item.field !== field);
    }
    next.collapsedRows = []; next.collapsedColumns = [];
    closeMenu(); onChange(next);
  }
  function start(event: DragEvent, source: PivotDrag) {
    event.dataTransfer.setData("application/x-dax-pivot-field", JSON.stringify(source));
    event.dataTransfer.effectAllowed = source.from ? "move" : "copyMove";
    setDrag(source);
  }
  function finishDrop(event: DragEvent, shelf: PivotShelf, index: number) {
    event.preventDefault(); event.stopPropagation();
    if (drag) place(drag, shelf, index);
    setDrop(null); setDrag(null);
  }
  const selectedValue = config.values.find(value => value.field === menu?.field);
  const selectedFilter = config.filters.find(filter => filter.field === menu?.field);
  return <aside className="pivot-fields" aria-label="PivotTable Fields" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="pivot-fields-heading"><strong>PivotTable Fields</strong><button className="icon-button" aria-label="Close fields pane" onClick={onClose}><Icon name="close" size={14}/></button></header>
    <div className="pivot-field-search"><Icon name="search" size={14}/><input type="search" aria-label="Search captured fields" placeholder="Search fields" value={search} onChange={event => setSearch(event.target.value)}/></div>
    <div className="pivot-field-list" aria-label="Captured fields">{data.columns.map((column, index) => ({ column, label: captions[index] }))
      .filter(({ column, label }) => `${column.name} ${label}`.toLowerCase().includes(search.toLowerCase())).map(({ column, label }) => {
        const field = pivotFieldKey(column), assigned = areas.some(area => fieldsIn(config, area.id).includes(field));
        const numeric = isNumeric(column) || isVariant(column);
        return <div className="pivot-field" key={field} draggable onDragStart={event => start(event, { field })} onDragEnd={() => { setDrag(null); setDrop(null); }}>
          <label title={`${column.name} (${column.dataType})`}>
            <input type="checkbox" aria-label={label} checked={assigned} onChange={event => event.target.checked
              ? place({ field }, numeric ? "values" : "rows", config[numeric ? "values" : "rows"].length) : remove(field)}/>
            <Icon name={numeric ? "measure" : "column"} size={13}/><span>{label}</span>
          </label>
          <button className="icon-button" aria-label={`Choose area for ${label}`} onClick={event => setMenu({ field, anchor: event.currentTarget })}><Icon name="down" size={12}/></button>
        </div>;
      })}</div>
    {search && !data.columns.some((column, i) => `${column.name} ${captions[i]}`.toLowerCase().includes(search.toLowerCase())) && <p className="pivot-field-help">No matching captured fields.</p>}
    <p className="pivot-field-help">Check fields to add. Drag to arrange.</p>
    <div className="pivot-shelves">{areas.map(area => {
      const entries = fieldsIn(config, area.id);
      return <section className={`pivot-shelf ${drag ? "accepts-drop" : ""}`} key={area.id} aria-label={`Pivot ${area.label}`}
        onDragOver={event => { if (drag) { event.preventDefault(); setDrop({ shelf: area.id, index: entries.length }); } }}
        onDrop={event => finishDrop(event, area.id, entries.length)}>
        <h4><Icon name={area.icon} size={13}/>{area.label}<span>{entries.length || ""}</span></h4>
        <div className="pivot-shelf-entries">
          {entries.map((field, index) => <div className="pivot-chip" key={field} draggable
            data-drop-before={drop?.shelf === area.id && drop.index === index || undefined}
            onDragStart={event => start(event, { field, from: area.id })} onDragEnd={() => { setDrag(null); setDrop(null); }}
            onDragOver={event => {
              if (!drag) return;
              event.preventDefault(); event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setDrop({ shelf: area.id, index: index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0) });
            }} onDrop={event => finishDrop(event, area.id, drop?.shelf === area.id ? drop.index : index)}>
            <Icon name="grip" size={12}/>
            <button className="pivot-chip-label" aria-label={`Settings for ${labels.get(field)} in ${area.label}`}
              title={area.id === "values" ? `${PIVOT_AGGREGATIONS[config.values[index].aggregation]} of ${labels.get(field)}` : labels.get(field)}
              onClick={event => setMenu({ field, shelf: area.id, anchor: event.currentTarget })}>
              {area.id === "values" ? <PivotValueCaption label={`${PIVOT_AGGREGATIONS[config.values[index].aggregation]} of ${labels.get(field)}`}/>
                : <span>{labels.get(field)}</span>}<Icon name="down" size={11}/>
            </button>
          </div>)}
          <div className="pivot-drop-slot" data-active={drop?.shelf === area.id && drop.index === entries.length || undefined}>
            {!entries.length && (area.id === "values" ? "Add a value" : "Drag fields here")}
          </div>
        </div>
      </section>;
    })}</div>
    {menu && <PivotPopover anchor={menu.anchor} title={labels.get(menu.field) ?? "Field settings"} onClose={closeMenu}>
      {menu.shelf === "values" && selectedValue && <div className="pivot-value-options">
        <label>Summarize by<select aria-label={`Aggregation for ${labels.get(menu.field)}`} value={selectedValue.aggregation}
          onChange={event => onChange({ ...config, values: config.values.map(value => value.field === menu.field ? { ...value, aggregation: event.target.value as PivotAggregation } : value) })}>
          {Object.entries(PIVOT_AGGREGATIONS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <div className="pivot-field-format"><span>Number format</span>
          <PivotFormatControls values={[selectedValue]} label={`Format for ${labels.get(menu.field)}`}
            onChange={values => onChange({ ...config, values: config.values.map(value => value.field === menu.field ? values[0] : value) })}/>
        </div>
      </div>}
      {menu.shelf === "filters" && selectedFilter && <PivotFilter data={data} field={menu.field} label={labels.get(menu.field)!} selected={selectedFilter.values}
        onChange={values => onChange({ ...config, filters: config.filters.map(filter => filter.field === menu.field ? { ...filter, values } : filter) })}/>}
      {menu.shelf && <div className="pivot-menu-actions">
        <button disabled={fieldsIn(config, menu.shelf).indexOf(menu.field) === 0}
          onClick={() => place({ field: menu.field, from: menu.shelf }, menu.shelf!, fieldsIn(config, menu.shelf!).indexOf(menu.field) - 1)}>Move up</button>
        <button disabled={fieldsIn(config, menu.shelf).indexOf(menu.field) === config[menu.shelf].length - 1}
          onClick={() => place({ field: menu.field, from: menu.shelf }, menu.shelf!, fieldsIn(config, menu.shelf!).indexOf(menu.field) + 2)}>Move down</button>
      </div>}
      <div className="pivot-menu-actions">{areas.filter(area => area.id !== menu.shelf).map(area => <button key={area.id}
        onClick={() => place({ field: menu.field, from: menu.shelf }, area.id, config[area.id].length)}>
        <Icon name={area.icon} size={13}/>{menu.shelf ? "Move to" : "Add to"} {area.label}</button>)}
        {menu.shelf && <button onClick={() => remove(menu.field, menu.shelf)}><Icon name="close" size={13}/>Remove field</button>}
      </div>
    </PivotPopover>}
  </aside>;
}

export function PivotFilter({ data, field, label, selected, onChange }: {
  data: LoadedRows; field: string; label: string; selected: Cell[] | null; onChange: (values: Cell[] | null) => void;
}) {
  const [search, setSearch] = useState(""), [page, setPage] = useState(0), [values, setValues] = useState<Cell[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const dataType = data.columns.find(column => pivotFieldKey(column) === field)?.dataType;
  useEffect(() => {
    let cancelled = false; setLoading(true); setError("");
    void (async () => {
      const index = data.columns.findIndex(column => pivotFieldKey(column) === field), values = new Map<string, Cell>();
      if (index < 0 || data.rows.length > PIVOT_LIMITS.rows) throw new Error("Filter unavailable or capture exceeds 100,000 rows. Remove this filter or refine the query.");
      for (let i = 0; i < data.rows.length; i++) {
        if (i % 1000 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); if (cancelled) return; }
        values.set(key(data.rows[i][index]), data.rows[i][index]);
      }
      if (!cancelled) setValues([...values.values()]);
    })().catch(reason => { if (!cancelled) setError(errorMessage(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [data, field]);
  const matches = values.filter(value => `${valueLabel(value, dataType)} ${pivotLabel(value)}`.toLowerCase().includes(search.toLowerCase())), keys = new Set(selected?.map(key));
  return <div className="pivot-filter">
    <input type="search" aria-label={`Find ${label} values`} placeholder="Find captured values" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }}/>
    <div className="button-row"><button className="button small" onClick={() => onChange(null)}>All</button><button className="button small" onClick={() => onChange([])}>None</button><span>{selected === null ? "All values" : `${selected.length} selected`}</span></div>
    {loading && <p role="status">Reading captured values...</p>}
    {error && <p role="alert" className="field-error">{error}</p>}
    {values.length > PIVOT_LIMITS.filterValues && <p>More than 1,000 values. Choose None, then include up to 1,000.</p>}
    <div className="pivot-filter-values">{matches.slice(page * 100, page * 100 + 100).map(value => <label key={key(value)} className="dashboard-checkbox" title={pivotLabel(value)}>
      <input type="checkbox" checked={selected === null || keys.has(key(value))}
        disabled={selected === null && values.length > PIVOT_LIMITS.filterValues || selected !== null && selected.length >= PIVOT_LIMITS.filterValues && !keys.has(key(value))}
        onChange={event => onChange(event.target.checked ? [...(selected ?? []), value] : (selected ?? values).filter(item => key(item) !== key(value)))}/>{valueLabel(value, dataType)}
    </label>)}</div>
    <div className="button-row"><button className="button small" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button>
      <span>{matches.length ? page * 100 + 1 : 0}–{Math.min((page + 1) * 100, matches.length)} of {matches.length}</span>
      <button className="button small" disabled={(page + 1) * 100 >= matches.length} onClick={() => setPage(page + 1)}>Next</button></div>
  </div>;
}
