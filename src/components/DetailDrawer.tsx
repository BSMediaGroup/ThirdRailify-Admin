import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function DetailDrawer({ titleId, onClose, children }: { titleId: string; onClose: () => void; children: ReactNode }) {
  const drawer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => drawer.current?.querySelector<HTMLElement>("[data-autofocus],button,a,[tabindex]:not([tabindex='-1'])")?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !drawer.current) return;
      const focusable = [...drawer.current.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) { event.preventDefault(); drawer.current.focus(); return; }
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { window.cancelAnimationFrame(frame); document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); returnFocus?.focus(); };
  }, [onClose]);
  return createPortal(<div className="detail-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={drawer} className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>{children}</aside></div>, document.body);
}
