import { useMemo } from "react";
import type { Cell } from "../contracts/workbench";
import type { LoadedRows } from "./Grid";
import type { AdvancedVisualConfig } from "../contracts/dashboards";
import { prepareFacets, prepareWaterfall } from "../shared/advanced-visuals.mjs";
import { errorMessage } from "./api";
import { LocalChart } from "./Chart";

const label = (value: Cell) => JSON.stringify(value);
export function AdvancedVisual({ data, config }: { data: LoadedRows; config: AdvancedVisualConfig }) {
  const prepared = useMemo(() => {
    try {
      return config.type === "waterfall" ? { waterfall: prepareWaterfall(data, config) } : { facets: prepareFacets(data, config) };
    } catch (reason) { return { error: errorMessage(reason) }; }
  }, [data, config]);
  if (prepared.error) return <p className="field-error" role="alert">{prepared.error}</p>;
  if (prepared.facets) return <div className="small-multiples">
    <p>Common value-axis scale; category positions stay local to each group. Chart coordinates are approximate. Exact source data remains available.</p>
    <div className="facet-grid">{prepared.facets.facets.map((facet, index) => <section key={index} aria-label={`Group ${label(facet.value)}`}>
      <h4>{label(facet.value)}</h4>
      <LocalChart data={{ columns: data.columns, rows: facet.rows }} truncated={false}
        initial={{ type: "bar", x: config.x, y: config.y, aggregation: "none" }} readOnly onSave={() => {}}
        valueDomain={[prepared.facets.minimum, prepared.facets.maximum]}/>
    </section>)}</div>
  </div>;
  const waterfall = prepared.waterfall;
  if (!waterfall) return null;
  const width = Math.max(480, waterfall.points.length * 84 + 100), height = 260;
  const y = (value: string | number) => 205 - (Number(value) - waterfall.minimum) / (waterfall.maximum - waterfall.minimum) * 175;
  const zero = y(0);
  return <div className="waterfall">
    <p>Starts at {config.start}; each returned row is a signed change, not a total. Order is the source order. Coordinates are approximate; totals below use exact decimals.</p>
    <div className="waterfall-scroll" tabIndex={0} aria-label="Waterfall plot; scroll horizontally to inspect every step"><svg width={width} height={height} role="img" aria-label={`Waterfall with ${waterfall.points.length} signed changes, exact ending amount ${waterfall.total}`}>
      <line x1={70} x2={width - 20} y1={zero} y2={zero} stroke="currentColor"/>
      {Array.from({ length: 5 }, (_, i) => {
        const value = waterfall.minimum + (waterfall.maximum - waterfall.minimum) * i / 4, position = y(value);
        return <g key={i}><line x1={70} x2={width - 20} y1={position} y2={position} className="waterfall-grid"/>
          <text x={62} y={position + 4} textAnchor="end">{new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value)}</text></g>;
      })}
      {waterfall.points.map((point, i) => {
        const x = 80 + i * 84, top = Math.min(y(point.before), y(point.after)), bottom = Math.max(y(point.before), y(point.after));
        return <g key={i}><title>{`${label(point.label)}: ${point.change}; ${point.before} to ${point.after}`}</title>
          <rect x={x} y={top} width={44} height={bottom - top} className={point.negative ? "waterfall-decrease" : "waterfall-increase"}/>
          <text x={x + 22} y={top - 7} textAnchor="middle">{point.negative ? "−" : "+"}</text>
          <text x={x + 22} y={231} textAnchor="middle">{label(point.label).slice(0, 12)}{label(point.label).length > 12 ? "…" : ""}</text>
          {i < waterfall.points.length - 1 && <line x1={x + 44} x2={x + 84} y1={y(point.after)} y2={y(point.after)} className="waterfall-grid"/>}
        </g>;
      })}
    </svg></div>
    <p><strong>Exact ending amount: {waterfall.total}</strong></p>
    <details><summary>Exact waterfall steps</summary><table><thead><tr><th>Label</th><th>Before</th><th>Change</th><th>After</th></tr></thead>
      <tbody>{waterfall.points.map((point, i) => <tr key={i}><th scope="row">{label(point.label)}</th><td>{point.before}</td><td>{point.change}</td><td>{point.after}</td></tr>)}</tbody></table></details>
  </div>;
}
