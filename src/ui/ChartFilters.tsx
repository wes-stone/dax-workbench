import { useMemo, useState } from "react";
import type { ChartFilter } from "../contracts/workbench";
import type { LoadedRows } from "./Grid";
import { CHART_LIMITS, chartFilterOptions } from "../shared/chart-data.mjs";
import { Icon } from "./icons";
import { resultColumnLabelMap } from "../shared/result-columns.mjs";

export function ChartFilters({ data, filters, onChange, disabled = false }: {
  data: LoadedRows; filters: ChartFilter[]; onChange: (filters: ChartFilter[]) => void; disabled?: boolean;
}) {
  const [field, setField] = useState("");
  const labels = useMemo(() => resultColumnLabelMap(data.columns), [data.columns]);
  const available = data.columns.filter(column => !filters.some(filter => filter.column === column.id));
  const selected = available.some(column => column.id === field) ? field : available[0]?.id ?? "";
  return <details className="chart-filters">
    <summary><Icon name="filter" size={13}/>Filters{filters.length ? ` (${filters.length})` : ""}<span>Only this chart · no query rerun</span></summary>
    <fieldset disabled={disabled}>
      <p className="field-help">Choose values from the captured result. Filters combine with AND; values within a filter combine with OR. The result grid stays unchanged.</p>
      {filters.map((filter, index) => <FilterValues key={filter.column} data={data} filter={filter}
        onChange={value => onChange(filters.map((item, i) => i === index ? value : item))}
        onRemove={() => onChange(filters.filter((_, i) => i !== index))}/>)}
      <div className="chart-filter-add">
        <label>Filter field<select value={selected} onChange={event => setField(event.target.value)}>
          {!available.length && <option value="">All fields filtered</option>}
          {available.map(column => <option value={column.id} key={column.id} title={column.name}>{labels.get(column.id)}</option>)}
        </select></label>
        <button className="button small" disabled={!selected || filters.length >= CHART_LIMITS.filters} onClick={() => onChange([...filters, { column: selected, operator: "in", values: [] }])}>Add filter</button>
        {filters.length > 0 && <button className="button quiet small" onClick={() => onChange([])}>Clear filters</button>}
      </div>
    </fieldset>
  </details>;
}

function FilterValues({ data, filter, onChange, onRemove }: {
  data: LoadedRows; filter: ChartFilter; onChange: (filter: ChartFilter) => void; onRemove: () => void;
}) {
  const [search, setSearch] = useState("");
  const field = data.columns.find(column => column.id === filter.column);
  const label = useMemo(() => resultColumnLabelMap(data.columns).get(filter.column), [data.columns, filter.column]);
  const options = useMemo(() => field ? chartFilterOptions(data, filter.column) : [], [data, filter.column, field]);
  const selected = new Set(filter.values.map(value => JSON.stringify(value)));
  const matches = options.filter(option => `${option.label} ${String(option.value)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const shown = matches.slice(0, 100);
  const missing = filter.values.filter(value => !options.some(option => JSON.stringify(option.value) === JSON.stringify(value)));
  return <section className="chart-filter" aria-label={`Filter ${label ?? filter.column}`}>
    <div className="chart-filter-heading"><strong title={field?.name}>{label ?? "Missing filter field"}</strong>
      <button className="button quiet small" onClick={onRemove}>Remove filter</button></div>
    {!field && <p className="field-error" role="alert">This field is not in the captured result. Remove the filter before applying.</p>}
    <div className="chart-filter-add">
      <label>Match<select value={filter.operator} onChange={event => onChange({ ...filter, operator: event.target.value as ChartFilter["operator"] })}>
        <option value="in">Include selected values</option><option value="notIn">Exclude selected values</option>
      </select></label>
      <label>Find values<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search captured values"/></label>
    </div>
    <div className="chart-filter-values">
      {shown.map(option => {
        const key = JSON.stringify(option.value), checked = selected.has(key);
        return <label key={key} title={option.value === null ? "(blank)" : String(option.value)}><input type="checkbox" checked={checked} disabled={!checked && selected.size >= CHART_LIMITS.values}
          onChange={event => onChange({ ...filter, values: event.target.checked ? [...filter.values, option.value] : filter.values.filter(value => JSON.stringify(value) !== key) })}/>{option.label}</label>;
      })}
      {!shown.length && <p className="field-help">No captured values match your search.</p>}
    </div>
    <div className="chart-filter-footer"><span>{selected.size} selected · {matches.length > 100 ? `showing 100 of ${matches.length} matches; narrow your search` : `${matches.length} captured values`}</span>
      <button className="text-button" disabled={new Set([...selected, ...shown.map(option => JSON.stringify(option.value))]).size > CHART_LIMITS.values}
        onClick={() => onChange({ ...filter, values: [...filter.values, ...shown.filter(option => !selected.has(JSON.stringify(option.value))).map(option => option.value)] })}>Select shown</button>
      <button className="text-button" onClick={() => onChange({ ...filter, values: [] })}>Clear selection</button></div>
    {!selected.size && <p className="field-help">{filter.operator === "in" ? "No values selected: applying this filter matches no rows." : "No values selected: this filter excludes no rows."}</p>}
    {missing.length > 0 && <p className="field-help">{missing.length} selected values are absent from this capture. They remain part of the filter.</p>}
  </section>;
}
