import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KnowledgeIdentity, KnowledgeRecord, KnowledgeReference, KnowledgeSearch } from "../contracts/model-context";
import type { ModelObject } from "../contracts/workbench";
import { api } from "./api";
import type { LibrarySession } from "./library-cache";
import { useLibraryRead } from "./useLibraryRead";
import { MarkdownPreview } from "./MarkdownPreview";

export function ModelNotes({ identity, session, references, field }: {
  identity: KnowledgeIdentity; session: LibrarySession; references?: KnowledgeReference[]; field?: ModelObject;
}) {
  const [selected, setSelected] = useState<KnowledgeReference | null>(null);
  const buttons = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef("");
  const fieldRef = field ? { kind: field.kind, table: field.table, name: field.name } : undefined;
  const scope = JSON.stringify([identity, fieldRef, references]);
  useEffect(() => { setSelected(null); }, [scope]);
  const catalog = useLibraryRead<KnowledgeSearch>(session, JSON.stringify(["knowledge.search", identity, fieldRef]), "detail",
    signal => api.read<KnowledgeSearch>("knowledge.search", { identity, ...(fieldRef ? { field: fieldRef } : {}) }, signal));
  const record = useLibraryRead<KnowledgeRecord>(session, JSON.stringify(["knowledge.get", identity, selected]), "detail",
    signal => api.read<KnowledgeRecord>("knowledge.get", { identity, ...selected }, signal), Boolean(selected));
  useLayoutEffect(() => {
    if (selected) back.current?.focus({ preventScroll: true });
    else if (restoreFocus.current) {
      const id = restoreFocus.current; restoreFocus.current = "";
      Array.from(buttons.current?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(button => button.dataset.id === id)?.focus();
    }
  }, [selected]);
  const notes = catalog.data?.entries.filter(entry => entry.kind === "note" && (!references || references.some(ref => ref.id === entry.id))) ?? [];
  const missing = references?.filter(ref => catalog.data && !catalog.data.entries.some(entry => entry.id === ref.id)) ?? [];
  const error = catalog.error || record.error;
  return <section className="model-notes" aria-label="Model notes">
    <h3>Model notes</h3>
    <p className="field-help">Bundled guidance available to you and Copilot. Native model metadata remains authoritative.</p>
    {error && <p className="field-error" role="alert">{error} <button className="text-button" onClick={catalog.error ? catalog.retry : record.retry}>Retry model notes</button></p>}
    {!selected ? <div className="model-note-links" ref={buttons}>
      {notes.map(note => <button className="model-note-link" key={note.id} data-id={note.id} onClick={() => setSelected(references?.find(ref => ref.id === note.id) ?? { id: note.id, version: note.version })}>
        <strong>{note.title}</strong><span>{note.summary}</span>
      </button>)}
      {missing.map(ref => <p className="field-help" key={ref.id}>Referenced note unavailable: {ref.id} (revision {ref.version}). Your saved documentation has not changed.</p>)}
      {!notes.length && !missing.length && !error && <p className="field-help">{catalog.loading ? "Loading model notes..." : field ? "No bundled notes for this field." : "No bundled model notes for this connection."}</p>}
    </div> : <>
      <button className="text-button model-notes-back" ref={back} onClick={() => {
        restoreFocus.current = selected.id; setSelected(null);
      }}>Back to model notes</button>
      {record.loading && <p className="field-help" role="status">Loading note...</p>}
      {record.data && <article className="model-note-detail">
        <h4>{record.data.title}</h4>
        {record.data.referenceStatus === "older" && <p className="field-help">This query references revision {record.data.requestedVersion}. Showing current revision {record.data.version}; the saved reference is unchanged.</p>}
        <MarkdownPreview text={record.data.body}/>
        {record.data.caveats.length > 0 && <ul>{record.data.caveats.map((text, index) => <li key={index}>{text}</li>)}</ul>}
        <details><summary>Source, revision, and unknowns</summary>
          <p>Bundled revision {record.data.version}. Guidance is not execution validation.</p>
          {record.data.provenance.map((source, index) => <p key={index}>{source}</p>)}
          {record.data.unknowns.map((unknown, index) => <p key={index}>{unknown}</p>)}
        </details>
      </article>}
    </>}
  </section>;
}
