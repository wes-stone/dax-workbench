import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { Cell } from "../contracts/workbench";
import type { PivotConfig, PivotNode, PivotOutput, PivotValue } from "../contracts/pivot";
import type { LoadedRows } from "./Grid";
import { downloadBlob, errorMessage } from "./api";
import { resultColumnLabels } from "../shared/result-columns.mjs";
import { emptyPivot, PIVOT_AGGREGATIONS, pivotFieldKey, pivotLayoutOnly } from "../shared/pivot-config.mjs";
import { formatPivotNumber, pivotCellKey, pivotContributingRows, pivotDelimited, pivotDisplayLabel, pivotLabel, pivotResult, pivotTableData } from "../shared/result-pivot.mjs";
import { pivotCalculationKey, pivotWorksheet, type PivotSort } from "./pivot-worksheet-model";
import { clampColumnWidth, isCellSelected, rangeSelection, selectionSize, type CellPosition, type GridSelection } from "./result-grid-model";
import { useSelectionSum } from "./useSelectionSum";
import { PivotFields, PivotFilter, PivotValueCaption } from "./PivotFields";
import { PivotPopover } from "./PivotPopover";
import { PivotFormatControls } from "./PivotFormatControls";
import { Icon } from "./icons";
import "./result-pivot.css";

type Inspection = { row: PivotNode; column: PivotNode; value: number };
export function ResultPivot({ data, initial, saved, onChange, onSave, scope }: {
  data: LoadedRows; initial: PivotConfig; saved: PivotConfig; onChange: (config: PivotConfig) => void;
  onSave: (config: PivotConfig) => Promise<unknown>; scope: string;
}) {
  const [config, setConfig] = useState(initial), [showFields, setShowFields] = useState(() => !matchMedia("(max-width: 640px)").matches);
  const [computed, setComputed] = useState<{ key: string; config: PivotConfig; data: LoadedRows; output: PivotOutput }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [notice, setNotice] = useState(""), [saveError, setSaveError] = useState(""), [localError, setLocalError] = useState("");
  const [saving, setSaving] = useState(false), [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState<PivotSort | null>(null), [selection, setSelection] = useState<GridSelection | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [formatField, setFormatField] = useState("");
  const [inspection, setInspection] = useState<Inspection>();
  const [popover, setPopover] = useState<{ kind: "layout" | "export" | "about" | "filter"; anchor: HTMLElement; field?: string }>();
  const closePopover = useCallback(() => setPopover(undefined), []);
  const saveVersion = useRef(0), mounted = useRef(true), tableScroll = useRef<HTMLDivElement>(null);
  const fieldsButton = useRef<HTMLButtonElement>(null);
  const closeFields = useCallback(() => { setShowFields(false); fieldsButton.current?.focus(); }, []);
  const dragging = useRef(false);
  const labels = useMemo(() => {
    const captions = resultColumnLabels(data.columns);
    return new Map(data.columns.map((column, index) => [pivotFieldKey(column), captions[index]]));
  }, [data.columns]);
  const types = useMemo(() => new Map(data.columns.map(column => [pivotFieldKey(column), column.dataType])), [data.columns]);
  const dimensionLabel = (value: Cell | undefined, field: string) => pivotDisplayLabel(value, types.get(field));
  const key = pivotCalculationKey(config);
  const calculation = useMemo(() => ({ ...config, rowOrder: "source" as const, columnOrder: "source" as const, totals: true,
    collapsedRows: [], collapsedColumns: [] }), [key]);
  const output = computed?.data === data && config.values.length ? computed.output : undefined;
  const current = Boolean(output && computed?.key === key);
  const displayed = current ? config : computed?.config ?? config;
  const error = failure?.key === key ? failure.message : "";
  const busy = config.values.length > 0 && !current && !error;
  const view = useMemo(() => {
    try { return { ...output ? pivotWorksheet(output, displayed, data.columns, current ? sort : null) : { rows: [], columns: [], headers: [] }, error: "" }; }
    catch (reason) { return { rows: [], columns: [], headers: [], error: errorMessage(reason) }; }
  }, [output, displayed, data.columns, current, sort]);
  const selectionData = useMemo<LoadedRows>(() => ({
    columns: view.columns.flatMap(column => displayed.values.map((value, index) => ({
      id: `${column.key}:${index}`, name: labels.get(value.field)!, dataType: "Decimal",
    }))),
    rows: view.rows.map(row => view.columns.flatMap(column => displayed.values.map((_, index) => row.groupOnly ? null : output?.cells.get(pivotCellKey(row.key, column.key))?.[index] ?? null))),
  }), [view, displayed.values, output, labels]);
  const indices = useMemo(() => selectionData.rows.map((_, i) => i), [selectionData]);
  const sum = useSelectionSum(selectionData, indices, selection);
  const count = selectionSize(selection);
  const selectedRow = selection && view.rows[selection.focus.row];
  const selectedColumn = selection && view.columns[Math.floor(selection.focus.column / displayed.values.length)];
  const selectedValue = selection ? selection.focus.column % displayed.values.length : 0;
  const exact = selectedRow && selectedColumn && !selectedRow.groupOnly ? output?.cells.get(pivotCellKey(selectedRow.key, selectedColumn.key))?.[selectedValue] : undefined;
  const formatTarget = config.values.some(value => value.field === formatField) ? formatField : "";
  const formatValues = config.values.filter(value => !formatTarget || value.field === formatTarget);
  const layoutSaved = JSON.stringify(pivotLayoutOnly(config)) === JSON.stringify(saved);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setSelection(null); setInspection(undefined);
    if (calculation.values.length) void pivotResult(data, calculation, controller.signal)
      .then(output => { if (!controller.signal.aborted) setComputed({ data, config: calculation, key, output }); })
      .catch(reason => { if (!controller.signal.aborted) setFailure({ key, message: errorMessage(reason) }); });
    return () => controller.abort();
  }, [data, calculation, key]);
  useEffect(() => {
    const end = () => { dragging.current = false; };
    window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end); window.addEventListener("blur", end);
    return () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); };
  }, []);
  function save(next: PivotConfig) {
    const version = ++saveVersion.current; setSaving(true); setSaveError("");
    void onSave(pivotLayoutOnly(next)).catch(reason => {
      if (mounted.current && version === saveVersion.current) setSaveError(`Layout not saved: ${errorMessage(reason)} Your current view is still available.`);
    }).finally(() => { if (mounted.current && version === saveVersion.current) setSaving(false); });
  }
  function update(next: PivotConfig) {
    let nextLayout: PivotConfig, previousLayout: PivotConfig;
    try { nextLayout = pivotLayoutOnly(next); previousLayout = pivotLayoutOnly(config); }
    catch (reason) { setLocalError(errorMessage(reason)); return; }
    if (pivotCalculationKey(next) !== key) setSort(null);
    if (pivotCalculationKey(next) !== key || next.rowOrder !== config.rowOrder || next.columnOrder !== config.columnOrder
      || next.totals !== config.totals || JSON.stringify([next.collapsedRows, next.collapsedColumns]) !== JSON.stringify([config.collapsedRows, config.collapsedColumns])) setSelection(null);
    setConfig(next); onChange(next); setInspection(undefined); setNotice(""); setLocalError("");
    if (JSON.stringify(previousLayout) !== JSON.stringify(nextLayout)) save(next);
  }
  function toggle(node: PivotNode, axis: "Rows" | "Columns") {
    const name = axis === "Rows" ? "collapsedRows" : "collapsedColumns";
    update({ ...config, [name]: config[name].includes(node.key) ? config[name].filter(key => key !== node.key) : [...config[name], node.key] });
  }
  function inspect() {
    if (current && selectedRow && selectedColumn && !selectedRow.groupOnly) setInspection({ row: selectedRow, column: selectedColumn, value: selectedValue });
  }
  function select(point: CellPosition, extend: boolean, focus = false) {
    if (!current || view.error) return;
    if (!extend) setFormatField(displayed.values[point.column % displayed.values.length].field);
    setSelection(previous => rangeSelection(extend && previous ? previous.anchor : point, point));
    if (focus) tableScroll.current?.querySelector<HTMLElement>(`[data-row="${point.row}"][data-column="${point.column}"]`)?.focus();
  }
  function navigate(event: KeyboardEvent<HTMLTableCellElement>, point: CellPosition) {
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!event.ctrlKey && !event.metaKey) inspect(); return; }
    if (event.key === "Escape") { event.stopPropagation(); setSelection(null); return; }
    const next = { ...point }, last = view.columns.length * displayed.values.length - 1;
    if (event.key === "ArrowLeft") next.column--;
    else if (event.key === "ArrowRight") next.column++;
    else if (event.key === "ArrowUp") next.row--;
    else if (event.key === "ArrowDown") next.row++;
    else if (event.key === "Home") { next.column = 0; if (event.ctrlKey) next.row = 0; }
    else if (event.key === "End") { next.column = last; if (event.ctrlKey) next.row = view.rows.length - 1; }
    else return;
    event.preventDefault(); event.stopPropagation();
    next.row = Math.max(0, Math.min(view.rows.length - 1, next.row)); next.column = Math.max(0, Math.min(last, next.column));
    select(next, event.shiftKey, true);
  }
  async function exportPivot(format: "copy" | "csv" | "json") {
    if (!output || !current || exporting || view.error) return;
    setExporting(true); setLocalError(""); setNotice(""); closePopover();
    try {
      const table = pivotTableData(output, config, data.columns, view);
      if (format === "copy") await navigator.clipboard.writeText(pivotDelimited(table));
      else if (format === "csv") downloadBlob(new Blob(["\uFEFF", pivotDelimited(table, ",")], { type: "text/csv;charset=utf-8" }), "dax-pivot.csv");
      else downloadBlob(new Blob([JSON.stringify({ version: 1, scope, sourceRows: output.sourceRows, filteredRows: output.filteredRows,
        note: "Local pivot in displayed order. Do not sum detail and subtotal rows together. Not recalculated DAX totals. Group-only rows have no displayed aggregate.",
        config, ...table, rowMembers: view.rows.map(row => row.path), columnMembers: view.columns.map(column => column.path),
        cells: view.rows.map(row => view.columns.map(column => {
          const values = output.cells.get(pivotCellKey(row.key, column.key));
          return row.groupOnly ? { groupOnly: true } : values ? { present: true, values } : { present: false };
        })) }, null, 2)], { type: "application/json" }), "dax-pivot.json");
      setNotice(format === "copy" ? "Pivot copied. Exact values; subtotal rows are marked." : `${format.toUpperCase()} pivot downloaded.${format === "csv" ? " Excel may reinterpret precision; JSON preserves exact strings." : ""}`);
    } catch (reason) { setLocalError(errorMessage(reason)); }
    finally { if (mounted.current) setExporting(false); }
  }
  function resizeHandle(id: string, label: string, fallback: number) {
    const width = widths[id] ?? fallback;
    return <span className="pivot-column-resize" role="separator" aria-label={`Resize ${label}`} aria-orientation="vertical" tabIndex={0}
      aria-valuemin={80} aria-valuemax={10000} aria-valuenow={width}
      onDoubleClick={() => setWidths(previous => ({ ...previous, [id]: fallback }))}
      onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); setWidths(previous => ({ ...previous, [id]: clampColumnWidth(width + (event.key === "ArrowRight" ? 16 : -16)) })); }
      }}
      onPointerDown={event => {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.startX = String(event.clientX); event.currentTarget.dataset.startWidth = String(width);
      }}
      onPointerMove={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidths(previous => ({ ...previous,
          [id]: clampColumnWidth(Number(event.currentTarget.dataset.startWidth) + event.clientX - Number(event.currentTarget.dataset.startX)) }));
      }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={event => setWidths(previous => ({ ...previous, [id]: Number(event.currentTarget.dataset.startWidth) || fallback }))}/>;
  }
  return <section className="pivot-workspace" aria-label="Pivot captured results" onKeyDown={event => {
    if (event.key === "F5" || (event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); }
  }}>
    <div className="pivot-toolbar">
      <button className="button small quiet" onClick={event => setPopover({ kind: "layout", anchor: event.currentTarget })}><Icon name="settings" size={14}/>Layout<Icon name="down" size={10}/></button>
      <button className="button small quiet" disabled={!current || exporting || Boolean(view.error)} onClick={() => void exportPivot("copy")}><Icon name="copy" size={14}/>Copy pivot</button>
      <button className="button small quiet" disabled={!current || exporting || Boolean(view.error)} onClick={event => setPopover({ kind: "export", anchor: event.currentTarget })}><Icon name="download" size={14}/>Export<Icon name="down" size={10}/></button>
      <div className="pivot-quick-format" role="group" aria-label="Quick value formatting">
        <span className="pivot-format-label">Format</span>
        <div className="pivot-format-target" title={formatTarget ? labels.get(formatTarget) : "Apply formatting to every value field"}>
          <select aria-label="Values to format" value={formatTarget} disabled={!config.values.length} onChange={event => setFormatField(event.target.value)}>
            <option value="">All values</option>
            {config.values.map(value => <option value={value.field} key={value.field}>{labels.get(value.field)}</option>)}
          </select>
          <span className="pivot-format-target-caption" aria-hidden="true">{formatTarget ? <PivotValueCaption label={labels.get(formatTarget)!}/> : "All values"}</span>
          <Icon name="down" size={10}/>
        </div>
        <PivotFormatControls values={formatValues} label="Pivot value format" onChange={(values: PivotValue[]) => {
          const changes = new Map(values.map(value => [value.field, value]));
          update({ ...config, values: config.values.map(value => changes.get(value.field) ?? value) });
        }}/>
      </div>
      <span className="pivot-toolbar-spacer"/>
      <button ref={fieldsButton} className="button small quiet" aria-pressed={showFields} aria-expanded={showFields} onClick={() => setShowFields(value => !value)}><Icon name="panel" size={14}/>Fields</button>
    </div>
    <div className={`pivot-layout ${showFields ? "" : "pivot-fields-hidden"}`}>
      <div className="pivot-main">
        {config.filters.length > 0 && <div className="pivot-filter-bar" aria-label="Pivot report filters">{config.filters.map(filter =>
          <button className="pivot-report-filter" key={filter.field} onClick={event => setPopover({ kind: "filter", field: filter.field, anchor: event.currentTarget })}
            aria-label={`Filter ${labels.get(filter.field)}`} data-filtered={filter.values !== null || undefined}>
            <Icon name="filter" size={12}/><span>{labels.get(filter.field)}</span><strong>{filter.values === null ? "All" : filter.values.length === 1 ? dimensionLabel(filter.values[0], filter.field) : `${filter.values.length} selected`}</strong><Icon name="down" size={10}/>
          </button>)}</div>}
        <div className="pivot-formula-bar"><span className="pivot-cell-address">{selection ? `R${selection.focus.row + 1} C${selection.focus.column + 1}` : "Value"}</span>
          <output aria-label="Selected pivot value" title={selection ? `${selectedRow?.path.map(pivotLabel).join(" / ") || "Grand total"} · ${selectedColumn?.path.map(pivotLabel).join(" / ") || "Grand total"}` : undefined}>
            {selection ? count > 1 ? `${count.toLocaleString()} cells selected` : pivotLabel(exact) : "Select cells to check values. Double-click a value to see its rows."}
          </output>
          <button className="button small quiet" disabled={!selection || count !== 1 || !current || Boolean(selectedRow?.groupOnly)} onClick={inspect}>Show rows</button>
        </div>
        {(error || view.error || localError) && <p className="pivot-message field-error" role="alert">{error || view.error || localError}{output && !current ? " Previous layout shown; copying is disabled." : ""}</p>}
        {busy && <div className="pivot-updating" role="status">{output ? "Updating locally · previous layout shown" : "Calculating locally..."}</div>}
        {!config.values.length && <div className="pivot-empty"><Icon name="table" size={34}/><h4>Start with a value</h4>
          <p>Check a measure in the field list. Add row and column fields to break it down.</p>
          {!showFields && <button className="button" onClick={() => setShowFields(true)}>Choose fields</button>}
          <span>Works with your captured result. No query runs.</span></div>}
        {output && !view.error && <div className="pivot-table-scroll" ref={tableScroll} tabIndex={0} role="region" aria-label="Scrollable pivot table" aria-busy={busy}
          onCopy={event => {
            if (!selection || !current) return;
            const range = selection.ranges[0];
            const rows = view.rows.slice(range.top, range.bottom + 1).map((row, ri) => Array.from({ length: range.right - range.left + 1 }, (_, offset) => {
              const ci = range.left + offset, column = view.columns[Math.floor(ci / displayed.values.length)];
              return row.groupOnly ? "" : output.cells.get(pivotCellKey(view.rows[range.top + ri].key, column.key))?.[ci % displayed.values.length] ?? pivotLabel(output.cells.get(pivotCellKey(row.key, column.key))?.[ci % displayed.values.length]);
            }));
            event.preventDefault(); event.clipboardData.setData("text/plain", pivotDelimited({ headers: [], rows }).slice(2));
            setNotice("Selected cells copied with exact values.");
          }}>
          <table className="pivot-table" aria-label="Local pivot" style={{ width: (widths.row ?? 224) + view.columns.reduce(total => total + displayed.values.reduce((sum, value) => sum + (widths[`${value.field}`] ?? 152), 0), 0) }}>
            <colgroup><col style={{ width: widths.row ?? 224 }}/>{view.columns.flatMap(column => displayed.values.map(value => <col key={`${column.key}:${value.field}`} style={{ width: widths[value.field] ?? 152 }}/>))}</colgroup>
            <thead>{view.headers.map((headers, level) => <tr key={level}>
              {level === 0 && <th className="pivot-row-corner" rowSpan={view.headers.length + 1} scope="col"><span>{displayed.rows.map(field => labels.get(field)).join(" / ") || "Row labels"}</span>{resizeHandle("row", "row labels", 224)}</th>}
              {headers.map(header => <th key={`${header.node.key}:${header.total}`} colSpan={header.span} rowSpan={header.rowSpan} scope="colgroup" data-total={header.total || undefined} title={header.node.path.map(pivotLabel).join(" / ") || "Grand total"}>
                <span className="pivot-column-group" style={{ left: (widths.row ?? 224) + 8 }}>
                {header.node.depth > 0 && header.node.children.length > 0 && <button className="pivot-toggle" disabled={!current} aria-label={`${config.collapsedColumns.includes(header.node.key) ? "Expand" : "Collapse"} column ${header.node.path.map((value, i) => dimensionLabel(value, displayed.columns[i])).join(" / ")}`}
                  aria-expanded={!config.collapsedColumns.includes(header.node.key)} onClick={() => toggle(header.node, "Columns")}>{config.collapsedColumns.includes(header.node.key) ? "+" : "−"}</button>}
                {header.labelIndex < 0 ? "Grand total" : dimensionLabel(header.node.path[header.labelIndex], displayed.columns[header.labelIndex]) + (header.total ? " Total" : "")}
                </span>
              </th>)}
            </tr>)}
            <tr>{!view.headers.length && <th className="pivot-row-corner" scope="col"><span>{displayed.rows.map(field => labels.get(field)).join(" / ") || "Row labels"}</span>{resizeHandle("row", "row labels", 224)}</th>}
              {view.columns.flatMap(column => displayed.values.map((value, index) => <th key={`${column.key}:${value.field}`} scope="col"
                aria-sort={sort?.column === column.key && sort.value === index ? sort.direction === 1 ? "ascending" : "descending" : undefined}>
                <button className="pivot-measure-heading" disabled={!current} title={`Sort rows by ${PIVOT_AGGREGATIONS[value.aggregation]} ${labels.get(value.field)} · ${column.path.map(pivotLabel).join(" / ") || "Grand total"}`}
                  onClick={() => { setSelection(null); setSort(previous => previous?.value === index && previous.column === column.key ? previous.direction === -1 ? { value: index, column: column.key, direction: 1 } : null : { value: index, column: column.key, direction: -1 }); }}>
                  <span>{PIVOT_AGGREGATIONS[value.aggregation]} {labels.get(value.field)}</span>{sort?.column === column.key && sort.value === index && <Icon name={sort.direction === 1 ? "up" : "down"} size={12}/>}
                  {value.format === "thousands" || value.format === "millions" ? <small>{value.format}</small> : null}
                </button>{resizeHandle(value.field, labels.get(value.field)!, 152)}
              </th>))}
            </tr></thead>
            <tbody>{view.rows.map((row, ri) => <tr key={row.key} data-total={row.children.length > 0 || row.depth === 0 || undefined} data-grand={row.depth === 0 || undefined}>
              <th scope="row" title={row.path.map(pivotLabel).join(" / ") || "Grand total"} style={{ "--pivot-depth": Math.max(0, row.depth - 1) } as CSSProperties}>
                <div className="pivot-row-label">{row.depth > 0 && row.children.length > 0 ? <button className="pivot-toggle" disabled={!current} aria-label={`${config.collapsedRows.includes(row.key) ? "Expand" : "Collapse"} row ${row.path.map((value, i) => dimensionLabel(value, displayed.rows[i])).join(" / ")}`}
                  aria-expanded={!config.collapsedRows.includes(row.key)} onClick={() => toggle(row, "Rows")}>{config.collapsedRows.includes(row.key) ? "+" : "−"}</button> : <span className="pivot-outline-space"/>}
                  <span>{row.depth ? dimensionLabel(row.path.at(-1), displayed.rows[row.depth - 1]) : "Grand total"}</span>
                </div>
              </th>
              {view.columns.flatMap((column, columnIndex) => displayed.values.map((value, index) => {
                const ci = columnIndex * displayed.values.length + index;
                const exact = output.cells.get(pivotCellKey(row.key, column.key))?.[index], point = { row: ri, column: ci };
                return <td key={`${column.key}:${value.field}`} data-row={ri} data-column={ci}
                  data-selected={isCellSelected(selection, ri, ci) || undefined} data-negative={typeof exact === "string" && exact.startsWith("-") || undefined}
                  tabIndex={selection ? selection.focus.row === ri && selection.focus.column === ci ? 0 : -1 : ri === 0 && ci === 0 ? 0 : -1}
                  title={row.groupOnly ? "Group heading" : `Exact: ${pivotLabel(exact)}. Double-click to see contributing captured rows.`}
                  onFocus={() => { if (!selection) select(point, false); }}
                  onPointerDown={event => { if (event.button !== 0) return; if (event.pointerType === "touch") { select(point, event.shiftKey); return; } event.preventDefault(); dragging.current = true; select(point, event.shiftKey, true); }}
                  onPointerEnter={event => { if (dragging.current && event.buttons === 1) select(point, true); }}
                  onClick={event => { if (!selection || event.detail === 0) select(point, event.shiftKey, true); }}
                  onDoubleClick={() => { if (current && !row.groupOnly) setInspection({ row, column, value: index }); }}
                  onKeyDown={event => navigate(event, point)}>
                  {row.groupOnly ? "" : formatPivotNumber(exact, value.format, value.decimalPlaces)}
                </td>;
              }))}
            </tr>)}</tbody>
          </table>
        </div>}
        {inspection && output && current && <PivotInspection data={data} config={config} inspection={inspection} output={output} onClose={() => { setInspection(undefined); if (selection) select(selection.focus, true, true); }}/>}
      </div>
      {showFields && <PivotFields data={data} config={config} onChange={update} onClose={closeFields} onError={setLocalError}/>}
    </div>
    <footer className="pivot-statusbar">
      <span role="status">{busy ? "Updating..." : output ? `${output.filteredRows.toLocaleString()} of ${output.sourceRows.toLocaleString()} captured rows` : "Local pivot"}</span>
      {count > 0 && <span className="pivot-selection-status" role="status">Count: {count.toLocaleString()} · Sum: {sum.loading ? "..." : sum.value?.sum ?? "—"}{count > 1 && <span title="Selection may include both totals and their details."> · includes selected totals</span>}</span>}
      <span className="pivot-save-status" title="Fields and formats are remembered; filter selections and collapsed members stay in memory only.">{saving ? "Saving..." : saveError ? "Not saved" : layoutSaved ? "Layout saved" : "Unsaved layout"}</span>
      <button className="icon-button" aria-label="About this local pivot" onClick={event => setPopover({ kind: "about", anchor: event.currentTarget })}><Icon name="info" size={13}/></button>
    </footer>
    {saveError && <p className="pivot-message field-error" role="alert">{saveError} <button className="button small" onClick={() => save(config)}>Retry saving layout</button></p>}
    {!saving && !saveError && !layoutSaved && <button className="button small" onClick={() => save(config)}>Save field layout</button>}
    {sum.error && <p className="pivot-message field-error" role="alert">{sum.error}</p>}
    {notice && <div className="pivot-message" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss pivot notice" onClick={() => setNotice("")}><Icon name="close" size={12}/></button></div>}
    {popover && <PivotPopover anchor={popover.anchor} title={popover.kind === "layout" ? "Pivot layout" : popover.kind === "export" ? "Export pivot" : popover.kind === "filter" ? labels.get(popover.field!)! : "About this local pivot"} onClose={closePopover}>
      {popover.kind === "export" ? <div className="pivot-menu-actions"><button onClick={() => void exportPivot("csv")}>Pivot CSV</button><button onClick={() => void exportPivot("json")}>Pivot JSON</button><p>Current visible pivot, with exact values. Raw-result exports above are separate.</p></div>
      : popover.kind === "filter" ? <PivotFilter data={data} field={popover.field!} label={labels.get(popover.field!)!} selected={config.filters.find(filter => filter.field === popover.field)?.values ?? null}
        onChange={values => update({ ...config, filters: config.filters.map(filter => filter.field === popover.field ? { ...filter, values } : filter) })}/>
      : popover.kind === "layout" ? <div className="pivot-layout-options">
        <label>Row order<select aria-label="Pivot row order" value={config.rowOrder} onChange={event => { setSort(null); update({ ...config, rowOrder: event.target.value as PivotConfig["rowOrder"] }); }}><option value="source">Captured order</option><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
        <label>Column order<select aria-label="Pivot column order" value={config.columnOrder} onChange={event => update({ ...config, columnOrder: event.target.value as PivotConfig["columnOrder"] })}><option value="source">Captured order</option><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
        <label className="dashboard-checkbox"><input type="checkbox" checked={config.totals} onChange={event => update({ ...config, totals: event.target.checked })}/>Show totals</label>
        <div className="pivot-menu-actions">
          <button disabled={!output || !current} onClick={() => { update({ ...config, collapsedRows: output!.rows.filter(row => row.depth === 1 && row.children.length).map(row => row.key) }); closePopover(); }}>Collapse rows</button>
          <button disabled={!output || !current} onClick={() => { update({ ...config, collapsedColumns: output!.columns.filter(column => column.depth === 1 && column.children.length).map(column => column.key) }); closePopover(); }}>Collapse columns</button>
          <button onClick={() => { update({ ...config, collapsedRows: [], collapsedColumns: [] }); closePopover(); }}>Expand all</button>
          <button onClick={() => { update(emptyPivot()); closePopover(); }}>Reset pivot</button>
        </div>
      </div> : <div className="pivot-about"><p>{scope}</p><p>Local aggregation of captured rows, not recalculated DAX measure totals. Nulls and absent combinations stay distinct. Averages round to 12 decimal places; formats change display only.</p>
        {output?.inferredFields.length ? <p>Numeric interpretation (inferred): {output.inferredFields.map(field => labels.get(field)).join(", ")}. Every captured non-null value is checked.</p> : null}
        <p>Fields, formats and label order are saved for this query revision and schema. Filters, collapsed members and value sorting stay in memory. Raw rows are not pinned or shared.</p>
        <p>Click a value heading to sort largest first, smallest first, then layout order. Shift-click or drag to select cells; Ctrl+C copies exact selected values. Resize a heading edge to widen columns.</p>
      </div>}
    </PivotPopover>}
  </section>;
}

function PivotInspection({ data, config, inspection, output, onClose }: {
  data: LoadedRows; config: PivotConfig; inspection: Inspection; output: PivotOutput; onClose: () => void;
}) {
  const [page, setPage] = useState(0), [rows, setRows] = useState<Cell[][]>(), [error, setError] = useState("");
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setRows(undefined); setError(""); setPage(0);
    void pivotContributingRows(data, config, inspection.row.path, inspection.column.path, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setRows(rows); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [data, config, inspection]);
  const exact = output.cells.get(pivotCellKey(inspection.row.key, inspection.column.key))?.[inspection.value];
  return <section className="pivot-inspection" aria-label="Contributing captured rows" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header><strong>Exact aggregate: {pivotLabel(exact)}</strong><button ref={close} className="button small quiet" onClick={onClose}>Close inspection<Icon name="close" size={12}/></button></header>
    {error && <p className="field-error" role="alert">{error}</p>}
    {!rows && !error ? <p role="status">Finding contributing captured rows...</p> : rows && <><p>{rows.length.toLocaleString()} contributing captured rows, not underlying model transactions. No query was run.</p>
      <div className="pivot-inspection-scroll"><table><thead><tr>{resultColumnLabels(data.columns).map((label, index) => <th key={index}>{label}</th>)}</tr></thead>
        <tbody>{rows.slice(page * 50, page * 50 + 50).map((row, index) => <tr key={index}>{row.map((value, ci) => <td key={ci} title={pivotLabel(value)}>{pivotDisplayLabel(value, data.columns[ci].dataType)}</td>)}</tr>)}</tbody></table></div>
      <div className="button-row"><button className="button small" disabled={!page} onClick={() => setPage(page - 1)}>Previous rows</button>
        <span>{rows.length ? page * 50 + 1 : 0}–{Math.min((page + 1) * 50, rows.length)} of {rows.length}</span>
        <button className="button small" disabled={(page + 1) * 50 >= rows.length} onClick={() => setPage(page + 1)}>Next rows</button></div></>}
  </section>;
}
