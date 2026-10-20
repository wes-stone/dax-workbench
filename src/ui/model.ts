import type { Cell, ModelObject, QueryDocument, Run } from "../contracts/workbench";
import { decimalParts } from "./result-numbers.mjs";
import { resultValueText } from "../shared/result-display.mjs";
export { isNumeric } from "./result-numbers.mjs";

export const RUNNING = new Set<Run["status"]>(["queued", "connecting", "executing", "streaming", "cancelling"]);
export const SYNTHETIC_QUERY = "// Synthetic example · requires the Demo connection\nEVALUATE 'Demo Sales'";

export function connectionKindLabel(kind?: string): string {
  if (kind === "powerbi-rest") return "Power BI REST";
  if (kind === "windows-msolap") return "Windows MSOLAP / OLE DB";
  if (kind === "msolap" || kind === "desktop") return "XMLA / ADOMD";
  if (kind === "synthetic") return "Synthetic";
  return kind ?? "Transport not recorded";
}

export function schemaGroup(object: ModelObject) {
  const table = object.kind === "table" ? object.name : object.table;
  if (table) return { key: `table:${table}`, name: table, kind: "table" as const };
  const names = { table: "Tables", column: "Columns (table not exposed)", measure: "Measures (table not exposed)", relationship: "Relationships" };
  return { key: `unassigned:${object.kind}`, name: names[object.kind], kind: object.kind };
}

export function displayCell(value: Cell, dataType?: string): string {
  if (value === null) return "BLANK";
  if (value === "") return '""';
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return resultValueText(value, dataType);
}

export function compareCells(a: Cell, b: Cell, numeric: boolean): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (numeric) {
    const left = decimalParts(a), right = decimalParts(b);
    if (left && right) {
      if (left.negative !== right.negative) return left.negative ? -1 : 1;
      const sign = left.negative ? -1 : 1;
      if (left.zero || right.zero) return left.zero === right.zero ? 0 : left.zero ? -1 : 1;
      if (left.magnitude !== right.magnitude) return sign * (left.magnitude < right.magnitude ? -1 : 1);
      const length = Math.max(left.digits.length, right.digits.length);
      const a = left.digits.padEnd(length, "0"), b = right.digits.padEnd(length, "0");
      return a === b ? 0 : sign * (a < b ? -1 : 1);
    }
  }
  return String(a).localeCompare(String(b), undefined, { numeric: !numeric });
}

export function parseParameters(text: string): { value?: QueryDocument["parameters"]; error?: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { error: "Parameters must be a JSON object, for example { \"Year\": 2026 }." };
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!key.trim()) return { error: "Parameter names cannot be empty." };
      const values = Array.isArray(entry) ? entry : [entry];
      for (const [index, item] of values.entries()) {
        const name = Array.isArray(entry) ? `${key}[${index}]` : key;
        if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
          return { error: `“${name}” must be a string, number, boolean, or null. Parameter arrays may contain primitives only, not nested arrays or objects.` };
        }
        if (typeof item === "number" && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) {
          return { error: `“${name}” is not a safe JavaScript number. Use a quoted string to preserve its precision.` };
        }
      }
    }
    return { value: value as QueryDocument["parameters"] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid JSON." };
  }
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function scopeLabel(truncated: boolean, count: number): string {
  return `${truncated ? "Capped preview" : "Complete result"} · ${count.toLocaleString()} rows`;
}
