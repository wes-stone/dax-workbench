import type { LibraryReference, SharedCopilotAnalysis } from "./query-library";
import type { KnowledgeIdentity, KnowledgeSummary } from "./model-context";
import type { ProjectProposal } from "./query-projects";
import type { CODE_FONTS } from "../shared/code-fonts.mjs";
import type { PivotLayout } from "./pivot";
export type Cell = string | number | boolean | null;
export type ParameterValue = Cell | Cell[];
export interface ParameterDefinition {
  type: "text" | "number" | "date" | "boolean" | "list[text]";
  default?: ParameterValue; required?: boolean; allowed_values?: ParameterValue[]; description?: string;
}
export interface Column { id: string; name: string; dataType: string; formatString?: string }
export interface Capability { status: "supported" | "unsupported" | "unknown"; reason: string }
export interface Connection {
  id: string; name: string; kind: string; model?: string; authMode?: "connection-string" | "azure-cli";
  capabilities?: Record<string, Capability>;
}
export interface ConnectionDetails {
  connectionId: string; source: string; authentication: string; connectionString: string | null;
  properties: { name: string; value: string; redacted: boolean }[]; notice: string;
}
export interface ModelObject {
  id: string; name: string; kind: "table" | "column" | "measure" | "relationship";
  table?: string; dataType?: string; expression?: string; description?: string;
  isHidden?: boolean; displayFolder?: string; formatString?: string; ordinal?: number;
  qualifiedName?: string; nativeDataType?: string; source?: string; measureGroup?: string; sortByColumnId?: string;
}
export interface ModelHierarchy {
  id: string; name: string; kind: "hierarchy"; table: string; qualifiedName: string;
  source: "MDSCHEMA_HIERARCHIES"; isHidden?: boolean; displayFolder?: string; description?: string;
  levels: Array<{ id: string; name: string; ordinal: number; columnId: string }>;
}
export type ModelItem = ModelObject | ModelHierarchy;
export interface CoverageFacet { status: "complete" | "partial" | "unavailable"; source: string; reason?: string }
export interface SchemaCoverage {
  status: "complete" | "partial"; source: "TMSCHEMA" | "MDSCHEMA"; scope: "model" | "reader-exposed";
  counts: { tables: number; columns: number; measures: number; relationships: number; hierarchies: number; hierarchyLevels: number; excludedSystemColumns: number };
  tables: CoverageFacet; columns: CoverageFacet; measures: CoverageFacet; relationships: CoverageFacet;
  hiddenObjects: CoverageFacet; dataTypes: CoverageFacet; visibility: CoverageFacet; displayFolders: CoverageFacet;
  measureTableAssociation: CoverageFacet; measureExpressions: CoverageFacet;
  sortByColumns: CoverageFacet; groupByColumns: CoverageFacet; hierarchies: CoverageFacet;
}
export interface SchemaRelationship {
  id: string; source: "TMSCHEMA_RELATIONSHIPS"; fromTable: string; fromColumn: string; toTable: string; toColumn: string;
  name?: string; isActive?: boolean; fromCardinality?: "one" | "many"; toCardinality?: "one" | "many";
  crossFilteringBehavior?: "oneDirection" | "bothDirections" | "automatic";
}
export interface BuilderField {
  id: string; kind: "column" | "measure"; table?: string; name: string; dataType?: string;
  caption?: string; expression?: string; isCustom?: boolean;
}
export interface BuilderFilter { id: string; field: BuilderField; operator: string; value: string; value2?: string; enabled: boolean; isParameter?: boolean; isParameter2?: boolean }
export interface FilterValueOption { value: Cell; literal: string | null; label: string; unavailable?: string; calendarYear?: number }
export type FilterValueOrder = "asc" | "desc" | "month-asc" | "month-desc";
export interface FilterValuePage { runId: string; order: FilterValueOrder; options: FilterValueOption[]; limited: boolean; warnings: string[]; capturedCount: number }
export interface BuilderOrder { fieldId: string; direction: "ASC" | "DESC" }
export interface BuilderDefinition { version: 2; fields: BuilderField[]; filters: BuilderFilter[]; orderBy: BuilderOrder[] }
export interface BuilderProposal {
  id: string; connectionId: string; baseRevision: number; baseBuilderRevision: number;
  definition: BuilderDefinition; query: string; rationale: string;
}
export interface BuilderContext {
  workbenchId: string; documentId: string; connection: Connection | null; revision: number; builderRevision: number;
  authoringGuidance: string;
  libraryRevision: number;
  artifactsRevision?: number;
  definition: BuilderDefinition; autoUpdate: boolean; pendingImport: boolean; schemaAvailable: boolean; schemaCoverage: SchemaCoverage | null;
  proposal: Pick<BuilderProposal, "id" | "baseRevision" | "baseBuilderRevision"> | null;
  privacy: { automaticRows: false; agentReadEnabled: boolean; agentResultsEnabled?: boolean };
}
export interface BuilderImport {
  version: 1; format: "dax-studio";
  fields: (BuilderField | { id: string; kind: "hierarchy"; table: string; name: string })[];
  filters: BuilderFilter[]; orderBy: BuilderOrder[];
}
export interface ModelSchema { connectionId: string; objects: ModelObject[]; fetchedAt: string; warnings: string[]; coverage?: SchemaCoverage; relationships?: SchemaRelationship[]; hierarchies?: ModelHierarchy[]; origin?: "native" | "dictionary" }
export interface Proposal { id: string; baseRevision: number; query: string; rationale: string }
export interface QueryDocument {
  id: string; title: string; query: string; revision: number; connectionId: string;
  parameters: Record<string, ParameterValue>; parameterDefinitions?: Record<string, ParameterDefinition>; proposal: Proposal | null;
  builder?: BuilderDefinition; builderRevision?: number; builderWarning?: string; builderAutoUpdate?: boolean; builderImport?: BuilderImport;
  builderProposal?: BuilderProposal | null;
  authoringFocus?: { id: string; surface: "builder" | "editor" };
  libraryRef?: LibraryReference;
}
export interface AuthoringEvent { phase: "prepare" | "hold" | "release" | "disconnected"; requestId: string; clientId: string }
export interface ResultSet {
  id: string; columns: Column[]; rowCount: number; truncated: boolean;
}
export interface Run {
  id: string; documentId: string; revision: number; connectionId: string; query: string;
  connectionKind?: string;
  querySource?: "builder" | "preview" | "project" | "filter-values" | "model-preview"; builderRevision?: number; projectId?: string; filterFieldId?: string; filterValueOrder?: FilterValueOrder; modelObjectId?: string;
  previewTitle?: string; executionLimits?: Limits; wallDurationMs?: number; providerDurationMs?: number;
  sourceBuilder?: BuilderDefinition;
  parameters: Record<string, ParameterValue>; parameterDefinitions?: Record<string, ParameterDefinition>; templateQuery?: string; startedAt: string; durationMs: number;
  status: "queued" | "connecting" | "executing" | "streaming" | "completed" | "cancelling" | "cancelled" | "failed" | "timed-out" | "interrupted";
  resultSets: ResultSet[]; rowCount: number; truncated: boolean; warnings: string[];
  error?: { code: string; message: string }; pinned: boolean; retained: boolean;
}
export interface SharingSelection { runId: string; resultSetId: string; row: number; columnId: string; value: Cell }
export interface AgentResultRead { runId: string; resultSetId: string; offset: number; rowCount: number; readAt: string }
export interface Limits { timeoutSeconds: number; maxRows: number; maxBytes: number }
export interface ChartFilter { column: string; operator: "in" | "notIn"; values: Cell[] }
export interface ChartConfig {
  type: "bar" | "line" | "scatter"; x: string; y: string; aggregation: "none" | "sum" | "average" | "count";
  legend?: string; filters?: ChartFilter[]; hiddenSeries?: Cell[];
}
export type ThemeMode = "system" | "light" | "dark";
export type CodeFont = keyof typeof CODE_FONTS;
export interface Appearance { themeMode: ThemeMode; codeFont?: CodeFont; codeFontSize?: number }
export interface Snapshot {
  workbenchId: string; version: number; activeDocumentId: string;
  hostMode?: "copilot-canvas" | "standalone";
  documents: QueryDocument[]; closedDocuments?: QueryDocument[]; connections: Connection[]; schema: ModelSchema | null;
  connectionDiscovery?: {
    status: "ready" | "partial" | "unavailable"; loaded: number; source?: string; warning?: string; errorCode?: string;
    issues: { name: string; code: string; message: string }[];
  };
  authoringBusy?: boolean;
  layout?: { builderSide: "left" | "right" };
  resultSettings?: { showFullColumnNames: boolean };
  appearance?: Appearance;
  libraryRevision?: number;
  artifactsRevision?: number;
  dashboardsRevision?: number;
  projectsRevision?: number;
  projectProposal?: ProjectProposal | null;
  dashboardProposalRevision?: number;
  contentReviewRevision?: number;
  libraryIdentity?: KnowledgeIdentity;
  sharedAnalysisId?: string | null;
  schemaError?: { code: string; message: string } | null;
  schemaLoading?: boolean;
  runs: Run[]; limits: Limits; selections: SharingSelection[]; selectedObjects: string[];
  agentReadEnabled: boolean; agentResultsEnabled?: boolean; agentResultReads?: AgentResultRead[]; chart: ChartConfig | null;
  chartSource?: string | null;
  pivotLayouts?: PivotLayout[];
  native: { available: boolean; version?: string; message: string };
  integration: { available: boolean; message: string };
}
export interface Bootstrap { token: string; state: Snapshot }
export interface ResultPage { columns: Column[]; rows: Cell[][]; offset: number; total: number; truncated: boolean }
export interface SafeContext {
  workbenchId: string; query: string; connection: Connection | null; schema: ModelObject[];
  connectionDiscovery?: { status: "ready" | "partial" | "unavailable"; loaded: number; issueCount: number; errorCode?: string };
  builder: BuilderContext;
  resultMetadata: Omit<Run, "query" | "parameters" | "sourceBuilder"> | null; selectedValues: SharingSelection[];
  privacy: { automaticRows: false };
  knowledge?: { identity: KnowledgeIdentity; entries: KnowledgeSummary[] };
  sharedAnalysis?: SharedCopilotAnalysis;
}
// UI sends POST /api/action { action, payload }, using X-Dax-Token.
// Success is {result}; errors are {error:{code,message}} with a non-2xx status.
// GET /api/state returns Snapshot; GET /api/result?runId=&resultSetId=&offset=&limit= returns ResultPage.
// POST /api/action names:
// document.create {title?}; document.select {id}; document.close {id}; document.update {id,revision,query?,title?,parameters?};
// document.closeAll {documentIds,activeDocumentId}; UI-only, saves all connected drafts, preserves recoverable tabs, opens one blank query.
// proposal.accept {documentId,proposalId}; proposal.reject {documentId,proposalId};
// connection.select {connectionId}; connection.add {name,connectionString,authMode?};
// connection.add {kind:"windows-msolap",name,connectionString,authMode:"connection-string"};
// connection.add {kind:"powerbi-rest",name,workspaceId,datasetId,tenantId?,authMode:"azure-cli"};
// connections.import {directory,connectionName?,kind?:"msolap"|"windows-msolap",authMode?}; connections.discover {}; schema.refresh {};
// query.run {documentId}; query.cancel {runId}; run.pin {runId}; run.open {runId};
// selection.set {cells:Array<{runId,resultSetId,row,columnId}>}; context.objects {ids};
// agent.enable {enabled:boolean}; UI-only, default-on, persisted across tabs/connections/restarts; never shares result values.
// agent.results.enable {enabled:boolean}; UI-only, default-on, persisted; allows bounded on-demand result reads, never ambient rows.
// Missing agentResultsEnabled means result access is unavailable, not granted. agentResultReads is ephemeral metadata only.
// settings.update {limits}; chart.set {config};
// pivot.layout.set {runId,resultSetId,config}; UI-only, stores field layout, never captured filter values or member keys.
// layout.update {builderSide:"left"|"right"}; UI-only, persisted per workbench, no query or grant changes.
// result-settings.update {showFullColumnNames:boolean}; UI-only display preference; canonical names and values unchanged.
// appearance.update {themeMode?,codeFont?,codeFontSize?}; UI-only partial update, persisted per workbench; never changes drafts or grants.
// Code fonts use shared/code-fonts.mjs preset IDs and integer sizes 10-24px. Missing legacy font settings default to Consolas 14px.
// result.compare {leftRunId,rightRunId}; library.list {}; library.open {path};
// knowledge.search {identity:KnowledgeIdentity,query?,field?}; knowledge.get {identity:KnowledgeIdentity,id,version?};
// Knowledge reads are bundled-only, identity-guarded, bounded and side-effect-free; saved library reads remain UI-only.
// library.analysis.share {id}; library.analysis.clear {}; UI-only, explicit ephemeral sharing of one saved analysis.
// Sharing contains plain-text analysis and safe run metadata, never saved parameter bindings or raw result rows.
// library.save {directory,name}; pack.import {path}; builder.generate {table,columns,measure?};
// builder.update {documentId,connectionId,builderRevision,definition:BuilderDefinition};
// builder.preview {documentId,connectionId,definition}; builder.apply {documentId,connectionId,revision,builderRevision,definition};
// builder.save {documentId,definition,directory,name}; query.run optionally accepts revision for compare-and-run admission.
// builder.values.start {documentId,connectionId,revision,fieldId,search?,order?}; UI-only bounded column lookup; month order requires a complete capture before sorting and displaying 200 choices. No inherited filters or bindings.
// builder.values.read {documentId,connectionId,fieldId,runId}; UI-only typed values from a completed lookup in the same native model session.
// model.preview.start {documentId,connectionId,revision,objectId}; UI-only native table/column preview, up to 100 rows / 32 visible table columns / 30s / 256 KiB or lower user limits. Never changes drafts or inherits filters/bindings.
// history is metadata-only; raw results are obtained by the authenticated result-page endpoint.
