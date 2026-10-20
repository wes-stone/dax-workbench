import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent, DataZoomComponent, AriaComponent, LegendComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Cell, ChartConfig } from "../contracts/workbench";
import type { ArtifactVisual } from "../contracts/artifacts";
import type { LoadedRows } from "./Grid";
import { isNumeric, scopeLabel } from "./model";
import { darkTheme, onThemeChange, themeColor } from "./theme";
import { prepareChart, captureChart } from "../shared/chart-data.mjs";
import { ChartFilters } from "./ChartFilters";
import { errorMessage } from "./api";
import { resultColumnLabelMap } from "../shared/result-columns.mjs";

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, TooltipComponent, DataZoomComponent, AriaComponent, LegendComponent, CanvasRenderer]);

export type VisualCapture = Pick<ArtifactVisual, "config" | "columns" | "rows"> & { approximate: boolean; scope: string };
export function LocalChart({ data, truncated, initial, onSave, onCapture, onDisplayed, readOnly = false, valueDomain, onSelectCategory }: {
  data: LoadedRows; truncated: boolean; initial: ChartConfig | null; onSave: (config: ChartConfig) => void | Promise<unknown>;
  onCapture?: (visual: VisualCapture) => void; readOnly?: boolean;
  onDisplayed?: (config: ChartConfig | null) => void;
  valueDomain?: [number, number];
  onSelectCategory?: (value: Cell) => void;
}) {
  const chartElement = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const selectCategory = useRef(onSelectCategory); selectCategory.current = onSelectCategory;
  const [exportError, setExportError] = useState("");
  const [applyError, setApplyError] = useState(""), [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const labels = useMemo(() => resultColumnLabelMap(data.columns), [data.columns]);
  const [config, setConfig] = useState<ChartConfig>(() => ({
    ...initial,
    type: initial?.type ?? "bar", x: initial?.x ?? data.columns[0]?.id ?? "",
    y: initial?.y ?? data.columns.find(isNumeric)?.id ?? "",
    aggregation: initial?.aggregation ?? "none",
  }));
  const [applied, setApplied] = useState<ChartConfig>(config);
  const prepared = useMemo(() => {
    try { return { model: prepareChart(data, applied), error: "" }; }
    catch (reason) { return { model: undefined, error: errorMessage(reason) }; }
  }, [applied, data]);
  const model = prepared.model;
  const visible = model?.series.filter(series => series.visible) ?? [];
  const visiblePoints = visible.reduce((count, series) => count + series.points.length, 0);
  const chartLabel = `${applied.type} chart, ${visiblePoints} points, ${visible.length} visible series, ${applied.aggregation} aggregation`;
  const dirty = JSON.stringify(config) !== JSON.stringify(applied);
  const legendSelection = () => Object.fromEntries(model?.series.map(series => [series.label, series.visible]) ?? []);
  const changeVisibility = useRef<(labels: Record<string, boolean>) => void>(() => {});
  changeVisibility.current = selected => {
    if (!model) return;
    if (pending.current) { chartInstance.current?.setOption({ legend: { selected: legendSelection() } }); return; }
    const currentKeys = new Set(model.series.map(series => series.key));
    const absent = (applied.hiddenSeries ?? []).filter(value => !currentKeys.has(JSON.stringify(value)));
    void commit({ ...applied, hiddenSeries: [...absent, ...model.series.filter(series => selected[series.label] === false).map(series => series.value)] }, false);
  };
  useEffect(() => { onDisplayed?.(prepared.error || !visiblePoints ? null : applied); }, [onDisplayed, applied, prepared.error, visiblePoints]);

  async function commit(next: ChartConfig, replaceDraft = true) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setApplyError("");
    try {
      prepareChart(data, next);
      if (!readOnly) await onSave(next);
      setApplied(structuredClone(next));
      setConfig(current => replaceDraft ? structuredClone(next) : current.legend === next.legend ? { ...current, hiddenSeries: next.hiddenSeries } : current);
    } catch (reason) {
      setApplyError(errorMessage(reason));
      chartInstance.current?.setOption({ legend: { selected: legendSelection() } });
    } finally { pending.current = false; setBusy(false); }
  }

  useEffect(() => {
    if (!chartElement.current || !model?.pointCount) return;
    const element = chartElement.current;
    const instance = echarts.init(element);
    chartInstance.current = instance;
    function render() {
      const style = getComputedStyle(document.documentElement);
      const fg = themeColor("--wb-muted", "#656d76");
      const line = themeColor("--wb-border", "#d1d9e0");
      const accent = themeColor("--wb-accent", "#0969da");
      const colors = darkTheme() ? [accent, "#b392f0", "#56d4dd", "#f2a85e", "#f778ba", "#a8cc60", "#ff938a", "#a8b9cc"]
        : [accent, "#8250df", "#087f8c", "#a65e00", "#bf3989", "#527600", "#bf4236", "#576b86"];
      instance.setOption({
        backgroundColor: themeColor("--wb-bg", "#ffffff"),
        textStyle: { fontFamily: style.getPropertyValue("--sans").trim() },
        animation: !matchMedia("(prefers-reduced-motion: reduce)").matches,
        animationDuration: 220, aria: { enabled: true, label: { description: chartLabel } },
        legend: { type: "scroll", top: 4, left: 16, right: 16, textStyle: { color: fg }, pageTextStyle: { color: fg },
          pageIconColor: fg, selected: Object.fromEntries(model!.series.map(series => [series.label, series.visible])) },
        grid: { left: 78, right: 30, top: 62, bottom: 76 },
        tooltip: { trigger: "item", confine: true, renderMode: "richText" },
        xAxis: { type: applied.type === "scatter" ? "value" : "category", data: applied.type === "scatter" ? undefined : model!.categories.map(category => category.label), axisLabel: { color: fg, hideOverlap: true }, axisLine: { lineStyle: { color: line } }, name: labels.get(applied.x), nameLocation: "middle", nameGap: 48, nameTextStyle: { color: fg } },
        yAxis: { type: "value", ...(valueDomain ? { min: valueDomain[0], max: valueDomain[1] } : {}), axisLabel: { color: fg, formatter: (value: number) => new Intl.NumberFormat("en-US", { notation: Math.abs(value) >= 10000 ? "compact" : "standard", maximumFractionDigits: 2 }).format(value) }, splitLine: { lineStyle: { color: line, type: "dashed" } }, name: applied.aggregation === "count" ? "Count" : labels.get(applied.y), nameTextStyle: { color: fg } },
        dataZoom: model!.categories.length > 30 ? [{ type: "inside" }, { type: "slider", height: 14, bottom: 8, borderColor: line }] : [],
        series: model!.series.map(series => {
          const coordinates = new Map(series.points.map(point => [point.category, point.y]));
          return { id: series.key, name: series.label, type: applied.type,
            data: applied.type === "scatter" ? series.points.map(point => [Number(point.x), point.y])
              : model!.categories.map((_, index) => coordinates.get(index) ?? null),
            itemStyle: { color: colors[series.colorIndex % colors.length] }, lineStyle: { width: 2 },
            connectNulls: false, symbolSize: applied.type === "scatter" ? 6 : 4, barMaxWidth: 42,
            large: applied.type === "scatter", progressive: 2000 };
        }),
      });
    }
    render();
    instance.on("legendselectchanged", event => {
      if (event && typeof event === "object" && "selected" in event && event.selected && typeof event.selected === "object")
        changeVisibility.current(Object.fromEntries(Object.entries(event.selected).map(([label, selected]) => [label, selected === true])));
    });
    instance.on("click", (event: { dataIndex?: number }) => {
      if (!selectCategory.current || applied.type === "scatter" || !Number.isInteger(event.dataIndex)) return;
      const category = model.categories[event.dataIndex!];
      if (!category) return;
      setExportError(""); selectCategory.current(category.value);
    });
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(element);
    const stopTheme = onThemeChange(render);
    return () => { resize.disconnect(); stopTheme(); instance.dispose(); chartInstance.current = null; };
  }, [model, applied, labels, valueDomain?.[0], valueDomain?.[1]]);

  function capture() {
    if (!onCapture || !visiblePoints) return;
    try { onCapture(captureChart(data, applied)); }
    catch (reason) { setExportError(errorMessage(reason)); }
  }
  function exportImage() {
    setExportError("");
    try {
      if (!chartInstance.current) throw new Error("The chart is not ready. Wait for it to render before downloading.");
      const link = document.createElement("a");
      link.href = chartInstance.current.getDataURL({ type: "png", pixelRatio: 2 });
      link.download = "dax-visual.png"; document.body.append(link); link.click(); link.remove();
    } catch (reason) { setExportError(reason instanceof Error ? reason.message : "Could not export the chart. Retry after it finishes rendering."); }
  }
  return <div className="chart-panel">
    {!readOnly && <fieldset className="chart-editor" disabled={busy}><div className="chart-config">
      <label>Chart<select value={config.type} onChange={event => setConfig({ ...config, type: event.target.value as ChartConfig["type"],
        ...(event.target.value === "scatter" ? { aggregation: "none" } : {}) })}><option value="bar">Bar</option><option value="line">Line</option><option value="scatter">Scatter</option></select></label>
      <label>X field<select value={config.x} onChange={event => setConfig({ ...config, x: event.target.value })}><option value="">Choose field</option>{data.columns.map(column => <option key={column.id} value={column.id} title={column.name}>{labels.get(column.id)}</option>)}</select></label>
      <label>Y field<select value={config.y} disabled={config.aggregation === "count"} onChange={event => setConfig({ ...config, y: event.target.value })}><option value="">Choose numeric field</option>{data.columns.filter(isNumeric).map(column => <option key={column.id} value={column.id} title={column.name}>{labels.get(column.id)}</option>)}</select></label>
      <label>Legend / series<select value={config.legend ?? ""} onChange={event => {
        const { legend: _legend, hiddenSeries: _hidden, ...rest } = config;
        setConfig({ ...rest, ...(event.target.value ? { legend: event.target.value } : {}) });
      }}><option value="">One series</option>{data.columns.map(column => <option key={column.id} value={column.id} title={column.name}>{labels.get(column.id)}</option>)}</select></label>
      <label>Aggregation<select value={config.aggregation} disabled={config.type === "scatter"} onChange={event => setConfig({ ...config, aggregation: event.target.value as ChartConfig["aggregation"] })}><option value="none">None · individual rows</option><option value="sum">Sum by X and series</option><option value="average">Average by X and series</option><option value="count">Count by X and series</option></select></label>
      <button className={`button ${dirty ? "primary" : ""}`} onClick={() => void commit(config)}>{busy ? "Applying..." : "Apply chart"}</button>
    </div><ChartFilters data={data} filters={config.filters ?? []} onChange={filters => setConfig({ ...config, filters })}/>
      {dirty && <p className="chart-scope" role="status">Unapplied changes. Apply chart to update the plotted view; saves and pins use the displayed chart.</p>}
    </fieldset>}
    {applyError && <p className="field-error chart-scope" role="alert">{applyError}</p>}
    <div className="chart-scope">{readOnly ? `${data.rows.length.toLocaleString()} saved rows${truncated ? " · capped source" : ""}` : scopeLabel(truncated, data.rows.length)}
      {model && ` · ${model.filteredRows.length.toLocaleString()} rows match ${applied.filters?.length ?? 0} chart filters`}. Grid/export scope is unchanged. No query is rerun.</div>
    {model && model.series.length > 0 && <div className="chart-series">
      <details><summary>Series visibility · {visible.length} of {model.series.length} shown</summary>
        <fieldset disabled={busy}><legend>Show or hide plotted series</legend>
          {model.series.map(series => <label key={series.key} title={series.value === null ? "(blank)" : String(series.value)}><input type="checkbox" checked={series.visible}
            onChange={event => changeVisibility.current({ ...legendSelection(), [series.label]: event.target.checked })}/>{series.label}</label>)}
        </fieldset>
      </details>
      {visible.length !== model.series.length && <button className="text-button" disabled={busy} onClick={() => void commit({ ...applied, hiddenSeries: [] }, false)}>Show all series</button>}
      <span>Click legend items to hide or show.</span>
    </div>}
    {prepared.error ? <div className="empty-state compact-empty" role="alert"><h3>Adjust the chart</h3><p>{prepared.error}</p></div>
      : !model?.pointCount ? <div className="empty-state compact-empty"><h3>{model?.filteredRows.length === 0 ? "No rows match these filters" : "No plottable values"}</h3><p>Change the chart filters or choose nonblank numeric fields. The captured result is unchanged.</p></div>
      : <><div ref={chartElement} className="echart" role="img" aria-label={chartLabel} />
        {!visiblePoints && <p className="chart-scope" role="status">All series are hidden. Use Show all series to restore the chart.</p>}</>}
    {(model?.precision || model?.skipped) ? <div className="chart-caution">{model.precision ? `Chart coordinates use approximate JavaScript numbers; ${readOnly ? "Exact data below preserves the captured values" : "the grid and result exports preserve exact source values"}. ` : ""}{model.skipped ? `${model.skipped.toLocaleString()} matching rows with blank or nonnumeric coordinates omitted.` : ""}</div> : null}
    <div className="chart-artifact-actions">
      {onCapture && <button className="button small" disabled={busy || !visiblePoints} onClick={capture}>Save visual to Artifacts</button>}
      <button className="button quiet small" disabled={busy || !visiblePoints} onClick={exportImage}>Download PNG</button>
    </div>
    {exportError && <p className="field-error" role="alert">{exportError}</p>}
  </div>;
}
