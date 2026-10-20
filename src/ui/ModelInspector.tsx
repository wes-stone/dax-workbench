import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelObject, ModelSchema, Snapshot } from "../contracts/workbench";
import type { Action } from "./useWorkbench";
import { errorMessage } from "./api";
import { Icon } from "./icons";
import { expressionKind, expressionReferences, objectRelationships } from "./model-inspection";

export function ModelInspector({ object, schema, state, action, onInspect, onBuilder, onPreview, previewDisabled }: {
  object: ModelObject; schema: ModelSchema; state: Snapshot; action: Action;
  onInspect: (object: ModelObject) => void; onBuilder: (object: ModelObject, target: "field" | "filter") => void;
  onPreview: (object: ModelObject) => void; previewDisabled: boolean;
}) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const kind = expressionKind(schema, object);
  const references = useMemo(() => expressionReferences(schema, object), [schema, object]);
  const relationships = useMemo(() => objectRelationships(schema, object), [schema, object]);
  const table = object.kind === "table" ? object.name : object.table;
  const home = schema.objects.find(item => item.kind === "table" && item.name === object.table);
  const members = schema.objects.filter(item => ["column", "measure"].includes(item.kind) && item.table === table && item.id !== object.id);
  const fields = members.filter(item => !search || `${item.name} ${item.description ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const sort = schema.origin !== "dictionary" && object.sortByColumnId ? schema.objects.find(item => item.id === object.sortByColumnId && item.kind === "column" && item.table === table) : undefined;
  const hierarchies = (schema.origin === "dictionary" ? [] : schema.hierarchies ?? []).filter(item => object.kind === "table" ? item.table === table : item.levels.some(level => level.columnId === object.id));
  useEffect(() => { setSearch(""); setError(""); heading.current?.focus({ preventScroll: true }); }, [object.id]);
  const link = (item: ModelObject) => <button className="model-object-link" key={item.id} onClick={() => onInspect(item)}>
    <Icon name={item.kind === "table" ? "table" : item.kind === "measure" ? "measure" : "column"} size={13}/>
    <span>{item.table && item.table !== table ? `${item.table} / ` : ""}{item.name}</span>
    <small>{item.isHidden ? "hidden" : item.kind}</small>
  </button>;
  const endpoint = (tableName: string, columnName: string) => {
    const item = schema.objects.find(item => item.kind === "column" && item.table === tableName && item.name === columnName);
    return item ? <button className="text-button" onClick={() => onInspect(item)}>{tableName}[{columnName}]</button> : <span>{tableName}[{columnName}]</span>;
  };
  return <>
    <div className="object-heading"><Icon name={object.kind === "measure" ? "measure" : object.kind === "table" ? "table" : "column"} size={22}/><h3 tabIndex={-1} ref={heading}>{object.name}</h3></div>
    <p className="field-help">{schema.origin === "dictionary" ? "Imported documentation; not verified native metadata." : `${schema.coverage?.scope === "reader-exposed" ? "Reader-exposed" : "Native"} model metadata. No model data is read when inspecting fields.`}</p>
    <p className="drawer-intro">{object.description || "No description was provided for this object."}</p>
    <div className="object-quick-actions">{["table", "column"].includes(object.kind) && <button className="button small" disabled={previewDisabled || schema.origin === "dictionary"} onClick={() => onPreview(object)} title="Explicitly read up to 100 rows without changing your query"><Icon name="table" size={13}/>Preview data</button>}{["column", "measure"].includes(object.kind) && <>
      <button className="button small" onClick={() => onBuilder(object, "field")}><Icon name="plus" size={13}/>Add output</button>
      <button className="button small" onClick={() => onBuilder(object, "filter")}><Icon name="filter" size={13}/>Add filter</button>
    </>}<button className="button small quiet" onClick={() => void action("context.objects", {
      ids: state.selectedObjects.includes(object.id) ? state.selectedObjects.filter(id => id !== object.id) : [...state.selectedObjects, object.id],
    }).catch(reason => setError(errorMessage(reason)))}><Icon name="lens" size={13}/>{state.selectedObjects.includes(object.id) ? "Remove from Context Lens" : "Include in Context Lens"}</button></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    <dl className="object-properties"><dt>Kind</dt><dd>{object.kind}</dd>
      {object.table && <><dt>Table</dt><dd>{home ? <button className="text-button" onClick={() => onInspect(home)}>{object.table}</button> : object.table}</dd></>}
      {object.kind !== "table" && <><dt>Data type</dt><dd>{object.dataType ?? "Not provided"}</dd><dt>Format</dt><dd>{object.formatString || "Not provided"}</dd></>}
      <dt>Visibility</dt><dd>{object.isHidden === undefined ? "Not provided" : object.isHidden ? "Hidden" : "Visible"}</dd>
      {object.displayFolder && <><dt>Display folder</dt><dd>{object.displayFolder}</dd></>}
      <dt>Source</dt><dd>{object.source ?? schema.coverage?.source ?? "Provider source not specified"}</dd>
      {object.nativeDataType && <><dt>Native type</dt><dd>{object.nativeDataType}{object.nativeDataType.startsWith("DBTYPE:") ? " (provider key type)" : ""}</dd></>}
    </dl>
    {(object.expression || object.kind === "measure") && <section className="drawer-section"><h3>{kind === "definition" ? "DAX definition" : kind === "documented" ? "Documented expression" : "Definition availability"}</h3>
      {kind === "definition" || kind === "documented" ? <pre className="json-preview" tabIndex={0}>{object.expression}</pre>
        : <p className="field-help">{schema.coverage?.measureExpressions.reason ?? "The provider did not expose an authoritative DAX definition. This does not mean the measure has no definition."}</p>}
      {kind === "reference" && <details><summary>Provider expression / reference</summary><p className="field-help">Not a verified DAX implementation.</p><pre className="json-preview">{object.expression}</pre></details>}
      {kind === "definition" && <><h4 className="object-reference-title">References in this definition</h4><p className="field-help">Matched against model names in the DAX text, excluding strings and comments. Not a complete engine dependency graph.</p>
        {references.length ? <div className="model-object-links">{references.map(link)}</div> : <p className="field-help">No unambiguous references were resolved. Dependencies may still exist.</p>}</>}
    </section>}
    {object.kind === "column" && <section className="drawer-section"><h3>Sort by column</h3>
      {sort ? link(sort) : <p className="field-help">{object.sortByColumnId ? "The referenced sort column is not available in this schema." : schema.coverage?.sortByColumns.status === "complete" ? "No separate sort column is configured." : schema.coverage?.sortByColumns.reason ?? "Sort-column metadata was not provided."}</p>}
    </section>}
    {["table", "column"].includes(object.kind) && <section className="drawer-section"><h3>Relationships</h3>
      {schema.origin === "dictionary" ? <p className="field-help">Refresh native metadata to inspect verified relationships.</p>
        : <>{schema.coverage?.relationships.status !== "complete" && <p className="field-help">{schema.coverage?.relationships.reason ?? "Relationship coverage is not complete. Missing links are not proof that tables are unrelated."}</p>}
          {relationships.length ? <ul className="object-relationships">{relationships.map(item => <li key={item.id}>
            <div>{endpoint(item.fromTable, item.fromColumn)}<span className="muted"> to </span>{endpoint(item.toTable, item.toColumn)}</div>
            <p>{item.fromCardinality ?? "Unknown"} to {item.toCardinality ?? "unknown"} · {item.isActive === undefined ? "activity not provided" : item.isActive ? "Active" : "Inactive"} · {item.crossFilteringBehavior === "bothDirections" ? "Filters both ways" : item.crossFilteringBehavior === "oneDirection" ? "Single-direction filtering" : item.crossFilteringBehavior === "automatic" ? "Automatic filtering" : "filter direction not provided"}</p>
          </li>)}</ul> : <p className="field-help">{schema.coverage?.relationships.status === "complete" ? "No relationships reference this object." : "No verified links available for this object."}</p>}</>}
    </section>}
    {!!hierarchies.length && <section className="drawer-section"><h3>Hierarchy levels</h3>{hierarchies.map(hierarchy => <div className="object-hierarchy" key={hierarchy.id}><h4>{hierarchy.name}</h4><div className="model-object-links">{[...hierarchy.levels].sort((a, b) => a.ordinal - b.ordinal).map(level => {
      const column = schema.objects.find(item => item.id === level.columnId && item.kind === "column");
      return column ? link(column) : <p className="field-help" key={level.id}>{level.name}: column unavailable.</p>;
    })}</div></div>)}</section>}
    {table && <section className="drawer-section"><h3>{object.kind === "table" ? "Fields" : "More in this table"} ({members.length})</h3>
      {!!members.length && <label className="search-field"><Icon name="search" size={13}/><input aria-label={`Search fields in ${table}`} placeholder="Find a related field" value={search} onChange={event => setSearch(event.target.value)}/></label>}
      <div className="model-object-links object-member-list">{fields.slice(0, 100).map(link)}</div>
      {fields.length > 100 && <p className="field-help">Showing 100 of {fields.length} matching fields. Narrow the search to find others.</p>}
      {!fields.length && <p className="field-help">{search ? "No fields match this search." : "No member fields were exposed."}</p>}
    </section>}
    {object.qualifiedName && <details className="drawer-section"><summary>Provider identity</summary><code className="object-provider-id">{object.qualifiedName}</code></details>}
  </>;
}
