import type { Column } from "../contracts/workbench";
import type { PivotConfig, PivotNode, PivotOutput } from "../contracts/pivot";
import { decimalCompare } from "../shared/result-analysis.mjs";
import { isNumeric } from "../shared/result-numbers.mjs";
import { PIVOT_LIMITS, pivotFieldKey, validatePivotConfig } from "../shared/pivot-config.mjs";
import { pivotCellKey, visiblePivotNodes } from "../shared/result-pivot.mjs";

export type PivotShelf = "rows" | "columns" | "values" | "filters";
export interface PivotDrag { field: string; from?: PivotShelf }
export interface PivotSort { value: number; column: string; direction: 1 | -1 }
export interface WorksheetRow extends PivotNode { groupOnly: boolean }
export interface PivotHeader { node: PivotNode; labelIndex: number; span: number; rowSpan: number; total: boolean }

export function placePivotField(config: PivotConfig, drag: PivotDrag, destination: PivotShelf, position: number, numeric: boolean): PivotConfig {
  const next = structuredClone(config);
  const value = next.values.find(item => item.field === drag.field);
  const filter = next.filters.find(item => item.field === drag.field);
  const source = drag.from ? next[drag.from].findIndex(item => (typeof item === "string" ? item : item.field) === drag.field) : -1;
  const remove = (area: PivotShelf) => {
    if (area === "rows" || area === "columns") next[area] = next[area].filter(field => field !== drag.field);
    else if (area === "values") next.values = next.values.filter(item => item.field !== drag.field);
    else next.filters = next.filters.filter(item => item.field !== drag.field);
  };
  if (drag.from) remove(drag.from);
  const existing = next[destination].findIndex(item => (typeof item === "string" ? item : item.field) === drag.field);
  if (existing >= 0) remove(destination);
  if (destination === "rows" || destination === "columns") { remove("rows"); remove("columns"); }
  const limit = destination === "rows" || destination === "columns" ? PIVOT_LIMITS.axes : destination === "values" ? PIVOT_LIMITS.values : PIVOT_LIMITS.filters;
  if (next[destination].length >= limit) throw new Error(`Use at most ${limit} fields in ${destination}. Remove a field before adding another.`);
  const index = Math.max(0, Math.min(next[destination].length, position - (drag.from === destination && source >= 0 && source < position ? 1 : 0)));
  if (destination === "rows" || destination === "columns") next[destination].splice(index, 0, drag.field);
  else if (destination === "values") next.values.splice(index, 0, value ?? { field: drag.field, aggregation: numeric ? "sum" : "count", format: numeric ? "number" : "exact" });
  else next.filters.splice(index, 0, filter ?? { field: drag.field, values: null });
  next.collapsedRows = []; next.collapsedColumns = [];
  return validatePivotConfig(next);
}

export function pivotCalculationKey(config: PivotConfig) {
  return JSON.stringify([config.rows, config.columns, config.values.map(value => [value.field, value.aggregation]), config.filters]);
}

export function pivotWorksheet(output: PivotOutput, config: PivotConfig, fields: Column[], sort: PivotSort | null) {
  const columnByKey = new Map(fields.map(field => [pivotFieldKey(field), field]));
  function orderNodes(nodes: PivotNode[], order: PivotConfig["rowOrder"], dimensions: string[], rowAxis: boolean) {
    const byKey = new Map(nodes.map(node => [node.key, node]));
    const ordered: PivotNode[] = [];
    const children = (node: PivotNode) => [...node.children].sort((a, b) => {
      const left = byKey.get(a)!, right = byKey.get(b)!;
      if (rowAxis && sort) {
        const aValue = output.cells.get(pivotCellKey(left.key, sort.column))?.[sort.value];
        const bValue = output.cells.get(pivotCellKey(right.key, sort.column))?.[sort.value];
        if (aValue == null || bValue == null) return aValue == null ? bValue == null ? 0 : 1 : -1;
        return decimalCompare(aValue, bValue) * sort.direction;
      }
      if (order === "source") return 0;
      const field = columnByKey.get(dimensions[node.depth]);
      if (!field) throw new Error("A sort field is no longer in the captured result. Reset the pivot layout.");
      const aValue = left.path.at(-1), bValue = right.path.at(-1);
      const compare = aValue == null ? bValue == null ? 0 : -1 : bValue == null ? 1
        : isNumeric(field) ? decimalCompare(aValue, bValue)
          : String(aValue).localeCompare(String(bValue), undefined, { numeric: true }) || (typeof aValue).localeCompare(typeof bValue);
      return Number(compare) * (order === "desc" ? -1 : 1);
    });
    const visit = (node: PivotNode) => {
      const sorted = children(node);
      if (rowAxis && node.depth) ordered.push(node);
      for (const child of sorted) visit(byKey.get(child)!);
      if (!rowAxis || !node.depth) ordered.push(node);
    };
    visit(byKey.get("[]")!);
    return ordered;
  }
  const rowNodes = orderNodes(output.rows, config.rowOrder, config.rows, true);
  const visibleRows = visiblePivotNodes(rowNodes, config.collapsedRows, true);
  const rows: WorksheetRow[] = visibleRows.filter(node => node.depth > 0 || config.totals || rowNodes.length === 1)
    .map(node => ({ ...node, groupOnly: !config.totals && node.children.length > 0 && !config.collapsedRows.includes(node.key) }));
  const orderedColumns = orderNodes(output.columns, config.columnOrder, config.columns, false);
  const columns = visiblePivotNodes(orderedColumns, config.collapsedColumns, config.totals);
  const allColumns = new Map(output.columns.map(node => [node.key, node]));
  const headers: PivotHeader[][] = [];
  for (let level = 0; level < config.columns.length; level++) {
    const cells: PivotHeader[] = [];
    for (let index = 0; index < columns.length;) {
      const column = columns[index];
      if (column.depth === 0) {
        if (level === 0) cells.push({ node: column, labelIndex: -1, span: config.values.length, rowSpan: config.columns.length, total: true });
        index++; continue;
      }
      if (column.depth <= level) { index++; continue; }
      if (column.depth === level + 1) {
        cells.push({ node: column, labelIndex: level, span: config.values.length, rowSpan: config.columns.length - level, total: column.children.length > 0 });
        index++; continue;
      }
      const prefix = JSON.stringify(column.path.slice(0, level + 1));
      let end = index + 1;
      while (end < columns.length && columns[end].depth > level + 1 && JSON.stringify(columns[end].path.slice(0, level + 1)) === prefix) end++;
      cells.push({ node: allColumns.get(prefix)!, labelIndex: level, span: (end - index) * config.values.length, rowSpan: 1, total: false });
      index = end;
    }
    headers.push(cells);
  }
  return { rows, columns, headers };
}
