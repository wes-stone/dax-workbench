import type { PivotFormat, PivotValue } from "../contracts/pivot";
import { PIVOT_FORMATS } from "../shared/pivot-config.mjs";

export function PivotFormatControls({ values, label, onChange }: {
  values: PivotValue[]; label: string; onChange: (values: PivotValue[]) => void;
}) {
  const format = values.length && values.every(value => value.format === values[0].format) ? values[0].format : "";
  const precision = values.length && values.every(value => (value.decimalPlaces ?? 2) === (values[0].decimalPlaces ?? 2))
    ? values[0].decimalPlaces ?? 2 : null;
  const canRound = values.length > 0 && values.every(value => value.format !== "exact");
  const changeDecimals = (delta: number) => onChange(values.map(value => ({
    ...value, decimalPlaces: Math.max(0, Math.min(12, (value.decimalPlaces ?? 2) + delta)),
  })));
  return <div className="pivot-format-controls">
    <select aria-label={label} title="Display format; exact values and copied data are unchanged" value={format} disabled={!values.length}
      onChange={event => onChange(values.map(value => ({ ...value, format: event.target.value as PivotFormat })))}>
      {!format && <option value="" disabled>{values.length ? "Mixed formats" : "Add a value"}</option>}
      {Object.entries(PIVOT_FORMATS).map(([id, text]) => <option key={id} value={id}>{text}</option>)}
    </select>
    <div className="pivot-decimals" role="group" aria-label="Decimal precision"
      title={canRound ? "Decimal places change display only (0 to 12)" : "Choose a rounded number format to adjust decimal places"}>
      <button className="button small quiet" aria-label="Decrease decimal places" title="Decrease decimal places"
        disabled={!canRound || !values.some(value => (value.decimalPlaces ?? 2) > 0)} onClick={() => changeDecimals(-1)}><span aria-hidden="true">−.0</span></button>
      <output aria-label="Decimal places">{!values.length ? "—" : !canRound ? format === "exact" ? "Exact" : "Mixed" : precision === null ? "Mixed" : `${precision} dp`}</output>
      <button className="button small quiet" aria-label="Increase decimal places" title="Increase decimal places"
        disabled={!canRound || !values.some(value => (value.decimalPlaces ?? 2) < 12)} onClick={() => changeDecimals(1)}><span aria-hidden="true">+.0</span></button>
    </div>
  </div>;
}
