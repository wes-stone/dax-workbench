import { fail } from "./policy.mjs";

export const BUILDER_START = "/* START QUERY BUILDER */";
export const BUILDER_END = "/* END QUERY BUILDER */";

function markedRange(text) {
  let start = -1, range = null;
  for (let i = 0; i < text.length;) {
    const c = text[i], next = text[i + 1];
    if ((c === "/" && next === "/") || (c === "-" && next === "-")) {
      const end = text.indexOf("\n", i + 2); i = end < 0 ? text.length : end + 1; continue;
    }
    if (c === '"' || c === "'" || c === "[") {
      const close = c === "[" ? "]" : c; i++;
      while (i < text.length) {
        if (text[i++] !== close) continue;
        if (text[i] === close) { i++; continue; }
        break;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw fail("BUILDER_BLOCK_INVALID", "Close the unfinished editor comment before updating the builder block.");
      const comment = text.slice(i, end + 2);
      if (comment === BUILDER_START) {
        if (start >= 0 || range) throw fail("BUILDER_BLOCK_INVALID", "Multiple or nested builder blocks need manual review before updating.");
        start = i;
      } else if (comment === BUILDER_END) {
        if (start < 0) throw fail("BUILDER_BLOCK_INVALID", "The editor has a builder end marker without its start marker.");
        range = { start, end: end + 2 }; start = -1;
      }
      i = end + 2; continue;
    }
    i++;
  }
  if (start >= 0) throw fail("BUILDER_BLOCK_INVALID", "The editor has an unfinished builder block. Restore its end marker before updating.");
  return range;
}

export function updateBuilderBlock(editor, generated, selection) {
  const existing = markedRange(editor);
  const wrapped = markedRange(generated) ? generated.trim() : `${BUILDER_START}\n${generated.trim()}\n${BUILDER_END}`;
  const target = existing ?? selection ?? { start: editor.length, end: editor.length };
  if (!Number.isInteger(target.start) || !Number.isInteger(target.end) || target.start < 0 || target.end < target.start || target.end > editor.length)
    throw fail("REVISION_CONFLICT", "The editor selection changed. Select an insertion point and try again.");
  const before = editor.slice(0, target.start), after = editor.slice(target.end);
  const value = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${wrapped}${after && !after.startsWith("\n") ? "\n" : ""}${after}`;
  if (value.length > 100000) throw fail("INVALID_QUERY", "The combined editor query exceeds 100,000 characters.");
  return value;
}

export function removeBuilderBlock(editor) {
  const range = markedRange(editor);
  return range ? editor.slice(0, range.start) + editor.slice(range.end) : editor;
}
