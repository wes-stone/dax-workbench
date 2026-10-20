import type { Paragraph, Root, RootContent, Table, TableCell } from "mdast";

const amount = /^[+-]?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/u;
interface Movement { id: string; name: string; before: string; after: string; change: string }
function movement(line: string): Movement | null {
  const match = /^(\d{3,20})[ \t]+([^:\n]{1,180}):[ \t]*(.+)$/u.exec(line.trim());
  if (!match) return null;
  const [, id, name, tail] = match;
  const values = tail.replace(/\.$/u, "");
  const pair = /^(.+?)\s*(?:->|→)\s*(.+?);\s*(.+)$/u.exec(values);
  if (!pair) return amount.test(values) ? { id, name, before: "Not supplied", after: "Not supplied", change: values } : null;
  const [before, after, change] = pair.slice(1).map(value => value.trim());
  if (![before, after].every(value => amount.test(value) || /^blank$/iu.test(value)) || !amount.test(change)) return null;
  return { id, name, before, after, change };
}
function preserveLines(node: Paragraph): Paragraph {
  return { ...node, data: { ...node.data, hProperties: { ...node.data?.hProperties, className: ["research-source-lines"] } } };
}

/** Only explicit, fully parseable watchlists become tables; never infer values or recompute changes. */
export function remarkResearchTables() {
  return (tree: Root) => {
    tree.children = tree.children.flatMap((node): RootContent[] => {
      if (node.type !== "paragraph") return [node];
      const text = node.children.map(child => child.type === "text" ? child.value : "\ufffc").join("");
      const lines = text.split("\n");
      const recordLines = lines.filter(line => /^\d{3,20}\s+.+:/u.test(line.trim())).length;
      if (recordLines < 2) return [node];
      if (node.children.some(child => child.type !== "text")) return [preserveLines(node)];
      const intro = lines.findIndex(line => /\bwatchlist\b/iu.test(line));
      if (intro < 0) return [preserveLines(node)];
      const rows = lines.slice(intro + 1).filter(line => line.trim()).map(movement);
      if (rows.length < 3 || rows.length > 200 || rows.some(row => row === null)) return [preserveLines(node)];
      const periods = /\(([^();]{1,40}?)\s*(?:->|→)\s*([^();]{1,40}?);\s*change\)\s*:\s*$/iu.exec(lines[intro]);
      const headers = ["ID", "Name", periods?.[1].trim() ?? "Before", periods?.[2].trim() ?? "After", "Change"];
      const cell = (value: string, numeric: boolean): TableCell => ({
        type: "tableCell", children: [{ type: "text", value }],
        ...(numeric ? { data: { hProperties: { className: ["research-numeric-cell"] } } } : {}),
      });
      const table: Table = {
        type: "table", align: ["left", "left", "right", "right", "right"],
        data: { hProperties: { "data-research-table": "movement-watchlist" } },
        children: [
          { type: "tableRow", children: headers.map(value => cell(value, false)) },
          ...rows.flatMap(row => row ? [{
            type: "tableRow" as const,
            children: [row.id, row.name, row.before, row.after, row.change].map((value, index) => cell(value, index >= 2)),
          }] : []),
        ],
      };
      return [{ ...node, children: [{ type: "text", value: lines.slice(0, intro + 1).join("\n") }] }, table];
    });
  };
}
