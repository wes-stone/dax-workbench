import type { Nodes, Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";

const parser = unified().use(remarkParse);
function plainText(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(plainText).join("") : "";
}
export interface DocumentationSection { title: string; markdown: string; body: string; technical: boolean; references: string }
export function documentationSections(text: string): DocumentationSection[] {
  const tree = parser.parse(text);
  const references = tree.children.filter(node => node.type === "definition")
    .map(node => text.slice(node.position!.start.offset, node.position!.end.offset)).join("\n\n");
  const result: DocumentationSection[] = [];
  let title = "", start = 0, bodyStart = 0;
  const flush = (end: number) => {
    if (end > start) result.push({ title, markdown: text.slice(start, end), body: text.slice(bodyStart, end), references,
      technical: /^(?:technical|execution|run|source) details$/iu.test(title) });
  };
  for (const node of tree.children) {
    if (node.type === "heading" && node.depth === 2) {
      const next = node.position!.start.offset!;
      flush(next); title = plainText(node);
      start = next; bodyStart = node.position!.end.offset!;
    }
  }
  flush(text.length);
  return result;
}

export function remarkReadableParagraphs() {
  return (tree: Root) => {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    tree.children = tree.children.flatMap((node): RootContent[] => {
      if (node.type !== "paragraph" || node.children.some(child => child.type !== "text")) return [node];
      if (node.data?.hProperties?.["data-research-literal"] === true) return [node];
      const classes = node.data?.hProperties?.className;
      if (Array.isArray(classes) && classes.includes("research-source-lines")) return [node];
      const text = node.children.map(child => child.type === "text" ? child.value : "").join("");
      if (text.length < 450) return [node];
      const groups: string[] = [];
      let current = "";
      for (const { segment } of segmenter.segment(text)) {
        if (current && (current.length + segment.length > 380 || (current + segment).split(/\s+/u).length > 60)) {
          groups.push(current); current = "";
        }
        current += segment;
      }
      if (current) groups.push(current);
      return groups.map(value => ({ type: "paragraph" as const, children: [{ type: "text" as const, value }] }));
    });
  };
}
