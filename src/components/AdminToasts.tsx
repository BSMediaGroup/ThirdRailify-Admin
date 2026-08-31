import { createContext, useCallback, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AdminIcon } from "./AdminIcon";

export type AdminToastTone = "success" | "info" | "warning";
type AdminToastOptions = { tone?: AdminToastTone; title?: string; durationMs?: number };
type AdminToast = Required<AdminToastOptions> & { id: string; message: string };
type AdminToastContextValue = { showToast: (message: string, options?: AdminToastOptions) => string; dismissToast: (id: string) => void };

const AdminToastContext = createContext<AdminToastContextValue | null>(null);
let toastSequence = 0;

export function AdminToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<AdminToast[]>([]);
  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const showToast = useCallback((message: string, options: AdminToastOptions = {}) => {
    const cleanMessage = message.replace(/\s+/g, " ").trim();
    if (!cleanMessage) return "";
    const tone = options.tone || "success";
    const id = `admin-toast-${Date.now()}-${++toastSequence}`;
    const toast: AdminToast = {
      id,
      message: cleanMessage,
      tone,
      title: options.title || (tone === "success" ? "Update complete" : tone === "warning" ? "Attention" : "Notice"),
      durationMs: Math.min(15_000, Math.max(2_000, options.durationMs || 5_200)),
    };
    setToasts((current) => [...current.filter((item) => item.message !== cleanMessage), toast].slice(-4));
    return id;
  }, []);

  useEffect(() => {
    if (!toasts.length) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[aria-modal="true"]')) dismissToast(toasts[toasts.length - 1].id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dismissToast, toasts]);

  return <AdminToastContext.Provider value={{ showToast, dismissToast }}>
    {children}
    {typeof document !== "undefined" && toasts.length ? createPortal(
      <div className="admin-toast-region" aria-label="Admin notifications" aria-live="polite" aria-relevant="additions removals">
        {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} dismissToast={dismissToast} />)}
      </div>,
      document.body,
    ) : null}
  </AdminToastContext.Provider>;
}

function ToastCard({ toast, dismissToast }: { toast: AdminToast; dismissToast: (id: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [dismissToast, toast.durationMs, toast.id]);
  const style = { "--admin-toast-duration": `${toast.durationMs}ms` } as CSSProperties;
  return <section className={`admin-toast admin-toast--${toast.tone}`} role="status" aria-atomic="true" style={style}>
    <span className="admin-toast__icon" aria-hidden="true"><AdminIcon name={toast.tone === "success" ? "shield" : "signal"} size={18} /></span>
    <span className="admin-toast__copy"><strong>{toast.title}</strong><span>{toast.message}</span></span>
    <button className="admin-toast__dismiss" type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification"><AdminIcon name="close" size={15} /></button>
    <i className="admin-toast__timer" aria-hidden="true" />
  </section>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAdminToast() {
  const value = useContext(AdminToastContext);
  if (!value) throw new Error("useAdminToast must be used inside AdminToastProvider");
  return value;
}
