import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Capability, ModelItem, ModelObject, ModelSchema, Run } from "../contracts/workbench";
import { Icon } from "./icons";
import type { Action } from "./useWorkbench";
import { formatDuration, schemaGroup } from "./model";
import { FIELD_DRAG_TYPE, explorerObjects, fieldFolders, fieldSearch, type FieldFolder } from "./builder-model";
import { ModelObjectMenu, type ModelMenuAnchor } from "./ModelObjectMenu";

export function ModelExplorer({ schema, action, onInsert, selectedObjects, onInspect, onPreview, previewDisabled, hasConnection, onConnect, capability, builderActive = false, onBuilderField, onBuilderFilter, refreshing, refreshDisabled, onRefresh }: {
  schema: ModelSchema | null; action: Action; onInsert: (text: string) => void;
  selectedObjects: string[]; onInspect: (object: ModelObject) => void; hasConnection: boolean; onConnect: () => void;
  onPreview: (object: ModelObject) => void; previewDisabled: boolean;
  capability?: Capability;
  builderActive?: boolean; onBuilderField?: (object: ModelItem) => void; onBuilderFilter?: (object: ModelItem) => void;
  refreshing: boolean; refreshDisabled: boolean; onRefresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [useFolders, setUseFolders] = useState(true);
  const [fieldKind, setFieldKind] = useState("all");
  const [focusedField, setFocusedField] = useState("");
  const [menu, setMenu] = useState<ModelMenuAnchor | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => { setMenu(null); }, [schema]);
  function showMenu(target: EventTarget, x?: number, y?: number) {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-object-id]") : null;
    const object = schema?.objects.find(item => item.id === element?.dataset.objectId);
    if (!element || !object) return false;
    setMenu({ object, target: element, x, y });
    return true;
  }
  const unsupported = capability?.status === "unsupported";
  const term = search.toLocaleLowerCase();
  const tables = useMemo(() => {
    if (!schema) return [];
    const groups = new Map<string, { name: string; kind: ModelObject["kind"]; object?: ModelObject; children: ModelObject[] }>();
    for (const object of explorerObjects(schema.objects, showHidden)) {
      if (object.kind !== "table" && fieldKind !== "all" && object.kind !== fieldKind) continue;
      const info = schemaGroup(object);
      const group = groups.get(info.key) ?? { name: info.name, kind: info.kind, children: [] };
      if (object.kind === "table") {
        group.object = object;
      } else {
        group.children.push(object);
      }
      groups.set(info.key, group);
    }
    return [...groups].filter(([, group]) => (!term || group.name.toLocaleLowerCase().includes(term) || group.children.some(object => fieldSearch(object, term)) || schema.hierarchies?.some(hierarchy => hierarchy.table === group.name && (showHidden || !hierarchy.isHidden) && hierarchy.name.toLocaleLowerCase().includes(term))) && (fieldKind === "all" || group.children.length))
      .sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [schema, term, showHidden, fieldKind]);
  function insert(object: ModelObject) {
    if (object.kind === "relationship" || (object.kind === "column" && !object.table)) { onInspect(object); return; }
    const table = `'${(object.table ?? object.name).replace(/'/g, "''")}'`;
    const name = `[${object.name.replace(/\]/g, "]]")}]`;
    onInsert(object.kind === "table" ? table : object.kind === "measure" ? name : `${table}${name}`);
  }
  function share(object: ModelObject) {
    const next = selectedObjects.includes(object.id) ? selectedObjects.filter(id => id !== object.id) : [...selectedObjects, object.id];
    void action("context.objects", { ids: next }).catch(() => {});
  }
  function toggle(key: string) { setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  function addObject(object: ModelItem, target: "field" | "filter") {
    if (target === "field") onBuilderField?.(object); else onBuilderFilter?.(object);
    if (search) { setSearch(""); searchInput.current?.focus(); }
  }
  function renderObjects(objects: ModelObject[], key: string) {
    return [...objects].sort((a, b) => a.name.localeCompare(b.name)).map(object => <div className={`tree-object-row ${focusedField === object.id ? "focused-field" : ""} ${object.isHidden ? "hidden-model-object" : ""}`} key={`${key}:${object.id}`} role="treeitem">
      <button className="tree-object" data-object-id={object.id} draggable={object.kind === "column" || object.kind === "measure"} onDragStart={event => { event.dataTransfer.setData(FIELD_DRAG_TYPE, object.id); event.dataTransfer.effectAllowed = "copy"; }} title={`${object.kind}${object.dataType ? ` / ${object.dataType}` : ""}${object.isHidden ? " / hidden" : ""}\n${object.description ?? ""}\nDouble-click to ${builderActive ? "add to query builder" : "insert into query"}`} onClick={() => { setFocusedField(object.id); if (!builderActive) onInspect(object); }} onDoubleClick={() => { if (builderActive && object.kind !== "relationship") addObject(object, "field"); else insert(object); }}><Icon name={object.kind === "measure" ? "measure" : object.kind === "relationship" ? "link" : "column"} size={13}/><span>{object.name}</span><span className="tree-type">{object.dataType}</span></button>
      {builderActive && object.kind !== "relationship" && <><button className="icon-button tree-action" aria-label={`Add ${object.name} to query builder`} title="Add output field" onClick={() => onBuilderField?.(object)}><Icon name="plus" size={13}/></button><button className="icon-button tree-action" aria-label={`Add filter on ${object.name}`} title="Add filter" onClick={() => onBuilderFilter?.(object)}><Icon name="filter" size={12}/></button></>}
      <button className="icon-button tree-action tree-inspect" aria-label={`Inspect ${object.name}`} title="Inspect definition and related fields" onClick={() => onInspect(object)}><Icon name="info" size={13}/></button>
      <button className={`icon-button tree-action ${selectedObjects.includes(object.id) ? "is-active" : ""}`} aria-label={`Share metadata for ${object.name}`} title="Include metadata in Context Lens" aria-pressed={selectedObjects.includes(object.id)} onClick={() => share(object)}><Icon name="lens" size={12}/></button>
    </div>);
  }
  function renderFolder(folder: FieldFolder, tableKey: string): React.ReactNode {
    return <>{[...folder.folders].sort((a, b) => a.name.localeCompare(b.name)).map(child => {
      const key = `${tableKey}:folder:${child.path}`, open = Boolean(search) || expanded.has(key);
      return <div role="treeitem" key={key} aria-expanded={open}><button className="tree-folder" aria-expanded={open} onClick={() => toggle(key)}><Icon name="chevron" size={11} style={{ transform: open ? "rotate(90deg)" : undefined }}/><Icon name="folder" size={13}/><span>{child.name}</span></button>{open && <div role="group">{renderFolder(child, tableKey)}</div>}</div>;
    })}{renderObjects(folder.fields, `${tableKey}:${folder.path}`)}</>;
  }
  return <div className="explorer-content">
    <div className="panel-section-heading"><h2>Model explorer</h2><button className={`icon-button ${refreshing ? "spinning" : ""}`} disabled={refreshDisabled} title={unsupported ? capability.reason : "Refresh native schema"} aria-label="Refresh native schema" onClick={onRefresh}><Icon name="refresh" size={14}/></button></div>
    <label className="search-field explorer-search"><Icon name="search" size={14}/><input ref={searchInput} disabled={unsupported} placeholder="Search model…" aria-label="Search model tables, columns and measures" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button className="icon-button" onClick={() => setSearch("")} aria-label="Clear schema search"><Icon name="close" size={12}/></button>}</label>
    <div className="explorer-options"><select aria-label="Model field types" value={fieldKind} onChange={event => setFieldKind(event.target.value)}><option value="all">All fields</option><option value="column">Columns</option><option value="measure">Measures</option></select><button className={`icon-button ${showHidden ? "is-active" : ""}`} aria-label="Show hidden model objects" aria-pressed={showHidden} title="Show hidden model objects" onClick={() => setShowHidden(!showHidden)}><Icon name="eye" size={14}/></button><button className={`icon-button ${useFolders ? "is-active" : ""}`} aria-label="Group fields in display folders" aria-pressed={useFolders} title="Group fields in display folders" onClick={() => setUseFolders(!useFolders)}><Icon name="folder" size={14}/></button></div>
    {builderActive && <p className="explorer-builder-hint">Double-click or drag fields. C / Enter adds output, F / Space filters, B adds both. I inspects; P previews data.</p>}
    <p className="explorer-preview-hint">Right-click a table or column for Preview data.</p>
    {!hasConnection ? <div className="sidebar-empty"><Icon name="database" size={26}/><h3>Choose a model</h3><p>Connect to Power BI Desktop, XMLA, or Analysis Services to explore its schema.</p><button className="button small" onClick={onConnect}>Add a connection</button></div>
      : unsupported ? <div className="sidebar-empty"><h3>Query-only connection</h3><p>{capability.reason}</p><p>Write DAX using known model names. Add an XMLA connection for model browsing.</p><button className="button small" onClick={onConnect}>Manage connections</button></div>
      : !schema ? <div className="sidebar-empty"><h3>{refreshing ? "Loading model fields" : "Schema not loaded"}</h3><p>Refresh to inspect tables and measures from the active connection.</p><button className="button small" disabled={refreshDisabled} onClick={onRefresh}>{refreshing ? "Refreshing…" : "Load schema"}</button></div>
      : <div className="schema-tree" role="tree" aria-label="Semantic model objects"
        onContextMenu={event => { if (showMenu(event.target, event.clientX, event.clientY)) event.preventDefault(); }}
        onKeyDown={event => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement) || !target.matches(".tree-table, .tree-object, .tree-folder")) return;
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if (key === "ContextMenu" || key === "F10" && event.shiftKey) {
          if (showMenu(target)) event.preventDefault();
          return;
        }
        if (key === "p" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const object = schema.objects.find(item => item.id === target.dataset.objectId && ["table", "column"].includes(item.kind));
          if (object) { event.preventDefault(); if (!previewDisabled) onPreview(object); return; }
        }
        if (key === "i" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const object = schema.objects.find(item => item.id === target.dataset.objectId);
          if (object) { event.preventDefault(); onInspect(object); return; }
        }
        if (builderActive && !event.altKey && !event.ctrlKey && !event.metaKey && ["c", "f", "b", "Enter", " "].includes(key)) {
          const object = schema.objects.find(item => item.id === target.dataset.objectId) ?? schema.hierarchies?.find(item => item.id === target.dataset.objectId);
          if (object) {
            event.preventDefault();
            if (["c", "b", "Enter"].includes(key)) addObject(object, "field");
            if (["f", "b", " "].includes(key)) addObject(object, "filter");
            return;
          }
        }
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".tree-table, .tree-object, .tree-folder")], index = buttons.indexOf(target);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
        } else if (event.key === "ArrowRight" && target.getAttribute("aria-expanded") === "false") { event.preventDefault(); target.click(); }
        else if (event.key === "ArrowLeft" && target.getAttribute("aria-expanded") === "true") { event.preventDefault(); target.click(); }
      }}>
        {tables.length === 0 && <p className="sidebar-note">No objects match “{search}”.</p>}
        {tables.map(([key, group]) => {
          const name = group.name;
          const open = Boolean(search) || expanded.has(key);
          const children = group.children.filter(object => !term || name.toLocaleLowerCase().includes(term) || fieldSearch(object, term));
          return <div key={key} role="treeitem" aria-expanded={open}>
            <div className="tree-table-row">
              <button className="tree-table" aria-expanded={open} data-object-id={group.object?.id} draggable={Boolean(group.object)} onDragStart={event => { if (group.object) { event.dataTransfer.setData(FIELD_DRAG_TYPE, group.object.id); event.dataTransfer.effectAllowed = "copy"; } }} onClick={() => toggle(key)} onDoubleClick={() => { if (group.object && !builderActive) insert(group.object); }}>
                <Icon name="chevron" size={12} style={{ transform: open ? "rotate(90deg)" : undefined }}/><Icon name={group.kind === "relationship" ? "link" : group.kind === "measure" ? "measure" : group.kind === "column" ? "column" : "table"} size={14}/><span>{name}</span><span className="tree-count">{group.children.length}</span>
              </button>
              {group.object && <><button className="icon-button tree-action tree-inspect" aria-label={`Inspect ${name}`} title="Inspect table and related fields" onClick={() => onInspect(group.object!)}><Icon name="info" size={13}/></button><button className={`icon-button tree-action ${selectedObjects.includes(group.object.id) ? "is-active" : ""}`} title="Include table metadata in Context Lens" aria-label={`Share metadata for ${name}`} aria-pressed={selectedObjects.includes(group.object.id)} onClick={() => share(group.object!)}><Icon name="lens" size={13}/></button></>}
            </div>
            {open && <div role="group">{fieldKind !== "measure" && schema.hierarchies?.filter(hierarchy => hierarchy.table === name && (showHidden || !hierarchy.isHidden) && (!term || name.toLocaleLowerCase().includes(term) || hierarchy.name.toLocaleLowerCase().includes(term))).map(hierarchy => {
              const hierarchyOpen = Boolean(search) || expanded.has(hierarchy.id);
              return <div key={hierarchy.id} role="treeitem" aria-expanded={hierarchyOpen}>
                <button className="tree-folder tree-object" data-object-id={hierarchy.id} aria-expanded={hierarchyOpen} draggable onDragStart={event => { event.dataTransfer.setData(FIELD_DRAG_TYPE, hierarchy.id); event.dataTransfer.effectAllowed = "copy"; }} onClick={() => toggle(hierarchy.id)} onDoubleClick={() => { if (builderActive) addObject(hierarchy, "field"); }} title="Hierarchy: add or drag to expand its verified levels">
                  <Icon name="chevron" size={11} style={{ transform: hierarchyOpen ? "rotate(90deg)" : undefined }}/><Icon name="link" size={13}/><span>{hierarchy.name}</span>
                </button>
                {hierarchyOpen && <div role="group">{[...hierarchy.levels].sort((a, b) => a.ordinal - b.ordinal).map(level => {
                  const column = schema.objects.find(item => item.id === level.columnId);
                  return column && <div className="tree-object-row" key={level.id}><button className="tree-object" data-object-id={column.id} draggable onDragStart={event => { event.dataTransfer.setData(FIELD_DRAG_TYPE, column.id); event.dataTransfer.effectAllowed = "copy"; }} onDoubleClick={() => { if (builderActive) addObject(column, "field"); else insert(column); }} title={`${column.table}[${column.name}]`}><Icon name="column" size={13}/><span>{level.name}</span></button><button className="icon-button tree-action tree-inspect" aria-label={`Inspect ${hierarchy.name} level ${level.name}`} onClick={() => onInspect(column)}><Icon name="info" size={13}/></button></div>;
                })}</div>}
              </div>;
            })}{useFolders ? renderFolder(fieldFolders(children), key) : renderObjects(children, key)}</div>}
          </div>;
        })}
      </div>}
    {menu && <ModelObjectMenu anchor={menu} onClose={closeMenu} onPreview={onPreview} onInspect={onInspect} previewDisabled={previewDisabled}/>}
    {schema && !unsupported && <><div className="schema-footer"><span>{schema.objects.length.toLocaleString()} objects</span><span title={schema.fetchedAt}>Refreshed {new Date(schema.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div><div className="schema-field-counts">{schema.objects.filter(object => object.kind === "column").length.toLocaleString()} columns / {schema.objects.filter(object => object.kind === "measure").length.toLocaleString()} measures{!showHidden && schema.objects.some(object => object.isHidden) ? " / hidden excluded from tree" : ""}</div></>}
    {!unsupported && schema && (schema.coverage || schema.warnings.length > 0) && <details className="schema-coverage"><summary>{schema.coverage ? `${schema.coverage.scope === "reader-exposed" ? "Reader" : "Model"} metadata / ${schema.coverage.status} coverage` : "Metadata notes"}</summary>
      {schema.coverage && <div className="sidebar-note"><p>Source: {schema.coverage.source}. Coverage is relative to this identity's {schema.coverage.scope === "reader-exposed" ? "reader-visible metadata, not the entire model" : "model metadata"}.</p>
        <p>Relationships: {schema.coverage.relationships.status}. Measure expressions: {schema.coverage.measureExpressions.status}. SortBy: {schema.coverage.sortByColumns.status}. GroupBy: {schema.coverage.groupByColumns.status}.</p></div>}
      {schema.warnings.map((warning, index) => <div key={index} className="sidebar-note warning-text">{warning}</div>)}
    </details>}
  </div>;
}

export function HistoryPanel({ runs, action, currentId, onSelect }: { runs: Run[]; action: Action; currentId?: string; onSelect: (run: Run) => void }) {
  const [filter, setFilter] = useState("");
  const filtered = runs.filter(run => !filter || `${run.previewTitle ?? ""} ${run.query} ${run.status} ${run.id}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <div className="explorer-content">
    <div className="panel-section-heading"><h2>Run history</h2><span className="count-badge">{runs.length}</span></div>
    <label className="search-field explorer-search"><Icon name="search" size={14}/><input placeholder="Search runs…" aria-label="Search run history" value={filter} onChange={event => setFilter(event.target.value)}/></label>
    <div className="history-list">
      {!filtered.length && <div className="sidebar-empty"><Icon name="history" size={25}/><h3>{filter ? "No matching runs" : "Every run has a record"}</h3><p>{filter ? "Try another query or status." : "Run a query to capture its revision, connection, duration, and result metadata here."}</p></div>}
      {filtered.map(run => <article key={run.id} className={`history-item ${currentId === run.id ? "is-current" : ""}`}>
        <button className="history-open" onClick={() => onSelect(run)} title={`Inspect ${run.id}`}>
          <span className="history-item-top"><span className={`status-dot ${run.status}`}/><strong>{run.status}</strong><time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></span>
          <span className="history-query">{run.query.replace(/^\s*\/\/.*\n/, "").slice(0, 110)}</span>
          {run.querySource === "preview" && <span className="history-meta">Supplied DAX preview: {run.previewTitle}</span>}
          {run.querySource === "filter-values" && <span className="history-meta">{run.previewTitle} · other filters not applied</span>}
          {run.querySource === "model-preview" && <span className="history-meta">{run.previewTitle} · query unchanged</span>}
          <span className="history-meta">rev {run.revision} · {run.rowCount.toLocaleString()} rows · {formatDuration(run.durationMs)}</span>
        </button>
        <div className="history-item-actions"><button className="text-button" onClick={() => void action("run.open", { runId: run.id }).catch(() => {})}>Open query</button><button className={`icon-button ${run.pinned ? "is-active" : ""}`} title={run.pinned ? "Unpin retained results" : "Pin raw results to local disk"} aria-label={run.pinned ? "Unpin results" : "Pin results"} aria-pressed={run.pinned} disabled={!run.retained && !run.pinned} onClick={() => void action("run.pin", { runId: run.id }).catch(() => {})}><Icon name="pin" size={13}/></button></div>
        {!run.retained && <p className="history-retention">Metadata only · raw rows no longer retained</p>}
      </article>)}
    </div>
    <div className="sidebar-note">History stores metadata. Pinning explicitly keeps raw results on local disk after restart.</div>
  </div>;
}
