import type { BuilderDefinition, BuilderProposal } from "../contracts/workbench";
import { fieldLabel } from "./builder-model";

function DefinitionSummary({ definition, title }: { definition: BuilderDefinition; title: string }) {
  return <section className="builder-review-definition" aria-label={title}>
    <h3>{title}</h3>
    <h4>Output fields ({definition.fields.length})</h4>
    {definition.fields.length ? <ol>{definition.fields.map(field => <li key={field.id}>
      <strong>{fieldLabel(field)}</strong>{field.caption && <span> as {field.caption}</span>}
      {field.expression !== undefined && <details><summary>Query-local measure definition</summary><pre>{field.expression}</pre></details>}
    </li>)}</ol> : <p className="muted">No output fields.</p>}
    <h4>Filters ({definition.filters.length})</h4>
    {definition.filters.length ? <ul>{definition.filters.map(filter => <li key={filter.id}>
      <strong>{fieldLabel(filter.field)}</strong> {filter.operator}
      {!["IsBlank", "IsNotBlank"].includes(filter.operator) && <code> {filter.isParameter ? `@${filter.value}` : JSON.stringify(filter.value)}
        {filter.operator === "Between" && ` to ${filter.isParameter2 ? `@${filter.value2}` : JSON.stringify(filter.value2 ?? "")}`}</code>}
      {!filter.enabled && <span> (disabled)</span>}
      {filter.field.expression !== undefined && <details><summary>Filter measure definition</summary><pre>{filter.field.expression}</pre></details>}
    </li>)}</ul> : <p className="muted">No filters.</p>}
    <h4>Sort order ({definition.orderBy.length})</h4>
    {definition.orderBy.length ? <ol>{definition.orderBy.map(order => {
      const field = definition.fields.find(item => item.id === order.fieldId);
      return <li key={order.fieldId}>{field ? fieldLabel(field) : order.fieldId} <strong>{order.direction}</strong></li>;
    })}</ol> : <p className="muted">No sorting.</p>}
  </section>;
}

export function BuilderProposalReview({ current, proposal, stale, busy, error, onBack, onAccept, onReject }: {
  current: BuilderDefinition; proposal: BuilderProposal; stale: boolean; busy: boolean; error: string;
  onBack: () => void; onAccept: () => void; onReject: () => void;
}) {
  return <div className="builder-review" aria-label="Builder proposal review">
    <div className="builder-commandbar"><h2>Review builder changes</h2><button className="button quiet" onClick={onBack}>Back to builder</button></div>
    <div className="builder-review-scroll">
      <p className="builder-review-rationale">{proposal.rationale || "Review the proposed output fields, filters, sorting and generated DAX."}</p>
      <p className="muted">Based on query revision {proposal.baseRevision} and builder revision {proposal.baseBuilderRevision}.</p>
      {error && <p className="warning-text" role="alert">{error}</p>}
      {stale && <p className="warning-text" role="status">Your query or builder has changed, or local edits are unfinished. Preserve those edits and request a fresh proposal.</p>}
      <div className="builder-review-columns"><DefinitionSummary definition={current} title="Current selections"/><DefinitionSummary definition={proposal.definition} title="Proposed selections"/></div>
      <details className="builder-review-dax"><summary>Proposed generated DAX</summary><pre>{proposal.query}</pre></details>
    </div>
    <div className="builder-review-actions"><p>Accept changes builder selections only. Your editor stays unchanged, Auto Update turns off, and nothing runs.</p><div className="button-row">
      <button className="button" disabled={busy} onClick={onReject}>Reject proposal</button>
      <button className="button primary" disabled={busy || stale} onClick={onAccept}>{busy ? "Saving..." : "Accept selections"}</button>
    </div></div>
  </div>;
}
