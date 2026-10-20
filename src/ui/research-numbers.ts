import type { Nodes, Root, Text } from "mdast";

const decimal = /^([+-]?)((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+))\.(\d+)(%)?$/u;
const candidates = /[+-]?\d[\d,]*\.\d+%?/gu;

/**
 * Display-only, half-away-from-zero rounding without a floating-point conversion.
 * Integers/identifiers are ineligible. Tiny nonzero decimals retain their precision
 * rather than implying zero; signed source zero is normalized in readable mode.
 */
export function formatResearchDecimal(source: string): string | null {
  const match = decimal.exec(source);
  if (!match) return null;
  const [, sign, groupedInteger, fraction, percent = ""] = match;
  const integer = groupedInteger.replaceAll(",", "");
  let hundredths = BigInt(integer + fraction.slice(0, 2).padEnd(2, "0"));
  if (fraction.length > 2 && fraction[2] >= "5") hundredths += 1n;
  const nonzero = /[1-9]/u.test(integer + fraction);
  if (hundredths === 0n && nonzero) return `${sign}${integer}.${fraction}${percent}`;
  const digits = hundredths.toString().padStart(3, "0");
  const integerDigits = digits.slice(0, -2);
  const groups = [integerDigits.slice(0, integerDigits.length % 3 || 3)];
  for (let index = groups[0].length; index < integerDigits.length; index += 3) groups.push(integerDigits.slice(index, index + 3));
  const whole = groups.join(",");
  return `${hundredths === 0n && sign === "-" ? "" : sign}${whole}.${digits.slice(-2)}${percent}`;
}

function hasSafeBoundary(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? "";
  const after = text[end] ?? "";
  // Leave identifiers, versions, dates, scientific notation, paths and formulas
  // literal. A sentence-ending period/comma remains ordinary punctuation.
  if (/[\p{L}\p{N}\p{M}_./\\:@#%+\-=−]/u.test(before)) return false;
  if (/[\p{L}\p{N}\p{M}_/\\@#%+\-=−]/u.test(after)) return false;
  if (after === ":" && text[end + 1] && !/\s/u.test(text[end + 1])) return false;
  if ((after === "." || after === ",") && /[\p{L}\p{N}_]/u.test(text[end + 1] ?? "")) return false;
  if (/\b(?:version|release|build|ver|v|id|tpid)\s*[:#=]?\s*$/iu.test(text.slice(0, start))) return false;
  if (/[\p{L}\p{N}_]\($/u.test(text.slice(0, start))) return false;
  if (/^[12]\d{3}\.(?:0[1-9]|1[0-2])$/u.test(text.slice(start, end))) return false;
  return true;
}

/** Transform parsed prose only: source Markdown, code and link labels stay exact. */
export function researchNumberText(value: string, before = "", after = ""): Text[] {
  const result: Text[] = [];
  const context = before + value + after;
  let cursor = 0;
  for (const match of value.matchAll(candidates)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!hasSafeBoundary(context, before.length + start, before.length + end)) continue;
    const formatted = formatResearchDecimal(match[0]);
    if (formatted === null) continue;
    if (start > cursor) result.push({ type: "text", value: value.slice(cursor, start) });
    result.push({
      type: "text",
      value: formatted,
      data: { hName: "span", hProperties: { "data-research-number": match[0] } },
    });
    cursor = end;
  }
  if (cursor < value.length || !result.length) result.push({ type: "text", value: value.slice(cursor) });
  return result;
}

function plainCell(node: Nodes): string | null {
  if (node.type === "text") return node.value;
  if (node.type !== "tableCell" && node.type !== "strong" && node.type !== "emphasis" && node.type !== "delete") return null;
  const children = node.children.map(plainCell);
  return children.includes(null) ? null : children.join("");
}

function inlineText(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(inlineText).join("") : " ";
}

export function remarkResearchNumbers() {
  return (tree: Root) => {
    function walk(node: Nodes, prose = false, before = "", after = ""): void {
      if (node.data?.hProperties?.["data-research-literal"] === true) return;
      if (node.type === "link" || node.type === "linkReference" || !("children" in node)) return;
      const insideProse = prose || node.type === "paragraph" || node.type === "tableCell";
      if (node.type === "tableCell") {
        const text = plainCell(node);
        const parts = text === null ? [] : researchNumberText(text.trim());
        if (parts.length === 1 && parts[0].data?.hName === "span") {
          node.data = {
            ...node.data,
            hProperties: { ...node.data?.hProperties, className: ["research-numeric-cell"], align: "right" },
          };
        }
      }
      const sources = insideProse ? node.children.map(inlineText) : [];
      const following: string[] = [];
      let suffix = prose ? after.slice(0, 80) : "";
      for (let index = sources.length - 1; index >= 0; index--) {
        following[index] = suffix;
        suffix = (sources[index] + suffix).slice(0, 80);
      }
      let prefix = prose ? before : "";
      node.children = node.children.flatMap((child, index) => {
        const suffix = following[index] ?? "";
        const preceding = prefix;
        prefix = (prefix + (sources[index] ?? "")).slice(-80);
        if (insideProse && child.type === "text") return researchNumberText(child.value, preceding, suffix);
        walk(child, insideProse, preceding, suffix);
        return [child];
      }) as typeof node.children;
    }
    walk(tree);
  };
}
