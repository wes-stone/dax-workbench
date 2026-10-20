import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Snapshot } from "../contracts/workbench";
import type { CopilotAnalysis, LibraryCatalog, LibraryItem } from "../contracts/query-library";
import type { Action } from "./useWorkbench";
import { api, errorMessage } from "./api";
import { Icon } from "./icons";
import { analysisExecutionLabel, filterLibrary, indexLibrary, sameLibraryModel, searchLibrary, type LibraryBrowse, type LibrarySession } from "./library-cache";
import { useLibraryRead } from "./useLibraryRead";
import { ModelNotes } from "./ModelNotes";
import { MarkdownPreview } from "./MarkdownPreview";
import { DocumentationReader } from "./DocumentationReader";
import { WritingEditor } from "./WritingEditor";

interface SaveDetails {
  documentId: string; id?: string; collectionId: string; title: string; description: string; documentation: string; expectedRevision: number; modelKey: string;
}
interface FolderDetails { id?: string; name: string; parentId: string; expectedRevision: number; modelKey: string }
interface SessionFields { sessionId: string; sessionTitle: string }
interface OrganizeDetails extends SessionFields {
  id: string; title: string; collectionId: string; archived: boolean; expectedRevision: number; modelKey: string;
}
interface JournalDraft extends SessionFields { id: string; content: string; expectedRevision: number; modelKey: string }
interface DocumentationDraft {
  id: string; title: string; description: string; documentation: string; expectedDescription: string;
  expectedDocumentation: string; expectedRevision: number; modelKey: string;
}
const validSession = ({ sessionId, sessionTitle }: SessionFields) => (!sessionId.trim() && !sessionTitle.trim())
  || (Boolean(sessionId.trim() && sessionTitle.trim()) && !/[\u0000-\u001f\u007f-\u009f]/u.test(sessionId + sessionTitle));
const sessionPayload = ({ sessionId, sessionTitle }: SessionFields) => sessionId.trim()
  ? { id: sessionId.trim(), title: sessionTitle.trim() } : undefined;

export function QueryLibrary({ state, action, files, saveRequest, onOpen, onDirtyChange, onBusyChange, session, connected, previewExpanded, onPreviewExpandedChange, embeddedEntryId, embeddedAnalysis = false, onArtifacts, relatedVisuals }: {
  state: Snapshot; action: Action; files: ReactNode; saveRequest: number;
  onOpen: () => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; session: LibrarySession; connected: boolean;
  previewExpanded: boolean; onPreviewExpandedChange: (expanded: boolean) => void;
  embeddedEntryId?: string; embeddedAnalysis?: boolean; onArtifacts?: (id: string) => void; relatedVisuals?: ReactNode;
}) {
  const active = state.documents.find(doc => doc.id === state.activeDocumentId);
  const namespace = embeddedEntryId ? "artifact-research" : "library";
  const modelKey = JSON.stringify(state.libraryIdentity ?? [state.workbenchId, active?.connectionId]);
  const catalogKey = JSON.stringify(["catalog", modelKey, state.libraryRevision ?? 0]);
  const remembered = session.navigation(modelKey);
  const [navigation, setNavigation] = useState<{ key: string; value: LibraryBrowse }>({ key: modelKey, value: { ...remembered,
    ...(embeddedEntryId ? { tab: "saved" as const, selected: embeddedEntryId, scope: "all" as const, status: "all" as const,
      previewTab: embeddedAnalysis ? "analysis" as const : "docs" as const } : { tab: remembered.tab === "research" ? "saved" as const : remembered.tab }),
  } });
  const browse: LibraryBrowse = navigation.key === modelKey ? navigation.value : embeddedEntryId
    ? { ...remembered, tab: "saved", selected: embeddedEntryId, scope: "all", status: "all", previewTab: embeddedAnalysis ? "analysis" : "docs" }
    : { ...remembered, tab: remembered.tab === "research" ? "saved" : remembered.tab };
  const { tab, collection, selected, search, sort, scope, collapsed, previewTab, status, sessionFilter } = browse;
  const patchBrowse = (patch: Partial<LibraryBrowse>) => setNavigation(previous => ({
    key: modelKey, value: { ...(previous.key === modelKey ? previous.value : remembered), ...patch },
  }));
  const setTab = (tab: LibraryBrowse["tab"]) => patchBrowse({ tab });
  const setCollection = (collection: string) => patchBrowse({ collection });
  const setSelected = (selected: string) => patchBrowse({ selected });
  const setSearch = (search: string) => { remembered.scrollTop = 0; patchBrowse({ search }); };
  const setPreviewTab = (previewTab: LibraryBrowse["previewTab"]) => patchBrowse({ previewTab });
  const setCollapsed = (change: (previous: Set<string>) => Set<string>) => setNavigation(previous => {
    const value = previous.key === modelKey ? previous.value : remembered;
    return { key: modelKey, value: { ...value, collapsed: change(value.collapsed) } };
  });
  const [override, setOverride] = useState<{ key: string; catalog: LibraryCatalog }>();
  const catalogRead = useLibraryRead<LibraryCatalog>(session, catalogKey, "catalog",
    async signal => {
      const next = await api.read<LibraryCatalog>("library.catalog", {}, signal);
      if (next.identity && JSON.stringify(next.identity) !== modelKey) throw new Error("The active model changed. Refresh the library.");
      return next;
    });
  const catalog = override?.key === modelKey && override.catalog.revision >= (catalogRead.data?.revision ?? -1)
    ? override.catalog : catalogRead.data ?? null;
  const [form, setForm] = useState<SaveDetails | null>(null);
  const [copy, setCopy] = useState(false);
  const [folderForm, setFolderForm] = useState<FolderDetails | null>(null);
  const [organizeForm, setOrganizeForm] = useState<OrganizeDetails | null>(null);
  const [journal, setJournal] = useState<JournalDraft | null>(null);
  const [documentationForm, setDocumentationForm] = useState<DocumentationDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const dirty = Boolean(form || folderForm || organizeForm || journal || documentationForm);
  const locked = dirty || busy || sharing || refreshing;
  const draftModel = form?.modelKey ?? folderForm?.modelKey ?? organizeForm?.modelKey ?? journal?.modelKey ?? documentationForm?.modelKey;
  const modelChanged = Boolean(draftModel && draftModel !== modelKey);
  const canRefreshDraft = modelChanged && sameLibraryModel(draftModel!, modelKey);
  const managing = Boolean(form || organizeForm || folderForm || documentationForm);
  const requested = useRef(0);
  const saveForm = useRef<HTMLFormElement>(null);
  const refresh = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null), foldersPanel = useRef<HTMLElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const restoreListFocus = useRef("");
  const currentKey = useRef(modelKey); currentKey.current = modelKey;
  const acceptCatalog = (next: LibraryCatalog) => {
    if (currentKey.current !== modelKey || next.identity && JSON.stringify(next.identity) !== modelKey)
      throw new Error("The model changed. Your draft is preserved; return to the original model and refresh before retrying.");
    session.cache.put(JSON.stringify(["catalog", modelKey, next.revision]), "catalog", next);
    setOverride(previous => previous?.key === modelKey && previous.catalog.revision > next.revision ? previous : { key: modelKey, catalog: next });
  };
  const load = async (allowRetry = false, recoverModel = false) => {
    if (modelChanged && !(recoverModel && canRefreshDraft)) return;
    refresh.current?.abort();
    const controller = new AbortController(); refresh.current = controller;
    setRefreshing(true); setError("");
    try {
      const next = await api.read<LibraryCatalog>("library.catalog", {}, controller.signal);
      if (controller.signal.aborted || currentKey.current !== modelKey) return;
      if (next.identity && JSON.stringify(next.identity) !== modelKey) throw new Error("The active model changed. Reopen the library.");
      if (recoverModel) {
        const entryId = journal?.id ?? organizeForm?.id ?? form?.id ?? documentationForm?.id;
        if (entryId && !next.entries.some(entry => entry.id === entryId && entry.source === "saved" && (!journal || entry.hasAnalysis)))
          throw new Error("The saved artifact is no longer available. Your draft is preserved; discard it only when you are ready.");
        if (folderForm?.id && !next.collections.some(folder => folder.id === folderForm.id && folder.source === "saved"))
          throw new Error("The saved folder is no longer available. Your draft is preserved.");
      }
      acceptCatalog(next);
      setPreviewEpoch(value => value + 1);
      catalogRead.accept(next);
      if (allowRetry && (!modelChanged || recoverModel && canRefreshDraft)) {
        const latestDocumentation = documentationForm
          ? await api.read<LibraryItem>("library.get", { id: documentationForm.id }, controller.signal) : null;
        if (controller.signal.aborted || currentKey.current !== modelKey) return;
        const reviewed = { expectedRevision: next.revision, ...(recoverModel ? { modelKey } : {}) };
        setForm(previous => previous ? { ...previous, ...reviewed } : null);
        setFolderForm(previous => previous ? { ...previous, ...reviewed } : null);
        setOrganizeForm(previous => previous ? { ...previous, ...reviewed } : null);
        setJournal(previous => previous ? { ...previous, ...reviewed } : null);
        if (latestDocumentation) setDocumentationForm(previous => previous ? { ...previous, ...reviewed,
          expectedDocumentation: latestDocumentation.documentation, expectedDescription: latestDocumentation.description } : null);
        if (recoverModel) setNavigation(previous => ({ key: modelKey, value: previous.value }));
        setNotice("Library refreshed. Your draft is preserved. Review the latest saved details before retrying.");
      }
    }
    catch (reason) { if (!controller.signal.aborted && currentKey.current === modelKey) setError(errorMessage(reason)); }
    finally { if (!controller.signal.aborted && currentKey.current === modelKey) setRefreshing(false); }
  };
  useEffect(() => { setRefreshing(false); setNotesOpen(false); setOverride(undefined); return () => refresh.current?.abort(); }, [modelKey]);
  useLayoutEffect(() => {
    const { scrollTop: _scroll, folderScrollTop: _folder, ...fields } = browse;
    Object.assign(remembered, fields);
  }, [browse, remembered]);
  useLayoutEffect(() => {
    onPreviewExpandedChange(false);
  }, [modelKey, selected, tab, notesOpen, managing, onPreviewExpandedChange]);
  useLayoutEffect(() => {
    if (previewExpanded) return;
    if (list.current) list.current.scrollTop = remembered.scrollTop;
    if (foldersPanel.current) foldersPanel.current.scrollTop = remembered.folderScrollTop;
  }, [modelKey, catalog, tab, notesOpen, managing, previewExpanded]);
  useLayoutEffect(() => {
    if (selected && !notesOpen && !managing && !journal && window.matchMedia("(max-width: 760px)").matches)
      backButton.current?.focus({ preventScroll: true });
    if (!selected && restoreListFocus.current) {
      const id = restoreListFocus.current; restoreListFocus.current = "";
      Array.from(list.current?.querySelectorAll<HTMLButtonElement>(".library-entry") ?? [])
        .find(node => node.dataset.id === id)?.focus({ preventScroll: true });
    }
  }, [selected, notesOpen, managing]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy || sharing || refreshing);
    return () => onBusyChange(false);
  }, [busy, sharing, refreshing, onBusyChange]);
  const beginSave = () => {
    if (!active || !catalog || locked) return;
    const ref = active.libraryRef;
    const linked = catalog.entries.find(entry => entry.id === ref?.entryId && entry.source === "saved");
    const folder = catalog.collections.find(folder => folder.id === collection && folder.source === "saved")
      ?? catalog.collections.find(folder => folder.id === ref?.collectionId && folder.source === "saved")
      ?? catalog.collections.find(folder => folder.source === "saved");
    if (!folder) { setError("Create a collection before saving a query."); return; }
    setTab("saved"); setNotesOpen(false); setCopy(false); setNotice(""); setError("");
    setForm({ documentId: active.id, id: linked?.id, collectionId: folder.id, title: linked?.title ?? active.title,
      description: ref?.description ?? "", documentation: ref?.documentation ?? "", expectedRevision: catalog.revision, modelKey });
  };
  useEffect(() => {
    if (saveRequest && requested.current !== saveRequest && catalog && active && !locked) {
      requested.current = saveRequest; beginSave();
    }
  }, [saveRequest, catalog, active, beginSave]);
  const index = useMemo(() => indexLibrary(catalog), [catalog]);
  const scoped = useMemo(() => filterLibrary(index, tab, scope, sort, status, sessionFilter, search), [index, tab, scope, sort, status, sessionFilter, search]);
  const matches = useMemo(() => searchLibrary(index, scoped.entries, collection, search), [index, scoped, collection, search]);
  const researchSessions = useMemo(() => {
    const entries = filterLibrary(index, "research", scope, "recent", status).entries;
    return [...new Map(entries.filter(entry => entry.session).map(entry => [entry.session!.id, entry.session!])).values()]
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [index, scope, status]);
  const preview = useLibraryRead<LibraryItem>(session, JSON.stringify(["preview", modelKey, catalog?.revision, selected, previewEpoch]), "detail",
    signal => api.read<LibraryItem>("library.get", { id: selected }, signal), Boolean(catalog && selected && !form && !folderForm && !notesOpen && !modelChanged));
  const item = preview.data;
  const collections = index.collections;
  const pathName = (id: string) => index.names.get(id) ?? "";
  const loading = catalogRead.loading || refreshing, previewing = preview.loading;
  const visibleError = error || catalogRead.error || preview.error;
  function backToList() {
    if (locked) return;
    restoreListFocus.current = selected;
    setSelected("");
  }
  function switchTab(next: LibraryBrowse["tab"]) {
    if (locked) return;
    patchBrowse({ tab: next, collection: "", selected: "", search: "", ...(next === "research" ? { sort: "recent" } : {}) }); remembered.scrollTop = 0;
    setNotesOpen(false); setError(""); setNotice("");
  }
  async function changeAnalysisSharing(share: boolean) {
    if (sharing || share && (!item?.analysis || item.source !== "saved" || !connected || locked || state.authoringBusy)) return;
    setSharing(true); setError("");
    try {
      await action(share ? "library.analysis.share" : "library.analysis.clear", share ? { id: item!.id } : {});
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSharing(false); }
  }
  async function openItem() {
    if (!item || locked) return;
    setBusy(true); setError("");
    try { await action("library.entry.open", { id: item.id }); onOpen(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  function beginDocumentation() {
    if (!item || item.source !== "saved" || item.archived || !catalog || locked) return;
    setDocumentationForm({ id: item.id, title: item.title, description: item.description, documentation: item.documentation,
      expectedDescription: item.description, expectedDocumentation: item.documentation, expectedRevision: catalog.revision, modelKey });
    setError(""); setNotice("");
  }
  async function saveDocumentation() {
    if (!documentationForm || busy || refreshing || !connected || modelChanged) return;
    setBusy(true); setError("");
    try {
      const { id, expectedRevision, expectedDocumentation, documentation, expectedDescription, description } = documentationForm;
      const next = await action<LibraryCatalog>("library.documentation.update", {
        id, expectedRevision, expectedDocumentation, documentation, expectedDescription, description,
      });
      acceptCatalog(next); setDocumentationForm(null); setPreviewTab("docs");
      setNotice("Documentation saved. Query, analysis, evidence and journal are unchanged.");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!form || !catalog || busy || refreshing || !connected || form.modelKey !== modelKey || active?.id !== form.documentId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { modelKey: _model, ...details } = form;
      const result = await action<{ id: string; catalog: LibraryCatalog }>("library.entry.save", {
        ...details, title: form.title.trim(), description: form.description.trim(),
        ...(copy ? { id: undefined } : {}),
      });
      acceptCatalog(result.catalog); setSelected(result.id); setCollection(form.collectionId); setSearch("");
      patchBrowse({ scope: result.catalog.entries.find(entry => entry.id === result.id)?.modelScope === "unassigned" ? "unassigned" : "current" });
      setCollapsed(previous => {
        const next = new Set(previous);
        for (const folder of indexLibrary(result.catalog).paths.get(form.collectionId) ?? []) next.delete(folder.id);
        return next;
      });
      setForm(null); setPreviewTab("docs");
      setNotice("Saved with documentation and builder selections. Existing analysis and journal are preserved. No query was run.");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  function beginFolder(edit = false) {
    if (!catalog || locked) return;
    const folder = edit ? collections.find(folder => folder.id === collection) : undefined;
    if (edit && (!folder || folder.source !== "saved" || folder.id === "saved:general")) return;
    setFolderForm({ id: folder?.id, name: folder?.name ?? "", parentId: folder?.parentId ?? (edit ? "" : collection),
      expectedRevision: catalog.revision, modelKey });
    setNotice(""); setError("");
  }
  async function saveFolder() {
    if (!catalog || !folderForm || busy || refreshing || !connected || modelChanged) return;
    setBusy(true); setError("");
    try {
      const next = await action<LibraryCatalog>(folderForm.id ? "library.collection.update" : "library.collection.create", {
        ...(folderForm.id ? { id: folderForm.id } : {}),
        name: folderForm.name.trim(), parentId: folderForm.parentId || null, expectedRevision: folderForm.expectedRevision,
      });
      const savedId = folderForm.id ?? next.collections.find(folder => !collections.some(old => old.id === folder.id))?.id;
      acceptCatalog(next); setFolderForm(null);
      if (savedId) { setCollection(savedId); setSelected(""); expandPath(next, savedId); }
      setNotice(folderForm.id ? "Folder updated. Saved queries and research stay together." : "Collection created.");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  function expandPath(next: LibraryCatalog, id: string) {
    setCollapsed(previous => {
      const expanded = new Set(previous);
      for (const folder of indexLibrary(next).paths.get(id) ?? []) expanded.delete(folder.id);
      return expanded;
    });
  }
  function beginOrganize(archived?: boolean) {
    if (!item || item.source !== "saved" || !catalog || locked) return;
    setOrganizeForm({ id: item.id, title: item.title, collectionId: item.collectionId, archived: archived ?? item.archived === true,
      sessionId: item.session?.id ?? "", sessionTitle: item.session?.title ?? "", expectedRevision: catalog.revision, modelKey });
    setError(""); setNotice("");
  }
  async function organize() {
    if (!organizeForm || !catalog || busy || refreshing || !connected || modelChanged || !validSession(organizeForm)) return;
    setBusy(true); setError("");
    try {
      const next = await action<LibraryCatalog>("library.entry.organize", {
        id: organizeForm.id, expectedRevision: organizeForm.expectedRevision, title: organizeForm.title.trim(),
        collectionId: organizeForm.collectionId, archived: organizeForm.archived, session: sessionPayload(organizeForm) ?? null,
      });
      acceptCatalog(next); setOrganizeForm(null); expandPath(next, organizeForm.collectionId);
      patchBrowse({ collection: organizeForm.collectionId, search: "", sessionFilter: "", selected: organizeForm.id,
        status: organizeForm.archived ? "archived" : "active" });
      setNotice("Artifact details saved. Query, analysis, and earlier journal notes are unchanged.");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  function editJournal(patch: Partial<Pick<JournalDraft, "content" | "sessionId" | "sessionTitle">>) {
    if (!item?.analysis || item.archived || !catalog || busy || refreshing || modelChanged) return;
    setJournal(previous => ({ ...(previous ?? { id: item.id, content: "", sessionId: "", sessionTitle: "",
      expectedRevision: catalog.revision, modelKey }), ...patch }));
  }
  async function appendNote() {
    if (!journal?.content.trim() || item?.archived || busy || refreshing || !connected || modelChanged || !validSession(journal)) return;
    setBusy(true); setError("");
    try {
      const next = await action<LibraryCatalog>("library.research.append", {
        id: journal.id, expectedRevision: journal.expectedRevision, content: journal.content.trim(),
        ...(sessionPayload(journal) ? { session: sessionPayload(journal) } : {}),
      });
      acceptCatalog(next); setJournal(null);
      setNotice("Note appended as Human. Earlier notes and original analysis are unchanged. Nothing was shared or run.");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  function folders(parentId: string | null): ReactNode {
    return <ul>{(index.children.get(parentId) ?? []).filter(folder => folder.source === (tab === "research" ? "saved" : tab)).map(folder => {
      const children = index.children.has(folder.id), expanded = !collapsed.has(folder.id);
      return <li key={folder.id}><div className={`library-folder-row ${collection === folder.id ? "selected" : ""}`}>
        {children ? <button className="icon-button" aria-label={`${expanded ? "Collapse" : "Expand"} ${folder.name}`} aria-expanded={expanded} onClick={() => setCollapsed(previous => {
          const next = new Set(previous); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next;
        })}><Icon name={expanded ? "down" : "chevron"} size={12}/></button> : <span className="library-folder-spacer"/>}
        <button className="library-folder" disabled={locked} aria-current={collection === folder.id ? "page" : undefined} title={pathName(folder.id)} onClick={() => {
          setCollection(folder.id); setSelected(""); remembered.scrollTop = 0;
        }}><Icon name="folder" size={14}/><span>{folder.name}</span><small>{scoped.counts.get(folder.id) ?? 0}</small></button>
      </div>{children && expanded && folders(folder.id)}</li>;
    })}</ul>;
  }
  return <section className={`query-library ${embeddedEntryId ? "artifact-research-reader" : ""}`} aria-label={embeddedEntryId ? "Research artifact reader" : "Query library explorer"} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); event.stopPropagation(); if ((form || documentationForm) && !busy) saveForm.current?.requestSubmit();
    }
  }}>
    {!embeddedEntryId && <div className="library-topbar">
      <div className="library-tabs" role="tablist" aria-label="Library sources" onKeyDown={event => {
        if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        if (!tabs.length) return;
        event.preventDefault();
        const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].focus(); tabs[next].click();
      }}>
        {([["starter", "Starter queries"], ["saved", "My queries"], ["files", "Files & packs"]] as const).map(([value, label]) =>
          <button key={value} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`${namespace}-content`} disabled={locked} onClick={() => switchTab(value)}>{label}</button>)}
      </div>
      <div className="library-topbar-actions">
        <button className="button quiet small" aria-expanded={notesOpen} disabled={locked || !state.libraryIdentity} onClick={() => setNotesOpen(value => !value)}>{notesOpen ? "Back to queries" : "Model notes"}</button>
        <button className="button primary small" disabled={!active || !catalog || locked || !connected} onClick={beginSave}><Icon name="plus" size={13}/>Save current query</button>
      </div>
    </div>}
    {!connected && <p className="library-cache-notice" role="status">Controller disconnected. Cached content may be out of date; opening, saving, and sharing are paused.</p>}
    {visibleError && <div className="inline-alert error" role="alert"><Icon name="warning" size={14}/><span>{visibleError}</span><button className="text-button" disabled={busy || loading || modelChanged || !connected} onClick={() => void load(true)}>Refresh library</button></div>}
    {notice && <div className="library-notice" role="status">{notice}</div>}
    {state.sharedAnalysisId && (state.sharedAnalysisId !== selected || notesOpen || form) && <div className="library-analysis-sharing">
      <p role="status"><strong>Saved analysis shared with Copilot:</strong> {catalog?.entries.find(entry => entry.id === state.sharedAnalysisId)?.title ?? "Previously selected analysis"}. Browsing another preview does not change what is shared.</p>
      <button className="button small" disabled={sharing || !connected} onClick={() => void changeAnalysisSharing(false)}>Stop sharing analysis</button>
    </div>}
    {modelChanged ? <div className="library-draft-recovery">
      <h3>Draft preserved for the previous model</h3>
      <p role="alert">The model or its metadata changed. Return to the original model, then explicitly refresh this draft to review and retry. It cannot be saved against another model.</p>
      <p>{form?.title ?? organizeForm?.title ?? folderForm?.name ?? documentationForm?.title}</p>
      {journal && <p className="library-documentation">{journal.content}</p>}
      {documentationForm && <pre className="library-documentation">{documentationForm.documentation}</pre>}
      {canRefreshDraft && <p><button className="button primary" disabled={busy || loading || !connected} onClick={() => void load(true, true)}>Refresh preserved draft</button></p>}
      <button className="button" disabled={busy} onClick={() => { setForm(null); setFolderForm(null); setOrganizeForm(null); setJournal(null); setDocumentationForm(null); setError(""); }}>Discard preserved draft</button>
    </div> : notesOpen && state.libraryIdentity ? <div className="library-notes-index"><ModelNotes identity={state.libraryIdentity} session={session}/></div> :
    <div id={`${namespace}-content`} role="tabpanel" aria-label={tab === "starter" ? "Starter queries" : tab === "saved" ? "My queries" : tab === "research" ? "Research" : "Files & packs"} className={tab === "files" ? "library-files" : `library-content ${managing ? "is-saving" : ""} ${selected && !managing ? "has-preview" : ""} ${previewExpanded ? "is-expanded" : ""}`}>
      {tab === "files" ? files : <>
        <nav className="library-collections" aria-label="Library collections" ref={foldersPanel} onScroll={event => { if (!previewExpanded) remembered.folderScrollTop = event.currentTarget.scrollTop; }}>
          <div className="library-section-title"><strong>{tab === "research" ? "Folders" : "Collections"}</strong><button className="icon-button" aria-label="Refresh query collections" disabled={busy || loading || !connected} onClick={() => void load(true)}><Icon name="refresh" size={13}/></button></div>
          <button className={`library-all ${!collection ? "selected" : ""}`} disabled={locked} aria-current={!collection ? "page" : undefined} onClick={() => { setCollection(""); setSelected(""); remembered.scrollTop = 0; }}><Icon name="book" size={14}/><span>All {tab === "starter" ? "starters" : tab === "research" ? "research" : "saved queries"}</span><small>{scoped.entries.length}</small></button>
          {folders(null)}
          {(tab === "saved" || tab === "research") && <>
            <button className="button small quiet library-new-folder" disabled={locked || !catalog || !connected} onClick={() => beginFolder()}><Icon name="plus" size={13}/>{tab === "research" ? "New folder" : "New collection"}</button>
            {collection && collection !== "saved:general" && <button className="button small quiet library-new-folder" disabled={locked || !connected} onClick={() => beginFolder(true)}>Manage folder</button>}
          </>}
          <p className="library-local-note">{tab === "starter" ? "Model-specific starters when available; DAX basics otherwise. Open a copy, adapt it, then save your version."
            : tab === "research" ? "Saved query + analysis bundles from My queries, not copies or session files. Notes stay inline. Nothing is shared automatically."
            : "Saved in this workbench's protected local store. Queries, notes, and builder selections stay together."}</p>
        </nav>
        {folderForm ? <form className="library-save-form library-manage-form" onSubmit={event => { event.preventDefault(); void saveFolder(); }}>
          <div className="library-detail-heading"><Icon name="folder" size={18}/><div><h3>{folderForm.id ? "Manage folder" : "New folder"}</h3><p>Organize the same saved entries in Research and My queries.</p></div></div>
          <fieldset className="library-save-fields" disabled={busy || refreshing}>
            <label className="field-label">Folder name<input autoFocus required maxLength={80} value={folderForm.name} onChange={event => setFolderForm({ ...folderForm, name: event.target.value })}/></label>
            <label className="field-label">Inside<select value={folderForm.parentId} onChange={event => setFolderForm({ ...folderForm, parentId: event.target.value })}><option value="">Top level</option>{collections.filter(folder => folder.source === "saved"
              && !index.paths.get(folder.id)?.some(parent => parent.id === folderForm.id)).map(folder => <option key={folder.id} value={folder.id}>{pathName(folder.id)}</option>)}</select></label>
          </fieldset>
          {folderForm.id && <p className="library-analysis-save-note">Currently saved: {pathName(folderForm.id) || "Folder no longer available"}. Moving includes its descendants; four folder levels maximum.</p>}
          <div className="library-save-actions"><button className="button primary" disabled={busy || refreshing || !connected || !folderForm.name.trim()}>{busy ? "Saving..." : folderForm.id ? "Save folder" : "Create folder"}</button><button className="button" type="button" disabled={busy || refreshing} onClick={() => setFolderForm(null)}>Cancel</button></div>
        </form> : organizeForm ? <form className="library-save-form library-manage-form" onSubmit={event => { event.preventDefault(); void organize(); }}>
          <div className="library-detail-heading"><Icon name="book" size={18}/><div><h3>Manage artifact</h3><p>Change organization without editing the saved query or analysis.</p></div></div>
          <fieldset className="library-save-fields" disabled={busy || refreshing}>
            <label className="field-label">Artifact title<input autoFocus required maxLength={120} value={organizeForm.title} onChange={event => setOrganizeForm({ ...organizeForm, title: event.target.value })}/></label>
            <label className="field-label">Folder<select value={organizeForm.collectionId} onChange={event => setOrganizeForm({ ...organizeForm, collectionId: event.target.value })}>{collections.filter(folder => folder.source === "saved").map(folder => <option key={folder.id} value={folder.id}>{pathName(folder.id)}</option>)}</select></label>
            <SessionInputs value={organizeForm} onChange={patch => setOrganizeForm({ ...organizeForm, ...patch })}/>
            <p className="library-local-note">Session labels are entered explicitly, not links. Leave both fields blank for Unassigned. No session files are imported.</p>
            <label className="check-field"><input type="checkbox" checked={organizeForm.archived} onChange={event => setOrganizeForm({ ...organizeForm, archived: event.target.checked })}/>Archived (hidden from Active; never deleted)</label>
          </fieldset>
          {item && <p className="library-analysis-save-note">Currently saved: {item.title} · {pathName(item.collectionId)} · {item.session ? `${item.session.title} (${item.session.id})` : "Unassigned"} · {item.archived ? "Archived" : "Active"}</p>}
          <div className="library-save-actions"><button className="button primary" disabled={busy || refreshing || previewing || !connected || !organizeForm.title.trim() || !validSession(organizeForm)}>{busy ? "Saving..." : "Save artifact details"}</button><button className="button" type="button" disabled={busy || refreshing} onClick={() => setOrganizeForm(null)}>Cancel</button></div>
        </form> : documentationForm ? <form className="library-save-form library-documentation-form" ref={saveForm} onSubmit={event => { event.preventDefault(); void saveDocumentation(); }}>
          <div className="library-detail-heading"><Icon name="edit" size={18}/><div><h3>Edit documentation</h3><p>{documentationForm.title}</p></div></div>
          <fieldset className="library-save-fields" disabled={busy || refreshing}>
            <label className="field-label">Short description<textarea rows={2} maxLength={500} value={documentationForm.description} onChange={event => setDocumentationForm({ ...documentationForm, description: event.target.value })}/></label>
            <WritingEditor label="Documentation" value={documentationForm.documentation} onChange={documentation => setDocumentationForm({ ...documentationForm, documentation })}
              maxLength={16384} disabled={busy || refreshing} rows={14}/>
          </fieldset>
          <details className="documentation-source"><summary>Currently saved documentation</summary><pre>{documentationForm.expectedDocumentation}</pre></details>
          <p className="field-help">Only documentation and the short description change. The query, builder, analysis, evidence and journal stay intact.</p>
          <div className="library-save-actions"><button className="button primary" disabled={busy || refreshing || !connected}>{busy ? "Saving..." : "Save documentation"}</button>
            <button className="button" type="button" disabled={busy || refreshing} onClick={() => { setDocumentationForm(null); setError(""); }}>Cancel</button></div>
        </form> : form ? <form className="library-save-form" ref={saveForm} onSubmit={event => { event.preventDefault(); void save(); }}>
          <div className="library-detail-heading"><Icon name="book" size={18}/><div><h3>{form.id && !copy ? "Update saved query" : "Save query to a collection"}</h3><p>{active?.id === form.documentId ? active.title : "The source tab has changed. Cancel and reopen Save."}</p></div></div>
          <fieldset className="library-save-fields" disabled={busy || refreshing}>
            <label className="field-label">Query title<input required maxLength={120} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })}/></label>
            <label className="field-label">Collection<select value={form.collectionId} onChange={event => setForm({ ...form, collectionId: event.target.value })}>{collections.filter(folder => folder.source === "saved").map(folder => <option key={folder.id} value={folder.id}>{pathName(folder.id)}</option>)}</select></label>
            <label className="field-label">Short description<textarea rows={2} maxLength={500} placeholder="What this query answers" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })}/></label>
            <WritingEditor label="Documentation" value={form.documentation} onChange={documentation => setForm({ ...form, documentation })} maxLength={16384} disabled={busy || refreshing}/>
            {form.id && <label className="check-field"><input type="checkbox" checked={copy} onChange={event => setCopy(event.target.checked)}/>Save a new copy instead of updating the linked query</label>}
          </fieldset>
          <p className="library-local-note">Saves the current editor DAX, parameter values, and builder draft separately. Unapplied builder edits stay unapplied. No results or read permissions are saved.</p>
          {form.id && !copy && <p className="library-analysis-save-note">Existing Copilot analysis and journal notes are preserved separately. Changing the saved query, parameters, or connection marks the analysis out of date.</p>}
          {form.modelKey !== modelKey && <p className="field-error" role="alert">The model changed. Cancel and reopen Save; your entered details are preserved until then.</p>}
          <div className="library-save-actions"><button className="button primary" disabled={busy || refreshing || !connected || active?.id !== form.documentId || form.modelKey !== modelKey || !form.title.trim()}>{busy ? "Saving..." : form.id && !copy ? "Update saved query" : "Save to collection"}</button><button className="button" type="button" disabled={busy || refreshing} onClick={() => setForm(null)}>Cancel</button></div>
        </form> : <>
          <div className="library-browser">
            <div className="library-search"><div className="search-field"><Icon name="search" size={14}/><input aria-label="Search query library" disabled={locked} placeholder={tab === "research" ? "Find research or session..." : "Search queries..."} value={search} onChange={event => setSearch(event.target.value)}/></div>
              <label className="sr-only" htmlFor={`${namespace}-sort`}>Sort library</label><select id={`${namespace}-sort`} disabled={locked} value={sort} onChange={event => patchBrowse({ sort: event.target.value })}><option value="title">Name</option><option value="recent">Recently updated</option></select>
              {(tab === "saved" || tab === "research") && <>
                <label className="library-scope">Model<select aria-label="Library model scope" disabled={locked} value={scope} onChange={event => { patchBrowse({ scope: event.target.value as LibraryBrowse["scope"], selected: "" }); remembered.scrollTop = 0; }}><option value="current">Current model</option><option value="all">All models</option><option value="unassigned">Unassigned</option></select></label>
                <label className="library-scope">Status<select aria-label="Artifact status" disabled={locked} value={status} onChange={event => { patchBrowse({ status: event.target.value as LibraryBrowse["status"], selected: "" }); remembered.scrollTop = 0; }}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label>
              </>}
              {tab === "research" && <label className="library-scope">Session<select aria-label="Research session" disabled={locked} value={sessionFilter} onChange={event => { patchBrowse({ sessionFilter: event.target.value, selected: "" }); remembered.scrollTop = 0; }}>
                <option value="">All sessions</option><option value="unassigned">Unassigned</option>
                {sessionFilter.startsWith("id:") && !researchSessions.some(value => `id:${value.id}` === sessionFilter) && <option value={sessionFilter}>{sessionFilter.slice(3)} (no matches)</option>}
                {researchSessions.map(value => <option key={value.id} value={`id:${value.id}`}>{value.title} ({value.id})</option>)}
              </select></label>}
            </div>
            <div className="library-breadcrumb">{collection ? pathName(collection) : tab === "starter" ? "All starter queries" : tab === "research" ? "All research" : "All saved queries"}<span>{matches.length}</span></div>
            <div className="library-entries" aria-label={tab === "research" ? "Research artifacts" : "Queries"} ref={list} onScroll={event => { if (!previewExpanded) remembered.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={event => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              const entries = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".library-entry:not(:disabled)"));
              if (!entries.length) return;
              event.preventDefault();
              const current = entries.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
              entries[next].focus();
            }}>
              {matches.map(entry => <button key={entry.id} data-id={entry.id} className={`library-entry ${selected === entry.id ? "selected" : ""}`} aria-pressed={selected === entry.id} disabled={locked} onClick={() => { setSelected(entry.id); setPreviewTab(tab === "research" ? "analysis" : "docs"); }}>
                <Icon name={entry.hasBuilder ? "table" : "code"} size={15}/><span><strong>{entry.title}</strong><small>{entry.description || "No description yet."}</small><em>{entry.connectionName || (entry.source === "starter" ? pathName(entry.collectionId) : "No connection assigned")}{entry.hasBuilder ? " / Builder" : entry.source === "starter" ? " / Editor only" : ""}</em>
                  {entry.hasAnalysis && <span className={`library-analysis-indicator ${entry.analysisStale ? "is-stale" : ""}`}><Icon name="lens" size={12}/>Copilot analysis{entry.analysisStale ? " · out of date" : ""}</span>}
                  {entry.hasAnalysis && <em>{entry.session ? `${entry.session.title} · ${entry.session.id}` : "Unassigned"} · {entry.noteCount ?? 0} journal notes</em>}
                  {entry.archived && <em>Archived</em>}
                </span>
              </button>)}
              {!matches.length && <div className="library-empty"><Icon name={search ? "search" : "folder"} size={26}/><h3>{loading ? "Loading library..." : tab === "research" ? "No research matches" : search ? "No matching queries" : "No saved queries here yet"}</h3><p>{tab === "research" ? "Try another title, folder, session, or filter. Research contains saved queries with Copilot analysis; ask Copilot to save research from your active query."
                : search ? "Try another name, description, or collection." : tab === "saved" ? "Check model and status filters, or save this query." : "Save the current query with a short description and notes."}</p>{!search && tab === "saved" && <button className="button small" disabled={!catalog || !active || !connected || locked} onClick={beginSave}>Save current query</button>}</div>}
            </div>
          </div>
          <div className={`library-detail ${selected ? "has-selection" : ""}`} aria-label="Query preview" aria-busy={previewing}>
            {selected && !embeddedEntryId && <div className="library-preview-tools">
              <button className="button quiet small library-back" ref={backButton} disabled={locked} onClick={backToList}><Icon name="chevron" size={12}/>Back to queries</button>
              <button className="button quiet small library-expand-preview" aria-expanded={previewExpanded} aria-controls={`${namespace}-preview-panel`}
                disabled={!previewExpanded && (!item || item.id !== selected)}
                title={previewExpanded ? "Restore folders and query list (Escape)" : "Read this artifact using the full workbench width"}
                onClick={() => onPreviewExpandedChange(!previewExpanded)}><Icon name={previewExpanded ? "restore" : "expand"} size={14}/>{previewExpanded ? "Restore preview" : "Expand preview"}</button>
            </div>}
            {item && item.id === selected ? <>
              <div className="library-detail-heading"><Icon name={item.hasBuilder ? "table" : "code"} size={19}/><div><h3>{item.title}</h3><p>{item.description}</p></div></div>
              <div className="library-item-meta">{!embeddedEntryId && <span>{pathName(item.collectionId)}</span>}<span>{item.source === "starter" ? item.connectionName ? `${item.connectionName} / model starter / opens without running` : "Illustrative example / no live data" : item.connectionName || "Choose a connection after opening"}</span>{item.updatedAt && <span>Saved {new Date(item.updatedAt).toLocaleDateString()}</span>}</div>
              {item.reusableEvidence && <p className="field-help">Reusable example: <strong>{item.reusableEvidence.status}</strong>{item.reusableEvidence.startedAt && ` · ${new Date(item.reusableEvidence.startedAt).toLocaleString()}`}. Execution evidence is not business certification. Open and explicitly run again to test the current query.</p>}
              {item.source === "saved" && <details className="library-source-details"><summary>Source details</summary><dl>
                <dt>Folder</dt><dd>{pathName(item.collectionId)}</dd><dt>Session</dt><dd>{item.session?.title ?? "Unassigned"}</dd>
                {item.session && <><dt>Session ID</dt><dd><code>{item.session.id}</code></dd></>}
              </dl></details>}
              {item.source === "saved" && <div className="library-artifact-actions">
                {item.archived && <p>Archived</p>}
                <div className="button-row"><button className="button small" disabled={locked || !connected} onClick={() => beginOrganize()}>Manage artifact</button>
                  <button className="button quiet small" disabled={locked || !connected} onClick={() => beginOrganize(!item.archived)}>{item.archived ? "Restore artifact" : "Archive artifact"}</button></div>
              </div>}
              <div className="library-preview-tabs" role="tablist" aria-label="Query preview tabs" onKeyDown={event => {
                if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
                if (!tabs.length) return;
                event.preventDefault();
                const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                tabs[next].focus(); tabs[next].click();
              }}>
                {([["docs", "Documentation"], ["dax", "DAX"], ...(embeddedEntryId ? [["analysis", "Copilot analysis"] as const] : []), ...(embeddedEntryId && item.source === "saved" && item.hasAnalysis ? [["journal", "Journal"] as const] : [])] as const).map(([value, label]) =>
                  <button key={value} id={`${namespace}-preview-${value}`} role="tab" tabIndex={previewTab === value ? 0 : -1} aria-label={label} aria-controls={`${namespace}-preview-panel`} aria-selected={previewTab === value} disabled={busy || refreshing || Boolean(journal) && value !== "journal"} onClick={() => setPreviewTab(value)}>{label}{value === "journal" ? ` (${item.notes?.length ?? 0})` : ""}</button>)}
              </div>
              <div id={`${namespace}-preview-panel`} className="library-preview-content" role="tabpanel" tabIndex={0} aria-label={previewTab === "docs" ? "Documentation" : previewTab === "dax" ? "DAX preview" : previewTab === "journal" ? "Research journal" : "Copilot analysis"}>
                {previewTab === "docs" ? <>
                  {item.source === "saved" && <div className="documentation-actions"><button className="button quiet small" disabled={locked || !connected || item.archived} onClick={beginDocumentation}><Icon name="edit" size={13}/>Edit documentation</button></div>}
                  <DocumentationReader text={item.documentation} kind="query"/>
                  {Boolean(item.knowledgeRefs?.length) && state.libraryIdentity && <ModelNotes identity={state.libraryIdentity} session={session} references={item.knowledgeRefs}/>}
                </> : previewTab === "dax" ? <pre tabIndex={0}>{item.query}</pre> : previewTab === "journal" && item.analysis && item.source === "saved" ? <article className="library-journal">
                  <h4>Research journal</h4><p className="library-analysis-caveat">Append-only observations, not validated run evidence. Earlier notes and original analysis cannot be edited here.</p>
                  {item.notes?.length ? <ol>{item.notes.map(note => <li key={note.id}>
                    <div className="library-journal-meta"><strong>{note.author === "copilot" ? "Copilot" : "Human"}</strong><time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleString()}</time></div>
                    {note.correctionOf && <p className="library-analysis-caveat">Correction to journal entry {note.correctionOf}. The original entry is preserved above.</p>}
                    <p className="library-journal-session">{note.session ? `${note.session.title} (${note.session.id})` : "Session: Unassigned"}</p>
                    <DocumentationReader text={note.content} kind="journal"/>
                  </li>)}</ol> : <p className="library-journal-empty">No journal notes yet. Append a follow-up without changing the original analysis.</p>}
                  <form className="library-journal-form" onSubmit={event => { event.preventDefault(); void appendNote(); }}>
                    <fieldset disabled={busy || refreshing || item.archived || (item.notes?.length ?? 0) >= 50}>
                      <WritingEditor label="Append a note" kind="journal" required rows={4} maxLength={4000} value={journal?.content ?? ""} onChange={content => editJournal({ content })} disabled={busy || refreshing || item.archived}/>
                      <details><summary>Attribute this note to a session (optional)</summary><SessionInputs value={journal ?? { sessionId: "", sessionTitle: "" }} onChange={editJournal}/><p>Blank means Unassigned, not the artifact’s session.</p></details>
                      <p className="library-analysis-caveat">Saved as Human. Notes stay private until you explicitly share this analysis with Copilot. {journal?.content.length ?? 0}/4000 characters · {item.notes?.length ?? 0}/50 notes.</p>
                      <div className="button-row"><button className="button primary small" disabled={!connected || !journal?.content.trim() || !validSession(journal)}>{busy ? "Appending..." : "Append note"}</button></div>
                    </fieldset>
                    {journal && <button type="button" className="button small library-journal-discard" disabled={busy || refreshing} onClick={() => setJournal(null)}>Discard note draft</button>}
                    {item.archived && <p className="library-analysis-caveat">Restore this artifact before appending a note. Existing journal history remains available.</p>}
                    {(item.notes?.length ?? 0) >= 50 && <p className="field-error">This artifact has reached the 50-note limit. Your draft is retained.</p>}
                  </form>
                </article> : item.analysis
                  ? <AnalysisPreview analysis={item.analysis} revised={item.analysisRevised} stale={item.analysisStale === true} visuals={relatedVisuals}/>
                  : <div className="library-analysis-empty"><h4>No Copilot analysis saved</h4><p>Ask Copilot to save its question, findings, limitations, and available run evidence alongside a query. Opening this preview does not generate notes or run DAX.</p></div>}
              </div>
              {item.analysis && item.source === "saved" && (previewTab === "analysis" || previewTab === "journal" || state.sharedAnalysisId === item.id) && <div className="library-analysis-sharing">
                {state.sharedAnalysisId === item.id
                  ? <><p role="status"><strong>Shared with Copilot</strong> · Analysis, bounded recent journal notes, session labels, and safe evidence only.</p><button className="button small" disabled={sharing || !connected} onClick={() => void changeAnalysisSharing(false)}>Stop sharing</button></>
                  : <><button className="button small" disabled={!connected || locked || state.authoringBusy || item.modelScope !== "current"} onClick={() => void changeAnalysisSharing(true)}>Share analysis with Copilot</button><p>Shares this analysis, bounded recent journal notes, session labels, and safe evidence, not saved parameter bindings or result rows. Clears on reload, query-tab or model changes, a saved-entry edit, or a query revision change.</p>{item.modelScope !== "current" && <p>Switch to this query’s model before sharing.</p>}</>}
                {(item.notes?.length ?? 0) > 10 && <p>Up to 10 latest notes, within the sharing size limit. Full history stays here.</p>}
              </div>}
              <div className="library-open-actions"><button className="button primary" disabled={locked || !connected} onClick={() => void openItem()}>{busy ? "Working..." : "Open in new tab"}</button>
                {!embeddedEntryId && item.hasAnalysis && onArtifacts && <button className="button" disabled={locked} onClick={() => onArtifacts(item.id)}><Icon name="folder" size={14}/>Read research in Artifacts</button>}
                <p>{item.source === "starter" ? item.hasBuilder
                  ? "Opens the editor and builder together. Auto Update starts off. "
                  : "Editor-only starter; its DAX has no matching builder selections. " : ""}
                  Opening never runs a query or replaces your current draft.</p></div>
            </> : <div className="library-empty"><Icon name="book" size={28}/><h3>{previewing ? "Loading preview..." : "Select a query"}</h3><p>Read its description, documentation, and DAX before opening.</p></div>}
          </div>
        </>}
      </>}
    </div>}
  </section>;
}

function SessionInputs({ value, onChange }: { value: SessionFields; onChange: (patch: Partial<SessionFields>) => void }) {
  return <div className="library-session-fields">
    <label className="field-label">Session ID<input maxLength={128} value={value.sessionId} onChange={event => onChange({ sessionId: event.target.value })} placeholder="Unassigned"/></label>
    <label className="field-label">Session title<input maxLength={120} value={value.sessionTitle} onChange={event => onChange({ sessionTitle: event.target.value })} placeholder="Unassigned"/></label>
    {!validSession(value) && <p className="field-error">Enter both a printable session ID and title, or leave both blank for Unassigned.</p>}
  </div>;
}

function AnalysisPreview({ analysis, stale, revised, visuals }: { analysis: CopilotAnalysis; stale: boolean; revised?: boolean; visuals?: ReactNode }) {
  return <article className="library-analysis">
    {stale && <p className="library-analysis-stale" role="status"><strong>Analysis out of date.</strong> The saved query, parameters, or connection changed after these notes were captured. Review the analysis before using it.</p>}
    <div className="library-analysis-meta"><span>{revised ? "Originally recorded by Copilot; wording subsequently revised" : "Written by Copilot"}</span><time dateTime={analysis.createdAt}>{new Date(analysis.createdAt).toLocaleString()}</time></div>
    {revised && <p className="library-analysis-caveat">Earlier text is available in Review content &amp; history. Rewriting does not add or recertify execution evidence.</p>}
    <section><h4>Question</h4><MarkdownPreview text={analysis.question} readableParagraphs/></section>
    <section><h4>Analysis</h4><DocumentationReader text={analysis.content} kind="research"/></section>
    {visuals}
    <section><h4>Limitations</h4><MarkdownPreview text={analysis.limitations || "No limitations recorded. This does not establish completeness or correctness."} readableParagraphs/></section>
    <section className="library-analysis-evidence"><h4>Run evidence</h4><p className="library-analysis-execution">{analysisExecutionLabel(analysis, stale)}</p>
      {analysis.evidence.length > 0 && <ul>{analysis.evidence.slice(0, 20).map(run => <li key={run.runId}>
        <strong>{run.status}</strong><span>Revision {run.revision}</span><span>{run.rowCount.toLocaleString()} rows</span><span>{run.durationMs.toLocaleString()} ms</span><span>{run.truncated ? "Truncated" : "Not truncated"}</span>
        <span>{run.querySource === "builder" ? "Builder query" : "Editor query"}</span>
        <span>{run.connectionKind === "synthetic" ? "Synthetic / test double — not live validation" : run.connectionKind}</span>
      </li>)}</ul>}
      <p className="library-analysis-caveat">Execution evidence describes recorded runs only. A completed run does not establish semantic or business correctness. No result rows are included.</p>
    </section>
  </article>;
}
