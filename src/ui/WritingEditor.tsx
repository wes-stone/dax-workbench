import { useId, useMemo, useState } from "react";
import { validateWriting, WRITING_RULES, WRITING_TEMPLATES } from "../shared/writing.mjs";
import { DocumentationReader } from "./DocumentationReader";
import { WritingChecks } from "./WritingChecks";
import "./writing.css";

export function WritingEditor({ label, value, onChange, kind = "query", disabled = false, required = false, maxLength, rows = 10 }: {
  label: string; value: string; onChange: (value: string) => void;
  kind?: "query" | "research" | "note" | "journal"; disabled?: boolean; required?: boolean; maxLength: number; rows?: number;
}) {
  const id = useId();
  const template = WRITING_TEMPLATES.find(item => item.id === kind)!;
  const [replace, setReplace] = useState(false);
  const [undo, setUndo] = useState<string | null>(null), [preview, setPreview] = useState(false);
  const validation = useMemo(() => validateWriting(value, kind), [value, kind]);
  function apply() {
    setUndo(value); onChange(template.markdown); setReplace(false); setPreview(false);
  }
  return <div className="writing-editor">
    <div className="writing-tools">
      <span>Template: <strong>{template.title}</strong></span>
      <button className="button small" type="button" disabled={disabled || replace} onClick={() => value.trim() ? setReplace(true) : apply()}>Use template</button>
      {undo !== null && <button className="text-button" type="button" disabled={disabled || replace} onClick={() => { onChange(undo); setUndo(null); }}>Undo template</button>}
      <button className="button small quiet" type="button" disabled={disabled} aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? "Edit Markdown" : "Preview"}</button>
    </div>
    {replace && <div className="writing-confirm" role="group" aria-label="Replace documentation draft">
      <p>Replace the current text with a template? This changes only the unsaved draft. Undo remains available.</p>
      <button className="button small" type="button" disabled={disabled} onClick={apply}>Replace draft</button>
      <button className="button small quiet" type="button" disabled={disabled} onClick={() => setReplace(false)}>Keep draft</button>
    </div>}
    <label className="field-label" htmlFor={`${id}-text`}>{label}</label>
    <textarea id={`${id}-text`} hidden={preview} value={value} onChange={event => { onChange(event.target.value); setReplace(false); }}
      disabled={disabled} required={required && !preview} aria-required={required} rows={rows} maxLength={maxLength} aria-describedby={`${id}-help`}/>
    {preview && <div className="writing-preview" role="region" aria-label={`${label} preview`}><DocumentationReader text={value} kind={kind} showChecks={false}/></div>}
    <p className="field-help" id={`${id}-help`}>Use headings, short paragraphs, selective bold emphasis and compact tables. Replace template prompts with supported facts; leave unknowns explicit.</p>
    <WritingChecks validation={validation}/>
    <details className="writing-rules"><summary>Writing rules</summary><ul>{WRITING_RULES.map(rule => <li key={rule}>{rule}</li>)}</ul></details>
  </div>;
}
