import type { LibraryCollection, ResearchSession } from "./query-library";
import type { Cell, ChartConfig, Column } from "./workbench";
import type { WritingSummary } from "./writing";

export type ArtifactKind = "research" | "query" | "note" | "visual" | "image" | "presentation" | "document" | "spreadsheet" | "pdf" | "text" | "file" | "project";
export interface ArtifactVisual {
  version: 1;
  config: ChartConfig;
  columns: Column[];
  rows: Cell[][];
  provenance: {
    description: string;
    runId?: string;
    resultSetId?: string;
    queryRevision?: number;
    truncated: boolean;
    approximate: boolean;
  };
}
export interface ArtifactSummary {
  id: string;
  kind: ArtifactKind;
  collectionId: string;
  title: string;
  description: string;
  updatedAt?: string;
  byteLength?: number;
  fileName?: string;
  mimeType?: string;
  archived?: boolean;
  researchEntryId?: string;
  researchChanged?: boolean;
  researchUpdatedAt?: string;
  connectionName?: string;
  modelScope?: "current" | "other" | "unassigned";
  session?: ResearchSession;
  hasBuilder?: boolean;
  hasAnalysis?: boolean;
  analysisStale?: boolean;
  noteCount?: number;
  canReviewDocumentation?: boolean;
  writing?: WritingSummary;
}
export interface ArtifactCatalog {
  revision: number;
  libraryRevision: number;
  collections: LibraryCollection[];
  entries: ArtifactSummary[];
  limits: { maxFileBytes: number; maxEntries: number };
}
export interface ArtifactDetail extends ArtifactSummary {
  text?: string;
  visual?: ArtifactVisual;
  slides?: Array<{ number: number; text: string }>;
  previewMessage?: string;
  downloadable: boolean;
}
