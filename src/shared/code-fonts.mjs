export const CODE_FONTS = Object.freeze({
    consolas: { label: "Consolas (VS Code on Windows)", family: 'Consolas, "Courier New", Menlo, monospace' },
    cascadia: { label: "Cascadia Code", family: '"Cascadia Code", Consolas, Menlo, monospace' },
    jetbrains: { label: "JetBrains Mono", family: '"JetBrains Mono", Consolas, Menlo, monospace' },
    fira: { label: "Fira Code", family: '"Fira Code", Consolas, Menlo, monospace' },
    menlo: { label: "Menlo (VS Code on macOS)", family: 'Menlo, Monaco, Consolas, monospace' },
    app: { label: "Follow app monospace", family: "var(--mono)" },
});
export const DEFAULT_CODE_FONT = "consolas";
export const DEFAULT_CODE_FONT_SIZE = 14;
export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 24;
