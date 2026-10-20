import type { ParameterDefinition, ParameterValue } from "./workbench";

export type ProjectTarget = "power-query" | "python" | "streamlit" | "pack" | "example" | "studio";
export interface ProjectSource {
  id: string; title: string; query: string; revision: number; connectionId: string; connectionName: string;
  connectionKind: string; model?: string; connectionHash: string;
  parameters: Record<string, ParameterValue>; parameterDefinitions?: Record<string, ParameterDefinition>;
  evidence: { status: string; runId?: string; startedAt?: string; truncated?: boolean };
}
export interface ProjectFile { name: string; content: string }
export interface ProjectPreview {
  id: string; target: ProjectTarget; title: string; sources: ProjectSource[];
  files: ProjectFile[]; warnings: string[]; libraryRevision: number;
  /** New folders that do not exist yet, most relevant first. */
  suggestedDirectories?: string[];
}
export interface ProjectActivity {
  status: "created" | "setting-up" | "ready" | "starting" | "running" | "completed" | "stopped" | "failed" | "interrupted";
  message: string; log?: string; url?: string; environmentReady: boolean;
}
export interface QueryProject {
  id: string; title: string; target: ProjectTarget; directory: string; collectionId: string;
  revision: number; createdAt: string; archived?: boolean; sources: ProjectSource[];
  files: Array<{ name: string; sha256: string }>; activity: ProjectActivity;
}
export interface ProjectProposal { id: string; target: ProjectTarget; documentId: string; revision: number; rationale: string }
