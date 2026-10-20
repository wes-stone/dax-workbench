import { useState } from "react";
import type { Appearance } from "../contracts/workbench";
import type { Action } from "./useWorkbench";
import { errorMessage } from "./api";
import { CODE_FONTS, DEFAULT_CODE_FONT, DEFAULT_CODE_FONT_SIZE, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE } from "../shared/code-fonts.mjs";

export function AppearanceSetting({ appearance, action }: { appearance?: Appearance; action: Action }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const themeMode = appearance?.themeMode ?? "system";
  const codeFont = appearance?.codeFont ?? DEFAULT_CODE_FONT;
  const codeFontSize = appearance?.codeFontSize ?? DEFAULT_CODE_FONT_SIZE;
  function save(patch: { themeMode?: string; codeFont?: string; codeFontSize?: number }) {
    setSaving(true); setError("");
    void action("appearance.update", patch)
      .catch(reason => setError(errorMessage(reason))).finally(() => setSaving(false));
  }
  return <div className="appearance-settings">
    <label className="field-label">Theme mode
      <select aria-label="Theme mode" aria-describedby="theme-mode-help" value={themeMode} disabled={saving} onChange={event => save({ themeMode: event.currentTarget.value })}>
        <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select>
    </label>
    <p className="field-help" id="theme-mode-help">System follows Copilot's theme, or your device in standalone mode. Light and Dark override it for the entire workbench. Your choice is remembered.</p>
    <div className="code-font-controls">
      <label className="field-label">Code font
        <select aria-label="Code font" aria-describedby="code-font-help" value={codeFont} disabled={saving}
          onChange={event => save({ codeFont: event.currentTarget.value })}>
          {Object.entries(CODE_FONTS).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}
        </select>
      </label>
      <label className="field-label">Size
        <select aria-label="Code font size" aria-describedby="code-font-help" value={codeFontSize} disabled={saving}
          onChange={event => save({ codeFontSize: Number(event.currentTarget.value) })}>
          {Array.from({ length: MAX_CODE_FONT_SIZE - MIN_CODE_FONT_SIZE + 1 }, (_, index) => MIN_CODE_FONT_SIZE + index)
            .map(size => <option key={size} value={size}>{size} px</option>)}
        </select>
      </label>
    </div>
    <pre className="code-font-preview" aria-label="Code font preview">{'EVALUATE ROW("Amount", 1234.56)\n// 0 O   1 l I'}</pre>
    <p className="field-help" id="code-font-help">Applies immediately to DAX editors, generated DAX previews, parameters, and builder filter values. Saved for this workbench; table cells and interface text stay unchanged. Fonts must already be installed, or a monospace fallback is used.</p>
    <button className="text-button" disabled={saving || codeFont === DEFAULT_CODE_FONT && codeFontSize === DEFAULT_CODE_FONT_SIZE}
      onClick={() => save({ codeFont: DEFAULT_CODE_FONT, codeFontSize: DEFAULT_CODE_FONT_SIZE })}>Reset code font</button>
    {saving && <p className="field-help" role="status">Saving appearance...</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}
