import type { BuilderDefinition } from "./workbench";

export interface KnowledgeIdentity {
  workbenchId: string; connectionId: string | null; model: string | null;
  generation: string; contextVersion: string;
}
export interface KnowledgeReference { id: string; version: number }
export interface KnowledgeField { kind: "column" | "measure" | "table"; table?: string; name: string }
export interface KnowledgeSummary extends KnowledgeReference {
  kind: "note" | "starter"; title: string; summary: string; reason?: string;
}
export interface KnowledgeSearch {
  identity: KnowledgeIdentity; entries: KnowledgeSummary[]; omitted: boolean;
}
export interface KnowledgeRecord extends KnowledgeSummary {
  identity: KnowledgeIdentity; body: string; caveats: string[]; unknowns: string[]; provenance: string[];
  referenceStatus?: "current" | "older"; requestedVersion?: number;
  knowledgeRefs?: KnowledgeReference[]; query?: string; builder?: BuilderDefinition;
}
export interface KnowledgeSearchRequest {
  identity: KnowledgeIdentity; query?: string; field?: KnowledgeField;
}
export interface KnowledgeGetRequest { identity: KnowledgeIdentity; id: string; version?: number }
