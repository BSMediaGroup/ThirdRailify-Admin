import { useCallback, useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { AdminIcon } from "../components/AdminIcon";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { getInboxMessages, markAllInboxRead, markInboxRead, type InboxMessage } from "../inbox/client";

export function InboxPage() {
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const { startLoading, refreshInbox } = useOutletContext<AdminShellOutletContext>();
  const [items, setItems] = useState<InboxMessage[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const stop = startLoading("Loading Admin inbox");
    setError("");
    try { setItems((await getInboxMessages(unreadOnly)).items); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The Admin inbox is unavailable."); }
    finally { stop(); }
  }, [startLoading, unreadOnly]);

  useEffect(() => { void load(); }, [load]);

  const openMessage = async (message: InboxMessage) => {
    if (!csrfToken) return;
    setBusy(true);
    try {
      if (message.unread) await markInboxRead(message.id, csrfToken);
      await refreshInbox();
      if (message.actionUrl) navigate(message.actionUrl);
      else await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The inbox message could not be updated."); }
    finally { setBusy(false); }
  };

  const markAll = async () => {
    if (!csrfToken) return;
    setBusy(true); setError("");
    try { await markAllInboxRead(csrfToken); await Promise.all([load(), refreshInbox()]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The inbox could not be updated."); }
    finally { setBusy(false); }
  };

  return <div className="inbox-page">
    <header className="page-heading inbox-heading"><div><p className="eyebrow">Admin operations</p><h1>Inbox</h1><p>Internal copies of actionable Admin notices, kept alongside the email delivery workflow so nothing waiting for review is buried.</p></div><button className="secondary-button" type="button" disabled={busy || !items.some((item) => item.unread)} onClick={() => void markAll()}>Mark all read</button></header>
    {error ? <div className="admin-alert" role="alert">{error}</div> : null}
    <nav className="inbox-filters" aria-label="Inbox filters"><button type="button" className={!unreadOnly ? "is-active" : ""} onClick={() => setUnreadOnly(false)}>All notices</button><button type="button" className={unreadOnly ? "is-active" : ""} onClick={() => setUnreadOnly(true)}>Unread only</button></nav>
    <section className="inbox-list" aria-live="polite">
      {items.length ? items.map((message) => <article key={message.id} className={`inbox-message${message.unread ? " is-unread" : ""}`}>
        <span className="inbox-message__state" aria-label={message.unread ? "Unread" : "Read"} />
        <div><p>{message.category}</p><h2>{message.title}</h2><strong>{message.preview}</strong><span>{message.body}</span><small>{formatDate(message.createdAt)}{message.resolvedAt ? " · action completed" : ""}</small></div>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void openMessage(message)}>{message.actionLabel || (message.unread ? "Mark read" : "Open")} <AdminIcon name="arrow" size={14} /></button>
      </article>) : <div className="inbox-empty"><AdminIcon name="emails" size={28} /><h2>{unreadOnly ? "No unread notices" : "Inbox clear"}</h2><p>New internal Admin notices will appear here when an authoritative workflow creates something that needs attention.</p></div>}
    </section>
  </div>;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown date" : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
