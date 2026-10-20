import type { Cell, Column } from "../contracts/workbench";
import { resultValueText } from "../shared/result-display.mjs";
export { resultColumnLabels } from "../shared/result-columns.mjs";

export const GRID_ROW_HEIGHT = 28;
export const GRID_HEADER_HEIGHT = 32;
export const GRID_GUTTER_WIDTH = 40;
export const GRID_MIN_COLUMN_WIDTH = 80;
export const GRID_MAX_COLUMN_WIDTH = 10000;
export const SHARE_CELL_LIMIT = 100;

export interface CellPosition { row: number; column: number }
export interface CellRange { top: number; bottom: number; left: number; right: number }
export interface GridSelection {
  anchor: CellPosition;
  focus: CellPosition;
  ranges: CellRange[];
}
export interface CellReference { row: number; columnId: string }

export function resultColumnWidth(label: string, type: string): number {
  return Math.min(260, Math.max(120, (Math.max(label.length, type.length) + 3) * 8));
}

export function clampColumnWidth(width: number): number {
  return Math.min(GRID_MAX_COLUMN_WIDTH, Math.max(GRID_MIN_COLUMN_WIDTH, Math.ceil(width)));
}

export async function fitResultColumnWidth(rows: Cell[][], column: number, headerWidth: number,
  measure: (text: string, blank: boolean) => number, signal?: AbortSignal,
  yieldControl = () => new Promise<void>(resolve => setTimeout(resolve, 0)), dataType?: string): Promise<number> {
  let width = clampColumnWidth(headerWidth + 48);
  const measured = new Map<string, number>();
  await yieldControl();
  signal?.throwIfAborted();
  let deadline = performance.now() + 4;
  for (let index = 0; index < rows.length; index++) {
    const value = rows[index][column] ?? null;
    // Match the worksheet's collapsed, single-line whitespace without changing values.
    const text = gridCellText(value, dataType).replace(/[ \t\r\n\f]+/g, " ").replace(/^ | $/g, "");
    const key = `${value === null ? "blank" : "text"}:${text}`;
    let size = measured.get(key);
    if (size === undefined) {
      size = measure(text, value === null);
      if (!Number.isFinite(size) || size < 0) throw new Error("The column text could not be measured.");
      if (measured.size < 2048) measured.set(key, size);
    }
    width = Math.max(width, clampColumnWidth(size + 20));
    if (width === GRID_MAX_COLUMN_WIDTH) return width;
    if ((index + 1) % 64 === 0 && (performance.now() >= deadline || (index + 1) % 4096 === 0)) {
      await yieldControl();
      signal?.throwIfAborted();
      deadline = performance.now() + 4;
    }
  }
  signal?.throwIfAborted();
  return width;
}

export function gridCellText(value: Cell, dataType?: string): string {
  return value === null ? "null" : resultValueText(value, dataType);
}

export function rangeSelection(anchor: CellPosition, focus: CellPosition): GridSelection {
  return {
    anchor, focus,
    ranges: [{ top: Math.min(anchor.row, focus.row), bottom: Math.max(anchor.row, focus.row),
      left: Math.min(anchor.column, focus.column), right: Math.max(anchor.column, focus.column) }],
  };
}

export function selectionSize(selection: GridSelection | null): number {
  return selection?.ranges.reduce((count, range) => count + (range.bottom - range.top + 1) * (range.right - range.left + 1), 0) ?? 0;
}

export function isCellSelected(selection: GridSelection | null, row: number, column: number): boolean {
  return selection?.ranges.some(range => row >= range.top && row <= range.bottom && column >= range.left && column <= range.right) ?? false;
}

export function toggleCell(selection: GridSelection | null, point: CellPosition): GridSelection {
  const ranges: CellRange[] = [];
  let removed = false;
  for (const range of selection?.ranges ?? []) {
    if (point.row < range.top || point.row > range.bottom || point.column < range.left || point.column > range.right) {
      ranges.push(range);
      continue;
    }
    removed = true;
    if (point.row > range.top) ranges.push({ ...range, bottom: point.row - 1 });
    if (point.row < range.bottom) ranges.push({ ...range, top: point.row + 1 });
    if (point.column > range.left) ranges.push({ top: point.row, bottom: point.row, left: range.left, right: point.column - 1 });
    if (point.column < range.right) ranges.push({ top: point.row, bottom: point.row, left: point.column + 1, right: range.right });
  }
  if (!removed) ranges.push({ top: point.row, bottom: point.row, left: point.column, right: point.column });
  return { anchor: point, focus: point, ranges };
}

function selectedAxes(selection: GridSelection) {
  const rows = new Set<number>(), columns = new Set<number>();
  for (const range of selection.ranges) {
    for (let row = range.top; row <= range.bottom; row++) rows.add(row);
    for (let column = range.left; column <= range.right; column++) columns.add(column);
  }
  return { rows: [...rows].sort((a, b) => a - b), columns: [...columns].sort((a, b) => a - b) };
}

function tsvCell(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function selectedCellsToTsv(data: { columns: Column[]; rows: Cell[][] }, viewRows: number[],
  selection: GridSelection, labels: string[], includeHeaders: boolean): string {
  const axes = selectedAxes(selection);
  const lines: string[] = [];
  if (includeHeaders) lines.push(axes.columns.map(column => tsvCell(labels[column])).join("\t"));
  for (const row of axes.rows) {
    lines.push(axes.columns.map(column => {
      if (!isCellSelected(selection, row, column)) return "";
      const value = data.rows[viewRows[row]][column];
      return tsvCell(value === null ? "" : String(value));
    }).join("\t"));
  }
  return lines.join("\r\n");
}

export function selectedCellReferences(columns: Column[], viewRows: number[], selection: GridSelection): CellReference[] {
  if (selectionSize(selection) > SHARE_CELL_LIMIT) throw new Error(`Share at most ${SHARE_CELL_LIMIT} cells at a time. Copy has no such limit.`);
  const cells: CellReference[] = [];
  const axes = selectedAxes(selection);
  for (const row of axes.rows) for (const column of axes.columns) {
    if (isCellSelected(selection, row, column)) cells.push({ row: viewRows[row], columnId: columns[column].id });
  }
  return cells;
}
