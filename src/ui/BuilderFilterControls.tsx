import { useId } from "react";
import type { BuilderFilter, QueryDocument, Snapshot } from "../contracts/workbench";
import type { Action } from "./useWorkbench";
import { CalendarRange, FilterValues } from "./FilterValues";
import { filterOperators, typeFamily } from "./builder-model";

export function BuilderFilterControls({ filter, document, latest, action, disabled, parametersSupported, parameterHelp, prepare, onChange, onCalendar, staged = false }: {
  filter: BuilderFilter; document: QueryDocument; latest: React.RefObject<Snapshot | null>; action: Action;
  disabled: boolean; parametersSupported: boolean; parameterHelp: string; prepare: () => Promise<void>;
  onChange: (update: Partial<BuilderFilter>) => void; onCalendar: (filters: [BuilderFilter, BuilderFilter]) => void; staged?: boolean;
}) {
  const operatorId = useId();
  const inactive = disabled || !filter.enabled;
  return <>
    <div className="builder-filter-inputs">
      <label className={staged ? "field-label filter-operator-label" : "sr-only"} htmlFor={operatorId}>{staged ? "Condition" : `Operator for ${filter.field.name}`}</label>
      <select id={operatorId} aria-label={`Operator for ${filter.field.name}`} value={filter.operator} disabled={inactive}
        onChange={event => onChange({ operator: event.target.value, isParameter2: event.target.value === "Between" ? filter.isParameter2 : false })}>
        {filterOperators(filter.field).filter(([value]) => !((filter.isParameter || filter.isParameter2) && ["In", "NotIn"].includes(value))).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
      {!["IsBlank", "IsNotBlank"].includes(filter.operator) && <FilterValue filter={filter} disabled={inactive} onChange={value => onChange({ value })}/>}
      {filter.operator === "Between" && <><span className="muted">and</span><input aria-label={`${filter.isParameter2 ? "Upper parameter name" : "Upper value"} for ${filter.field.name}`} disabled={inactive} value={filter.value2 ?? ""}
        onChange={event => onChange({ value2: event.target.value })} placeholder={filter.isParameter2 ? "Parameter name without @" : typeFamily(filter.field.dataType) === "date" ? "YYYY-MM-DD" : "Upper value"}/></>}
    </div>
    {!["IsBlank", "IsNotBlank"].includes(filter.operator) && <div className="builder-filter-parameters"><label className="check-field" title={parameterHelp}>
      <input type="checkbox" aria-label={`Use parameter for ${filter.field.name}`} checked={filter.isParameter ?? false} disabled={inactive || (!parametersSupported && !filter.isParameter)}
        onChange={event => onChange({ isParameter: event.target.checked, operator: event.target.checked && ["In", "NotIn"].includes(filter.operator) ? filter.operator === "In" ? "Is" : "IsNot" : filter.operator })}/>Parameter</label>
      {filter.operator === "Between" && <label className="check-field" title={parameterHelp}><input type="checkbox" aria-label={`Use upper parameter for ${filter.field.name}`} checked={filter.isParameter2 ?? false}
        disabled={inactive || (!parametersSupported && !filter.isParameter2)} onChange={event => onChange({ isParameter2: event.target.checked })}/>Upper parameter</label>}
    </div>}
    {!parametersSupported && (filter.isParameter || filter.isParameter2) && <p className="field-help warning-text">{parameterHelp} Disable parameter mode or choose ADOMD before running.</p>}
    {["In", "NotIn"].includes(filter.operator) && <p className="field-help">One value per line. Paste a list directly; values are quoted as literals. Empty lines mean empty text, not blank.</p>}
    {staged && typeFamily(filter.field.dataType) === "number" && <p className="field-help">Enter exact numeric text, without grouping commas. Decimal and large integer values are not rounded.</p>}
    {filter.field.kind === "column" && !filter.isParameter && !filter.isParameter2 && <>
      <FilterValues filter={filter} document={document} latest={latest} action={action} disabled={inactive} prepare={prepare} onApply={onChange} staged={staged}/>
      {typeFamily(filter.field.dataType) === "date" && !filter.id.startsWith("calendar:") && <CalendarRange filter={filter} disabled={inactive} onApply={onCalendar}/>}
    </>}
  </>;
}

function FilterValue({ filter, disabled, onChange }: { filter: BuilderFilter; disabled: boolean; onChange: (value: string) => void }) {
  const label = `Filter value for ${filter.field.name}`;
  if (filter.isParameter) return <input aria-label={`Parameter name for ${filter.field.name}`} value={filter.value} disabled={disabled} onChange={event => onChange(event.target.value)} spellCheck={false} placeholder="Parameter name without @"/>;
  if (["In", "NotIn"].includes(filter.operator) || /[\r\n]/.test(filter.value)) return <textarea aria-label={label} rows={3} value={filter.value} disabled={disabled} onChange={event => onChange(event.target.value)} spellCheck={false}/>;
  if (typeFamily(filter.field.dataType) === "boolean") return <select aria-label={label} value={filter.value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">Choose value</option><option value="true">True</option><option value="false">False</option></select>;
  return <input aria-label={label} value={filter.value} disabled={disabled} onChange={event => onChange(event.target.value)} spellCheck={false} placeholder={typeFamily(filter.field.dataType) === "date" ? "YYYY-MM-DD or ISO datetime" : typeFamily(filter.field.dataType) === "number" ? "Exact numeric value" : "Text value (empty string allowed)"}/>;
}
