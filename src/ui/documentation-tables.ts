import type { Nodes, Root, RootContent, Table, TableCell } from "mdast";

function plainText(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(plainText).join("") : "";
}
function literal(node: RootContent): RootContent {
  return { ...node, data: { ...node.data, hProperties: { ...node.data?.hProperties, "data-research-literal": true } } };
}

function separators(text: string): { clauses: number[]; sentences: number[] } | null {
  const clauses: number[] = [], sentences: number[] = [], brackets: string[] = [];
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && (text[index + 1] === quote || text[index + 1] === "\\")) { index++; continue; }
      if (char === quote) {
        if (text[index + 1] === quote) index++;
        else quote = "";
      }
      continue;
    }
    if ((char === '"' || char === "'") && (index === 0 || /[\s=<>(,;:]/u.test(text[index - 1]))) { quote = char; continue; }
    if ("([{".includes(char)) brackets.push(char);
    else if (")]}".includes(char) && brackets.pop() !== ({ ")": "(", "]": "[", "}": "{" }[char])) return null;
    if (brackets.length) continue;
    if (char === ";") clauses.push(index);
    if (char === "." && (/^\s+\p{Lu}/u.test(text.slice(index + 1)) || !text.slice(index + 1).trim())) sentences.push(index);
  }
  return quote || brackets.length ? null : { clauses, sentences };
}

function splitAt(text: string, positions: number[], retainSeparator = false): string[] {
  let start = 0;
  const parts = positions.map(index => {
    const part = text.slice(start, index + (retainSeparator ? 1 : 0)).trim();
    start = index + 1;
    return part;
  });
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}

const noteStart = /^(?:(?:Product|Filter|Mapping|Adjustment) (?:literals|choices|values|definitions|assumptions|sources)\b|(?:The|These) (?:native descriptions|filters|mappings|adjustments|values|choices|query)\b|(?:Note|Source|Caveat|Assumption|Exclusion|Inclusion)s?\s*:|(?:All|Only|No)\b[^.]*\b(?:included|excluded)\b)/iu;
const paragraph = (value: string): RootContent => ({ type: "paragraph", children: [{ type: "text", value }] });

function notes(label: string, text: string): RootContent[] {
  if (!text) return [];
  const boundaries = separators(text)?.sentences ?? [];
  return [
    { type: "heading", depth: 3, children: [{ type: "text", value: label }] },
    ...splitAt(text, boundaries, true).map(paragraph),
  ];
}

function table(kind: "filters" | "scope", headers: string[], rows: string[][]): Table {
  const cell = (value: string, rowHeader: boolean): TableCell => ({
    type: "tableCell", children: [{ type: "text", value }],
    ...(rowHeader ? { data: { hName: "th", hProperties: { scope: "row" } } } : {}),
  });
  return {
    type: "table", align: headers.map(() => "left"),
    data: { hProperties: { "data-documentation-table": kind, "data-research-literal": true } },
    children: [
      { type: "tableRow", children: headers.map(value => cell(value, false)) },
      ...rows.map(row => ({ type: "tableRow" as const, children: row.map((value, index) => cell(value, index === 0)) })),
    ],
  };
}

function filters(text: string): RootContent[] | null {
  const body = text.replace(/^Filters:\s*/iu, ""), boundaries = separators(body);
  if (!boundaries) return null;
  const end = boundaries.sentences[0] ?? body.length;
  const tail = body.slice(end + 1).trim();
  // An unknown sentence may be part of an unquoted literal. Do not guess.
  if (tail && !noteStart.test(tail)) return null;
  const clauses = splitAt(body.slice(0, end), boundaries.clauses.filter(index => index < end));
  if (!clauses.length || clauses.length > 50) return null;
  const rows: string[][] = [];
  for (const clause of clauses) {
    const match = /^([^;=<>!\n]{1,100}?)\s*(<=|>=|<>|!=|=|<|>|\bnot in\b|\bin\b|\bis not\b|\bis\b)\s*(\S[\s\S]*)$/iu.exec(clause);
    if (!match || /(?:^|\s)(?:AND|OR)(?:\s|$)|&&|\|\|/iu.test(match[3])) return null;
    rows.push(match.slice(1).map(value => value.trim()));
  }
  return [table("filters", ["Filter", "Operator", "Value(s)"], rows), ...notes("Filter notes", tail)];
}

function scope(text: string): RootContent[] | null {
  const boundaries = separators(text);
  if (!boundaries) return null;
  const sentences = splitAt(text, boundaries.sentences, true), rows: string[][] = [];
  if (sentences.length > 20) return null;
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index];
    const label = /^(Grain|Period|Dates|Measures?|Units|Population):\s*([\s\S]+)$/iu.exec(sentence)
      ?? /^(Measures?)\s+(?:is|are)\s+([\s\S]+)$/iu.exec(sentence);
    if (label) rows.push([label[1], label[2]]);
    else if (/^Fixed month-start range\s+\S/iu.test(sentence)) rows.push(["Period", sentence]);
    else if (noteStart.test(sentence)) {
      if (rows.length < 2) return null;
      return [table("scope", ["Setting", "As documented"], rows), ...notes("Scope notes", sentences.slice(index).join(" "))];
    } else return null;
  }
  return rows.length >= 2 ? [table("scope", ["Setting", "As documented"], rows)] : null;
}

/** Presentation only. Rich Markdown and ambiguous clauses retain their original rendering. */
export function remarkDocumentationTables() {
  return (tree: Root) => {
    let filterDepth: number | null = null;
    tree.children = tree.children.flatMap((node): RootContent[] => {
      if (node.type === "heading") {
        if (filterDepth !== null && node.depth <= filterDepth) filterDepth = null;
        if (/^Filters?(?: changes)?$/iu.test(plainText(node))) filterDepth = node.depth;
        return [node];
      }
      const filterParagraph = node.type === "paragraph" && /^Filters:\s*\S/iu.test(plainText(node));
      const unchanged = filterParagraph || filterDepth !== null ? literal(node) : node;
      if (node.type !== "paragraph" || node.children.some(child => child.type !== "text")) return [unchanged];
      const text = node.children.map(child => child.type === "text" ? child.value : "").join("");
      if (text.length > 16384) return [unchanged];
      if (filterParagraph) {
        const rendered = filters(text);
        return rendered ? filterDepth !== null ? rendered.map(literal) : rendered : [unchanged];
      }
      if (/^Grain:\s*\S/iu.test(text)) {
        const rendered = scope(text);
        return rendered ? filterDepth !== null ? rendered.map(literal) : rendered : [unchanged];
      }
      return [unchanged];
    });
  };
}
