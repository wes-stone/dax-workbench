import type { ArtifactKind, ArtifactSummary } from "../contracts/artifacts";
import type { LibraryCollection } from "../contracts/query-library";
import type { IconName } from "./icons";
import { WRITING_VERSION } from "../shared/writing.mjs";

export function writingState(entry: ArtifactSummary) {
  if (!["query", "research", "note"].includes(entry.kind)) return "unsupported";
  return entry.writing?.version === WRITING_VERSION ? entry.writing.status : "unchecked";
}
export function writingLabel(entry: ArtifactSummary) {
  const status = writingState(entry);
  return status === "unsupported" ? "" : status === "unchecked" ? "Documentation not checked"
    : status === "empty" ? "Missing documentation" : status === "needs-attention" ? `Documentation: ${entry.writing!.errorCount} issues`
    : entry.writing!.warningCount ? `Structure passes; ${entry.writing!.warningCount} warnings` : "Structure passes";
}

export const artifactTypes: Record<ArtifactKind, { label: string; icon: IconName }> = {
  project: { label: "Query project", icon: "code" },
  research: { label: "Research", icon: "book" },
  query: { label: "DAX query", icon: "code" },
  note: { label: "Research note", icon: "book" },
  visual: { label: "Chart", icon: "chart" },
  image: { label: "Image", icon: "image" },
  presentation: { label: "PowerPoint deck", icon: "presentation" },
  document: { label: "Document", icon: "file" },
  spreadsheet: { label: "Spreadsheet", icon: "table" },
  pdf: { label: "PDF", icon: "file" },
  text: { label: "Text", icon: "file" },
  file: { label: "File", icon: "file" },
};
export type ArtifactFilter = "all" | "research" | "visuals" | "presentations" | "files" | "queries" | "projects";
export function matchesArtifactType(kind: ArtifactKind, filter: ArtifactFilter) {
  if (filter === "all") return true;
  if (filter === "research") return kind === "research" || kind === "note";
  if (filter === "visuals") return kind === "visual" || kind === "image";
  if (filter === "presentations") return kind === "presentation";
  if (filter === "queries") return kind === "query";
  if (filter === "projects") return kind === "project";
  return ["document", "spreadsheet", "pdf", "text", "file"].includes(kind);
}
export function folderPath(collections: LibraryCollection[], id: string) {
  const byId = new Map(collections.map(folder => [folder.id, folder]));
  const seen = new Set<string>(), result: LibraryCollection[] = [];
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id); result.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return result;
}
export function filterArtifacts(entries: ArtifactSummary[], collections: LibraryCollection[], options: {
  folder: string; type: ArtifactFilter; search: string; status: "active" | "archived" | "all";
  scope: "all" | "current" | "unassigned"; session: string; sort: "name" | "recent" | "type";
  writing?: "all" | "attention" | "pass" | "unchecked";
}) {
  const words = options.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const paths = new Map(collections.map(folder => [folder.id, folderPath(collections, folder.id)]));
  return entries.filter(entry => {
    if (!matchesArtifactType(entry.kind, options.type)) return false;
    const checks = writingState(entry);
    if (options.writing === "attention" && !["needs-attention", "empty", "unchecked"].includes(checks)) return false;
    if ((options.writing === "pass" || options.writing === "unchecked") && checks !== options.writing) return false;
    if (options.status !== "all" && Boolean(entry.archived) !== (options.status === "archived")) return false;
    if (options.scope !== "all" && (entry.modelScope ?? "unassigned") !== options.scope) return false;
    if (options.session === "unassigned" ? entry.session : options.session && entry.session?.id !== options.session) return false;
    const path = paths.get(entry.collectionId) ?? [];
    if (options.folder && !path.some(folder => folder.id === options.folder)) return false;
    const text = [entry.title, entry.description, entry.fileName, artifactTypes[entry.kind].label,
      entry.connectionName, entry.session?.title, entry.session?.id, ...path.map(folder => folder.name)].join(" ").toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }).sort((a, b) => {
    const order = options.sort === "recent" ? (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
      : options.sort === "type" ? artifactTypes[a.kind].label.localeCompare(artifactTypes[b.kind].label) : 0;
    return order || a.title.localeCompare(b.title, undefined, { numeric: true }) || a.id.localeCompare(b.id);
  });
}
export function artifactSize(bytes?: number) {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}
