import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Cell, Column } from "../contracts/workbench";
import { compareCells, isNumeric, scopeLabel } from "./model";
import { Icon } from "./icons";
import { ResultNameSetting } from "./ResultNameSetting";
import type { Action } from "./useWorkbench";
import { useSelectionSum } from "./useSelectionSum";
import { formatSelectionSum } from "./result-selection-sum";
import { GRID_GUTTER_WIDTH, GRID_HEADER_HEIGHT, GRID_ROW_HEIGHT, GRID_MIN_COLUMN_WIDTH, GRID_MAX_COLUMN_WIDTH,
  SHARE_CELL_LIMIT, clampColumnWidth, fitResultColumnWidth, gridCellText, isCellSelected,
  rangeSelection, resultColumnLabels, resultColumnWidth, selectedCellReferences, selectedCellsToTsv, selectionSize, toggleCell,
  type CellPosition, type CellReference, type GridSelection } from "./result-grid-model";

export type { CellReference } from "./result-grid-model";
export interface LoadedRows { columns: Column[]; rows: Cell[][] }
type SelectionMode = "cell" | "row" | "column";

export function DataGrid({ data, truncated, filter, onFilterChange, onShare, sharing, showFullColumnNames, action }: {
  data: LoadedRows; truncated: boolean; filter: string; onFilterChange: (value: string) => void;
  onShare: (cells: CellReference[]) => Promise<void>; sharing: boolean;
  showFullColumnNames: boolean; action: Action;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<{ column: number; direction: 1 | -1 } | null>(null);
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const selectionRef = useRef<GridSelection | null>(null);
  const cancelDragRef = useRef<(() => void) | null>(null);
  const [copyNotice, setCopyNotice] = useState({ message: "", error: false });
  const [copying, setCopying] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const [fittingColumn, setFittingColumn] = useState<string | null>(null);
  const [sizingError, setSizingError] = useState("");
  const fitAbort = useRef<AbortController | null>(null);
  const resize = useRef<{ pointerId: number; target: HTMLElement; columnId: string; startX: number; startWidth: number; previousWidth?: number } | null>(null);
  const cancelResizeRef = useRef<(() => void) | null>(null);
  const helpId = useId();
  const labels = useMemo(() => resultColumnLabels(data.columns, showFullColumnNames), [data.columns, showFullColumnNames]);
  const widths = useMemo(() => data.columns.map((column, index) => columnWidths[column.id] ?? resultColumnWidth(labels[index], column.dataType)), [data.columns, labels, columnWidths]);
  const offsets = useMemo(() => {
    let offset = 0;
    return widths.map(width => { const start = offset; offset += width; return start; });
  }, [widths]);
  const rows = useMemo(() => {
    const term = filter.toLocaleLowerCase();
    const indices = data.rows.map((_, index) => index).filter(index => !term || data.rows[index].some((value, column) =>
      gridCellText(value, data.columns[column].dataType).toLocaleLowerCase().includes(term) || gridCellText(value).toLocaleLowerCase().includes(term)));
    if (sort) {
      const numeric = isNumeric(data.columns[sort.column]);
      indices.sort((a, b) => sort.direction * compareCells(data.rows[a][sort.column], data.rows[b][sort.column], numeric) || a - b);
    }
    return indices;
  }, [data, filter, sort]);
  const rowCount = rows.length, columnCount = data.columns.length;
  const virtualRows = useVirtualizer({ count: rowCount, getScrollElement: () => scroll.current, estimateSize: () => GRID_ROW_HEIGHT, overscan: 10, paddingStart: GRID_HEADER_HEIGHT });
  const virtualColumns = useVirtualizer({ horizontal: true, count: columnCount, getScrollElement: () => scroll.current, estimateSize: index => widths[index], overscan: 2, paddingStart: GRID_GUTTER_WIDTH });
  useLayoutEffect(() => { virtualColumns.measure(); }, [widths, virtualColumns]);

  const cancelFit = useCallback(() => {
    fitAbort.current?.abort();
    fitAbort.current = null;
    setFittingColumn(null);
  }, []);
  useEffect(() => {
    cancelFit();
    return () => { fitAbort.current?.abort(); cancelResizeRef.current?.(); };
  }, [data, labels, cancelFit]);
  const setColumnWidth = useCallback((columnId: string, width?: number) => {
    setColumnWidths(current => {
      const next = { ...current };
      if (width === undefined) delete next[columnId];
      else next[columnId] = clampColumnWidth(width);
      return next;
    });
  }, []);
  useEffect(() => {
    const grid = scroll.current;
    if (!grid) return;
    let frame: number | null = null, pointerX = 0;
    const apply = () => {
      frame = null;
      const current = resize.current;
      if (current) setColumnWidth(current.columnId,
        pointerX === current.startX ? current.previousWidth : current.startWidth + pointerX - current.startX);
    };
    const finish = (restore = false) => {
      const current = resize.current;
      if (!current) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (restore) setColumnWidth(current.columnId, current.previousWidth);
      else apply();
      resize.current = null;
      setResizingColumn(null);
      if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    };
    const cancel = () => finish(true);
    cancelResizeRef.current = cancel;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== resize.current?.pointerId) return;
      pointerX = event.clientX;
      if (frame === null) frame = requestAnimationFrame(apply);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== resize.current?.pointerId) return;
      pointerX = event.clientX;
      finish();
    };
    const lost = (event: PointerEvent) => { if (event.pointerId === resize.current?.pointerId) cancel(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !resize.current) return;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    const abort = new AbortController();
    const options = { signal: abort.signal };
    document.addEventListener("pointermove", move, options);
    document.addEventListener("pointerup", up, options);
    document.addEventListener("pointercancel", lost, options);
    document.addEventListener("keydown", escape, { ...options, capture: true });
    grid.addEventListener("lostpointercapture", lost, options);
    window.addEventListener("blur", cancel, options);
    return () => { cancel(); abort.abort(); cancelResizeRef.current = null; };
  }, [setColumnWidth]);

  async function fitColumn(index: number, header: HTMLElement) {
    cancelResizeRef.current?.(); cancelFit(); setSizingError("");
    const abort = new AbortController();
    fitAbort.current = abort;
    const column = data.columns[index];
    setFittingColumn(column.id);
    try {
      const context = document.createElement("canvas").getContext("2d");
      if (!context || !scroll.current) throw new Error("Text measurement is unavailable in this browser.");
      const body = getComputedStyle(scroll.current), heading = getComputedStyle(header.querySelector(".column-name") ?? header);
      const font = (style: CSSStyleDeclaration, italic = false) => `${italic ? "italic" : style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.font = font(heading);
      const headerWidth = context.measureText(labels[index]).width;
      const width = await fitResultColumnWidth(data.rows, index, headerWidth, (text, blank) => {
        context.font = font(body, blank);
        return context.measureText(text).width;
      }, abort.signal, undefined, column.dataType);
      if (!abort.signal.aborted) setColumnWidth(column.id, width);
    } catch (reason) {
      if (!abort.signal.aborted) setSizingError(`Column could not be fitted: ${reason instanceof Error ? reason.message : String(reason)} Drag its edge to resize instead.`);
    } finally {
      if (fitAbort.current === abort) { fitAbort.current = null; setFittingColumn(null); }
    }
  }

  const updateSelection = useCallback((next: GridSelection | null) => {
    selectionRef.current = next;
    setSelection(next);
    setCopyNotice({ message: "", error: false });
  }, []);
  const clearSelection = useCallback(() => {
    cancelDragRef.current?.();
    updateSelection(null);
  }, [updateSelection]);
  useEffect(() => { updateSelection(null); }, [rows, updateSelection]);
  const extendSelection = useCallback((position: CellPosition, mode: SelectionMode, extend: boolean) => {
    let anchor = extend && selectionRef.current ? selectionRef.current.anchor : position;
    let focus = position;
    if (mode === "row") {
      anchor = { row: anchor.row, column: 0 };
      focus = { row: position.row, column: columnCount - 1 };
    } else if (mode === "column") {
      anchor = { row: 0, column: anchor.column };
      focus = { row: rowCount - 1, column: position.column };
    }
    updateSelection(rangeSelection(anchor, focus));
  }, [rowCount, columnCount, updateSelection]);
  const selectAll = useCallback(() => {
    if (rowCount && columnCount) updateSelection(rangeSelection({ row: 0, column: 0 }, { row: rowCount - 1, column: columnCount - 1 }));
  }, [rowCount, columnCount, updateSelection]);

  useEffect(() => {
    const grid = scroll.current;
    if (!grid) return;
    let frame: number | null = null;
    let drag: { id: number; mode: SelectionMode; x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
    const cancel = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      const id = drag?.id;
      drag = null;
      if (id !== undefined && grid.hasPointerCapture(id)) grid.releasePointerCapture(id);
    };
    cancelDragRef.current = cancel;
    const step = () => {
      frame = null;
      if (!drag?.moved) return;
      const rect = grid.getBoundingClientRect();
      const left = rect.left + GRID_GUTTER_WIDTH, top = rect.top + GRID_HEADER_HEIGHT;
      const right = rect.left + grid.clientWidth, bottom = rect.top + grid.clientHeight;
      const speed = (point: number, min: number, max: number) =>
        point < min + 22 ? -Math.min(36, (min + 22 - point) / 2) :
          point > max - 22 ? Math.min(36, (point - max + 22) / 2) : 0;
      const oldX = grid.scrollLeft, oldY = grid.scrollTop;
      if (drag.mode !== "row") grid.scrollLeft += speed(drag.x, left, right);
      if (drag.mode !== "column") grid.scrollTop += speed(drag.y, top, bottom);
      const x = Math.max(left, Math.min(right - 1, drag.x)) - left + grid.scrollLeft;
      let column = 0;
      while (column < columnCount - 1 && offsets[column] + widths[column] <= x) column++;
      const row = Math.max(0, Math.min(rowCount - 1, Math.floor(
        (Math.max(top, Math.min(bottom - 1, drag.y)) - top + grid.scrollTop) / GRID_ROW_HEIGHT)));
      extendSelection({ row, column }, drag.mode, true);
      if (grid.scrollLeft !== oldX || grid.scrollTop !== oldY) frame = requestAnimationFrame(step);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !rowCount || !columnCount || !(event.target instanceof Element) ||
        event.target.closest("button, [data-column-resizer]")) return;
      const cell = event.target.closest<HTMLElement>("[data-result-column-index]");
      const row = event.target.closest<HTMLElement>("[data-select-row]");
      const column = event.target.closest<HTMLElement>("[data-select-column]");
      const all = event.target.closest("[data-select-all-results]");
      if (!cell && !row && !column && !all) return;
      event.preventDefault();
      grid.focus({ preventScroll: true });
      cancel();
      if (all) { selectAll(); return; }
      const position = {
        row: Number(row?.dataset.selectRow ?? cell?.closest<HTMLElement>("[data-result-row-index]")?.dataset.resultRowIndex ?? 0),
        column: Number(column?.dataset.selectColumn ?? cell?.dataset.resultColumnIndex ?? 0),
      };
      if ((event.ctrlKey || event.metaKey) && cell) {
        updateSelection(toggleCell(selectionRef.current, position));
        return;
      }
      const mode = row ? "row" : column ? "column" : "cell";
      extendSelection(position, mode, event.shiftKey);
      drag = { id: event.pointerId, mode, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
      grid.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.x = event.clientX; drag.y = event.clientY;
      drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3;
      if (frame === null) frame = requestAnimationFrame(step);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== drag?.id) return;
      if (frame !== null) cancelAnimationFrame(frame);
      step(); cancel();
    };
    const abort = new AbortController();
    const options = { signal: abort.signal };
    grid.addEventListener("pointerdown", down, options);
    grid.addEventListener("lostpointercapture", cancel, options);
    document.addEventListener("pointermove", move, options);
    document.addEventListener("pointerup", up, options);
    document.addEventListener("pointercancel", cancel, options);
    window.addEventListener("blur", cancel, options);
    return () => { cancel(); abort.abort(); if (cancelDragRef.current === cancel) cancelDragRef.current = null; };
  }, [rows, widths, offsets, rowCount, columnCount, extendSelection, selectAll, updateSelection]);

  const selectedCount = selectionSize(selection);
  const summary = useSelectionSum(data, rows, selection);
  const sumText = useMemo(() => summary.value?.sum != null ? formatSelectionSum(summary.value.sum) : "—", [summary.value?.sum]);
  const visibleRows = virtualRows.getVirtualItems(), visibleColumns = virtualColumns.getVirtualItems();
  const activeVisible = selection && visibleRows.some(row => row.index === selection.focus.row) &&
    visibleColumns.some(column => column.index === selection.focus.column);
  async function copy(includeHeaders: boolean) {
    const current = selectionRef.current;
    if (!current || !selectionSize(current)) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(selectedCellsToTsv(data, rows, current, labels, includeHeaders));
      setCopyNotice({ message: `${selectionSize(current).toLocaleString()} cells copied${includeHeaders ? " with headers" : ""}.`, error: false });
    } catch {
      setCopyNotice({ message: "Selected cells could not be copied. Check clipboard permissions and try again.", error: true });
    } finally { setCopying(false); }
  }
  function reveal(position: CellPosition) {
    const grid = scroll.current;
    if (!grid) return;
    const x = offsets[position.column], y = position.row * GRID_ROW_HEIGHT;
    if (x < grid.scrollLeft) grid.scrollLeft = x;
    else if (x + widths[position.column] > grid.scrollLeft + grid.clientWidth - GRID_GUTTER_WIDTH)
      grid.scrollLeft = x + widths[position.column] - grid.clientWidth + GRID_GUTTER_WIDTH;
    if (y < grid.scrollTop) grid.scrollTop = y;
    else if (y + GRID_ROW_HEIGHT > grid.scrollTop + grid.clientHeight - GRID_HEADER_HEIGHT)
      grid.scrollTop = y + GRID_ROW_HEIGHT - grid.clientHeight + GRID_HEADER_HEIGHT;
  }

  return <div className="grid-panel">
    <div className="grid-filterbar">
      <label className="search-field compact"><Icon name="search" /><input aria-label="Filter retrieved result rows" placeholder="Filter retrieved rows…" value={filter} onChange={event => onFilterChange(event.target.value)} />{filter && <button className="icon-button" aria-label="Clear result filter" onClick={() => onFilterChange("")}><Icon name="close" size={13}/></button>}</label>
      <ResultNameSetting showFullColumnNames={showFullColumnNames} action={action}/>
      <span className="scope-copy">{filter ? `${rowCount.toLocaleString()} matching · ` : ""}{scopeLabel(truncated, data.rows.length)}</span>
      {sort && <button className="text-button" onClick={() => setSort(null)}>Clear sort</button>}
      {Object.keys(columnWidths).length > 0 && <button className="text-button" onClick={() => {
        cancelResizeRef.current?.(); cancelFit(); setColumnWidths({}); setSizingError("");
      }}>Reset column widths</button>}
    </div>
    <div className="worksheet-actions" aria-label="Result worksheet actions">
      <span className="worksheet-selection-status" role="status" data-selected-cells={selectedCount}>
        {selectedCount ? `${selectedCount.toLocaleString()} cells selected${selection?.ranges.length === 1 ? ` (${selection.ranges[0].bottom - selection.ranges[0].top + 1} × ${selection.ranges[0].right - selection.ranges[0].left + 1})` : ""}` : "Drag to select cells"}
      </span>
      {selectedCount > 0 && <span className={`worksheet-sum ${summary.error ? "field-error" : ""}`} role="status" aria-label="Selection sum"
        data-selection-sum={summary.value?.sum ?? ""} data-numeric-cells={summary.value?.numericCount ?? 0}
        data-inferred-numeric-cells={summary.value?.inferredCount ?? 0} aria-busy={summary.loading}
        title={summary.error ?? `Sum of ${(summary.value?.numericCount ?? 0).toLocaleString()} selected numeric cells in the retrieved rows. Nonnumeric text, blanks, and booleans are excluded. ${summary.value?.inferredCount ? `${summary.value.inferredCount.toLocaleString()} values are interpreted as numeric from Variant/Object cells, including numeric strings; this is not a model type change. ` : ""}Calculated locally; never shared automatically.`}>
        <strong>Sum:</strong> {summary.error ? `Unavailable: ${summary.error}` : summary.loading ? "Calculating…" : sumText}
        {!summary.error && !summary.loading && Boolean(summary.value?.inferredCount) && <span className="muted"> (inferred)</span>}
      </span>}
      <button className="text-button" onClick={selectAll} disabled={!rowCount || !columnCount || selectedCount === rowCount * columnCount}>Select all</button>
      <button className="text-button" onClick={() => void copy(false)} disabled={!selectedCount || copying} aria-keyshortcuts="Control+C Meta+C">Copy</button>
      <button className="text-button" onClick={() => void copy(true)} disabled={!selectedCount || copying} aria-keyshortcuts="Control+Shift+C Meta+Shift+C">Copy with headers</button>
      <button className="text-button" onClick={clearSelection} disabled={!selectedCount}>Clear</button>
      <span className="worksheet-action-divider" aria-hidden="true"/>
      <button className="text-button share-button" disabled={!selectedCount || selectedCount > SHARE_CELL_LIMIT || sharing}
        title={`Share only highlighted cells with Copilot (up to ${SHARE_CELL_LIMIT} cells). Copy has no such limit.`}
        onClick={() => { if (selection) void onShare(selectedCellReferences(data.columns, rows, selection)); }}>
        {sharing ? "Sharing…" : "Add to Context"}
      </button>
    </div>
    {copyNotice.message && <div className={`result-notice ${copyNotice.error ? "field-error" : ""}`} role={copyNotice.error ? "alert" : "status"}>{copyNotice.message}</div>}
    {sizingError && <div className="result-notice field-error" role="alert">{sizingError}</div>}
    {fittingColumn && <span className="sr-only" role="status">Fitting column to retrieved values.</span>}
    <p id={helpId} className="sr-only">Click a cell, drag to select a range, or Shift-click to extend. Ctrl-click toggles a cell.
      Arrow keys move; Shift and arrows extend. Row numbers select rows; column names select columns.
      Shift Space selects a row; Control Space selects a column. Control or Command A selects all,
      C copies cells, and Shift C copies with headers. Home, End and Page keys navigate. Escape clears.
      Drag a column's right edge to resize; double-click the edge to fit all retrieved values.
      Focus the edge and use Left or Right to resize, Shift for larger steps, Enter to fit, or Home to reset.
      Copy stays local. Only Add to Context shares selected cells with Copilot.</p>
    <div className={`data-grid ${resizingColumn ? "is-resizing-column" : ""}`} ref={scroll} role="grid" aria-label="Query results" aria-describedby={helpId}
      aria-readonly="true" aria-multiselectable="true" aria-rowcount={rowCount + 1} aria-colcount={columnCount + 1} tabIndex={0}
      aria-activedescendant={activeVisible ? `result-cell-${rows[selection.focus.row]}-${selection.focus.column}` : undefined}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || event.altKey) return;
        const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
        if (key === "escape") { event.preventDefault(); event.stopPropagation(); clearSelection(); return; }
        if (!rowCount || !columnCount) return;
        if (command && key === "c") {
          if (selectedCount) { event.preventDefault(); event.stopPropagation(); void copy(event.shiftKey); }
          return;
        }
        if (command && key === "a") { event.preventDefault(); event.stopPropagation(); selectAll(); return; }
        const focus = { ...(selectionRef.current?.focus ?? { row: 0, column: 0 }) };
        if (key === " ") {
          event.preventDefault(); event.stopPropagation();
          extendSelection(focus, command ? "column" : event.shiftKey ? "row" : "cell", false);
          return;
        }
        const pageRows = Math.max(1, Math.floor((event.currentTarget.clientHeight - GRID_HEADER_HEIGHT) / GRID_ROW_HEIGHT));
        switch (key) {
          case "arrowup": focus.row = command ? 0 : focus.row - 1; break;
          case "arrowdown": focus.row = command ? rowCount - 1 : focus.row + 1; break;
          case "arrowleft": focus.column = command ? 0 : focus.column - 1; break;
          case "arrowright": focus.column = command ? columnCount - 1 : focus.column + 1; break;
          case "home": focus.column = 0; if (command) focus.row = 0; break;
          case "end": focus.column = columnCount - 1; if (command) focus.row = rowCount - 1; break;
          case "pageup": focus.row -= pageRows; break;
          case "pagedown": focus.row += pageRows; break;
          default: return;
        }
        event.preventDefault(); event.stopPropagation();
        focus.row = Math.max(0, Math.min(rowCount - 1, focus.row));
        focus.column = Math.max(0, Math.min(columnCount - 1, focus.column));
        extendSelection(focus, "cell", event.shiftKey);
        reveal(focus);
      }}>
      <div style={{ height: Math.max(virtualRows.getTotalSize(), 64), width: Math.max(virtualColumns.getTotalSize(), GRID_GUTTER_WIDTH), minWidth: "100%", position: "relative" }}>
        <div className="grid-header" role="row" aria-rowindex={1}>
          <div className="row-number header-number" role="columnheader" data-select-all-results aria-label="Select all cells" title="Select all cells (Ctrl/Cmd+A)">#</div>
          {visibleColumns.map(item => {
            const column = data.columns[item.index];
            const selectedHeader = selection?.ranges.some(range => item.index >= range.left && item.index <= range.right);
            return <div key={column.id} className={`column-header ${selectedHeader ? "is-selected-header" : ""}`} role="columnheader"
              data-select-column={item.index} aria-colindex={item.index + 2}
              aria-sort={sort?.column === item.index ? sort.direction === 1 ? "ascending" : "descending" : "none"}
              title={`${column.name} (${column.dataType}) · Click to select column`} style={{ left: item.start, width: item.size }}>
              <span className="column-name">{labels[item.index]}</span>
              <button className={`column-sort ${sort?.column === item.index ? "is-active" : ""}`} aria-label={`Sort ${labels[item.index]}`} title="Sort retrieved rows locally"
                onClick={() => setSort(current => ({ column: item.index, direction: current?.column === item.index && current.direction === 1 ? -1 : 1 }))}>
                <Icon name={sort?.column === item.index && sort.direction === -1 ? "down" : "up"} size={12}/>
              </button>
              <div className={`column-resizer ${resizingColumn === column.id ? "is-resizing" : ""}`} data-column-resizer
                role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`Resize ${labels[item.index]}`}
                aria-valuemin={GRID_MIN_COLUMN_WIDTH} aria-valuemax={GRID_MAX_COLUMN_WIDTH} aria-valuenow={widths[item.index]}
                aria-valuetext={`${widths[item.index]} pixels`} aria-busy={fittingColumn === column.id}
                title="Drag to resize; double-click to fit retrieved values. Left/Right adjusts width; Shift for larger steps; Enter fits; Home resets."
                onPointerDown={event => {
                  if (event.button !== 0 || !scroll.current) return;
                  event.preventDefault(); event.stopPropagation();
                  cancelDragRef.current?.(); cancelResizeRef.current?.(); cancelFit(); setSizingError("");
                  event.currentTarget.focus({ preventScroll: true });
                  resize.current = { pointerId: event.pointerId, target: event.currentTarget, columnId: column.id, startX: event.clientX,
                    startWidth: widths[item.index], previousWidth: columnWidths[column.id] };
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setResizingColumn(column.id);
                }}
                onDoubleClick={event => {
                  event.preventDefault(); event.stopPropagation();
                  void fitColumn(item.index, event.currentTarget.parentElement!);
                }}
                onKeyDown={event => {
                  if (event.ctrlKey || event.metaKey || event.altKey) return;
                  if (!["ArrowLeft", "ArrowRight", "Enter", "Home", "Escape"].includes(event.key)) return;
                  event.preventDefault(); event.stopPropagation();
                  cancelResizeRef.current?.(); cancelFit(); setSizingError("");
                  if (event.key === "Enter") void fitColumn(item.index, event.currentTarget.parentElement!);
                  else if (event.key === "Home") setColumnWidth(column.id);
                  else if (event.key === "Escape") scroll.current?.focus({ preventScroll: true });
                  else setColumnWidth(column.id, widths[item.index] + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 50 : 10));
                }}/>
            </div>;
          })}
        </div>
        {visibleRows.map(item => {
          const sourceIndex = rows[item.index], row = data.rows[sourceIndex];
          return <div key={sourceIndex} className="grid-row" role="row" aria-rowindex={item.index + 2}
            data-result-row-index={item.index} data-source-row-index={sourceIndex} style={{ top: item.start, height: item.size }}>
            <div className={`row-number ${selection?.ranges.some(range => item.index >= range.top && item.index <= range.bottom) ? "is-selected-header" : ""}`}
              role="rowheader" data-select-row={item.index} title={`Select row ${item.index + 1} (source row ${sourceIndex + 1})`}>{item.index + 1}</div>
            {visibleColumns.map(columnItem => {
              const column = data.columns[columnItem.index], value = row[columnItem.index] ?? null;
              const selected = isCellSelected(selection, item.index, columnItem.index);
              const active = selection?.focus.row === item.index && selection.focus.column === columnItem.index;
              const edges = selected ? [
                !isCellSelected(selection, item.index - 1, columnItem.index) && "selection-top",
                !isCellSelected(selection, item.index + 1, columnItem.index) && "selection-bottom",
                !isCellSelected(selection, item.index, columnItem.index - 1) && "selection-left",
                !isCellSelected(selection, item.index, columnItem.index + 1) && "selection-right",
              ].filter(Boolean).join(" ") : "";
              return <div key={column.id} id={`result-cell-${sourceIndex}-${columnItem.index}`} role="gridcell"
                data-result-column-index={columnItem.index} aria-colindex={columnItem.index + 2} aria-selected={selected}
                className={`grid-cell ${isNumeric(column) ? "numeric" : ""} ${value === null ? "blank" : ""} ${typeof value === "boolean" ? "boolean-value" : ""} ${selected ? "selected" : ""} ${active ? "active-cell" : ""} ${edges}`}
                style={{ left: columnItem.start, width: columnItem.size }} title={gridCellText(value)}>
                <span className="result-cell-value">{gridCellText(value, column.dataType)}</span>
              </div>;
            })}
          </div>;
        })}
      </div>
      {!rowCount && <div className="grid-empty">{filter ? "No rows match this local filter." : "The query returned no rows."}</div>}
    </div>
    <div className="grid-hint"><span title="Drag a column's right edge to resize; double-click it to fit retrieved values. Drag cells to select; Ctrl+C copies; Ctrl+Shift+C includes headers. Only Add to Context shares cells.">Drag header edge to resize · Double-click to fit · Ctrl+C to copy · Add to Context shares explicitly</span><span>{selectedCount > SHARE_CELL_LIMIT ? "Copy available · share up to 100 cells" : "Read-only"}</span></div>
  </div>;
}
