import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

export function PivotPopover({ anchor, title, onClose, children }: {
  anchor: HTMLElement; title: string; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect(), bounds = panel.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, innerHeight - bounds.height - 8)) });
    panel.current?.querySelector<HTMLElement>("input, select, button")?.focus();
  }, [anchor]);
  useEffect(() => {
    const original = anchor.getBoundingClientRect();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.contains(event.target)) onClose();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      const current = anchor.getBoundingClientRect();
      if (current.left !== original.left || current.top !== original.top) onClose();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", onClose);
      if (anchor.isConnected && (panel.current?.contains(document.activeElement) || document.activeElement === document.body)) anchor.focus();
    };
  }, [anchor, onClose]);
  return createPortal(<div ref={panel} style={position} className="pivot-popover" role="dialog" aria-label={title}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); anchor.focus(); onClose(); }
      if (event.key === "Tab") {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']")];
        if (event.shiftKey && document.activeElement === controls[0] || !event.shiftKey && document.activeElement === controls.at(-1)) {
          event.preventDefault(); anchor.focus(); onClose();
        }
      }
    }}>
    <header><strong>{title}</strong><button className="icon-button" aria-label="Close field settings" onClick={() => { anchor.focus(); onClose(); }}><Icon name="close" size={14}/></button></header>
    {children}
  </div>, document.body);
}
