export const WRITING_VERSION = 2;
export const WRITING_GUIDANCE = "Before writing documentation, call writing_guide for the appropriate template and use its versioned requirements. Check the completed text with writing_guide again: validation must report no structural errors before calling documentation complete. Lead with the answer or purpose; use short paragraphs, scope tables and selective bold emphasis for key findings, labels and important contrasts. Give filters their own table: one field per row, explicit operator and exact literal values. Keep exclusions and unverified filter assumptions visible beside that table. Never bold whole paragraphs. Keep caveats visible and run IDs in Technical details. Replace all template prompts. Drafts may still be saved with failures, but must be described as incomplete. Structural checks never verify business facts.";

export const WRITING_REQUIREMENTS = {
  query: { sections: ["Purpose", "Scope", "Filters", "Caveats"], scope: ["Source", "Period", "Grain", "Measure / units"] },
  research: { sections: ["Answer", "Key evidence", "Scope", "Filters", "Caveats"], scope: ["Population", "Period", "Grain", "Measure / units"] },
  note: { sections: ["Takeaway", "Evidence", "Filters", "Limits"], scope: [] },
  journal: { sections: ["Update", "Evidence and impact", "Filter changes"], scope: [] },
};

export const WRITING_RULES = [
  "Lead with one plain-language answer or purpose. Do not open with connection strings, run IDs, or a process diary.",
  "Give each section one job. Query references use Purpose, Scope, Filters, Definitions, Caveats, and optional Technical details.",
  "Keep paragraphs below 80 words. Prefer one to three sentences; use a table for repeated settings or comparisons.",
  "State the period, grain, measure and units. Distinguish base versus converted measures, ACR versus ARR, and complete versus capped results.",
  "Make filters a first-class table, not a paragraph or one crowded Scope row: one field per row, explicit operator and exact literal values in code formatting. Include date filters. Keep exclusions, mapping sources and unverified assumptions visible nearby. Distinguish documented filters from query-verified filters; never infer or silently add one.",
  "Use short, descriptive headings and at most seven bullets together. Avoid numbered headings unless the order matters.",
  "Use selective bold emphasis for a key finding, short label or important contrast. Keep surrounding explanations in normal text; never bold whole paragraphs or every number. Use headings for structure and code formatting for literal identifiers.",
  "Round narrative numbers deliberately and state their scale. Preserve exact values in source tables or visuals; never invent currency or silently change units.",
  "Separate observations from hypotheses. State material limitations once, near the finding. A successful run is not proof of business correctness.",
  "Put run IDs, provider details and mechanical checks under Technical details. Keep substantive caveats and scope visible.",
  "Use informative chart captions and explain why each visual matters. Never add a visual just to decorate a report.",
  "Replace every [TODO: ...] prompt. Do not invent results, sources, conclusions, refresh dates or access requirements to fill a template.",
  "Pass the selected template's required sections and table checks before calling documentation complete. Explicit unknowns remain warnings, not invented facts. Draft saving does not imply a passing check.",
];

const filterTemplate = `## Filters

| Field | Operator | Exact value(s) |
|---|---|---|
| **[TODO: Filter field]** | [TODO: Operator] | [TODO: Literal values in code formatting; no rounding or paraphrasing] |

**Excluded:** [TODO: Material exclusions, or state none only if established.]

**Filter assumptions:** [TODO: Identify unverified choices and their source, or state what was actually checked. Use Not applicable for non-query notes.]
`;

export const WRITING_TEMPLATES = [
  {
    id: "query", title: "Query reference",
    markdown: `## Purpose

[TODO: State the question this query answers in one sentence.]

## Scope

| Setting | Value |
|---|---|
| **Source** | [TODO: Model and connection name] |
| **Period** | [TODO: Explicit dates and date field] |
| **Grain** | [TODO: What one output row represents] |
| **Measure / units** | [TODO: Exact measure and units; do not assume a currency] |

${filterTemplate}

## Definitions

[TODO: Explain only the product mappings or calculations needed to interpret this query. Use a table for repeated definitions.]

## Caveats

- [TODO: State the important coverage, interpretation or comparability limit.]

## Technical details

[TODO: Record known execution status, truncation and source references, or say Not executed. Never fabricate a run.]
`,
  },
  {
    id: "research", title: "Research brief",
    markdown: `## Answer

**[TODO: Key finding in a short phrase]**: [TODO: Explain the finding in one or two sentences. Label an unresolved question as unresolved.]

## Key evidence

| Observation | Evidence | Interpretation |
|---|---|---|
| [TODO: Finding] | [TODO: Value, units, period and source] | [TODO: What it supports, not an unsupported cause] |

## Scope

| Setting | Value |
|---|---|
| **Population** | [TODO: Who or what is covered] |
| **Period** | [TODO: Dates and date field] |
| **Grain** | [TODO: What one row represents] |
| **Measure / units** | [TODO: Exact measure and units] |

${filterTemplate}

## Caveats

- [TODO: State what the evidence cannot establish.]

## Next decision

[TODO: State the decision or the specific evidence still needed. Remove this section if none is needed.]

## Technical details

[TODO: Known query/run references, controls and freshness. Keep exact values in source tables or managed visuals.]
`,
  },
  {
    id: "note", title: "Analysis note",
    markdown: `## Takeaway

**[TODO: Key takeaway in a short phrase]**: [TODO: Explain the one idea the reader should retain.]

## Evidence

[TODO: Give the supporting facts with period, units and a source. Add a compact table or a managed visual only if useful.]

${filterTemplate}

## Limits

[TODO: State what is unknown or not supported. Remove repetition, not material caveats.]
`,
  },
  {
    id: "journal", title: "Journal update",
    markdown: `## Update

**[TODO: What changed, in a short phrase]**: [TODO: Explain the change since the earlier research.]

## Evidence and impact

[TODO: Identify the new evidence and whether it changes the conclusion. Label hypotheses explicitly.]

## Filter changes

| Field | Previous condition | New condition | Reason |
|---|---|---|---|
| **[TODO: Changed field]** | [TODO: Operator and exact values] | [TODO: Operator and exact values] | [TODO: Why it changed; mark assumptions] |

[TODO: If filters did not change, replace the table with an explicit statement. Keep new exclusions or unverified choices visible.]

## Open question

[TODO: State the unresolved question, or remove this section.]
`,
  },
];

/** @param {string} text */
function blocks(text) {
  const result = [];
  let fence = "", buffer = [], start = 1, section = "";
  const flush = () => {
    if (buffer.length) result.push({ text: buffer.join(" "), line: start, section });
    buffer = [];
  };
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = ""; continue; }
    if (marker) { flush(); fence = marker; continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/u.exec(line);
    if (heading) { flush(); section = heading[1]; continue; }
    if (!line.trim() || /^\s*(?:\||[-*+] |\d+[.)] |>)/u.test(line) || /^(?: {4}|\t)/u.test(line)) { flush(); continue; }
    if (!buffer.length) start = index + 1;
    buffer.push(line.trim());
  }
  flush();
  return result;
}

const plain = text => text.replace(/[`*_]/gu, "").trim();
const label = text => plain(text).toLowerCase().replace(/\(s\)/gu, "s").replace(/[^a-z0-9]+/gu, " ").trim();
const unknown = text => /^(?:unknown|unverified|not (?:supplied|specified|verified|established)|to be confirmed)\b/iu.test(plain(text));
const unfinished = text => /\[(?:TODO(?::[^\]]*)?|TBD|INSERT[^\]]*)\]/iu.test(text);
const conditionOperator = /^(?:==|!=|<>|<=|>=|=|<|>|not in\b|in\b|is not\b|is\b|not contains\b|contains\b|starts with\b|ends with\b|between\b)\s*/iu;

function literalValues(text) {
  const runs = [...text.matchAll(/`+/gu)], next = [], following = new Map();
  for (let index = runs.length - 1; index >= 0; index--) {
    next[index] = following.get(runs[index][0].length);
    following.set(runs[index][0].length, index);
  }
  let remainder = "", cursor = 0, count = 0;
  for (let index = 0; index < runs.length; index++) {
    const closing = next[index];
    if (closing === undefined) continue;
    remainder += text.slice(cursor, runs[index].index);
    cursor = runs[closing].index + runs[closing][0].length;
    count++; index = closing;
  }
  remainder += text.slice(cursor);
  return count > 0 && /^[\s,;\u2013\u2014\-[\](){}]*$/u.test(remainder.replace(/[*_]/gu, "").replace(/\b(?:and|or|to)\b/giu, ""));
}

function structuralLines(text) {
  let fence = "", comment = false, html = "";
  return text.split(/\r?\n/u).map((raw, index) => {
    const line = raw, ignored = { text: "", line: index + 1 };
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = "";
      return ignored;
    }
    if (html) {
      if (html === "block" ? !line.trim() : new RegExp(`</${html}\\s*>`, "iu").test(line)) html = "";
      return ignored;
    }
    if (comment) {
      if (line.includes("-->")) comment = false;
      return ignored;
    }
    if (marker) { fence = marker; return ignored; }
    if (line.includes("<!--")) {
      const start = line.indexOf("<!--"), end = line.indexOf("-->", start + 4);
      comment = end < 0;
      return ignored;
    }
    const tag = /^ {0,3}<(script|pre|style|textarea|details)(?:\s|>)/iu.exec(line)?.[1].toLowerCase();
    if (tag) {
      if (!new RegExp(`</${tag}\\s*>`, "iu").test(line)) html = tag;
      return ignored;
    }
    if (/^ {0,3}<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>\s*$/iu.test(line) || /^ {0,3}<(?:!|\?)/u.test(line)) {
      html = "block"; return ignored;
    }
    if (/^(?: {4}|\t| {0,3}>)/u.test(line)) return ignored;
    return { text: line, line: index + 1 };
  });
}

function tableCells(text) {
  if (!text.includes("|")) return null;
  const cells = [];
  let cell = "", ticks = 0, sawPipe = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) { cell += char + text[++index]; continue; }
    if (char === "`") {
      let count = 1;
      while (text[index + count] === "`") count++;
      if (!ticks) ticks = count; else if (ticks === count) ticks = 0;
      cell += "`".repeat(count); index += count - 1; continue;
    }
    if (char === "|") { cells.push(cell.trim()); cell = ""; sawPipe = true; }
    else cell += char;
  }
  cells.push(cell.trim());
  if (text.trimStart().startsWith("|")) cells.shift();
  if (text.trimEnd().endsWith("|") && cells.at(-1) === "") cells.pop();
  return sawPipe && !ticks ? cells : null;
}

function sectionTables(lines) {
  const tables = [];
  for (let index = 0; index + 1 < lines.length; index++) {
    const header = tableCells(lines[index].text), divider = tableCells(lines[index + 1].text);
    if (!header || !divider || header.length !== divider.length || !divider.every(cell => /^:?-{3,}:?$/u.test(cell))) continue;
    const rows = [];
    let cursor = index + 2;
    for (; cursor < lines.length; cursor++) {
      const cells = tableCells(lines[cursor].text);
      if (!cells) break;
      rows.push({ cells, line: lines[cursor].line });
    }
    tables.push({ header, rows, line: lines[index].line }); index = cursor - 1;
  }
  return tables;
}

/** Deterministic structure checks only. Never reads data, rewrites text or validates business meaning.
 * @param {string} text
 * @param {import("../contracts/writing").WritingKind} [kind]
 * @returns {import("../contracts/writing").WritingValidation}
 */
export function validateWriting(text, kind = "query") {
  if (typeof text !== "string" || text.length > 196608) throw new Error("Writing validation accepts at most 196608 characters.");
  if (!Object.hasOwn(WRITING_REQUIREMENTS, kind)) throw new Error("Unknown writing template. Choose query, research, note or journal.");
  const requirements = WRITING_REQUIREMENTS[kind];
  /** @type {import("../contracts/writing").WritingIssue[]} */
  const issues = [];
  let errorCount = 0, warningCount = 0;
  /** @param {string} code @param {string} message @param {number} [line] @param {string} [section] @param {"error"|"warning"} [severity] */
  const add = (code, message, line = 1, section = "", severity = "error") => {
    if (severity === "error") errorCount++; else warningCount++;
    if (issues.length < 32) issues.push({ code, message, line, ...(section ? { section } : {}), severity });
  };
  const lines = structuralLines(text), sections = new Map();
  let current;
  for (let index = 0; index < lines.length; index++) {
    const item = lines[index];
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(item.text);
    const setext = item.text.trim() && !/^\s/u.test(item.text) && /^(?:={3,}|-{3,})\s*$/u.test(lines[index + 1]?.text ?? "");
    if (atx || setext) {
      const level = atx ? atx[1].length : lines[index + 1].text.trim()[0] === "=" ? 1 : 2;
      if (level <= 2) {
        const title = plain(atx ? atx[2] : item.text), key = label(title);
        if (sections.has(key)) add("duplicate-section", "Combine repeated sections so the scope is unambiguous.", item.line);
        current = { title, line: item.line, lines: [] };
        sections.set(key, current);
      }
      if (setext) index++;
      continue;
    }
    current?.lines.push(item);
  }
  if (!text.trim()) add("empty-document", "Add documentation using the selected template; an empty document is not checked as complete.");
  for (const title of requirements.sections) {
    const section = sections.get(label(title));
    if (!section) add("required-section", `Add a ${title} section.`, 1, title);
    else if (!section.lines.some(item => plain(item.text).replace(/^[-#>\s]+$/u, ""))) add("empty-section", `Fill ${title} with supported content or an explicit limitation.`, section.line, title);
  }
  for (const item of lines) {
    if (unfinished(item.text))
      add("template-prompt", "Replace unfinished template prompts with supported content; state unknowns explicitly.", item.line);
  }
  for (const section of sections.values()) {
    for (const table of sectionTables(section.lines)) {
      for (const row of table.rows) if (row.cells.length !== table.header.length || row.cells.some(cell => !plain(cell)))
        add("table-row", "Each table row needs the same number of nonempty cells as its header. State unknowns explicitly.", row.line);
    }
  }
  const scope = sections.get("scope");
  if (scope && requirements.scope.length) {
    const table = sectionTables(scope.lines).find(item => /^(?:setting|scope|property)$/u.test(label(item.header[0]))
      && /^(?:value|definition)$/u.test(label(item.header[1])) && item.header.length === 2);
    if (!table?.rows.length) add("scope-table", "Use a two-column Setting / Value scope table with populated rows.", scope.line, "Scope");
    else {
      const rows = new Map(table.rows.filter(row => row.cells.length === 2).map(row => [label(row.cells[0]), row]));
      if (rows.size < table.rows.filter(row => row.cells.length === 2).length)
        add("duplicate-scope-field", "Use one scope row per setting; combine duplicate settings without hiding conflicts.", scope.line, "Scope");
      for (const field of requirements.scope) {
        const found = field === "Measure / units"
          ? rows.get("measure units") ?? (rows.has("measure") && rows.has("units") ? rows.get("measure") : undefined)
          : rows.get(label(field));
        if (!found) add("scope-field", `Add a ${field} row to the scope table.`, scope.line, "Scope");
      }
      for (const row of rows.values()) if (unknown(row.cells[1]))
        add("unverified-scope", "This scope value is explicitly unverified; resolve it before using the document as an authoritative reference.", row.line, "Scope", "warning");
    }
  }
  const filters = sections.get(kind === "journal" ? "filter changes" : "filters");
  if (filters) {
    const body = filters.lines.map(item => plain(item.text)).join("\n").trim();
    const noFilters = /^(?:No filters(?: (?:are )?applied)?|None)\s*[.!]?\s*$/imu.test(body);
    const notApplicable = kind === "note" && /^Not applicable(?:[.: -]|$)/imu.test(body);
    const unchanged = kind === "journal" && /^(?:No filter changes|Filters (?:are )?unchanged)\s*[.!]?\s*$/imu.test(body);
    const tables = sectionTables(filters.lines);
    if (noFilters || notApplicable || unchanged) {
      if (tables.some(table => table.rows.length)) add("contradictory-filters", "Do not combine a no-filters/unchanged statement with a populated filter table.", filters.line, filters.title);
    } else {
      const expected = kind === "journal"
        ? [/^field$/u, /^previous condition$/u, /^new condition$/u, /^reason$/u]
        : [/^(?:field|filter|field condition)$/u, /^operator$/u, /^(?:exact )?values?$|^documented value$/u];
      const table = tables.find(item => expected.every((pattern, index) => pattern.test(label(item.header[index] ?? ""))));
      if (!table?.rows.length) add("filter-table", kind === "journal"
        ? "Use Field / Previous condition / New condition / Reason rows, or explicitly state No filter changes."
        : "Use Field / Operator / Exact value(s) rows, or explicitly state No filters. Non-query notes may state Not applicable.", filters.line, filters.title);
      else for (const row of table.rows) {
        if (row.cells.length !== table.header.length) continue;
        for (const cell of row.cells.slice(1)) if (unknown(cell))
          add("unverified-filter", "An operator or condition is unverified. Keep this limitation visible; these are documented, not query-verified filters.", row.line, filters.title, "warning");
        if (kind !== "journal") {
          const operator = plain(row.cells[1]);
          if (!unfinished(operator) && !unknown(operator) && !/^(?:=|==|!=|<>|<=|>=|<|>|in|not in|is|is not|contains|not contains|starts with|ends with|between)$/iu.test(operator))
            add("filter-operator", "Use an explicit supported operator, or state that the operator was not supplied.", row.line, filters.title);
          if (plain(row.cells[2]) && !unfinished(row.cells[2]) && !unknown(row.cells[2]) && !literalValues(row.cells[2]))
            add("filter-literal", "Put exact filter values in inline code; do not round or paraphrase them.", row.line, filters.title);
        } else {
          for (const cell of row.cells.slice(1, 3)) {
            const condition = plain(cell);
            if (unfinished(condition) || unknown(condition) || /^(?:none|not applicable|unchanged)$/iu.test(condition)) continue;
            if (!conditionOperator.test(condition))
              add("filter-operator", "Start each previous/new condition with an explicit operator, or state None, Unchanged, Not applicable or Unknown.", row.line, "Filter changes");
            if (!literalValues(cell.trim().replace(/^\*\*([^*]+)\*\*/u, "$1").replace(conditionOperator, "")))
              add("filter-literal", "Put exact previous/new filter values in inline code; do not round or paraphrase them.", row.line, "Filter changes");
          }
        }
      }
    }
    if (kind !== "journal" && tables.some(table => table.rows.length)) {
      if (!/excluded\s*:/iu.test(body)) add("filter-exclusions", "State Excluded: beside the filters, including None only if established.", filters.line, filters.title);
      if (!/filter assumptions\s*:/iu.test(body)) add("filter-assumptions", "State Filter assumptions: beside the filters; distinguish documented choices from verified settings.", filters.line, filters.title);
    }
  }
  const evidence = sections.get("key evidence");
  if (kind === "research" && evidence && !sectionTables(evidence.lines).some(table => table.rows.length
      && ["observation", "evidence", "interpretation"].every((value, index) => label(table.header[index] ?? "") === value)))
    add("evidence-table", "Use an Observation / Evidence / Interpretation table. State missing evidence rather than inventing findings.", evidence.line, "Key evidence");
  for (const issue of reviewWriting(text, Infinity).filter(issue => issue.code !== "template-prompt"))
    add(issue.code, issue.message, issue.line, "", "warning");
  return {
    version: WRITING_VERSION, template: kind, scope: "structure-only", checkedDocuments: 1,
    status: !text.trim() ? "empty" : errorCount ? "needs-attention" : "pass",
    errorCount, warningCount, issues, omittedIssues: Math.max(0, errorCount + warningCount - issues.length),
  };
}

/** @param {Array<{text: string, kind: import("../contracts/writing").WritingKind}>} documents
 * @returns {import("../contracts/writing").WritingSummary}
 */
export function summarizeWriting(documents) {
  const checks = documents.map(document => validateWriting(document.text, document.kind));
  return {
    version: WRITING_VERSION, checkedDocuments: checks.length,
    status: !checks.length || checks.every(check => check.status === "empty") ? "empty" : checks.every(check => check.status === "pass") ? "pass" : "needs-attention",
    errorCount: checks.reduce((sum, check) => sum + check.errorCount, 0),
    warningCount: checks.reduce((sum, check) => sum + check.warningCount, 0),
  };
}

/** Advisory checks only; never rewrite content or infer its correctness.
 * @param {string} text
 * @param {number} [maximumIssues]
 */
export function reviewWriting(text, maximumIssues = 24) {
  const issues = [];
  const prose = blocks(text);
  for (const block of prose) {
    const words = block.text.split(/\s+/u).length;
    if (words > 80 || block.text.length > 600) issues.push({
      code: "long-paragraph", line: block.line,
      message: "Break this paragraph into short sections or a settings/comparison table (80 words or 600 characters maximum recommended).",
    });
    if ((/^Filters:/iu.test(block.text) || /^Filters\s*#*$/iu.test(block.section))
      && block.text.includes(";") && /(?:=|\b(?:in|is|not in)\b)/iu.test(block.text)) issues.push({
      code: "dense-filters", line: block.line,
      message: "Give filters their own table: one field per row, explicit operator and exact values. Keep exclusions and unverified assumptions visible below it.",
    });
    if (/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/iu.test(block.text)
      && !/^(?:technical|execution|run|source) details\s*#*$/iu.test(block.section))
      issues.push({ code: "technical-id", line: block.line, message: "Move opaque IDs to Technical details; keep the reading flow focused on meaning." });
  }
  const unfenced = [];
  let fence = "";
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = ""; continue; }
    if (marker) { fence = marker; continue; }
    unfenced.push(line);
    if (/\[TODO:\s*[^\]]+\]/u.test(line)) issues.push({
      code: "template-prompt", line: index + 1, message: "Replace this template prompt with supported content, or remove the unused section.",
    });
  }
  if (unfenced.join(" ").split(/\s+/u).filter(Boolean).length > 120 && !unfenced.some(line => /^\s{0,3}#{1,6}\s/u.test(line)))
    issues.unshift({ code: "missing-sections", line: 1, message: "Add descriptive headings so scope, findings and caveats are easy to find." });
  return issues.slice(0, maximumIssues);
}

/** @param {string} [template] @param {string} [text] */
export function getWritingGuide(template = "query", text = "") {
  const chosen = WRITING_TEMPLATES.find(item => item.id === template);
  if (!chosen) throw new Error("Unknown writing template. Choose query, research, note or journal.");
  if (typeof text !== "string" || text.length > 196608) throw new Error("Writing review accepts at most 196608 characters of supplied text.");
  return { version: WRITING_VERSION, rules: [...WRITING_RULES], template: { ...chosen },
    requirements: structuredClone(WRITING_REQUIREMENTS[template]), validation: validateWriting(text, template), issues: reviewWriting(text) };
}
