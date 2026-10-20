import type { CodeFont, ThemeMode } from "../contracts/workbench";
import { CODE_FONTS, DEFAULT_CODE_FONT, DEFAULT_CODE_FONT_SIZE } from "../shared/code-fonts.mjs";

function rgbToHex(value: string): string | null {
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  if (/^#[\da-f]{3}$/i.test(value)) return "#" + [...value.slice(1)].map(part => part + part).join("");
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const channels = rgb?.slice(1).map(Number) ?? srgb?.slice(1).map(channel => Number(channel) * 255);
  return channels ? "#" + channels.map(channel => Math.min(255, Math.max(0, Math.round(channel))).toString(16).padStart(2, "0")).join("") : null;
}

export function themeColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const direct = rgbToHex(raw);
  if (direct) return direct;
  if (!raw) return fallback;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  probe.style.color = raw;
  document.body.append(probe);
  const resolved = rgbToHex(getComputedStyle(probe).color);
  probe.remove();
  return resolved ?? fallback;
}

export function darkTheme(): boolean {
  // Root background paint can lag an injected stylesheet; its resolved token does not.
  const background = themeColor("--wb-bg", "") || rgbToHex(getComputedStyle(document.documentElement).backgroundColor);
  if (background) {
    const [red, green, blue] = [1, 3, 5].map(index => parseInt(background.slice(index, index + 2), 16));
    return (red * .2126 + green * .7152 + blue * .0722) < 128;
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

const THEME_CHANGE = "workbench-theme-change";

export function setThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;
  if (root.dataset.workbenchTheme !== mode) root.dataset.workbenchTheme = mode;
}

export function setCodeFont(font: CodeFont = DEFAULT_CODE_FONT, size = DEFAULT_CODE_FONT_SIZE): void {
  const style = document.documentElement.style;
  for (const [name, value] of [["--wb-code-font", CODE_FONTS[font].family], ["--wb-code-size", `${size}px`]]) {
    if (style.getPropertyValue(name) !== value) style.setProperty(name, value);
  }
}

export function codeFontOptions() {
  const style = getComputedStyle(document.documentElement);
  const fontSize = parseFloat(style.getPropertyValue("--wb-code-size")) || DEFAULT_CODE_FONT_SIZE;
  return {
    fontFamily: style.getPropertyValue("--wb-code-font").trim() || CODE_FONTS[DEFAULT_CODE_FONT].family,
    fontSize, lineHeight: Math.round(fontSize * 1.5), fontWeight: "normal", fontLigatures: false,
  };
}

export function onThemeChange(listener: () => void): () => void {
  window.addEventListener(THEME_CHANGE, listener);
  return () => window.removeEventListener(THEME_CHANGE, listener);
}

export function followHostTheme(): () => void {
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  let hostMode: string | undefined;
  let previousMode: string | undefined;
  let signature = "";
  const sync = () => {
    const style = getComputedStyle(root);
    const hostColors = ["--background-color-default", "--bgColor-default", "--color-canvas-default"]
      .some(name => style.getPropertyValue(name).trim());
    const forced = root.dataset.workbenchTheme === "light" || root.dataset.workbenchTheme === "dark";
    if (!forced && hostColors) {
      if (hostMode === undefined) previousMode = root.dataset.colorMode;
      hostMode = darkTheme() ? "dark" : "light";
      if (root.dataset.colorMode !== hostMode) root.dataset.colorMode = hostMode;
    } else if (!forced && hostMode !== undefined) {
      if (root.dataset.colorMode === hostMode) {
        if (previousMode === undefined) delete root.dataset.colorMode;
        else root.dataset.colorMode = previousMode;
      }
      hostMode = undefined;
    }
    const resolved = getComputedStyle(root);
    const next = ["--wb-bg", "--wb-fg", "--wb-muted", "--wb-subtle", "--wb-border", "--wb-accent", "--sans", "--mono", "--wb-code-font", "--wb-code-size"]
      .map(name => resolved.getPropertyValue(name)).concat(resolved.colorScheme).join("\n");
    if (next !== signature) {
      signature = next;
      window.dispatchEvent(new Event(THEME_CHANGE));
    }
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ["style", "class", "data-theme", "data-color-mode", "data-workbench-theme"] });
  // Canvas theme variables can arrive in an injected stylesheet after the UI mounts.
  observer.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href", "media", "disabled"] });
  const stylesheetLoaded = (event: Event) => { if (event.target instanceof HTMLLinkElement && event.target.relList.contains("stylesheet")) sync(); };
  document.addEventListener("load", stylesheetLoaded, true);
  media.addEventListener("change", sync);
  return () => { observer.disconnect(); media.removeEventListener("change", sync); document.removeEventListener("load", stylesheetLoaded, true); };
}
