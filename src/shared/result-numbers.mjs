/** @param {import("../contracts/workbench").Column} column */
export function isNumeric(column) {
  return /int|decimal|currency|double|float|numeric|number/i.test(column.dataType);
}

/** @param {import("../contracts/workbench").Column} column */
export function isVariant(column) {
  return /^(variant|object|system\.object)$/i.test(column.dataType);
}

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** @param {string} value */
export function isDecimalText(value) {
  return DECIMAL_PATTERN.test(value.trim());
}

/** @param {import("../contracts/workbench").Cell} value */
export function decimalParts(value) {
  const text = String(value).trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const digits = (match[2] + fraction).replace(/^0+/, "");
  const zero = digits.length === 0;
  const magnitude = zero ? 0n : BigInt(match[4] ?? "0") - BigInt(fraction.length) + BigInt(digits.length);
  return { negative: match[1] === "-" && !zero, digits, magnitude, zero };
}
