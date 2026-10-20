// @ts-check
import ExcelJS from "exceljs/dist/exceljs.min.js";
import { decimalParts, isNumeric } from "./result-numbers.mjs";
import { decimalCompare } from "./result-analysis.mjs";
import { resultColumnLabels } from "./result-columns.mjs";

export const EXCEL_CELL_LIMIT = 1_000_000;
export const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** @param {string} value @param {string} address */
function text(value, address) {
  if (value.length > 32767)
    throw new Error(`${address} exceeds Excel's 32,767-character cell limit. Use JSON to preserve the full value; no file was exported.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value))
    throw new Error(`${address} contains a character Excel cannot preserve. Use JSON; no file was exported.`);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
    throw new Error(`${address} contains invalid Unicode. Use JSON; no file was exported.`);
  return value;
}

/**
 * @param {import("../contracts/workbench").Cell} value
 * @param {import("../contracts/workbench").Column} column
 * @param {string} address
 */
function excelValue(value, column, address) {
  if (value === null || typeof value === "boolean") return { value, preserved: false };
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`${address} is not a supported result value.`);
  const original = String(value);
  const numeric = typeof value === "number" || isNumeric(column);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${address} is not a finite number.`);
  const parts = numeric ? decimalParts(value) : null;
  if (parts && original.length <= 1024) {
    const number = Number(value), significant = parts.digits.replace(/0+$/, "").length;
    if (significant <= 15 && Number.isFinite(number) && (number === 0 ? parts.zero : Math.abs(number) >= 1e-307 && Math.abs(number) < 1e308)
      && (!Number.isInteger(number) || Math.abs(number) < 1e15)
      && !/^[-+]?0\d/.test(original) && decimalCompare(original, String(number)) === 0) {
      return { value: number, preserved: false };
    }
  }
  return { value: text(original, address), preserved: Boolean(numeric) };
}

/**
 * @param {{ columns: import("../contracts/workbench").Column[], rows: import("../contracts/workbench").Cell[][] }} data
 * @param {import("../contracts/workbench").Run} run
 * @param {string} resultSetId
 * @param {{fullColumnNames?: boolean}} options
 */
export async function createResultWorkbook(data, run, resultSetId, { fullColumnNames = false } = {}) {
  const set = run.resultSets.find(item => item.id === resultSetId);
  if (!set || set.rowCount !== data.rows.length || JSON.stringify(set.columns) !== JSON.stringify(data.columns))
    throw new Error("The loaded rows do not match this captured result. Reload the result before exporting.");
  if (["queued", "connecting", "executing", "streaming", "cancelling"].includes(run.status))
    throw new Error("Wait for the run to finish before exporting.");
  if (!data.columns.length || data.columns.length > 16384 || data.rows.length > 1048575
    || (data.rows.length + 1) * data.columns.length > EXCEL_CELL_LIMIT)
    throw new Error("Excel export supports up to 1,000,000 cells including headers. Use CSV/JSON or refine the query explicitly; no rows were sampled.");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "DAX Workbench";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Results", { views: [{ state: "frozen", ySplit: 1 }] });
  const labels = resultColumnLabels(data.columns, fullColumnNames);
  const widths = labels.map(label => Math.min(48, Math.max(16, label.length + 3)));
  sheet.columns = data.columns.map((column, index) => ({ header: text(labels[index], "Column header"), width: widths[index] }));
  sheet.getRow(1).font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  sheet.getRow(1).alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(1).height = 30;
  data.columns.forEach((column, index) => {
    sheet.getCell(1, index + 1).note = `Source: ${text(column.name, "Source column name")}\nType: ${text(column.dataType, "Source column type")}`;
  });
  let preservedNumbers = 0;
  for (let index = 0; index < data.rows.length; index++) {
    if (index % 500 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const row = data.rows[index];
    if (!Array.isArray(row) || row.length !== data.columns.length) throw new Error(`Captured row ${index + 1} has an inconsistent width.`);
    const values = row.map((value, column) => {
      const converted = excelValue(value, data.columns[column], `Captured row ${index + 1}, column ${column + 1}`);
      if (converted.preserved) preservedNumbers++;
      widths[column] = Math.min(48, Math.max(widths[column], ...String(converted.value ?? "").split(/\r\n|\r|\n/).map(line => Math.min(48, line.length + 2))));
      return converted.value;
    });
    const added = sheet.addRow(values);
    added.font = { name: "Calibri", size: 11 };
    added.eachCell(cell => { if (typeof cell.value === "string") cell.numFmt = "@"; });
  }
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: data.rows.length + 1, column: data.columns.length } };
  const details = workbook.addWorksheet("Export details");
  details.columns = [{ header: "Property", width: 32 }, { header: "Value", width: 100 }];
  const partial = run.truncated || set.truncated || run.status !== "completed";
  /** @type {[string, string | number][]} */
  const metadata = [
    ["Scope", partial ? `Partial/capped capture (${run.status}); not the full query or model.` : "Complete captured result; not the full model."],
    ["Rows exported", data.rows.length], ["Columns exported", data.columns.length],
    ["Run ID", run.id], ["Result set ID", resultSetId], ["Query revision", run.revision],
    ["Connection ID", run.connectionId], ["Transport", run.connectionKind ?? "Unrecorded"],
    ["Run started", run.startedAt], ["Run status", run.status],
    ["Exported at", workbook.created.toISOString()],
    ["Operation", "Local export of all captured rows in original order. Ignores grid filters/sort and Explore aggregation. No query rerun or sharing."],
    ["Precision", "Excel numbers are limited to 15 significant digits. Values outside that precision/range are text, preserving the captured value."],
    ["Numeric cells kept as text", preservedNumbers],
    ["Text and dates", "Declared text and Variant strings stay text, including formula-like text. Timestamps stay exact text; no timezone conversion."],
    ["Null and empty", "Null is a blank cell; empty text is an explicit empty string. They may look alike in Excel."],
  ];
  for (const warning of run.warnings) metadata.push(["Run warning", warning]);
  if (run.error) metadata.push(["Run error", `${run.error.code}: ${run.error.message}`]);
  metadata.push(["Column headers", fullColumnNames ? "Full source names; duplicate names are disambiguated." : "Short captions; collisions retain source names or a numbered suffix. Source names and values are unchanged."]);
  metadata.push(["Column types", "Original provider types; no inferred model types."]);
  for (const [index, column] of data.columns.entries()) metadata.push([labels[index], `${column.name} (${column.dataType})`]);
  for (const [key, value] of metadata) {
    const row = details.addRow([text(key, "Export detail name"), typeof value === "string" ? text(value, "Export detail value") : value]);
    row.font = { name: "Calibri", size: 11 };
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell(cell => { if (typeof cell.value === "string") cell.numFmt = "@"; });
  }
  details.getRow(1).font = { name: "Calibri", size: 11, bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return { bytes: new Uint8Array(buffer), preservedNumbers, partial };
}
