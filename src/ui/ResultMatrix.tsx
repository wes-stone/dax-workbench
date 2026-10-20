import { useMemo } from "react";
import type { LoadedRows } from "./Grid";
import type { MatrixConfig } from "../contracts/dashboards";
import type { Cell } from "../contracts/workbench";
import { matrixResult, numericColumn } from "../shared/result-analysis.mjs";
import { decimalParts } from "../shared/result-numbers.mjs";
import { errorMessage } from "./api";
import { displayCell } from "./model";

type Matrix = ReturnType<typeof matrixResult>;
const shown = (value: Cell | undefined, dataType?: string) => value === undefined ? "(absent)" : value === null ? "(null)" : value === "" ? '""' : displayCell(value, dataType);
export function MatrixTable({ matrix, emphasizeNegative, numeric, rowType, columnType, valueType }: {
  matrix: Matrix; emphasizeNegative: boolean; numeric: boolean; rowType?: string; columnType?: string; valueType?: string;
}) {
  return <div className="result-matrix"><table><thead><tr><th>Row dimension</th>{matrix.columns.map((item, index) => <th key={index} title={shown(item)}>{shown(item, columnType)}</th>)}</tr></thead>
    <tbody>{matrix.rows.map((item, index) => <tr key={index}><th scope="row" title={shown(item.label)}>{shown(item.label, rowType)}</th>{item.values.map((cell, index) => <td key={index} title={shown(cell)}
      data-negative={emphasizeNegative && numeric && cell !== undefined && cell !== null && decimalParts(cell)?.negative || undefined}>
      {shown(cell, valueType)}</td>)}</tr>)}</tbody></table></div>;
}
export function SavedMatrix({ data, config }: { data: LoadedRows; config: MatrixConfig }) {
  const value = useMemo(() => {
    try { return { matrix: matrixResult(data, config.row, config.column, config.value, config.aggregation),
      interpretation: numericColumn(data, config.value) }; }
    catch (reason) { return { error: errorMessage(reason) }; }
  }, [data, config]);
  if (!value.matrix) return <p className="field-error" role="alert">{value.error}</p>;
  return <div className="result-analysis"><p>Aggregation: {config.aggregation}. Null and absent combinations are distinct. Values cover the saved capture only.</p>
    {value.interpretation?.reason && <p className="field-help">{value.interpretation.reason}</p>}
    <MatrixTable matrix={value.matrix} emphasizeNegative={config.emphasizeNegative}
      rowType={data.columns.find(column => column.id === config.row)?.dataType} columnType={data.columns.find(column => column.id === config.column)?.dataType}
      valueType={config.aggregation === "none" ? data.columns.find(column => column.id === config.value)?.dataType : undefined}
      numeric={config.aggregation !== "none" || Boolean(value.interpretation?.numeric)}/></div>;
}
