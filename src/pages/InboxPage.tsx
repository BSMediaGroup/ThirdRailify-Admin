import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useOutletContext } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { AdminIcon } from "../components/AdminIcon";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { getInboxMessages, markAllInboxRead, mutateInboxMessages, type InboxMessage } from "../inbox/client";

export function InboxPage() {
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const { startLoading, refreshInbox } = useOutletContext<AdminShellOutletContext>();
  const [items, setItems] = useState<InboxMessage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<InboxMessage | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const stop = startLoading("Loading Admin inbox"); setError("");
    try { setItems((await getInboxMessages(unreadOnly)).items); setSelected(new Set()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The Admin inbox is unavailable."); }
    finally { stop(); }
  }, [startLoading, unreadOnly]);
  useEffect(() => { void load(); }, [load]);

  const mutate = async (ids: string[], action: "read" | "unread" | "delete") => {
    if (!csrfToken || !ids.length) return;
    if (action === "delete" && !window.confirm(`Delete ${ids.length} selected ${ids.length === 1 ? "message" : "messages"} from your Admin inbox?`)) return;
    setBusy(true); setError("");
    try { await mutateInboxMessages(ids, action, csrfToken); setDetail((current) => current && ids.includes(current.id) ? null : current); await Promise.all([load(), refreshInbox()]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The inbox could not be updated."); }
    finally { setBusy(false); }
  };
  const open = async (message: InboxMessage) => {
    setDetail(message);
    if (message.unread && csrfToken) try {
      await mutateInboxMessages([message.id], "read", csrfToken);
      const readAt = new Date().toISOString();
      setItems((current) => current.map((item) => item.id === message.id ? { ...item, unread: false, readAt } : item));
      setDetail((current) => current?.id === message.id ? { ...current, unread: false, readAt } : current);
      await refreshInbox();
    } catch { /* Detail remains readable if the background state update fails. */ }
  };
  const markAll = async () => { if (!csrfToken) return; setBusy(true); try { await markAllInboxRead(csrfToken); await Promise.all([load(), refreshInbox()]); } catch (reason) { setError(reason instanceof Error ? reason.message : "The inbox could not be updated."); } finally { setBusy(false); } };
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));

  return <div className="inbox-page">
    <header className="page-heading inbox-heading"><div><p className="eyebrow">Admin operations</p><h1>Inbox</h1><p>Review complete notice context, then control read state or remove messages individually or in bulk.</p></div><button className="secondary-button" type="button" disabled={busy || !items.some((item) => item.unread)} onClick={() => void markAll()}>Mark all read</button></header>
    {error ? <div className="admin-alert" role="alert">{error}</div> : null}
    <div className="inbox-toolbar"><nav className="inbox-filters" aria-label="Inbox filters"><button type="button" className={!unreadOnly ? "is-active" : ""} onClick={() => setUnreadOnly(false)}>All notices</button><button type="button" className={unreadOnly ? "is-active" : ""} onClick={() => setUnreadOnly(true)}>Unread only</button></nav><div className="inbox-bulk" aria-label="Bulk message actions"><label><input type="checkbox" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? new Set(items.map((item) => item.id)) : new Set())} /><span>Select all</span></label><button type="button" disabled={busy || !selected.size} onClick={() => void mutate([...selected], "read")}>Read</button><button type="button" disabled={busy || !selected.size} onClick={() => void mutate([...selected], "unread")}>Unread</button><button className="is-danger" type="button" disabled={busy || !selected.size} onClick={() => void mutate([...selected], "delete")}>Delete</button></div></div>
    <section className="inbox-list" aria-live="polite">{items.length ? items.map((message) => <article key={message.id} className={`inbox-message${message.unread ? " is-unread" : ""}`} tabIndex={0} role="button" aria-label={`Open ${message.title}`} onClick={() => void open(message)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void open(message); } }}>
      <label className="inbox-message__select" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected.has(message.id)} aria-label={`Select ${message.title}`} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(message.id); else next.delete(message.id); return next; })} /></label><span className="inbox-message__state" aria-label={message.unread ? "Unread" : "Read"} /><div><p>{message.category}</p><h2>{message.title}</h2><strong>{message.preview}</strong><span>{message.body}</span><small>{formatDate(message.createdAt)}{message.resolvedAt ? " · action completed" : ""}</small></div>
      <div className="inbox-message__actions" onClick={(event) => event.stopPropagation()}><button type="button" disabled={busy} onClick={() => void mutate([message.id], message.unread ? "read" : "unread")}>{message.unread ? "Mark read" : "Mark unread"}</button>{message.actionUrl ? <button className="secondary-button" type="button" disabled={busy} onClick={() => navigate(message.actionUrl!)}>{message.actionLabel || "Open action"} <AdminIcon name="arrow" size={14} /></button> : null}<button className="inbox-delete" type="button" disabled={busy} onClick={() => void mutate([message.id], "delete")} aria-label={`Delete ${message.title}`}><AdminIcon name="close" size={14} /></button></div>
    </article>) : <div className="inbox-empty"><AdminIcon name="emails" size={28} /><h2>{unreadOnly ? "No unread notices" : "Inbox clear"}</h2><p>New internal Admin notices will appear here when an authoritative workflow creates something that needs attention.</p></div>}</section>
    {detail ? <MessageDetail message={detail} busy={busy} onClose={() => setDetail(null)} onRead={(action) => void mutate([detail.id], action)} onAction={() => detail.actionUrl && navigate(detail.actionUrl)} /> : null}
  </div>;
}

function MessageDetail({ message, busy, onClose, onRead, onAction }: { message: InboxMessage; busy: boolean; onClose: () => void; onRead: (action: "read" | "unread" | "delete") => void; onAction: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key); }, [onClose]);
  return createPortal(<div className="message-lightbox" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="message-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-message-title"><header><div><p className="eyebrow">{message.category} · {message.unread ? "Unread" : "Read"}</p><h2 id="admin-message-title">{message.title}</h2><span>{formatDate(message.createdAt)}</span></div><button ref={close} type="button" aria-label="Close message" onClick={onClose}><AdminIcon name="close" /></button></header><div className="message-dialog__body"><p className="message-dialog__preview">{message.preview}</p><p>{message.body}</p><dl><div><dt>Source</dt><dd>{message.sourceType}</dd></div><div><dt>Source ID</dt><dd>{message.sourceId}</dd></div><div><dt>Created</dt><dd>{formatDate(message.createdAt)}</dd></div><div><dt>Status</dt><dd>{message.resolvedAt ? `Action completed ${formatDate(message.resolvedAt)}` : "Open"}</dd></div></dl></div><footer><button type="button" disabled={busy} onClick={() => onRead(message.unread ? "read" : "unread")}>{message.unread ? "Mark read" : "Mark unread"}</button><button className="inbox-delete" type="button" disabled={busy} onClick={() => onRead("delete")}>Delete</button>{message.actionUrl ? <button className="secondary-button" type="button" disabled={busy} onClick={onAction}>{message.actionLabel || "Open action"} <AdminIcon name="arrow" size={14} /></button> : null}</footer></section></div>, document.body);
}

function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown date" : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date); }
