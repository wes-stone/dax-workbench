import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { ModelObject, Proposal } from "../contracts/workbench";
import { codeFontOptions, darkTheme, onThemeChange, themeColor as color } from "./theme";

(globalThis as typeof globalThis & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.languages.register({ id: "dax" });
const FUNCTIONS = ["CALCULATE", "CALCULATETABLE", "FILTER", "SUM", "SUMX", "AVERAGE", "AVERAGEX", "COUNTROWS", "DISTINCTCOUNT", "DIVIDE", "IF", "SWITCH", "VALUES", "ALL", "ALLSELECTED", "REMOVEFILTERS", "KEEPFILTERS", "SELECTEDVALUE", "SUMMARIZECOLUMNS", "SUMMARIZE", "SELECTCOLUMNS", "ADDCOLUMNS", "TOPN", "ROW", "UNION", "INTERSECT", "EXCEPT", "TREATAS", "RELATED", "COALESCE", "FORMAT", "DATE", "DATESYTD", "SAMEPERIODLASTYEAR", "BLANK"];
const KEYWORDS = ["EVALUATE", "DEFINE", "MEASURE", "VAR", "RETURN", "ORDER", "BY", "ASC", "DESC", "START", "AT", "TABLE", "COLUMN", "TRUE", "FALSE", "IN", "NOT"];
monaco.languages.setMonarchTokensProvider("dax", {
  ignoreCase: true,
  keywords: KEYWORDS,
  functions: FUNCTIONS,
  tokenizer: {
    root: [
      [/\/\/.*$|--.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/"(?:[^"]|"")*"/, "string"],
      [/'(?:[^']|'')*'/, "type.identifier"],
      [/\[(?:[^\]]|\]\])*\]/, "variable"],
      [/@[a-zA-Z_]\w*/, "variable.parameter"],
      [/\b\d+(\.\d+)?([eE][+-]?\d+)?\b/, "number"],
      [/[a-zA-Z_][\w.]*/, { cases: { "@keywords": "keyword", "@functions": "predefined", "@default": "identifier" } }],
      [/[{}()[\]]/, "@brackets"],
      [/[+\-*/=<>!&|]+/, "operator"],
      [/[,:;.]/, "delimiter"],
    ],
    comment: [[/[^/*]+/, "comment"], [/\*\//, "comment", "@pop"], [/[/*]/, "comment"]],
  },
});
monaco.languages.setLanguageConfiguration("dax", {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [["(", ")"], ["[", "]"], ["{", "}"]],
  autoClosingPairs: [{ open: "(", close: ")" }, { open: "[", close: "]" }, { open: "{", close: "}" }, { open: '"', close: '"' }, { open: "'", close: "'" }],
  surroundingPairs: [{ open: "(", close: ")" }, { open: "[", close: "]" }, { open: '"', close: '"' }],
});

function installTheme() {
  const dark = darkTheme();
  monaco.editor.defineTheme("workbench", {
    base: dark ? "vs-dark" : "vs", inherit: true,
    rules: [{ token: "keyword", foreground: dark ? "ff7b72" : "cf222e" }, { token: "predefined", foreground: dark ? "d2a8ff" : "8250df" }, { token: "type.identifier", foreground: dark ? "7ee787" : "116329" }, { token: "variable", foreground: dark ? "79c0ff" : "0550ae" }],
    colors: {
      "editor.background": color("--wb-bg", dark ? "#0d1117" : "#ffffff"),
      "editor.foreground": color("--wb-fg", dark ? "#e6edf3" : "#1f2328"),
      "editorLineNumber.foreground": color("--wb-muted", dark ? "#9198a1" : "#656d76"),
      "editor.lineHighlightBackground": color("--wb-subtle", dark ? "#151b23" : "#f6f8fa"),
      "editorGutter.background": color("--wb-bg", dark ? "#0d1117" : "#ffffff"),
    },
  });
  monaco.editor.setTheme("workbench");
}

export interface EditorCommands { focus: () => void }

export function DaxEditor({ value, onChange, objects, onRun, onSave, insert, onInserted, ariaLabel = "DAX query editor", onSelectionChange, commands }: {
  value: string; onChange: (value: string) => void; objects: ModelObject[];
  onRun: () => void; onSave: () => void; insert?: { text: string; sequence: number }; onInserted?: () => void;
  ariaLabel?: string; onSelectionChange?: (selection: { start: number; end: number }) => void;
  commands?: React.RefObject<EditorCommands | null>;
}) {
  const element = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef({ onChange, onRun, onSave, objects, onSelectionChange });
  callbacks.current = { onChange, onRun, onSave, objects, onSelectionChange };
  const externalChange = useRef(false);

  useEffect(() => {
    if (!element.current) return;
    installTheme();
    const instance = monaco.editor.create(element.current, {
      value, language: "dax", theme: "workbench", automaticLayout: true,
      ...codeFontOptions(), minimap: { enabled: false }, scrollBeyondLastLine: false,
      padding: { top: 14, bottom: 14 }, lineNumbersMinChars: 3, glyphMargin: false,
      folding: true, renderLineHighlight: "line", roundedSelection: false,
      overviewRulerLanes: 0, hideCursorInOverviewRuler: true, wordWrap: "on",
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
      ariaLabel, fixedOverflowWidgets: true, tabSize: 4,
    });
    editor.current = instance;
    const editorCommands = { focus: () => instance.focus() };
    if (commands) commands.current = editorCommands;
    const change = instance.onDidChangeModelContent(() => { if (!externalChange.current) callbacks.current.onChange(instance.getValue()); });
    const selectionChange = instance.onDidChangeCursorSelection(event => {
      const model = instance.getModel();
      if (model) callbacks.current.onSelectionChange?.({ start: model.getOffsetAt(event.selection.getStartPosition()), end: model.getOffsetAt(event.selection.getEndPosition()) });
    });
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => callbacks.current.onRun());
    instance.addCommand(monaco.KeyCode.F5, () => callbacks.current.onRun());
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
    const completion = monaco.languages.registerCompletionItemProvider("dax", {
      triggerCharacters: ["[", "'", "@"],
      provideCompletionItems(model, position) {
        if (model !== instance.getModel()) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const suggestions: monaco.languages.CompletionItem[] = [...KEYWORDS, ...FUNCTIONS].map(label => ({
          label, kind: FUNCTIONS.includes(label) ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Keyword,
          insertText: label, range,
        }));
        for (const object of callbacks.current.objects) {
          const table = `'${(object.table ?? object.name).replace(/'/g, "''")}'`;
          const name = `[${object.name.replace(/\]/g, "]]")}]`;
          const text = object.kind === "table" ? table : object.kind === "measure" ? name : `${table}${name}`;
          if (object.kind !== "relationship" && (object.kind !== "column" || object.table)) suggestions.push({
            label: object.name, detail: `${object.table ? `${object.table} · ` : ""}${object.kind}${object.dataType ? ` · ${object.dataType}` : ""}`,
            documentation: object.description, kind: object.kind === "table" ? monaco.languages.CompletionItemKind.Class : monaco.languages.CompletionItemKind.Field,
            insertText: text, range,
          });
        }
        return { suggestions };
      },
    });
    const updateTheme = () => {
      installTheme();
      instance.updateOptions(codeFontOptions());
    };
    const stopTheme = onThemeChange(updateTheme);
    return () => { if (commands?.current === editorCommands) commands.current = null; change.dispose(); selectionChange.dispose(); completion.dispose(); instance.getModel()?.dispose(); instance.dispose(); editor.current = null; stopTheme(); };
  }, []);

  useEffect(() => {
    const instance = editor.current;
    if (instance && instance.getValue() !== value) {
      const position = instance.getPosition();
      externalChange.current = true;
      try { instance.setValue(value); } finally { externalChange.current = false; }
      if (position) instance.setPosition(position);
    }
  }, [value]);
  useEffect(() => {
    if (!insert || !editor.current) return;
    const instance = editor.current;
    const selection = instance.getSelection();
    if (selection) instance.executeEdits("schema-insert", [{ range: selection, text: insert.text }]);
    instance.focus();
    onInserted?.();
  }, [insert]);
  return <div className="monaco-surface" ref={element} />;
}

export function ProposalDiff({ original, proposal }: { original: string; proposal: Proposal }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    installTheme();
    const originalModel = monaco.editor.createModel(original, "dax");
    const modifiedModel = monaco.editor.createModel(proposal.query, "dax");
    const instance = monaco.editor.createDiffEditor(element.current, {
      theme: "workbench", readOnly: true, automaticLayout: true,
      renderSideBySide: element.current.clientWidth > 650, minimap: { enabled: false },
      ...codeFontOptions(), scrollBeyondLastLine: false,
      ariaLabel: "Review proposed DAX changes", originalEditable: false,
    });
    instance.setModel({ original: originalModel, modified: modifiedModel });
    const stopTheme = onThemeChange(() => { installTheme(); instance.updateOptions(codeFontOptions()); });
    return () => { stopTheme(); instance.dispose(); originalModel.dispose(); modifiedModel.dispose(); };
  }, [original, proposal.id, proposal.query]);
  return <div className="proposal-diff" ref={element} />;
}
