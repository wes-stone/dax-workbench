import type { KnowledgeIdentity, KnowledgeReference } from "./model-context";
import type { WritingSummary } from "./writing";
export type LibrarySource = "starter" | "saved";
export interface ResearchSession { id: string; title: string }
export interface ResearchNote {
  id: string; author: "human" | "copilot"; createdAt: string; content: string; session?: ResearchSession; correctionOf?: string;
}
export interface LibraryCollection {
  id: string; name: string; parentId: string | null; source: LibrarySource;
}
export interface LibrarySummary {
  id: string; title: string; description: string; collectionId: string;
  source: LibrarySource; connectionName?: string; updatedAt?: string; hasBuilder: boolean;
  modelScope: "current" | "other" | "unassigned"; model?: string;
  hasAnalysis?: boolean; analysisStale?: boolean;
  researchContentVersion?: string;
  archived?: boolean; session?: ResearchSession; noteCount?: number;
  canReviewDocumentation?: boolean;
  writing?: WritingSummary;
  reusableEvidence?: { status: string; startedAt?: string };
}
export interface AnalysisEvidence {
  runId: string; revision: number; status: "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string; durationMs: number; rowCount: number; truncated: boolean;
  queryFingerprint: string; metadataFingerprint: string | null;
  connectionKind: string; querySource: "editor" | "builder";
}
export interface CopilotAnalysis {
  version: 1; author: "copilot"; createdAt: string; question: string; content: string; limitations: string;
  source: {
    documentId: string; revision: number; builderRevision: number; connectionId: string; queryFingerprint: string;
  };
  evidence: AnalysisEvidence[];
}
export interface SharedCopilotAnalysis extends Omit<CopilotAnalysis, "source" | "evidence"> {
  entryId: string; title: string; stale: boolean; matchesActiveQuery: boolean;
  notes?: ResearchNote[]; session?: ResearchSession; omittedNotes?: number;
  source: Omit<CopilotAnalysis["source"], "queryFingerprint">;
  evidence: Array<Omit<AnalysisEvidence, "queryFingerprint">>;
}
export interface LibraryItem extends LibrarySummary {
  query: string; documentation: string; knowledgeRefs?: KnowledgeReference[]; analysis?: CopilotAnalysis;
  notes?: ResearchNote[];
  analysisRevised?: boolean;
}
export interface LibraryCatalog {
  revision: number; collections: LibraryCollection[]; entries: LibrarySummary[];
  identity?: KnowledgeIdentity;
}
export interface LibraryReference {
  entryId: string; collectionId: string; description: string; documentation: string;
  knowledgeRefs?: KnowledgeReference[];
}
