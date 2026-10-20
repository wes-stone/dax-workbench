import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BuilderDefinition, BuilderField, BuilderFilter, ModelHierarchy, ModelItem, ModelObject, QueryDocument, Snapshot } from "../contracts/workbench";
import type { Action } from "./useWorkbench";
import { api, ApiError, errorMessage } from "./api";
import { Icon } from "./icons";
import { DaxEditor } from "./Editor";
import { BuilderProposalReview } from "./BuilderProposalReview";
import { BuilderFieldPicker } from "./BuilderFieldPicker";
import { BuilderFilterControls } from "./BuilderFilterControls";
import { FilterControlPane, type FilterControlStart } from "./FilterControlPane";
import { ModelObjectMenu, type ModelMenuAnchor } from "./ModelObjectMenu";
import { BUILDER_DRAG_TYPE, FIELD_DRAG_TYPE, EMPTY_BUILDER, addBuilderItems, applyStagedFilters, fieldLabel, moveItem, newFilter, removeField, replaceCalendarRange } from "./builder-model";

export interface BuilderCommands {
  save: () => Promise<void>;
  prepareNavigation: () => Promise<void>;
  prepareAuthoring: () => Promise<void>;
  setAuthoringPaused: (paused: boolean) => void;
  addField: (object: ModelItem) => void;
  addFilter: (object: ModelItem) => void;
  run: () => void;
  editorChanged: () => void;
}
interface Generated { query: string }
interface MeasureEdit { originalId?: string; name: string; table: string; expression: string; dataType: string }

export function QueryBuilder({ document, objects, hierarchies, action, latest, commands, beforeApply, editorSelection, onEditor, onParameters, onCopilot, onPreview, onInspect, previewDisabled, hidden, running, schemaMessage, refreshDisabled, onRefresh }: {
  document: QueryDocument; objects: ModelObject[]; action: Action; latest: React.RefObject<Snapshot | null>;
  hierarchies?: ModelHierarchy[];
  commands: React.RefObject<BuilderCommands | null>; beforeApply: () => Promise<void>; onEditor: () => void; hidden: boolean; running: boolean;
  editorSelection: () => { start: number; end: number } | undefined;
  onParameters: () => void;
  onCopilot: () => void;
  onPreview: (object: ModelObject) => void; onInspect: (object: ModelObject) => void; previewDisabled: boolean;
  schemaMessage?: string; refreshDisabled: boolean; onRefresh: () => void;
}) {
  const [definition, setDefinition] = useState<BuilderDefinition>(() => structuredClone(document.builder ?? EMPTY_BUILDER));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [authoringPaused, setAuthoringPaused] = useState(false);
  const authoringPausedRef = useRef(false);
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [autoUpdate, setAutoUpdate] = useState(document.builderAutoUpdate ?? false);
  const [confirmAutoUpdate, setConfirmAutoUpdate] = useState(false);
  const [confirmCrossjoin, setConfirmCrossjoin] = useState(false);
  const [showQuery, setShowQuery] = useState(false);
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [selected, setSelected] = useState("");
  const [fieldMenu, setFieldMenu] = useState<ModelMenuAnchor | null>(null);
  const closeFieldMenu = useCallback(() => setFieldMenu(null), []);
  const [pane, setPane] = useState<"filters" | "order">("filters");
  const [picker, setPicker] = useState<"field" | null>(null);
  const [filterControls, setFilterControls] = useState<FilterControlStart | null>(null);
  const [measureEdit, setMeasureEdit] = useState<MeasureEdit | null>(null);
  const [measureInsert, setMeasureInsert] = useState<{ text: string; sequence: number }>();
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState(document.title);
  const [openPath, setOpenPath] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [reviewedProposalId, setReviewedProposalId] = useState<string | null>(null);
  const reviewingProposal = Boolean(document.builderProposal && document.builderProposal.id === reviewedProposalId);
  const draft = useRef({ definition, revision: document.builderRevision ?? 0, dirty: false });
  const inFlight = useRef<Promise<void> | null>(null);
  const operation = useRef(false);
  const automaticOperation = useRef(false);
  const pendingApply = useRef<Promise<void> | null>(null);
  const generation = useRef(0);
  const builderRoot = useRef<HTMLElement>(null);
  const autoUpdateRef = useRef(autoUpdate);
  const lastAutoDefinition = useRef(JSON.stringify(definition));
  const sortMemory = useRef(new Map<string, "ASC" | "DESC">());
  const [bulkDescending, setBulkDescending] = useState(true);
  const [fieldSplit, setFieldSplit] = useState(48);
  const fieldPreviewDisabled = previewDisabled || busy || syncing || authoringPaused;
  useEffect(() => { setFieldMenu(null); }, [definition, hidden, measureEdit, picker, filterControls, reviewingProposal, document.builderImport]);
  useEffect(() => {
    if (fieldMenu && !objects.some(object => object.id === fieldMenu.object.id && object.kind === fieldMenu.object.kind
      && object.table === fieldMenu.object.table && object.name === fieldMenu.object.name && object.source === fieldMenu.object.source)) setFieldMenu(null);
  }, [objects, fieldMenu]);
  function nativeField(field: BuilderField) {
    return !field.isCustom ? objects.find(object => object.id === field.id && object.kind === field.kind
      && object.name === field.name && object.table === field.table) : undefined;
  }
  function showFieldMenu(field: BuilderField, target: HTMLElement, x?: number, y?: number) {
    setSelected(field.id);
    const object = nativeField(field);
    if (!object) {
      if (field.isCustom) setNotice("Data previews are available for native columns. Use Edit measure for this query measure.");
      else setError("This field is not available in the current model schema. Refresh schema before previewing it.");
      return;
    }
    setFieldMenu({ object, target, x, y });
  }
  function openPicker(target: "field" | "filter") {
    if (target === "filter") setFilterControls({});
    else setPicker(target);
    setError("");
  }
  function openFilter(start: FilterControlStart) {
    setPane("filters"); setFilterControls(start); setError("");
  }
  const connection = latest.current?.connections.find(item => item.id === document.connectionId);
  const parametersSupported = !["windows-msolap", "powerbi-rest"].includes(connection?.kind ?? "") && (connection?.capabilities?.parameters?.status === "supported" || connection?.kind === "msolap" && connection.capabilities?.parameters?.status !== "unsupported");
  const parameterHelp = parametersSupported ? "Use a native @Name parameter; set its value in Parameters." : "Native parameter binding requires ADOMD. This transport supports literal builder filters only.";

  const edit = useCallback((next: BuilderDefinition) => {
    if (authoringPausedRef.current) { setError("Wait for the current draft to finish saving before changing fields."); return false; }
    if (latest.current?.documents.find(item => item.id === document.id)?.builderImport) { setError("Restore or discard the imported selections before editing this builder."); return false; }
    if (operation.current && !automaticOperation.current) { setError("Wait for the current builder action to finish before changing fields."); return false; }
    draft.current.definition = next; draft.current.dirty = true;
    setDefinition(next); setDirty(true); setError(""); setSaveError(""); setNotice(""); setPreview(""); setPreviewError("");
    generation.current++;
    return true;
  }, [latest, document.id]);
  useEffect(() => {
    if ((document.builderRevision ?? 0) === draft.current.revision) return;
    if (!draft.current.dirty && !inFlight.current) {
      const next = structuredClone(document.builder ?? EMPTY_BUILDER);
      draft.current = { definition: next, revision: document.builderRevision ?? 0, dirty: false };
      autoUpdateRef.current = document.builderAutoUpdate ?? false;
      setAutoUpdate(autoUpdateRef.current);
      lastAutoDefinition.current = JSON.stringify(next);
      setPreview(""); setPreviewError(""); generation.current++;
      setDefinition(next);
    }
  }, [document.builderRevision]);

  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) { await inFlight.current; if (draft.current.dirty) return save(); return; }
    if (!draft.current.dirty) return;
    const captured = structuredClone(draft.current.definition);
    const capturedAutoUpdate = autoUpdateRef.current;
    setSaving(true); setSaveError("");
    const promise = (async () => {
      const result = await action<{ builderRevision: number }>("builder.update", {
        documentId: document.id, connectionId: document.connectionId, builderRevision: draft.current.revision, definition: captured,
        autoUpdate: capturedAutoUpdate,
      });
      draft.current.revision = result.builderRevision;
      if (JSON.stringify(captured) === JSON.stringify(draft.current.definition) && capturedAutoUpdate === autoUpdateRef.current) { draft.current.dirty = false; setDirty(false); }
    })();
    inFlight.current = promise;
    try { await promise; }
    catch (reason) { setSaveError(errorMessage(reason)); throw reason; }
    finally { inFlight.current = null; setSaving(false); }
    if (draft.current.dirty) await save();
  }, [action, document.id, document.connectionId]);
  useEffect(() => {
    if (!dirty || saveError) return;
    const timer = setTimeout(() => { void save().catch(() => {}); }, 550);
    return () => clearTimeout(timer);
  }, [definition, dirty, autoUpdate, saveError, save]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (draft.current.dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const generate = useCallback(async () => {
    const ticket = ++generation.current;
    if (!draft.current.definition.fields.length) { setPreview(""); setPreviewError(""); setGenerating(false); return; }
    setGenerating(true);
    try {
      const result = await api.action<Generated>("builder.preview", { documentId: document.id, connectionId: document.connectionId, definition: draft.current.definition });
      if (ticket === generation.current) { setPreview(result.query); setPreviewError(""); }
    } catch (reason) {
      if (ticket === generation.current) { setPreview(""); setPreviewError(errorMessage(reason)); }
    } finally { if (ticket === generation.current) setGenerating(false); }
  }, [document.id, document.connectionId]);
  useEffect(() => {
    if (!autoGenerate || hidden) return;
    const timer = setTimeout(() => { void generate(); }, 300);
    return () => { clearTimeout(timer); generation.current++; };
  }, [definition, autoGenerate, hidden, generate]);

  const add = useCallback((object: ModelItem | ModelItem[], target: "field" | "filter", index?: number) => {
    try {
      const items = Array.isArray(object) ? object : [object];
      const current = draft.current.definition;
      const next = addBuilderItems(current, items, objects, target, index);
      if (!edit(next)) return false;
      if (target === "field") {
        const first = next.fields.find(field => !current.fields.some(item => item.id === field.id));
        if (first) setSelected(first.id);
        else if (items[0]) { setSelected(items[0].id); setNotice(`${items[0].name} is already included.`); }
      }
      return true;
    } catch (reason) { setError(errorMessage(reason)); return false; }
  }, [edit, objects]);

  const apply = useCallback(async (run: boolean, automatic: false | "background" | "navigation" = false, crossjoinConfirmed = false) => {
    if (automatic && ((authoringPausedRef.current && automatic !== "navigation") || operation.current)) { lastAutoDefinition.current = ""; return; }
    if (reviewingProposal) { setError("Close the proposal review before running or updating the current builder."); return; }
    if (operation.current) return;
    operation.current = true; automaticOperation.current = Boolean(automatic);
    if (automatic) setSyncing(true); else setBusy(true);
    setError(""); setNotice("");
    const captured = structuredClone(draft.current.definition), signature = JSON.stringify(captured);
    const pending = (async () => {
      try {
        await beforeApply(); await save();
        if (automatic && ((authoringPausedRef.current && automatic !== "navigation") || signature !== JSON.stringify(draft.current.definition))) {
          lastAutoDefinition.current = ""; return;
        }
        if (automatic && !autoUpdateRef.current) return;
        const current = latest.current?.documents.find(item => item.id === document.id);
        if (!current) throw new Error("This document is no longer open.");
        if (run && !crossjoinConfirmed && new Set(captured.fields.filter(field => field.kind === "column").map(field => field.table)).size > 1 && !captured.fields.some(field => field.kind === "measure")) { setConfirmCrossjoin(true); return; }
        await action(run ? "builder.run" : "builder.apply", {
          documentId: document.id, connectionId: document.connectionId, revision: current.revision,
          builderRevision: draft.current.revision, definition: captured,
          selection: editorSelection(), confirmCrossjoin: crossjoinConfirmed,
        });
        if (automatic && signature === JSON.stringify(draft.current.definition)) lastAutoDefinition.current = signature;
        if (!run && !automatic) { setNotice("Generated block updated; surrounding editor text was preserved. Nothing was executed."); onEditor(); }
      } catch (reason) {
        setError(errorMessage(reason));
        if (automatic) {
          if (reason instanceof ApiError && reason.code === "REVISION_CONFLICT" && signature !== JSON.stringify(draft.current.definition))
            lastAutoDefinition.current = "";
          else { autoUpdateRef.current = false; setAutoUpdate(false); draft.current.dirty = true; setDirty(true); }
        }
      } finally {
        operation.current = false; automaticOperation.current = false;
        if (automatic) setSyncing(false); else setBusy(false);
      }
    })();
    pendingApply.current = pending;
    await pending;
    if (pendingApply.current === pending) pendingApply.current = null;
  }, [action, beforeApply, document.id, document.connectionId, latest, onEditor, save, editorSelection, reviewingProposal]);
  useEffect(() => {
    const signature = JSON.stringify(definition);
    if (authoringPaused || !autoUpdate || !preview || previewError || signature === lastAutoDefinition.current) return;
    lastAutoDefinition.current = signature;
    void apply(false, "background");
  }, [authoringPaused, busy, syncing, autoUpdate, definition, preview, previewError, apply]);
  useLayoutEffect(() => {
    const prepareNavigation = async () => {
      if (picker) throw new Error("Add or cancel the field selection before switching query tabs. Your choices are still here.");
      if (filterControls) throw new Error("Apply or cancel filter controls before switching query tabs. Your choices are still here.");
      if (measureEdit) throw new Error("Save or cancel the measure edit before switching query tabs. Your draft is still here.");
      if (confirmAutoUpdate || confirmCrossjoin || confirmClear || reviewingProposal)
        throw new Error("Finish the current builder confirmation or proposal review before switching query tabs.");
      if (operation.current && !automaticOperation.current)
        throw new Error("Wait for the current builder action to finish before switching query tabs.");
      await pendingApply.current;
      await save();
      if (autoUpdateRef.current && draft.current.definition.fields.length && JSON.stringify(draft.current.definition) !== lastAutoDefinition.current) {
        await apply(false, "navigation");
        await save();
      }
    };
    const value: BuilderCommands = {
      setAuthoringPaused: paused => { authoringPausedRef.current = paused; setAuthoringPaused(paused); },
      save, prepareNavigation, addField: object => add(object, "field"), addFilter: object => add(object, "filter"), run: () => { void apply(true); },
      prepareAuthoring: async () => {
        if (operation.current || picker || filterControls || measureEdit || confirmAutoUpdate || confirmCrossjoin || confirmClear || reviewingProposal)
          throw new Error("Finish the current builder edit or review before Copilot authors this canvas.");
        await save();
      },
      editorChanged: () => {
        if (autoUpdateRef.current) {
          autoUpdateRef.current = false; setAutoUpdate(false);
          setNotice("Auto Update paused because you edited the DAX. Your manual changes are preserved.");
          draft.current.dirty = true; setDirty(true);
        }
      },
    };
    commands.current = value;
    return () => { if (commands.current === value) commands.current = null; };
  }, [commands, save, add, apply, picker, filterControls, measureEdit, confirmAutoUpdate, confirmCrossjoin, confirmClear, reviewingProposal]);

  function drop(event: React.DragEvent, target: "field" | "filter" | "order", index?: number) {
    event.preventDefault();
    const objectId = event.dataTransfer.getData(FIELD_DRAG_TYPE);
    if (objectId) {
      const object = objects.find(item => item.id === objectId) ?? hierarchies?.find(item => item.id === objectId);
      if (object && target !== "order") add(object, target, index);
      return;
    }
    const itemId = event.dataTransfer.getData(BUILDER_DRAG_TYPE);
    const current = draft.current.definition;
    const filterIndex = current.filters.findIndex(filter => `filter:${filter.id}` === itemId);
    if (target === "filter" && filterIndex >= 0) {
      edit({ ...current, filters: moveItem(current.filters, filterIndex, index ?? current.filters.length - 1) }); return;
    }
    const field = current.fields.find(item => item.id === itemId);
    if (target === "filter" && field) {
      if (current.filters.some(item => item.field.id === field.id)) { setNotice(`${field.name} already has a filter.`); return; }
      edit({ ...current, filters: [...current.filters, newFilter(field)] }); return;
    }
    if (target === "field" && field) {
      edit({ ...current, fields: moveItem(current.fields, current.fields.indexOf(field), index ?? current.fields.length - 1) }); return;
    }
    if (target === "order" && field) {
      const from = current.orderBy.findIndex(item => item.fieldId === field.id);
      if (from >= 0) edit({ ...current, orderBy: moveItem(current.orderBy, from, index ?? current.orderBy.length - 1) });
      else edit({ ...current, orderBy: [...current.orderBy, { fieldId: field.id, direction: "ASC" }] });
    }
  }
  function drag(event: React.DragEvent, id: string) { event.dataTransfer.setData(BUILDER_DRAG_TYPE, id); event.dataTransfer.effectAllowed = "copyMove"; }
  function cycleSort(field: BuilderField) {
    const current = definition.orderBy.find(item => item.fieldId === field.id);
    const orderBy = !current ? [...definition.orderBy, { fieldId: field.id, direction: "ASC" as const }]
      : current.direction === "ASC" ? definition.orderBy.map(item => item.fieldId === field.id ? { ...item, direction: "DESC" as const } : item)
        : definition.orderBy.filter(item => item.fieldId !== field.id);
    if (current) sortMemory.current.set(field.id, current.direction);
    edit({ ...definition, orderBy });
  }
  function toggleSort(field: BuilderField) {
    const current = definition.orderBy.find(item => item.fieldId === field.id);
    if (current) sortMemory.current.set(field.id, current.direction);
    edit({ ...definition, orderBy: current ? definition.orderBy.filter(item => item.fieldId !== field.id)
      : [...definition.orderBy, { fieldId: field.id, direction: sortMemory.current.get(field.id) ?? "ASC" }] });
  }
  function updateFilter(filter: BuilderFilter, update: Partial<BuilderFilter>) {
    const current = draft.current.definition;
    edit({ ...current, filters: current.filters.map(item => item.id === filter.id ? { ...item, ...update } : item) });
  }
  function moveField(id: string, offset: number) {
    const current = draft.current.definition, index = current.fields.findIndex(item => item.id === id);
    edit({ ...current, fields: moveItem(current.fields, index, index + offset) });
  }
  function editMeasure(field?: BuilderField) {
    const native = field && objects.find(item => item.id === field.id);
    setMeasureEdit({
      originalId: field?.id, name: field?.name ?? "", table: field?.table ?? "",
      expression: field?.expression ?? native?.expression ?? "", dataType: field?.dataType ?? "Decimal",
    });
    setError("");
  }
  function duplicateMeasure(field: BuilderField) {
    const native = objects.find(item => item.id === field.id);
    setMeasureEdit({ name: `${field.name} - Copy`, table: field.table ?? "", expression: field.expression ?? native?.expression ?? "", dataType: field.dataType ?? "Decimal" });
    setError("");
  }
  async function resetBuilder() {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try {
      await beforeApply(); await save();
      const current = latest.current?.documents.find(item => item.id === document.id);
      if (!current) throw new Error("This document is no longer open.");
      const result = await action<{ builderRevision: number }>("builder.reset", { documentId: document.id, connectionId: document.connectionId, revision: current.revision, builderRevision: draft.current.revision, removeGenerated: autoUpdateRef.current });
      draft.current = { definition: structuredClone(EMPTY_BUILDER), revision: result.builderRevision, dirty: false };
      setDefinition(draft.current.definition); setDirty(false); setPreview(""); setPreviewError(""); setConfirmClear(false);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { operation.current = false; setBusy(false); }
  }
  async function saveMeasure() {
    if (!measureEdit) return;
    const value = measureEdit;
    if (!value.name.trim() || !value.table || !value.expression.trim()) { setError("A measure needs a name, home table, and DAX expression."); return; }
    const existing = definition.fields.find(field => field.id === value.originalId);
    const field: BuilderField = {
      id: existing?.id ?? `custom:${crypto.randomUUID()}`, name: value.name.trim(), table: value.table,
      kind: "measure", dataType: value.dataType, expression: value.expression, isCustom: existing?.isCustom ?? !existing,
      caption: existing?.caption,
    };
    const next = {
      ...definition,
      fields: existing ? definition.fields.map(item => item.id === existing.id ? field : item) : [...definition.fields, field],
      filters: definition.filters.map(item => item.field.id === existing?.id ? { ...item, field } : item),
    };
    try {
      await api.action("builder.preview", { documentId: document.id, connectionId: document.connectionId, definition: next });
      edit(next); setSelected(field.id); setMeasureEdit(null);
    } catch (reason) { setError(errorMessage(reason)); }
  }
  const chosenIndex = definition.fields.findIndex(field => field.id === selected);
  const proposal = document.builderProposal;
  const proposalStale = Boolean(proposal && (proposal.connectionId !== document.connectionId
    || proposal.baseRevision !== document.revision || proposal.baseBuilderRevision !== (document.builderRevision ?? 0)
    || dirty || saving || measureEdit));
  async function resolveProposal(accept: boolean) {
    if (!proposal || operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try {
      if (accept) { await beforeApply(); await save(); }
      const result = await action<{ definition: BuilderDefinition; builderRevision: number }>(accept ? "builder.proposal.accept" : "builder.proposal.reject", { documentId: document.id, proposalId: proposal.id });
      if (accept) {
        draft.current = { definition: result.definition, revision: result.builderRevision, dirty: false };
        autoUpdateRef.current = false; setAutoUpdate(false);
        lastAutoDefinition.current = JSON.stringify(result.definition);
        setDefinition(result.definition); setDirty(false); setPreview(""); setPreviewError(""); generation.current++;
        setNotice("Copilot selections accepted. Choose Update query to change the editor, or Run builder to execute only these selections. Your editor was not changed.");
      }
      setReviewedProposalId(null);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { operation.current = false; setBusy(false); }
  }

  if (proposal && reviewingProposal && !document.builderImport) return <section className="builder-workspace" hidden={hidden} aria-label="Visual query builder" ref={builderRoot}>
    <BuilderProposalReview current={definition} proposal={proposal} stale={proposalStale} busy={busy} error={error || saveError}
      onBack={() => setReviewedProposalId(null)} onAccept={() => void resolveProposal(true)} onReject={() => void resolveProposal(false)}/>
  </section>;

  if (document.builderImport) return <section className="builder-workspace" hidden={hidden} aria-label="Visual query builder" ref={builderRoot}>
    <div className="builder-commandbar"><h2>Restore Studio selections</h2><button className="button quiet" onClick={onEditor}>View preserved DAX</button></div>
    <div className="builder-import">
      <p role="status">{document.builderWarning}</p>
      <p>Choose the intended model above. Restoration reads model metadata only; it does not execute your DAX or enable Auto Update.</p>
      <ul aria-label="Imported selections">{document.builderImport.fields.map(field => <li key={field.id}>{field.table ? `${field.table} · ` : ""}{field.name}{field.kind === "hierarchy" ? " (hierarchy)" : ""}</li>)}</ul>
      {(error || saveError) && <p className="warning-text" role="alert">{error || saveError}</p>}
      <div className="button-row"><button className="button primary" disabled={busy || !connection} onClick={() => {
        operation.current = true; setBusy(true); setError("");
        void action("builder.import.resolve", { documentId: document.id, connectionId: document.connectionId, builderRevision: draft.current.revision })
          .catch(reason => setError(errorMessage(reason))).finally(() => { operation.current = false; setBusy(false); });
      }}>{busy ? "Reading model..." : "Retry model binding"}</button><button className="button" disabled={busy} onClick={() => setConfirmClear(true)}>Discard imported selections</button></div>
      {confirmClear && <div role="alert"><p>Discard these saved selections and start an empty builder? The paired DAX will remain unchanged.</p><div className="button-row"><button className="button" disabled={busy} onClick={() => void resetBuilder()}>Discard selections</button><button className="button quiet" disabled={busy} onClick={() => setConfirmClear(false)}>Cancel</button></div></div>}
    </div>
  </section>;

  return <section className="builder-workspace" hidden={hidden} aria-label="Visual query builder" ref={builderRoot} onKeyDown={event => {
    if (measureEdit && (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key === "Enter"))) { event.preventDefault(); event.stopPropagation(); }
  }}>
    <div className="builder-commandbar">
      <div className="toolbar-group">
        <button className="button primary" disabled={busy || syncing || !definition.fields.length} onClick={() => void apply(false)} title="Update the generated block, or insert it at the editor selection; surrounding DAX is preserved">Update query</button>
        <button className="button" disabled={busy || syncing || running || !definition.fields.length} onClick={() => void apply(true)} title="Generate and run only the builder selections, not the surrounding editor text"><Icon name="play" size={14}/>Run builder</button>
      </div>
      <div className="toolbar-group builder-tools">
        <button className={`button quiet ${showQuery ? "is-active" : ""}`} aria-pressed={showQuery} onClick={() => { setShowQuery(!showQuery); if (!preview) void generate(); }}><Icon name="code" size={14}/>Show query</button>
        <button className="button quiet" onClick={onParameters} title={parameterHelp}>Parameters</button>
        <button className="button quiet" disabled={busy} onClick={() => void save().then(onCopilot).catch(reason => setError(errorMessage(reason)))}><Icon name="lens" size={14}/>Ask Copilot</button>
      </div>
      <div className="toolbar-group builder-generation">
        <label className="check-field"><input type="checkbox" checked={autoUpdate} onChange={event => {
          if (event.target.checked) setConfirmAutoUpdate(true);
          else { autoUpdateRef.current = false; setAutoUpdate(false); draft.current.dirty = true; setDirty(true); }
        }}/>Auto Update</label>
        <span className="muted" role="status">{saving ? "Saving selections..." : dirty ? "Unsaved selections" : syncing ? "Updating query..." : autoUpdate ? "Editor linked" : "DAX updates manually"}</span>
      </div>
      {confirmAutoUpdate && <div className="builder-notice warning-text" role="alert"><p>Auto Update replaces the generated editor block when selections change. Text outside that block stays intact; manual editor edits turn Auto Update off. Queries will not run automatically.</p><div className="button-row"><button className="button small" onClick={() => {
        lastAutoDefinition.current = ""; autoUpdateRef.current = true; setAutoUpdate(true); setConfirmAutoUpdate(false); draft.current.dirty = true; setDirty(true);
      }}>Enable Auto Update</button><button className="button small" onClick={() => setConfirmAutoUpdate(false)}>Cancel</button></div></div>}
      {confirmCrossjoin && <div className="builder-notice warning-text" role="alert"><p>Columns from multiple tables without a measure can create a large crossjoin. Transfer caps do not limit all server computation.</p><div className="button-row"><button className="button small" onClick={() => { setConfirmCrossjoin(false); void apply(true, false, true); }}>Run crossjoin</button><button className="button small" onClick={() => setConfirmCrossjoin(false)}>Cancel</button></div></div>}
    </div>
    {(error || saveError) && <div className="inline-alert error" role="alert"><Icon name="warning" size={14}/><span>{error || saveError}</span>{saveError && <button className="text-button" onClick={() => {
      const current = latest.current?.documents.find(item => item.id === document.id);
      if (current) { draft.current.revision = current.builderRevision ?? 0; setSaveError(""); }
    }}>Keep local builder on latest revision</button>}</div>}
    {document.builderWarning && <details className="builder-compatibility"><summary>DAX Studio compatibility notes</summary><p>{document.builderWarning}</p></details>}
    {proposal && <div className="proposal-bar"><Icon name="lens"/><span><strong>Copilot proposed builder changes</strong>{proposalStale ? " · local selections or revisions changed" : ""}</span><button className="button small" onClick={() => setReviewedProposalId(proposal.id)}>Review builder proposal</button></div>}
    {notice && <div className="builder-notice" role="status">{notice}</div>}
    <div className="builder-body">
      {measureEdit ? <div className="builder-measure-editor">
        <div className="panel-section-heading"><h2>{measureEdit.originalId ? "Edit query measure" : "New query measure"}</h2><button className="icon-button" aria-label="Cancel measure editing" onClick={() => setMeasureEdit(null)}><Icon name="close"/></button></div>
        <p className="muted">Query-scoped only. New measures and overrides never change the semantic model.</p>
        <div className="builder-measure-properties">
          <label className="field-label">Measure name<input value={measureEdit.name} readOnly={Boolean(measureEdit.originalId && !definition.fields.find(field => field.id === measureEdit.originalId)?.isCustom)} maxLength={200} onChange={event => setMeasureEdit({ ...measureEdit, name: event.target.value })}/></label>
          <label className="field-label">Home table<select value={measureEdit.table} disabled={Boolean(measureEdit.originalId && !definition.fields.find(field => field.id === measureEdit.originalId)?.isCustom && definition.fields.find(field => field.id === measureEdit.originalId)?.table)} onChange={event => setMeasureEdit({ ...measureEdit, table: event.target.value })}><option value="">Choose a table</option>{objects.filter(item => item.kind === "table").map(table => <option key={table.id} value={table.name}>{table.name}</option>)}</select></label>
          <label className="field-label">Filter value type<select value={measureEdit.dataType} onChange={event => setMeasureEdit({ ...measureEdit, dataType: event.target.value })}>{[...new Set([measureEdit.dataType, "Decimal", "Int64", "Double", "String", "DateTime", "Boolean"])].map(type => <option key={type}>{type}</option>)}</select></label>
        </div>
        {!measureEdit.expression && measureEdit.originalId && <p className="warning-text">The model's expression may be unavailable to this identity. Enter an override explicitly; a blank expression does not mean the model measure is empty.</p>}
        <div className="builder-expression" onDragOver={event => event.preventDefault()} onDrop={event => {
          event.preventDefault();
          const object = objects.find(item => item.id === event.dataTransfer.getData(FIELD_DRAG_TYPE));
          if (object && object.kind !== "relationship") {
            const table = `'${(object.table ?? object.name).replaceAll("'", "''")}'`, name = `[${object.name.replaceAll("]", "]]")}]`;
            setMeasureInsert({ text: object.kind === "table" ? table : object.kind === "measure" ? name : `${table}${name}`, sequence: Date.now() });
          }
        }}><DaxEditor ariaLabel="DAX measure expression" value={measureEdit.expression} onChange={expression => setMeasureEdit(current => current ? { ...current, expression } : current)} objects={objects} onRun={() => {}} onSave={() => void saveMeasure()} insert={measureInsert} onInserted={() => setMeasureInsert(undefined)}/></div>
        <div className="button-row"><button className="button primary" onClick={() => void saveMeasure()}>Save measure</button><button className="button" onClick={() => setMeasureEdit(null)}>Cancel</button></div>
      </div> : <>
        <div className="builder-design" style={{ gridTemplateRows: `minmax(160px, ${fieldSplit}fr) 5px minmax(180px, ${100 - fieldSplit}fr)` }}>
          <section className="builder-fields-panel" aria-label="Columns and measures">
            <div className="panel-section-heading"><h2>Columns and measures <span className="count-badge">{definition.fields.length}</span></h2><div className="toolbar-group">
              <button className="icon-button" title="Move selected field up" aria-label="Move selected field up" disabled={chosenIndex <= 0 || busy} onClick={() => moveField(selected, -1)}><Icon name="up" size={14}/></button>
              <button className="icon-button" title="Move selected field down" aria-label="Move selected field down" disabled={chosenIndex < 0 || chosenIndex === definition.fields.length - 1 || busy} onClick={() => moveField(selected, 1)}><Icon name="down" size={14}/></button>
              <button className="button small quiet" aria-haspopup="dialog" disabled={busy || authoringPaused} onClick={() => openPicker("field")}><Icon name="plus" size={13}/>Add field</button>
            </div></div>
            <div className="builder-field-list" role="listbox" aria-label="Selected output fields" onDragOver={event => event.preventDefault()} onDrop={event => drop(event, "field")}>
              {!definition.fields.length && <div className="builder-drop-empty"><Icon name="table" size={24}/><strong>No output fields selected yet</strong><p>Use Add field to search and select columns and measures, or drag them from the model explorer.</p></div>}
              {definition.fields.map((field, index) => {
                const sort = definition.orderBy.find(item => item.fieldId === field.id), priority = definition.orderBy.findIndex(item => item.fieldId === field.id);
                const native = nativeField(field);
                return <div className={`builder-field-row ${selected === field.id ? "selected-field" : ""}`} data-field-id={field.id} data-field-name={field.name} key={field.id} draggable={!busy} onDragStart={event => drag(event, field.id)} onDragOver={event => event.preventDefault()} onDrop={event => { event.stopPropagation(); drop(event, "field", index); }}
                  onContextMenu={event => { event.preventDefault(); event.stopPropagation(); showFieldMenu(field, event.currentTarget, event.clientX, event.clientY); }}
                  role="option" aria-selected={selected === field.id} tabIndex={0} onFocus={() => setSelected(field.id)} onClick={() => setSelected(field.id)} onKeyDown={event => {
                    if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
                      event.preventDefault(); event.stopPropagation(); showFieldMenu(field, event.currentTarget); return;
                    }
                    if (event.target !== event.currentTarget) return;
                    if (event.key.toLowerCase() === "p" && !event.altKey && !event.ctrlKey && !event.metaKey && field.kind === "column") {
                      event.preventDefault(); event.stopPropagation();
                      if (native && !fieldPreviewDisabled) onPreview(native);
                      return;
                    }
                    if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); moveField(field.id, event.key === "ArrowUp" ? -1 : 1); }
                    if (event.key === "Delete") { event.preventDefault(); edit(removeField(definition, field.id)); }
                  }}>
                  <Icon name="grip" size={13}/><Icon name={field.kind} size={15}/>
                  <span className="builder-field-name" title={fieldLabel(field)}><strong>{field.caption || field.name}{field.expression && <span className="builder-override"> query measure</span>}</strong><small>{field.table ?? "Measure"}{field.dataType ? ` / ${field.dataType}` : ""}</small></span>
                  <span className="builder-field-actions"><input type="checkbox" aria-label={`Enable sort ${field.name}`} checked={Boolean(sort)} disabled={busy} onChange={() => toggleSort(field)} title="Enable or disable sorting; the previous direction is remembered"/>
                  <button className={`button small quiet builder-sort ${sort ? "is-active" : ""}`} disabled={busy} aria-label={`Sort ${field.name}: ${sort?.direction ?? "none"}`} title="Cycle ascending, descending, or no sort" onClick={() => cycleSort(field)}>{sort ? <><Icon name={sort.direction === "ASC" ? "up" : "down"} size={12}/>{priority + 1}</> : "Sort"}</button>
                  {field.kind === "column" && <button className="button small quiet builder-field-preview" disabled={fieldPreviewDisabled || !native}
                    aria-label={`Preview field ${field.name}`} title="Preview up to 100 distinct values without applying query filters (P)"
                    onClick={() => { if (native) onPreview(native); }}><Icon name="table" size={13}/>Preview field</button>}
                  {field.kind === "measure" && <><button className="icon-button" disabled={busy} aria-label={`Edit measure ${field.name}`} title="Edit query-scoped measure" onClick={() => editMeasure(field)}><Icon name="edit" size={13}/></button><button className="icon-button" disabled={busy} aria-label={`Duplicate measure ${field.name}`} title="Duplicate query measure" onClick={() => duplicateMeasure(field)}><Icon name="copy" size={13}/></button></>}
                  <button className="icon-button" disabled={busy || authoringPaused} aria-label={`Filter ${field.name}`} aria-haspopup="dialog" title="Configure filters for this field" onClick={() => openFilter({ field })}><Icon name="filter" size={13}/></button>
                  <button className="icon-button" disabled={busy} aria-label={`Remove field ${field.name}`} onClick={() => edit(removeField(definition, field.id))}><Icon name="close" size={13}/></button>
                  </span>
                </div>;
              })}
            </div>
            <div className="builder-panel-footer"><button className="text-button" disabled={busy} onClick={() => editMeasure()}><Icon name="plus" size={13}/> New measure</button><span className="muted">Drag to reorder / Alt + arrow keys</span></div>
          </section>
          <div className="builder-divider" role="separator" aria-label="Resize output fields and filters" aria-orientation="horizontal" aria-valuemin={25} aria-valuemax={75} aria-valuenow={fieldSplit} tabIndex={0}
            onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const bounds = event.currentTarget.parentElement!.getBoundingClientRect(); setFieldSplit(Math.max(25, Math.min(75, Math.round((event.clientY - bounds.top) / bounds.height * 100)))); } }}
            onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
            onKeyDown={event => { if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setFieldSplit(value => Math.max(25, Math.min(75, value + (event.key === "ArrowUp" ? -5 : 5)))); } }}/>
          <section className="builder-filters-panel" aria-label="Filters and sorting">
            <div className="panel-section-heading"><div className="builder-subtabs" role="tablist" aria-label="Builder options"><button role="tab" aria-selected={pane === "filters"} className={pane === "filters" ? "active-tab" : ""} onClick={() => setPane("filters")}>Filters <span className="count-badge">{definition.filters.length}</span></button><button role="tab" aria-selected={pane === "order"} className={pane === "order" ? "active-tab" : ""} onClick={() => setPane("order")}>Sort order <span className="count-badge">{definition.orderBy.length}</span></button></div>{pane === "filters" && <div className="toolbar-group">
              {!!definition.filters.length && <button className="button small quiet" aria-haspopup="dialog" disabled={busy || authoringPaused} onClick={() => openFilter({ id: definition.filters[0].id })}>Edit filters</button>}
              <button className="button small quiet" aria-haspopup="dialog" disabled={busy || authoringPaused} onClick={() => openPicker("filter")}><Icon name="plus" size={13}/>Add filter</button></div>}</div>
            {pane === "filters" ? <div className="builder-filter-list" onDragOver={event => event.preventDefault()} onDrop={event => drop(event, "filter")}>
              {!definition.filters.length && <div className="builder-drop-empty"><Icon name="filter" size={24}/><strong>Add fields to filter</strong><p>Use Add filter or drop fields here. Filter columns without adding them to the output; measure filters apply to the grouped result.</p></div>}
              {definition.filters.map((filter, index) => <div key={filter.id} className={`builder-filter ${filter.enabled ? "" : "disabled-filter"}`} draggable={!busy} onDragStart={event => drag(event, `filter:${filter.id}`)} onDragOver={event => event.preventDefault()} onDrop={event => { event.stopPropagation(); drop(event, "filter", index); }}>
                <div className="builder-filter-heading"><input type="checkbox" checked={filter.enabled} disabled={busy} aria-label={`Enable filter ${filter.field.name}`} onChange={event => updateFilter(filter, { enabled: event.target.checked })}/><Icon name={filter.field.kind} size={14}/><span title={fieldLabel(filter.field)}><strong>{filter.field.name}</strong><small>{filter.field.table}{filter.field.dataType ? ` / ${filter.field.dataType}` : ""}</small></span>
                  <button className="icon-button" disabled={busy || authoringPaused} aria-label={`Edit filter ${filter.field.name}`} aria-haspopup="dialog" title="Open full filter controls" onClick={() => openFilter({ id: filter.id })}><Icon name="edit" size={13}/></button>
                  <button className="icon-button" disabled={busy} aria-label={`Remove filter ${filter.field.name}`} onClick={() => edit({ ...definition, filters: definition.filters.filter(item => item.id !== filter.id) })}><Icon name="close" size={13}/></button></div>
                <BuilderFilterControls filter={filter} document={document} latest={latest} action={action} disabled={busy || authoringPaused}
                  parametersSupported={parametersSupported} parameterHelp={parameterHelp} prepare={async () => { await pendingApply.current; await beforeApply(); await save(); }}
                  onChange={update => updateFilter(filter, update)} onCalendar={range => {
                    const current = draft.current.definition;
                    if (edit({ ...current, filters: replaceCalendarRange(current.filters, range) }))
                      setNotice("Calendar range applied as two filters, including the full end day. The query was not run.");
                  }}/>
              </div>)}
            </div> : <>{definition.fields.some(field => field.kind === "column") && <div className="builder-bulk-sort">
              <button className="button small" onClick={() => {
                const columns = definition.fields.filter(field => field.kind === "column");
                const enabled = columns.every(field => definition.orderBy.some(item => item.fieldId === field.id));
                definition.orderBy.forEach(item => sortMemory.current.set(item.fieldId, item.direction));
                edit({ ...definition, orderBy: [...definition.orderBy.filter(item => !columns.some(field => field.id === item.fieldId)), ...(enabled ? [] : columns.map(field => ({ fieldId: field.id, direction: sortMemory.current.get(field.id) ?? "ASC" as const })))] });
              }}>{definition.fields.filter(field => field.kind === "column").every(field => definition.orderBy.some(item => item.fieldId === field.id)) ? "Disable column sorts" : "Enable column sorts"}</button>
              <button className="button small" onClick={() => {
                const columns = definition.fields.filter(field => field.kind === "column");
                edit({ ...definition, orderBy: [...definition.orderBy.filter(item => !columns.some(field => field.id === item.fieldId)), ...columns.map(field => ({ fieldId: field.id, direction: bulkDescending ? "DESC" as const : "ASC" as const }))] }); setBulkDescending(!bulkDescending);
              }}>{bulkDescending ? "All columns descending" : "All columns ascending"}</button>
            </div>}<div className="builder-order-list" onDragOver={event => event.preventDefault()} onDrop={event => drop(event, "order")}>
              {!definition.orderBy.length && <div className="builder-drop-empty"><Icon name="up" size={24}/><strong>No explicit sort order</strong><p>Use Sort beside an output field or drag it here. The first sort has highest priority.</p></div>}
              {definition.orderBy.map((order, index) => {
                const field = definition.fields.find(item => item.id === order.fieldId);
                return <div key={order.fieldId} className="builder-order-row" draggable={!busy} onDragStart={event => drag(event, order.fieldId)} onDragOver={event => event.preventDefault()} onDrop={event => { event.stopPropagation(); drop(event, "order", index); }}>
                  <span className="builder-priority">{index + 1}</span><strong>{field?.caption || field?.name || "Missing field"}</strong>
                  <select aria-label={`Sort direction for ${field?.name}`} value={order.direction} onChange={event => edit({ ...definition, orderBy: definition.orderBy.map(item => item.fieldId === order.fieldId ? { ...item, direction: event.target.value === "DESC" ? "DESC" : "ASC" } : item) })}><option value="ASC">Ascending</option><option value="DESC">Descending</option></select>
                  <button className="icon-button" aria-label={`Increase sort priority for ${field?.name}`} disabled={index === 0 || busy} onClick={() => edit({ ...definition, orderBy: moveItem(definition.orderBy, index, index - 1) })}><Icon name="up" size={13}/></button>
                  <button className="icon-button" aria-label={`Decrease sort priority for ${field?.name}`} disabled={index === definition.orderBy.length - 1 || busy} onClick={() => edit({ ...definition, orderBy: moveItem(definition.orderBy, index, index + 1) })}><Icon name="down" size={13}/></button>
                  <button className="icon-button" aria-label={`Remove sort ${field?.name}`} disabled={busy} onClick={() => edit({ ...definition, orderBy: definition.orderBy.filter(item => item.fieldId !== order.fieldId) })}><Icon name="close" size={13}/></button>
                </div>;
              })}
            </div></>}
          </section>
        </div>
      </>}
      {showQuery && !measureEdit && <section className="builder-query-preview" aria-label="Generated DAX preview"><div className="panel-section-heading"><h2>Generated DAX</h2><label className="check-field"><input type="checkbox" checked={autoGenerate} onChange={event => setAutoGenerate(event.target.checked)}/>Auto preview</label>{!autoGenerate && <button className="button small" disabled={generating || !definition.fields.length} onClick={() => void generate()}>Generate</button>}<span className="muted">{generating ? "Generating..." : preview ? "Preview only / not executed" : "Waiting for valid selections"}</span></div><pre tabIndex={0}>{preview || previewError || "Add fields to generate a query."}</pre></section>}
    </div>
    {previewError && !showQuery && <div className="builder-notice warning-text" role="status">{previewError}</div>}
    {fieldMenu && !hidden && <ModelObjectMenu anchor={fieldMenu} onClose={closeFieldMenu} onPreview={onPreview}
      onInspect={onInspect} previewDisabled={fieldPreviewDisabled} previewLabel="Preview field"/>}
    {picker && !hidden && <BuilderFieldPicker objects={objects}
      includedIds={definition.fields.map(field => field.id)}
      disabled={busy || authoringPaused} error={error || saveError} schemaMessage={schemaMessage} refreshDisabled={refreshDisabled} onRefresh={onRefresh}
      onClose={() => setPicker(null)} onAdd={items => {
        if (add(items, picker)) setPicker(null);
      }}/>}
    {filterControls && !hidden && <FilterControlPane definition={definition} start={filterControls} objects={objects}
      document={document} latest={latest} action={action} disabled={busy || authoringPaused} error={error || saveError}
      schemaMessage={schemaMessage} refreshDisabled={refreshDisabled} onRefresh={onRefresh} parametersSupported={parametersSupported} parameterHelp={parameterHelp}
      prepare={async () => { await pendingApply.current; await beforeApply(); await save(); }} onClose={() => setFilterControls(null)}
      onApply={(filters, original) => {
        try {
          if (edit(applyStagedFilters(draft.current.definition, original, filters))) {
            setFilterControls(null); setPane("filters"); setNotice("Filters applied. The query was not run.");
          }
        } catch (reason) { setError(errorMessage(reason)); }
      }}/>}
    <details className="builder-file-tools"><summary>Open / save query builder</summary><div className="builder-file-grid">
      <form onSubmit={event => { event.preventDefault(); setBusy(true); setNotice(""); void save().then(() => action<{ path: string }>("builder.save", { documentId: document.id, definition: draft.current.definition, directory: directory.trim(), name: name.trim() })).then(result => setNotice(`Saved ${result.path} and its DAX Studio builder companion.`)).catch(reason => setError(errorMessage(reason))).finally(() => setBusy(false)); }}>
        <label className="field-label">Save directory<input value={directory} onChange={event => setDirectory(event.target.value)} placeholder={"C:\\Data\\queries"} required/></label><label className="field-label">File name<input value={name} onChange={event => setName(event.target.value)} required maxLength={120}/></label><button className="button small" disabled={busy || !definition.fields.length}>Save .dax + .queryBuilder</button>
      </form>
      <form onSubmit={event => { event.preventDefault(); setBusy(true); void save().then(() => action("library.open", { path: openPath.trim() })).catch(reason => setError(errorMessage(reason))).finally(() => setBusy(false)); }}>
        <label className="field-label">Open DAX or builder file<input value={openPath} onChange={event => setOpenPath(event.target.value)} placeholder={"C:\\Data\\queries\\summary.dax.queryBuilder"} required/></label><button className="button small" disabled={busy}>Open in new document</button>
      </form>
    </div></details>
    <div className="builder-bottom"><span className="muted">Update changes the editor, never runs it.</span>
      {confirmClear ? <span className="button-row"><span>Clear builder selections?</span><button className="text-button" disabled={busy} onClick={() => void resetBuilder()}>Clear</button><button className="text-button" disabled={busy} onClick={() => setConfirmClear(false)}>Cancel</button></span> : <button className="text-button" disabled={busy || (!definition.fields.length && !definition.filters.length)} onClick={() => setConfirmClear(true)}>Clear builder</button>}
    </div>
  </section>;
}
