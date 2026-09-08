import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
export function Lightbox({ title, children, onClose, pending = false }: { title: string; children: ReactNode; onClose: () => void; pending?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const [host, setHost] = useState(() => document.fullscreenElement || document.body);
  useEffect(() => () => { if (previous.current?.isConnected) previous.current.focus({ preventScroll: true }); }, []);
  useEffect(() => { const change = () => setHost(document.fullscreenElement || document.body); document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change); }, []);
  useLayoutEffect(() => { if (!previous.current) previous.current = document.activeElement as HTMLElement; if (!ref.current?.open) ref.current?.showModal(); }, [host]);
  return createPortal(<dialog className="bracket-lightbox" ref={ref} onCancel={e => { e.preventDefault(); if (!pending) onClose(); }} aria-label={title}><header><h2>{title}</h2><button type="button" disabled={pending} onClick={onClose} aria-label="Close dialog">&#215;</button></header>{children}</dialog>, host);
}
