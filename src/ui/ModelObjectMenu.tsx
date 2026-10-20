import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelObject } from "../contracts/workbench";
import { Icon } from "./icons";

export interface ModelMenuAnchor {
  object: ModelObject;
  target: HTMLElement;
  x?: number;
  y?: number;
}

export function ModelObjectMenu({ anchor, onClose, onPreview, onInspect, previewDisabled, previewLabel = "Preview data" }: {
  anchor: ModelMenuAnchor; onClose: () => void;
  onPreview: (object: ModelObject) => void; onInspect: (object: ModelObject) => void;
  previewDisabled: boolean; previewLabel?: string;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => {
    const target = anchor.target.getBoundingClientRect();
    return {
      left: Math.max(8, Math.min(anchor.x ?? target.left, window.innerWidth - 232)),
      top: Math.max(8, Math.min(anchor.y ?? target.bottom, window.innerHeight - 152)),
    };
  });
  const canPreview = anchor.object.kind === "table" || anchor.object.kind === "column";
  useLayoutEffect(() => {
    const target = anchor.target.getBoundingClientRect(), bounds = menu.current?.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.x ?? target.left, window.innerWidth - (bounds?.width ?? 224) - 8)),
      top: Math.max(8, Math.min(anchor.y ?? target.bottom, window.innerHeight - (bounds?.height ?? 144) - 8)),
    });
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor]);
  useEffect(() => {
    const original = anchor.target.getBoundingClientRect();
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose();
    };
    const dismissScroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      const current = anchor.target.getBoundingClientRect();
      if (current.left !== original.left || current.top !== original.top) onClose();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("scroll", dismissScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("scroll", dismissScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);
  function close() { anchor.target.focus(); onClose(); }
  function preview() { if (canPreview && !previewDisabled) { close(); onPreview(anchor.object); } }
  function inspect() { close(); onInspect(anchor.object); }
  return createPortal(<div className="model-context-menu" ref={menu} role="menu" aria-label={`Actions for ${anchor.object.name}`}
    style={position} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const current = buttons.findIndex(button => button === document.activeElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
      if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key.toLowerCase() === "p") { event.preventDefault(); preview(); }
        if (event.key.toLowerCase() === "i") { event.preventDefault(); inspect(); }
      }
      if (event.key === "F5" || (event.ctrlKey || event.metaKey) && event.key === "Enter") event.preventDefault();
    }}>
    {canPreview && <button role="menuitem" disabled={previewDisabled} onClick={preview}><Icon name="table" size={14}/><span>{previewLabel}</span><kbd>P</kbd></button>}
    <button role="menuitem" onClick={inspect}><Icon name="info" size={14}/><span>Inspect details</span><kbd>I</kbd></button>
    <p>{canPreview ? "Preview reads up to 100 rows. Query filters are not applied." : "Data previews are available for tables and columns."}</p>
  </div>, document.body);
}
