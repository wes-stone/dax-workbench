import type { KnowledgeIdentity } from "./model-context";

export interface DocumentationReviewRequest {
  documentId: string;
  connectionId: string;
  libraryRevision: number;
  identity: KnowledgeIdentity;
  entryIds: string[];
}

export interface DocumentationReviewPreview {
  workbenchId: string;
  documentId: string;
  connectionId: string;
  model: string;
  libraryRevision: number;
  entries: Array<{ entryTitle: string; expectedDocumentation: string }>;
  byteLength: number;
}
