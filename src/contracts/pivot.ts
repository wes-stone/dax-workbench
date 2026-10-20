import type { Cell } from "./workbench";

export type PivotAggregation = "sum" | "average" | "min" | "max" | "count" | "countRows" | "distinct";
export type PivotFormat = "exact" | "number" | "thousands" | "millions" | "percent";
export interface PivotValue { field: string; aggregation: PivotAggregation; format: PivotFormat; decimalPlaces?: number }
export interface PivotFilter { field: string; values: Cell[] | null }
export interface PivotConfig {
  version: 1;
  rows: string[];
  columns: string[];
  values: PivotValue[];
  filters: PivotFilter[];
  rowOrder: "source" | "asc" | "desc";
  columnOrder: "source" | "asc" | "desc";
  totals: boolean;
  collapsedRows: string[];
  collapsedColumns: string[];
}
export interface PivotLayout { source: string; config: PivotConfig }
export interface PivotNode {
  key: string; path: Cell[]; parent: string | null; depth: number; children: string[];
}
export interface PivotOutput {
  rows: PivotNode[]; columns: PivotNode[];
  cells: Map<string, (Cell | undefined)[]>;
  sourceRows: number; filteredRows: number; inferredFields: string[];
}
