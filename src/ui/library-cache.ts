import type { CopilotAnalysis, LibraryCatalog, LibraryCollection, LibrarySource, LibrarySummary } from "../contracts/query-library";

type Group = "catalog" | "detail";
interface Cached { value: unknown; bytes: number; group: Group }
interface Pending { promise: Promise<unknown>; controller: AbortController; readers: number }

/** Reloadable data only. Forms and drafts never enter this cache. */
export class LibraryCache {
  private values = new Map<string, Cached>();
  private pending = new Map<string, Pending>();
  private bytes = 0;
  get stats() { return { bytes: this.bytes, entries: this.values.size, pending: this.pending.size }; }
  peek<T>(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key); this.values.set(key, entry);
    return entry.value as T;
  }
  remove(key: string) {
    const entry = this.values.get(key);
    if (entry) { this.bytes -= entry.bytes; this.values.delete(key); }
  }
  put<T>(key: string, group: Group, value: T) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    this.remove(key);
    if (bytes > 2 * 1024 * 1024) return;
    this.values.set(key, { value, bytes, group }); this.bytes += bytes;
    const limit = group === "catalog" ? 2 : 24;
    while ([...this.values.values()].filter(entry => entry.group === group).length > limit) {
      const oldest = [...this.values].find(([, entry]) => entry.group === group);
      if (oldest) this.remove(oldest[0]);
    }
    while (this.bytes > 2 * 1024 * 1024) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }
  read<T>(key: string, group: Group, load: (signal: AbortSignal) => Promise<T>) {
    const cached = this.peek<T>(key);
    if (cached !== undefined) return { promise: Promise.resolve(cached), release() {} };
    let pending = this.pending.get(key);
    if (!pending) {
      const controller = new AbortController();
      const entry: Pending = { controller, readers: 0, promise: Promise.resolve() };
      entry.promise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return load(controller.signal);
      }).then(value => {
        if (!controller.signal.aborted) this.put(key, group, value);
        return value;
      }).finally(() => { if (this.pending.get(key) === entry) this.pending.delete(key); });
      pending = entry; this.pending.set(key, pending);
    }
    pending.readers++;
    let released = false;
    const entry = pending;
    return { promise: entry.promise as Promise<T>, release: () => {
      if (released) return;
      released = true;
      if (--entry.readers === 0 && this.pending.get(key) === entry) {
        this.pending.delete(key); entry.controller.abort();
      }
    } };
  }
}

export interface LibraryBrowse {
  tab: LibrarySource | "files" | "research"; collection: string; selected: string; search: string;
  sort: string; scope: "current" | "all" | "unassigned"; collapsed: Set<string>;
  status: "active" | "archived" | "all"; sessionFilter: string;
  previewTab: "docs" | "dax" | "analysis" | "journal"; scrollTop: number; folderScrollTop: number;
}
export class LibrarySession {
  readonly cache = new LibraryCache();
  private browsing = new Map<string, LibraryBrowse>();
  navigation(key: string): LibraryBrowse {
    let value = this.browsing.get(key);
    if (!value) value = { tab: "starter", collection: "", selected: "", search: "", sort: "title", scope: "current",
      status: "active", sessionFilter: "", collapsed: new Set(), previewTab: "docs", scrollTop: 0, folderScrollTop: 0 };
    this.browsing.delete(key); this.browsing.set(key, value);
    if (this.browsing.size > 2) this.browsing.delete(this.browsing.keys().next().value!);
    return value;
  }
}

/** Only permits an explicit draft refresh, never cache reuse or automatic revision rebasing. */
export function sameLibraryModel(left: string, right: string) {
  try {
    const a = JSON.parse(left), b = JSON.parse(right);
    if (!a || !b) return false;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && left === right;
    return typeof a.workbenchId === "string" && typeof a.connectionId === "string"
      && a.workbenchId === b.workbenchId && a.connectionId === b.connectionId && a.model === b.model;
  } catch { return false; }
}

export function analysisExecutionLabel(analysis: CopilotAnalysis, stale = false) {
  if (!analysis.evidence.length) return "Not run / no recorded run evidence";
  const checked = !stale ? analysis.evidence.filter(run => run.status === "completed"
    && run.revision === analysis.source.revision && run.queryFingerprint === analysis.source.queryFingerprint) : [];
  if (!checked.length) return "Execution not checked";
  return checked.every(run => run.connectionKind === "synthetic") ? "Execution checked (synthetic only)" : "Execution checked";
}

export function indexLibrary(catalog: LibraryCatalog | null) {
  const collections = catalog?.collections ?? [], entries = catalog?.entries ?? [];
  const byId = new Map(collections.map(folder => [folder.id, folder]));
  const paths = new Map<string, LibraryCollection[]>(), names = new Map<string, string>();
  const children = new Map<string | null, LibraryCollection[]>();
  for (const folder of collections) {
    const path: LibraryCollection[] = [], seen = new Set<string>();
    let current: LibraryCollection | undefined = folder;
    while (current && !seen.has(current.id)) {
      path.unshift(current); seen.add(current.id); current = byId.get(current.parentId ?? "");
    }
    paths.set(folder.id, path); names.set(folder.id, path.map(item => item.name).join(" / "));
    const siblings = children.get(folder.parentId) ?? []; siblings.push(folder); children.set(folder.parentId, siblings);
  }
  const ancestors = new Map(entries.map(entry => [entry.id, new Set(paths.get(entry.collectionId)?.map(folder => folder.id))]));
  const text = new Map(entries.map(entry => [entry.id, `${entry.title} ${entry.description} ${entry.connectionName ?? ""} ${names.get(entry.collectionId) ?? ""} ${entry.session ? `${entry.session.id} ${entry.session.title}` : "Unassigned"}`.toLocaleLowerCase()]));
  const title = [...entries].sort((a, b) => a.title.localeCompare(b.title));
  const recent = [...entries].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.title.localeCompare(b.title));
  return { collections, entries, paths, names, children, ancestors, text, title, recent };
}
export function filterLibrary(index: ReturnType<typeof indexLibrary>, tab: LibraryBrowse["tab"], scope: LibraryBrowse["scope"], sort: string,
  status: LibraryBrowse["status"] = "active", sessionFilter = "", query = "") {
  const source = tab === "research" ? "saved" : tab;
  const needle = query.toLocaleLowerCase().trim();
  const entries = (sort === "recent" ? index.recent : index.title).filter(entry => entry.source === source
    && (tab !== "research" || entry.hasAnalysis === true)
    && (entry.source === "starter" || scope === "all" || entry.modelScope === scope)
    && (entry.source === "starter" || status === "all" || (entry.archived === true) === (status === "archived"))
    && (tab !== "research" || !sessionFilter || (sessionFilter === "unassigned" ? !entry.session : `id:${entry.session?.id}` === sessionFilter))
    && index.text.get(entry.id)?.includes(needle));
  const counts = new Map<string, number>();
  for (const entry of entries) for (const id of index.ancestors.get(entry.id) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return { entries, counts };
}
export function searchLibrary(index: ReturnType<typeof indexLibrary>, entries: LibrarySummary[], collection: string, query: string) {
  const needle = query.toLocaleLowerCase().trim();
  return entries.filter(entry => (!collection || index.ancestors.get(entry.id)?.has(collection)) && index.text.get(entry.id)?.includes(needle));
}
