import type { Cell, Column } from "../contracts/workbench";
import type { GridSelection } from "./result-grid-model";
import { decimalParts, isNumeric, isVariant, isDecimalText } from "./result-numbers.mjs";

export interface SelectionSum { sum: string | null; numericCount: number; inferredCount: number }
const MAX_DIGITS = 1000;
const precisionError = () => new Error("Selected numbers exceed the 1,000-digit sum limit.");
const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export async function sumSelectedCells(data: { columns: Column[]; rows: Cell[][] }, viewRows: number[],
  selection: GridSelection, signal?: AbortSignal, yieldControl = yieldToBrowser): Promise<SelectionSum> {
  const groups = new Map<number, bigint>();
  const parsed = new Map<string, { coefficient: bigint; exponent: number }>();
  let numericCount = 0, inferredCount = 0, visited = 0;
  await yieldControl();
  signal?.throwIfAborted();
  let deadline = performance.now() + 4;
  for (const range of selection.ranges) {
    for (let column = range.left; column <= Math.min(range.right, data.columns.length - 1); column++) {
      const inferred = isVariant(data.columns[column]);
      if (!isNumeric(data.columns[column]) && !inferred) continue;
      for (let row = range.top; row <= Math.min(range.bottom, viewRows.length - 1); row++) {
        if (++visited % 256 === 0) {
          signal?.throwIfAborted();
          if (visited % 8192 === 0 || performance.now() >= deadline) {
            await yieldControl(); signal?.throwIfAborted();
            deadline = performance.now() + 4;
          }
        }
        const value = data.rows[viewRows[row]][column];
        if (value === null || typeof value === "boolean") continue;
        // Variant decimals/Int64 arrive as exact strings, but Variant text is also valid.
        if (inferred && typeof value === "string" && !isDecimalText(value)) continue;
        if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))
          throw new Error("A selected numeric cell is outside JavaScript's safe integer range. Return exact numeric strings from the provider.");
        const text = String(value);
        let number = parsed.get(text);
        if (!number) {
          if (text.length > MAX_DIGITS + 24) throw precisionError();
          const parts = decimalParts(value);
          if (!parts) throw new Error("A selected numeric cell is not a finite decimal.");
          const exponent = parts.zero ? 0n : parts.magnitude - BigInt(parts.digits.length);
          if (parts.digits.length > MAX_DIGITS || exponent < -MAX_DIGITS || exponent > MAX_DIGITS) throw precisionError();
          number = { coefficient: parts.zero ? 0n : BigInt(parts.digits) * (parts.negative ? -1n : 1n), exponent: Number(exponent) };
          if (parsed.size < 2048) parsed.set(text, number);
        }
        groups.set(number.exponent, (groups.get(number.exponent) ?? 0n) + number.coefficient);
        numericCount++;
        if (inferred) inferredCount++;
      }
    }
  }
  signal?.throwIfAborted();
  const nonzero = [...groups].filter(([, coefficient]) => coefficient !== 0n);
  if (!nonzero.length) return { sum: numericCount ? "0" : null, numericCount, inferredCount };
  const exponent = Math.min(...nonzero.map(([power]) => power));
  let total = 0n;
  for (const [power, coefficient] of nonzero) {
    const length = (coefficient < 0n ? -coefficient : coefficient).toString().length;
    // Bound exponent expansion before allocating a large BigInt or display string.
    if (length + power - Math.min(exponent, 0) > MAX_DIGITS) throw precisionError();
    total += coefficient * 10n ** BigInt(power - exponent);
  }
  if (!total) return { sum: "0", numericCount, inferredCount };
  let digits = (total < 0n ? -total : total).toString();
  if (digits.length + Math.max(exponent, 0) > MAX_DIGITS) throw precisionError();
  if (exponent >= 0) digits += "0".repeat(exponent);
  else {
    digits = digits.padStart(1 - exponent, "0");
    digits = `${digits.slice(0, exponent)}.${digits.slice(exponent)}`.replace(/0+$/, "").replace(/\.$/, "");
  }
  return { sum: (total < 0n ? "-" : "") + digits, numericCount, inferredCount };
}

export function formatSelectionSum(sum: string, locale?: string): string {
  const [integer, fraction] = sum.split(".");
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const grouped = formatter.format(integer === "-0" ? -0 : BigInt(integer));
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === "decimal")?.value ?? ".";
  return fraction ? `${grouped}${decimal}${fraction}` : grouped;
}
