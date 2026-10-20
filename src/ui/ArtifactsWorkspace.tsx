import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ArtifactCatalog, ArtifactDetail, ArtifactSummary } from "../contracts/artifacts";
import type { LibraryCatalog } from "../contracts/query-library";
import type { Snapshot } from "../contracts/workbench";
import { api, downloadBlob, errorMessage } from "./api";
import { ArtifactBody, ArtifactEmbed, RelatedArtifacts } from "./ArtifactPreview";
import { artifactSize, artifactTypes, filterArtifacts, folderPath, writingLabel, writingState, type ArtifactFilter } from "./artifacts-model";
import { WRITING_VERSION } from "../shared/writing.mjs";
import { ResearchPresentationProvider } from "./artifact-embeds";
import { Icon } from "./icons";
import { LibrarySession } from "./library-cache";
import { QueryLibrary } from "./QueryLibrary";
import { useLibraryRead } from "./useLibraryRead";
import { WritingEditor } from "./WritingEditor";
import { DocumentationReview } from "./DocumentationReview";
import { ContentReview } from "./ContentReview";
import { QueryProject } from "./QueryProject";
import type { Action } from "./useWorkbench";
import "./artifacts.css";

interface FolderDraft { type: "folder"; id?: string; name: string; parentId: string; revision: number }
interface FileDraft {
  type: "details" | "note"; id?: string; title: string; description: string; collectionId: string;
  archived: boolean; text: string; researchEntryId: string; revision: number;
}
type Draft = FolderDraft | FileDraft;
const noExpand = () => {};
const typeFilters: Array<{ value: ArtifactFilter; label: string }> = [
  { value: "all", label: "All types" }, { value: "research", label: "Research" }, { value: "visuals", label: "Visuals" },
  { value: "presentations", label: "PowerPoint decks" }, { value: "files", label: "Documents & files" }, { value: "queries", label: "DAX queries" },
  { value: "projects", label: "Projects" },
];

export function ArtifactsWorkspace({ state, action, connected, hidden, inert, requested, onQuery, onDirtyChange }: {
  state: Snapshot; action: Action; connected: boolean; hidden: boolean; inert: boolean;
  requested?: { id: string; sequence: number }; onQuery: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [session] = useState(() => new LibrarySession());
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const [folder, setFolder] = useState(""), [type, setType] = useState<ArtifactFilter>("all");
  const [search, setSearch] = useState(""), [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const [scope, setScope] = useState<"all" | "current" | "unassigned">("all"), [attribution, setAttribution] = useState("");
  const [sort, setSort] = useState<"name" | "recent" | "type">("recent");
  const [writingFilter, setWritingFilter] = useState<"all" | "attention" | "pass" | "unchecked">("all");
  const [selected, setSelected] = useState(""), [focused, setFocused] = useState("");
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [foldersOpen, setFoldersOpen] = useState(false), [exact, setExact] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null), [readerDirty, setReaderDirty] = useState(false);
  const [readerBusy, setReaderBusy] = useState(false), [busy, setBusy] = useState(false);
  const [reviewDocumentation, setReviewDocumentation] = useState(false);
  const [reviewContent, setReviewContent] = useState(false);
  const [sharedDocumentation, setSharedDocumentation] = useState(new Set<string>());
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [dragging, setDragging] = useState(false);
  const upload = useRef<HTMLInputElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null), draftForm = useRef<HTMLFormElement>(null);
  const listScroll = useRef(0), pendingRequest = useRef(0), restoreFocus = useRef("");
  const focusSearch = useRef(false);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const locked = Boolean(draft || readerDirty || readerBusy || busy);
  const catalogKey = JSON.stringify(["artifacts-catalog", state.workbenchId, state.artifactsRevision ?? 0,
    state.libraryRevision ?? 0, state.projectsRevision ?? 0, state.libraryIdentity, catalogEpoch]);
  const read = useLibraryRead<ArtifactCatalog>(session, catalogKey, "catalog", signal => api.read("artifacts.catalog", {}, signal), !hidden);
  const lastCatalog = useRef<ArtifactCatalog | undefined>(undefined);
  if (read.data) lastCatalog.current = read.data;
  const catalog = read.data ?? lastCatalog.current;
  const entries = catalog?.entries ?? [], collections = catalog?.collections ?? [];
  const current = entries.find(entry => entry.id === selected);
  const managed = current && !["research", "query", "project"].includes(current.kind);
  const canFormatNumbers = current && (["research", "query", "note"].includes(current.kind) || /\.(?:md|mdown|markdown)$/i.test(current.fileName ?? ""));
  const detail = useLibraryRead<ArtifactDetail>(session, JSON.stringify(["artifact", state.workbenchId, catalog?.revision, selected]), "detail",
    signal => api.read("artifacts.get", { id: selected }, signal), Boolean(managed && !hidden));
  const matches = useMemo(() => filterArtifacts(entries, collections, { folder, type, search, status, scope, session: attribution, sort, writing: writingFilter }),
    [entries, collections, folder, type, search, status, scope, attribution, sort, writingFilter]);
  const paths = useMemo(() => new Map(collections.map(item => [item.id, folderPath(collections, item.id)])), [collections]);
  const pathName = (id: string) => paths.get(id)?.map(part => part.name).join(" / ") ?? "";
  const sessions = [...new Map(entries.filter(entry => entry.session).map(entry => [entry.session!.id, entry.session!])).values()]
    .sort((a, b) => a.title.localeCompare(b.title));
  const rows = useVirtualizer({ count: matches.length, getScrollElement: () => list.current, estimateSize: () => 52,
    getItemKey: index => matches[index].id, overscan: 6 });
  const visibleRows = rows.getVirtualItems();
  const loadCatalog = useCallback(async () => {
    const next = await api.read<ArtifactCatalog>("artifacts.catalog");
    lastCatalog.current = next;
    setCatalogEpoch(value => value + 1);
    return next;
  }, []);
  useEffect(() => {
    if (detail.data?.id === selected && detail.data.writing && current?.kind === "note"
      && JSON.stringify(detail.data.writing) !== JSON.stringify(current.writing))
      setCatalogEpoch(value => value + 1);
  }, [detail.data, selected, current?.kind, current?.writing]);
  useEffect(() => {
    onDirtyChange(Boolean(draft || readerDirty || readerBusy || busy));
    return () => onDirtyChange(false);
  }, [draft, readerDirty, readerBusy, busy, onDirtyChange]);
  useEffect(() => {
    if (!draft && !readerDirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [draft, readerDirty]);
  useEffect(() => {
    if (!requested || requested.sequence === pendingRequest.current) return;
    pendingRequest.current = requested.sequence;
    if (locked) { setError("Finish or cancel the current artifact edit before opening another artifact. Your draft is preserved."); return; }
    setSelected(requested.id); setFoldersOpen(false);
  }, [requested, locked]);
  useLayoutEffect(() => {
    if (selected || draft || hidden || !list.current) return;
    list.current.scrollTop = listScroll.current;
    if (focusSearch.current) { focusSearch.current = false; restoreFocus.current = ""; searchInput.current?.focus(); return; }
  }, [selected, draft, hidden]);
  useLayoutEffect(() => {
    if (selected || draft || hidden || !list.current) return;
    if (restoreFocus.current) {
      const target = restoreFocus.current;
      const index = matches.findIndex(entry => entry.id === target);
      if (index >= 0) rows.scrollToIndex(index, { align: "auto" });
      const frame = requestAnimationFrame(() => {
        const button = list.current?.querySelector<HTMLButtonElement>(`[data-artifact-id="${CSS.escape(target)}"]`);
        if (button) { button.focus({ preventScroll: true }); restoreFocus.current = ""; }
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [selected, draft, hidden, visibleRows]);
  function select(entry: ArtifactSummary) {
    if (locked) return;
    setSelected(entry.id); setFocused(entry.id); setFoldersOpen(false); setError(""); setNotice("");
  }
  function back() {
    if (locked) return;
    restoreFocus.current = selected; setSelected(""); setError("");
  }
  function changeFolder(id: string) {
    if (locked) return;
    setFolder(id); setSelected(""); setSearch(""); listScroll.current = 0; setFoldersOpen(false);
  }
  function beginFolder(edit = false) {
    if (!catalog || locked) return;
    const target = edit ? collections.find(item => item.id === folder) : undefined;
    setDraft({ type: "folder", id: target?.id, name: target?.name ?? "", parentId: target?.parentId ?? (edit ? "" : folder), revision: catalog.libraryRevision });
    setError(""); setNotice("");
  }
  function beginNote() {
    if (!catalog || locked) return;
    setDraft({ type: "note", title: "", description: "", text: "", collectionId: folder || "saved:general", archived: false,
      researchEntryId: "", revision: catalog.revision }); setError(""); setNotice("");
  }
  function manage(entry: ArtifactSummary, editText = false, archived = entry.archived === true) {
    if (!catalog || locked) return;
    if (entry.kind === "research" || entry.kind === "query") { select(entry); return; }
    setDraft({ type: editText ? "note" : "details", id: entry.id, title: entry.title, description: entry.description,
      collectionId: entry.collectionId, text: editText ? detail.data?.text ?? "" : "", archived,
      researchEntryId: entry.researchEntryId ?? "", revision: catalog.revision });
    setError(""); setNotice("");
  }
  async function saveDraft() {
    if (!draft || !catalog || busy || !connected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (draft.type === "folder") {
        const result = await action<LibraryCatalog>(draft.id ? "library.collection.update" : "library.collection.create", {
          ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), parentId: draft.parentId || null, expectedRevision: draft.revision,
        });
        const id = draft.id ?? result.collections.find(item => !collections.some(old => old.id === item.id))?.id;
        if (id) { setFolder(id); setSelected(""); setCollapsed(previous => new Set([...previous].filter(value => value !== draft.parentId))); }
      } else {
        const result = await action<{ id: string; revision: number }>(draft.id ? "artifacts.update" : "artifacts.create", {
          ...(draft.id ? { id: draft.id, archived: draft.archived } : { kind: "note" }),
          expectedRevision: draft.revision, title: draft.title.trim(), description: draft.description.trim(), collectionId: draft.collectionId,
          ...(draft.type === "note" ? { text: draft.text } : {}),
          researchEntryId: draft.researchEntryId || null,
        });
        setSelected(result.id); setFolder(draft.collectionId);
      }
      setDraft(null); setNotice("Saved in Artifacts. No query was run or data shared.");
      await loadCatalog();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function refreshForReview() {
    setError("");
    try {
      const next = await loadCatalog();
      setDraft(previous => previous ? { ...previous, revision: previous.type === "folder" ? next.libraryRevision : next.revision } : null);
      setNotice("Latest saved details refreshed. Your draft is preserved. Review the current details below before saving again.");
    } catch (reason) { setError(errorMessage(reason)); }
  }
  async function importFiles(files: File[]) {
    if (!catalog || locked || !connected || !files.length) return;
    if (files.length > 25) { setError("Import up to 25 files at a time. Nothing was imported."); return; }
    const tooLarge = files.find(file => file.size > catalog.limits.maxFileBytes);
    if (tooLarge) { setError(`${tooLarge.name} exceeds the ${artifactSize(catalog.limits.maxFileBytes)} file limit. Nothing was imported.`); return; }
    setBusy(true); setError(""); setNotice("");
    let confirmed = 0, revision = catalog.revision, lastId = "";
    try {
      for (const file of files) {
        setNotice(`Importing ${confirmed + 1} of ${files.length}: ${file.name}`);
        const result = await api.uploadArtifact(file, folder || "saved:general", revision);
        revision = result.revision; lastId = result.id; confirmed++;
      }
      setNotice(`${confirmed} ${confirmed === 1 ? "file imported" : "files imported"}. Originals are stored separately from the query library.`);
    } catch (reason) {
      setError(`Import stopped after ${confirmed} confirmed ${confirmed === 1 ? "file" : "files"}. ${errorMessage(reason)} Refresh before retrying an unconfirmed file.`);
      setNotice("");
    } finally {
      if (lastId) setSelected(lastId);
      try { await loadCatalog(); } catch (reason) { setError(previous => `${previous ? `${previous} ` : ""}Could not refresh the catalog: ${errorMessage(reason)}`); }
      setBusy(false);
    }
  }
  async function download() {
    if (!current || busy) return;
    setBusy(true); setError("");
    try { downloadBlob(await api.artifactBlob(current.id), current.fileName || `${current.title}.${current.kind === "visual" ? "json" : "md"}`); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function checkDocumentation() {
    if (!catalog || locked || !connected || reviewDocumentation || reviewContent) return;
    const targets = selected ? current ? [current] : [] : matches;
    const ids = targets.filter(entry => entry.kind === "note").map(entry => entry.id);
    const targetIds = new Set(targets.map(entry => entry.id));
    setBusy(true); setError(""); setNotice("");
    let checked = 0;
    try {
      for (let offset = 0; offset < ids.length; offset += 25) {
        setNotice(`Checking managed notes locally: ${offset} of ${ids.length}. Nothing is sent to Copilot.`);
        const result = await api.action<{ checkedCount: number }>("artifacts.checkWriting", { expectedRevision: catalog.revision, ids: ids.slice(offset, offset + 25) });
        checked += result.checkedCount;
      }
      const next = await loadCatalog();
      const checkedEntries = next.entries.filter(entry => targetIds.has(entry.id) && entry.writing?.version === WRITING_VERSION);
      const documents = checkedEntries.reduce((sum, entry) => sum + entry.writing!.checkedDocuments, 0);
      const attention = checkedEntries.filter(entry => writingState(entry) !== "pass").length;
      setNotice(`Checked ${documents} documentation bodies across ${checkedEntries.length} artifacts using rules v${WRITING_VERSION}. ${attention} artifacts need attention. No text was changed or shared; imported files are outside these checks.`);
    } catch (reason) { setNotice(""); setError(`Local checks stopped after ${checked} managed notes. ${errorMessage(reason)} No text was changed or shared.`); }
    finally { setBusy(false); }
  }
  function folderTree(parentId: string | null): ReactNode {
    return <ul>{collections.filter(item => item.source === "saved" && item.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name)).map(item => {
        const children = collections.some(child => child.parentId === item.id);
        const expanded = !collapsed.has(item.id);
        return <li key={item.id}><div className={`artifact-folder-row ${folder === item.id ? "selected" : ""}`}>
          {children ? <button className="icon-button" aria-label={`${expanded ? "Collapse" : "Expand"} folder ${item.name}`} aria-expanded={expanded} onClick={() => setCollapsed(previous => {
            const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next;
          })}><Icon name={expanded ? "down" : "chevron"} size={12}/></button> : <span className="artifact-tree-spacer"/>}
          <button className="artifact-folder" disabled={locked} aria-current={folder === item.id ? "page" : undefined} title={pathName(item.id)} onClick={() => changeFolder(item.id)}>
            <Icon name="folder" size={15}/><span>{item.name}</span>
          </button>
        </div>{children && expanded && folderTree(item.id)}</li>;
      })}</ul>;
  }
  const renderArtifact = useCallback((id: string, alt: string) => catalog
    ? <ArtifactEmbed id={id} alt={alt} catalog={catalog} session={session} workbenchId={state.workbenchId}/>
    : <span>[Visual unavailable: {alt || id}]</span>, [catalog, session, state.workbenchId]);
  const visibleError = error || read.error;
  return <main id="artifacts-workspace" role="tabpanel" aria-labelledby="artifacts-workspace-tab" className={`artifacts-workspace ${dragging ? "is-dragging" : ""}`} hidden={hidden} inert={inert}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); if (!locked && !reviewDocumentation && !reviewContent) setDragging(true); } }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault(); setDragging(false);
      if (locked || reviewDocumentation || reviewContent) setError("Finish the current artifact edit or content review before importing files. Your draft is preserved.");
      else void importFiles(Array.from(event.dataTransfer.files));
    }}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); event.stopPropagation();
        if (!locked && !reviewDocumentation && !reviewContent) { if (selected) { focusSearch.current = true; setSelected(""); } else searchInput.current?.focus(); }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !reviewContent && !reviewDocumentation) { event.preventDefault(); event.stopPropagation(); draftForm.current?.requestSubmit(); }
      if (event.key === "Escape" && !locked && !reviewDocumentation && !reviewContent) { event.preventDefault(); event.stopPropagation(); if (foldersOpen) setFoldersOpen(false); else back(); }
    }}>
    <div className="artifacts-heading">
      <div><h2><Icon name="folder" size={18}/>Artifacts</h2><span>Research, visuals &amp; files</span></div>
      <div className="artifact-create-actions">
        <button className="button small" title={selected ? "Check the selected artifact locally without sharing its text." : "Check documentation in the current filtered view locally without sharing text."}
          disabled={locked || !catalog || !connected || reviewDocumentation || reviewContent} onClick={() => void checkDocumentation()}>Check docs</button>
        <button ref={reviewButton} className="button small" disabled={locked || !catalog || !connected || reviewDocumentation || reviewContent} onClick={() => { setReviewDocumentation(true); setError(""); setNotice(""); }}>Review docs</button>
        <button className="button small" disabled={locked || !catalog || !connected || reviewDocumentation || reviewContent}
          onClick={() => setReviewContent(true)}>Review content &amp; history</button>
        <button className="button small" disabled={locked || !catalog || !connected || reviewDocumentation || reviewContent} onClick={beginNote}><Icon name="edit" size={14}/>New note</button>
        <button className="button small" disabled={locked || !catalog || !connected || reviewDocumentation || reviewContent} onClick={() => upload.current?.click()}><Icon name="upload" size={14}/>Import files</button>
        <input ref={upload} className="sr-only" type="file" multiple aria-label="Choose artifact files" tabIndex={-1} onChange={event => {
          const files = Array.from(event.target.files ?? []); event.target.value = ""; void importFiles(files);
        }}/>
        <button className="icon-button" aria-label="Refresh artifacts" disabled={busy || !connected} onClick={() => void loadCatalog().catch(reason => setError(errorMessage(reason)))}><Icon name="refresh" size={14}/></button>
      </div>
    </div>
    {!connected && <div className="artifact-notice" role="status">Disconnected. Cached artifacts remain visible; reconnect before saving or importing.</div>}
    {read.loading && catalog && <div className="artifact-notice" role="status">Refreshing artifact metadata...</div>}
    {visibleError && <div className="inline-alert error" role="alert"><Icon name="warning" size={14}/><span>{visibleError}</span>
      <button className="text-button" disabled={busy || !connected} onClick={() => void (draft ? refreshForReview() : loadCatalog().catch(reason => setError(errorMessage(reason))))}>{draft ? "Refresh for review" : "Retry catalog"}</button>
    </div>}
    {notice && <div className="artifact-notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss artifact notification" onClick={() => setNotice("")}><Icon name="close" size={12}/></button></div>}
    {reviewContent && catalog && <ContentReview state={state} entries={selected ? current ? [current] : [] : matches} initialId={selected}
      action={action} connected={connected} onDirtyChange={setReaderDirty} onClose={() => { setReviewContent(false); void loadCatalog().catch(reason => setError(errorMessage(reason))); }}/>}
    {reviewDocumentation && catalog && <DocumentationReview state={state} entries={selected ? current ? [current] : [] : matches}
      libraryRevision={catalog.libraryRevision} initialId={selected} sharedIds={sharedDocumentation} connected={connected}
      onClose={() => { setReviewDocumentation(false); requestAnimationFrame(() => reviewButton.current?.focus()); }}
      onSent={(count, ids) => { setReviewDocumentation(false); setSharedDocumentation(previous => new Set([...previous, ...ids]));
        setNotice(`${count} documentation ${count === 1 ? "entry" : "entries"} shared with Copilot for rewriting. This is a handoff, not a completed review; follow the conversation for saved changes or blockers.`);
        requestAnimationFrame(() => reviewButton.current?.focus()); }}/>}
    <div className="artifacts-layout" hidden={reviewDocumentation || reviewContent}>
      {foldersOpen && <button className="artifact-folder-backdrop" aria-label="Close artifact folders" tabIndex={-1} onClick={() => setFoldersOpen(false)}/>}
      <aside className={`artifact-folders ${foldersOpen ? "is-open" : ""}`} aria-label="Artifact folders">
        <div className="artifact-folders-heading"><h3>Folders</h3><button className="icon-button" aria-label="New artifact folder" disabled={locked || !catalog || !connected} onClick={() => beginFolder()}><Icon name="plus" size={14}/></button></div>
        <button className={`artifact-all ${!folder ? "selected" : ""}`} aria-current={!folder ? "page" : undefined} disabled={locked} onClick={() => changeFolder("")}><Icon name="folder" size={15}/>All artifacts<span>{entries.length}</span></button>
        <nav aria-label="Artifact folder navigation">{folderTree(null)}</nav>
        <div className="artifact-folder-actions">
          <button className="button small quiet" disabled={locked || !catalog || !connected} onClick={() => beginFolder()}>New folder</button>
          {folder && folder !== "saved:general" && <button className="button small quiet" disabled={locked || !connected} onClick={() => beginFolder(true)}>Rename / move folder</button>}
        </div>
        <p className="artifact-folder-note">Protected library records; folders are shared with Query Library. Linked projects remain plaintext in their chosen local folders. Nothing is shared automatically.</p>
      </aside>
      <section className="artifact-content" aria-label="Artifact workspace">
        <div className="artifact-location">
          <button className="icon-button artifact-folders-toggle" aria-label="Show artifact folders" aria-expanded={foldersOpen} onClick={() => setFoldersOpen(value => !value)}><Icon name="panel" size={15}/></button>
          {selected && <button className="button quiet small artifact-back" disabled={locked} onClick={back}><Icon name="chevron" size={12}/>Back to files</button>}
          <nav aria-label="Artifact breadcrumb"><button disabled={locked} onClick={() => changeFolder("")}>Artifacts</button>
            {(paths.get(current?.collectionId ?? folder) ?? []).map(part => <span key={part.id}><Icon name="chevron" size={11}/><button disabled={locked} onClick={() => changeFolder(part.id)}>{part.name}</button></span>)}
          </nav>
          {canFormatNumbers && <label className="artifact-number-mode"><input type="checkbox" checked={exact} onChange={event => setExact(event.target.checked)}/>Exact values</label>}
        </div>
        {draft ? <form ref={draftForm} className="artifact-form" onSubmit={event => { event.preventDefault(); void saveDraft(); }}>
          <h3>{draft.type === "folder" ? draft.id ? "Rename or move folder" : "New folder" : draft.type === "note" ? draft.id ? "Edit research note" : "New research note" : "Manage artifact"}</h3>
          <fieldset disabled={busy || !connected}>
            {draft.type === "folder" ? <>
              <label className="field-label">Folder name<input autoFocus required maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
              <label className="field-label">Inside<select value={draft.parentId} onChange={event => setDraft({ ...draft, parentId: event.target.value })}><option value="">Top level</option>
                {collections.filter(item => !paths.get(item.id)?.some(parent => parent.id === draft.id)).map(item => <option key={item.id} value={item.id}>{pathName(item.id)}</option>)}
              </select></label><p className="field-help">Moving a folder includes its descendants and every artifact type. Up to four folder levels; existing query-library limits apply.</p>
              {draft.id && <p className="field-help">Currently saved: {pathName(draft.id)}</p>}
            </> : <>
              <label className="field-label">Artifact title<input autoFocus required maxLength={120} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
              <label className="field-label">Folder<select value={draft.collectionId} onChange={event => setDraft({ ...draft, collectionId: event.target.value })}>{collections.map(item => <option key={item.id} value={item.id}>{pathName(item.id)}</option>)}</select></label>
              <label className="field-label">Description<textarea rows={2} maxLength={500} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })}/></label>
              {draft.type === "note" && <><WritingEditor label="Research Markdown" kind="note" required rows={15} maxLength={128000} value={draft.text} onChange={text => setDraft({ ...draft, text })} disabled={busy || !connected}/>
                <p className="field-help">Embed a saved chart or image with <code>![Caption](artifact:ID)</code>. Use Copy visual reference on its preview. Remote images remain blocked.</p></>}
              <label className="field-label">Attach to research<select value={draft.researchEntryId} onChange={event => setDraft({ ...draft, researchEntryId: event.target.value })}><option value="">No attachment</option>{entries.filter(entry => entry.kind === "research" && !entry.archived).map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
              {draft.id && <label className="check-field"><input type="checkbox" checked={draft.archived} onChange={event => setDraft({ ...draft, archived: event.target.checked })}/>Archived (recoverable; not deleted)</label>}
              {draft.id && <p className="field-help">Currently saved: {entries.find(entry => entry.id === draft.id)?.title} · {pathName(entries.find(entry => entry.id === draft.id)?.collectionId ?? "")}</p>}
            </>}
          </fieldset>
          <div className="button-row"><button className="button primary" disabled={busy || !connected}>{busy ? "Saving..." : draft.type === "folder" ? draft.id ? "Save folder" : "Create folder" : "Save artifact"}</button><button className="button" type="button" disabled={busy} onClick={() => { setDraft(null); setError(""); }}>Cancel</button></div>
        </form> : <>
          <div className="artifact-browser" hidden={Boolean(selected)}>
            <div className="artifact-filters">
              <div className="search-field"><Icon name="search" size={14}/><input ref={searchInput} aria-label="Search artifacts" placeholder="Find a name, folder, or session..." value={search} onChange={event => { setSearch(event.target.value); listScroll.current = 0; }}/></div>
              <label><span className="sr-only">Artifact type</span><select value={type} onChange={event => setType(event.target.value as ArtifactFilter)}>{typeFilters.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select></label>
              <label><span className="sr-only">Artifact status</span><select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All statuses</option></select></label>
              <details className="artifact-more-filters"><summary>More filters</summary><div>
                <label>Model<select aria-label="Artifact model" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="all">All models</option><option value="current">Current model</option><option value="unassigned">Unassigned</option></select></label>
                <label>Session<select aria-label="Artifact session" value={attribution} onChange={event => setAttribution(event.target.value)}><option value="">All sessions</option><option value="unassigned">Unassigned</option>{sessions.map(item => <option key={item.id} value={item.id}>{item.title} ({item.id})</option>)}</select></label>
                <label>Sort<select aria-label="Sort artifacts" value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="recent">Recently updated</option><option value="name">Name</option><option value="type">Type</option></select></label>
                <label>Documentation<select aria-label="Documentation status" value={writingFilter} onChange={event => setWritingFilter(event.target.value as typeof writingFilter)}>
                  <option value="all">All checks</option><option value="attention">Needs attention / unchecked</option><option value="pass">Structure passes</option><option value="unchecked">Not checked</option>
                </select></label>
              </div></details>
            </div>
            <div className="artifact-list-heading"><span>Name <small>{matches.length.toLocaleString()}</small></span><span>Type</span><span>Updated</span></div>
            <div className="artifact-file-list" ref={list} aria-label="Artifact files" onScroll={event => { if (!selected) listScroll.current = event.currentTarget.scrollTop; }}
              onKeyDown={event => {
                if (!["ArrowDown", "ArrowUp", "Home", "End", "F2"].includes(event.key) || !matches.length) return;
                event.preventDefault();
                const index = Math.max(0, matches.findIndex(entry => entry.id === focused));
                if (event.key === "F2") { manage(matches[index]); return; }
                const next = event.key === "Home" ? 0 : event.key === "End" ? matches.length - 1 : Math.max(0, Math.min(matches.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
                setFocused(matches[next].id); rows.scrollToIndex(next, { align: "auto" });
                requestAnimationFrame(() => {
                  if (list.current?.contains(document.activeElement)) list.current.querySelector<HTMLButtonElement>(`[data-artifact-id="${CSS.escape(matches[next].id)}"]`)?.focus({ preventScroll: true });
                });
              }}>
              <div className="artifact-virtual-space" style={{ height: rows.getTotalSize() }}>
                {visibleRows.map(row => {
                  const entry = matches[row.index], presentation = artifactTypes[entry.kind];
                  return <button key={entry.id} className={`artifact-entry ${focused === entry.id ? "is-focused" : ""}`} data-artifact-id={entry.id}
                    style={{ transform: `translateY(${row.start}px)` }} aria-label={entry.title}
                    title={`${entry.title}\n${entry.description || pathName(entry.collectionId)}`}
                    tabIndex={entry.id === focused || !matches.some(item => item.id === focused) && row.index === 0 ? 0 : -1}
                    onFocus={() => setFocused(entry.id)} onClick={() => select(entry)}>
                    <span className="artifact-entry-name"><Icon name={presentation.icon} size={19}/><span><strong>{entry.title}</strong>
                      <small>{writingLabel(entry)}{writingLabel(entry) ? " · " : ""}{entry.description || entry.session?.title || pathName(entry.collectionId)}{entry.analysisStale ? " · analysis out of date" : ""}</small></span></span>
                    <span className="artifact-entry-type">{presentation.label}<small>{artifactSize(entry.byteLength)}</small></span>
                    <time dateTime={entry.updatedAt}>{entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""}</time>
                  </button>;
                })}
              </div>
              {!matches.length && <div className="artifact-empty"><Icon name={search ? "search" : "folder"} size={30}/><h3>{read.loading ? "Loading artifacts..." : entries.length ? "No matching artifacts" : "A place for your analysis"}</h3>
                <p>{entries.length ? "Try another folder, type, status, model, or session." : "Save research from Copilot, save a chart from Results, or import an image, PowerPoint deck, document, or other file."}</p>
                {!!entries.length && <button className="button small" onClick={() => { setFolder(""); setType("all"); setSearch(""); setStatus("all"); setScope("all"); setAttribution(""); setWritingFilter("all"); }}>Clear filters</button>}
              </div>}
            </div>
            <p className="artifact-list-footer">{catalog ? `${entries.length.toLocaleString()} artifacts · up to ${artifactSize(catalog.limits.maxFileBytes)} per imported file` : "Loading protected local catalog"} · Drop files here to import.</p>
          </div>
          {selected && <div className="artifact-reader" aria-label="Artifact preview">
            {!current ? <div className="artifact-empty"><h3>{read.loading ? "Loading artifact..." : "Artifact unavailable"}</h3><p>Refresh the catalog or return to the file list. Existing drafts and queries are unchanged.</p></div>
              : <ResearchPresentationProvider numbers={exact ? "exact" : "readable"} renderArtifact={renderArtifact}>
                {current.kind === "project" ? <QueryProject key={current.id} id={current.id} action={action} connected={connected} hidden={hidden} revision={state.projectsRevision ?? 0} onChanged={() => setCatalogEpoch(value => value + 1)}/>
                  : current.kind === "research" || current.kind === "query" ? <QueryLibrary key={current.id} state={state} action={action} files={null} saveRequest={0}
                  onOpen={onQuery} onDirtyChange={setReaderDirty} onBusyChange={setReaderBusy} session={session} connected={connected}
                  previewExpanded onPreviewExpandedChange={noExpand} embeddedEntryId={current.id} embeddedAnalysis={current.kind === "research"}
                  relatedVisuals={catalog && <RelatedArtifacts entryId={current.id} catalog={catalog} session={session} workbenchId={state.workbenchId} onOpen={select}/>}/>
                  : <div className="artifact-managed-reader">
                    {current.researchChanged && <p className="inline-alert" role="status">Linked research changed, or its original revision was not recorded. This attachment has not been automatically refreshed or revalidated.</p>}
                    <header className="artifact-document-heading"><Icon name={artifactTypes[current.kind].icon} size={22}/><div><h3>{current.title}</h3><p>{current.description}</p>
                      <div className="artifact-metadata"><span>{artifactTypes[current.kind].label}</span><span>{artifactSize(current.byteLength)}</span>{current.updatedAt && <time dateTime={current.updatedAt}>{new Date(current.updatedAt).toLocaleString()}</time>}{current.archived && <strong>Archived</strong>}</div></div></header>
                    <div className="artifact-document-actions">
                      <button className="button small" disabled={locked || !connected} onClick={() => manage(current)}>Rename / move</button>
                      {current.kind === "note" && <button className="button small" disabled={locked || !connected || !detail.data || current.archived} onClick={() => manage(current, true)}><Icon name="edit" size={13}/>Edit note</button>}
                      <button className="button small" disabled={busy || !connected || !detail.data?.downloadable} onClick={() => void download()}><Icon name="download" size={13}/>Download</button>
                      {["visual", "image"].includes(current.kind) && <button className="button small quiet" onClick={() => {
                        void navigator.clipboard.writeText(`![${current.title.replace(/[\[\]\\\r\n]/g, " ")}](${current.id})`)
                          .then(() => setNotice("Visual reference copied. Paste it into a research note or journal."))
                          .catch(reason => setError(`Could not copy the visual reference: ${errorMessage(reason)}`));
                      }}>Copy visual reference</button>}
                      <button className="button small quiet" disabled={locked || !connected} onClick={() => manage(current, false, !current.archived)}>{current.archived ? "Restore artifact" : "Archive artifact"}</button>
                    </div>
                    {detail.error ? <div className="artifact-preview-error" role="alert"><p>{detail.error}</p><button className="button small" onClick={detail.retry}>Retry preview</button></div>
                      : detail.data ? <ArtifactBody detail={detail.data}/> : <div className="artifact-loading" role="status">Loading artifact preview...</div>}
                  </div>}
              </ResearchPresentationProvider>}
          </div>}
        </>}
      </section>
    </div>
    {dragging && <div className="artifact-drop-indicator">Import into {pathName(folder) || "General"}</div>}
  </main>;
}
