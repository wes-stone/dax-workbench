import { useId, useMemo, useRef } from "react";
import { documentationSections } from "./documentation-model";
import { MarkdownPreview } from "./MarkdownPreview";
import { validateWriting } from "../shared/writing.mjs";
import type { WritingKind } from "../contracts/writing";
import { WritingChecks } from "./WritingChecks";
import "./writing.css";

export function DocumentationReader({ text, kind = "query", showChecks = true }: { text: string; kind?: WritingKind; showChecks?: boolean }) {
  const id = useId(), root = useRef<HTMLElement>(null);
  const sections = useMemo(() => documentationSections(text), [text]);
  const validation = useMemo(() => showChecks ? validateWriting(text, kind) : null, [text, kind, showChecks]);
  const headings = sections.map((section, index) => ({ ...section, index })).filter(section => section.title);
  return <article className="documentation-reader" ref={root}>
    {validation && <WritingChecks validation={validation}/>}
    {!text.trim() && <p>No documentation yet. Use the {kind} template and state missing evidence explicitly.</p>}
    {headings.length >= 3 && <nav className="documentation-contents" aria-label="Documentation contents">
      <label htmlFor={`${id}-section`}>Jump to</label>
      <select id={`${id}-section`} value="" onChange={event => {
        const target = root.current?.querySelector<HTMLElement>(`[data-documentation-section="${event.target.value}"]`);
        if (target instanceof HTMLDetailsElement) target.open = true;
        target?.scrollIntoView({ block: "start" }); target?.focus({ preventScroll: true });
      }}><option value="" disabled>Select a section</option>{headings.map(section => <option key={section.index} value={section.index}>{section.title}</option>)}</select>
    </nav>}
    {sections.map((section, index) => section.technical
      ? <details key={`${index}:${section.title}`} className="documentation-technical" data-documentation-section={index} tabIndex={-1}>
        <summary>{section.title}</summary><MarkdownPreview text={`${section.references}\n\n${section.body}`} readableParagraphs/>
      </details>
      : <section key={`${index}:${section.title}`} data-documentation-section={index} tabIndex={-1}>
        <MarkdownPreview text={`${section.references}\n\n${section.markdown}`} readableParagraphs/>
      </section>)}
    <details className="documentation-source"><summary>Original Markdown</summary>
      <p>Stored text is unchanged. Reading view spaces paragraphs, folds technical sections and arranges recognizable scope, filter clauses and movement watchlists into tables. Documented filters are not verified against the query. It never recalculates values or changes conclusions.</p>
      <pre tabIndex={0}>{text}</pre>
    </details>
  </article>;
}
