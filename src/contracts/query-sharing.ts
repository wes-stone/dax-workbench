import type { KnowledgeIdentity, KnowledgeReference } from "./model-context";

export type ShareSchemaScope = "selected" | "loaded" | "none";
export interface ShareModelOptions {
  starters: boolean; tabs: boolean; saved: boolean; modelContext: boolean; validatedQueries: boolean; skill: boolean;
}
export interface ShareCoverage {
  source: string; status: "included" | "missing" | "excluded" | "unavailable"; count: number; detail: string;
}
export interface ShareRequest {
  documentId: string; connectionId: string; revision: number; builderRevision: number; libraryRevision: number;
  documents: Array<{ id: string; revision: number; builderRevision: number }>;
  entryIds: string[]; title: string; note: string; schemaScope: ShareSchemaScope;
  includeDocumentation: boolean; includeResearch: boolean; includeValues: boolean;
  knowledgeRefs: KnowledgeReference[]; identity?: KnowledgeIdentity;
  scope?: "queries" | "model"; modelOptions?: ShareModelOptions;
}
export interface ShareFile { name: string; content: string }
export interface SharePreview {
  id: string; title: string; filename: string; createdAt: string; expiresAt: string;
  files: ShareFile[]; bytes: number; queryCount: number; schemaCount: number; noteCount: number;
  warnings: string[];
  scope?: "queries" | "model"; coverage?: ShareCoverage[];
}
