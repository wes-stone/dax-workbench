import type { BuilderDefinition, Cell, ChartConfig, Column, ParameterDefinition, ParameterValue } from "./workbench";

export interface DashboardSource {
  version: 1;
  connectionId: string;
  connectionName: string;
  model: string | null;
  connectionKind: string;
  query: string;
  parameters: Record<string, ParameterValue>;
  parameterDefinitions?: Record<string, ParameterDefinition>;
  builder?: BuilderDefinition;
  documentId?: string;
  queryRevision: number;
  fingerprint: string;
}
export interface DashboardFilter {
  id: string;
  label: string;
  type: "text" | "number" | "date" | "boolean";
  value: string;
}
export interface DashboardMapping { filterId: string; parameter: string }
export interface ResultAssertion {
  id: string; type: "row-count" | "non-null" | "unique" | "sum-range" | "schema-type";
  columnId?: string; min?: string; max?: string; expectedType?: string;
}
export interface AdvancedVisualConfig {
  type: "waterfall" | "small-multiples"; x: string; y: string; group: string; start: string;
}
export interface MatrixConfig {
  row: string; column: string; value: string; aggregation: "none" | "sum" | "count"; emphasizeNegative: boolean;
}
export interface DashboardVisual {
  type: "table" | "indicator" | "bar" | "line" | "scatter" | "waterfall" | "small-multiples" | "matrix";
  chart?: ChartConfig;
  advanced?: AdvancedVisualConfig;
  matrix?: MatrixConfig;
  valueColumn?: string;
  contextColumn?: string;
  units: string;
}
export interface DashboardTile {
  id: string;
  pageId: string;
  title: string;
  description?: string;
  width: number;
  height: number;
  note?: string;
  source?: DashboardSource;
  unboundSource?: DashboardSource;
  visual: DashboardVisual;
  mappings: DashboardMapping[];
  snapshotId?: string;
  previousSnapshotIds: string[];
  archived?: boolean;
  assertions?: ResultAssertion[];
  crossFilterId?: string;
}
export interface Dashboard {
  id: string;
  title: string;
  revision: number;
  favorite: boolean;
  archived: boolean;
  pages: Array<{ id: string; title: string }>;
  filters: DashboardFilter[];
  tiles: DashboardTile[];
  release?: { sourceId: string; sourceRevision: number; reviewedAt: string; reviewer: string };
}
export interface DashboardCatalog {
  revision: number;
  homeId: string | null;
  entries: Array<Pick<Dashboard, "id" | "title" | "revision" | "favorite" | "archived">>;
  limits: { dashboards: number; pages: number; tiles: number; snapshotRows: number; snapshotBytes: number };
}
export interface DashboardSnapshot {
  version: 1;
  id: string;
  capturedAt: string;
  durationMs?: number;
  runId?: string;
  resultSetId?: string;
  source?: DashboardSource;
  executedFilters: Array<{ label: string; parameter: string; value: ParameterValue }>;
  columns: Column[];
  rows: Cell[][];
  truncated: boolean;
  origin: "run" | "artifact";
  sourceDescription?: string;
  checks?: { version: 1; rules: ResultAssertion[]; status: "passed" | "failed" | "not-evaluated";
    results: Array<{ id: string; status: "passed" | "failed" | "not-evaluated"; message: string; actual?: string }> };
}
export interface DashboardRefresh {
  id: string;
  dashboardId: string;
  status: "running" | "completed" | "partial" | "cancelled";
  startedAt?: string;
  cancelRequested?: boolean;
  tiles: Array<{ tileId: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; runId?: string; error?: string;
    startedAt?: string; finishedAt?: string; durationMs?: number }>;
}
export interface DashboardDetail {
  dashboard: Dashboard;
  refresh: DashboardRefresh | null;
  captureStatus?: Record<string, "missing" | "snapshot-only" | "matching" | "changed">;
  filterTargets?: Record<string, Array<{ name: string; type: string; label: string }>>;
}
export interface DashboardProposal {
  id: string;
  expiresAt: number;
  definition: { format: "dax-workbench-dashboard"; version: 1; dashboard: Dashboard };
}
