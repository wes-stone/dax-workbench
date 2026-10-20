import { useEffect, useState } from "react";
import type { ArtifactCatalog, ArtifactDetail, ArtifactSummary, ArtifactVisual } from "../contracts/artifacts";
import { api, downloadBlob, errorMessage } from "./api";
import { LocalChart } from "./Chart";
import { Icon } from "./icons";
import { DocumentationReader } from "./DocumentationReader";
import { displayCell, isNumeric } from "./model";
import { artifactSize, artifactTypes } from "./artifacts-model";
import type { LibrarySession } from "./library-cache";
import { useLibraryRead } from "./useLibraryRead";
import { resultColumnLabels } from "../shared/result-columns.mjs";

const noChartEdit = () => {};
export function SavedVisual({ visual }: { visual: ArtifactVisual }) {
  const labels = resultColumnLabels(visual.columns);
  return <div className="artifact-saved-visual">
    <LocalChart data={visual} initial={visual.config} truncated={visual.provenance.truncated} onSave={noChartEdit} readOnly/>
    <p className="artifact-provenance">{visual.provenance.description}</p>
    {visual.provenance.approximate && <p className="artifact-provenance">Captured aggregate values are approximate. These are plotted values, not exact underlying source rows.</p>}
    <details className="artifact-exact-data">
      <summary>Exact data <span>{visual.rows.length.toLocaleString()} rows</span></summary>
      <p>Captured values, without display rounding. Chart coordinates use approximate numbers.</p>
      <div className="artifact-data-scroll" role="region" tabIndex={0} aria-label="Captured visual data">
        <table><thead><tr>{visual.columns.map((column, index) => <th key={column.id} scope="col" title={`${column.name} (${column.dataType})`}>{labels[index]}</th>)}</tr></thead>
          <tbody>{visual.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={visual.columns[column].id}
            className={isNumeric(visual.columns[column]) ? "numeric" : ""}>{cell === null ? <span className="muted">null</span> : displayCell(cell)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <button className="button small" onClick={() => downloadBlob(new Blob([JSON.stringify(visual, null, 2)], { type: "application/json" }), "visual-data.json")}>Download captured data</button>
    </details>
    {visual.provenance.runId && <details className="artifact-run-reference"><summary>Source reference</summary><dl>
      <dt>Run</dt><dd>{visual.provenance.runId}</dd>
      {visual.provenance.resultSetId && <><dt>Result set</dt><dd>{visual.provenance.resultSetId}</dd></>}
      {visual.provenance.queryRevision !== undefined && <><dt>Query revision</dt><dd>{visual.provenance.queryRevision}</dd></>}
    </dl><p>A reference identifies a source; it does not independently certify the supplied data or business conclusions.</p></details>}
  </div>;
}

function SavedImage({ id, alt }: { id: string; alt: string }) {
  const [url, setUrl] = useState(""), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl = "";
    setUrl(""); setError("");
    void api.artifactBlob(id, true, abort.signal).then(blob => {
      if (abort.signal.aborted) return;
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(blob.type))
        throw new Error("This file is not a supported raster image. Download it to inspect it outside the workbench.");
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, attempt]);
  return error ? <div className="artifact-preview-error" role="alert"><p>{error}</p><button className="button small" onClick={() => setAttempt(value => value + 1)}>Retry image</button></div>
    : url ? <figure className="artifact-image"><img src={url} alt={alt} onError={() => setError("The image could not be decoded. Download the original file or import a supported PNG, JPEG, WebP, or GIF.")}/></figure>
    : <div className="artifact-loading" role="status">Loading saved image...</div>;
}

export function ArtifactBody({ detail }: { detail: ArtifactDetail }) {
  if (detail.visual) return <SavedVisual visual={detail.visual}/>;
  if (detail.kind === "image") return <SavedImage id={detail.id} alt={detail.description || detail.title}/>;
  if (detail.slides) return <div className="artifact-deck-preview">
    <p className="artifact-provenance">{detail.previewMessage || "Text-only slide preview. Download the deck for its complete PowerPoint layout, charts, and media."}</p>
    {detail.slides.map(slide => <section className="artifact-slide" key={slide.number}>
      <h3>Slide {slide.number}</h3><p>{slide.text || "No extractable text. This slide may contain charts or images."}</p>
    </section>)}
    {!detail.slides.length && <p>No extractable slide text. Download the original presentation to view its visuals.</p>}
  </div>;
  if (detail.text !== undefined) return <article className="artifact-document">
    {detail.previewMessage && <p className="artifact-provenance">{detail.previewMessage}</p>}
    {detail.kind === "note" || /\.(?:md|mdown|markdown)$/i.test(detail.fileName ?? "") ? <DocumentationReader text={detail.text} kind="note" showChecks={detail.kind === "note"}/>
      : <pre tabIndex={0} className={`artifact-text-preview${detail.kind === "document" || /\.txt$/i.test(detail.fileName ?? "") ? " artifact-prose-preview" : ""}`}>{detail.text}</pre>}
  </article>;
  return <div className="artifact-file-preview">
    <Icon name={artifactTypes[detail.kind].icon} size={38}/>
    <h3>{artifactTypes[detail.kind].label}</h3>
    <p>{detail.previewMessage || "The original file is stored here. Download it to open in its native application; the workbench does not execute file content."}</p>
    <dl><dt>File</dt><dd>{detail.fileName || detail.title}</dd>{detail.byteLength !== undefined && <><dt>Size</dt><dd>{artifactSize(detail.byteLength)}</dd></>}</dl>
  </div>;
}

export function ArtifactEmbed({ id, alt, catalog, session, workbenchId }: {
  id: string; alt: string; catalog: ArtifactCatalog; session: LibrarySession; workbenchId: string;
}) {
  const known = catalog.entries.find(entry => entry.id === id && !entry.archived && ["visual", "image"].includes(entry.kind));
  const read = useLibraryRead<ArtifactDetail>(session, JSON.stringify(["artifact", workbenchId, catalog.revision, id]), "detail",
    signal => api.read("artifacts.get", { id }, signal), Boolean(known));
  if (!known) return <span className="artifact-embed-unavailable">[Visual unavailable: {alt || id}]</span>;
  if (read.error) return <div className="artifact-preview-error" role="alert"><p>{read.error}</p><button className="button small" onClick={read.retry}>Retry visual</button></div>;
  return <figure className="artifact-embedded-visual">
    <figcaption>{alt || known.title}</figcaption>
    {known.researchChanged && <p className="inline-alert" role="status">Linked research changed or its original revision is unknown. This saved visual has not been refreshed.</p>}
    {read.data ? <ArtifactBody detail={read.data}/> : <div className="artifact-loading" role="status">Loading saved visual...</div>}
  </figure>;
}

export function RelatedArtifacts({ entryId, catalog, session, workbenchId, onOpen }: {
  entryId: string; catalog: ArtifactCatalog; session: LibrarySession; workbenchId: string; onOpen: (entry: ArtifactSummary) => void;
}) {
  const [shown, setShown] = useState(4);
  const related = catalog.entries.filter(entry => entry.researchEntryId === entryId && !entry.archived);
  if (!related.length) return null;
  return <section className="artifact-related" aria-label="Research visuals and attachments">
    <h3>Visuals &amp; attachments <span>{related.length}</span></h3>
    {related.slice(0, shown).map(entry => ["visual", "image"].includes(entry.kind)
      ? <ArtifactEmbed key={`${entry.id}:${entry.updatedAt}`} id={entry.id} alt={entry.title} catalog={catalog} session={session} workbenchId={workbenchId}/>
      : <button key={entry.id} className="artifact-attachment button quiet" onClick={() => onOpen(entry)}><Icon name={artifactTypes[entry.kind].icon}/><span>{entry.title}</span><span className="muted">{artifactTypes[entry.kind].label}</span></button>)}
    {related.length > shown && <button className="button small" onClick={() => setShown(value => value + 4)}>Show more attachments</button>}
  </section>;
}
