import { useEffect, useRef, type ReactNode } from 'react';
export function Lightbox({ title, children, onClose, pending = false }: { title: string; children: ReactNode; onClose: () => void; pending?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement; ref.current?.showModal(); return () => { previous?.focus(); }; }, []);
  return <dialog className="bracket-lightbox" ref={ref} onCancel={e => { e.preventDefault(); if (!pending) onClose(); }} aria-label={title}><header><h2>{title}</h2><button type="button" disabled={pending} onClick={onClose} aria-label="Close dialog">×</button></header>{children}</dialog>;
}
