import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { AdminIcon } from "../components/AdminIcon";
import { manageWatch, type WatchAction, type WatchAdminEpisode, type WatchAdminPayload } from "../watch/client";

export function WatchAdminPage() {
  const { csrfToken, access } = useAuth();
  const [data, setData] = useState<WatchAdminPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    if (!csrfToken || !access.isMasterAdmin) return;
    setLoading(true); setError("");
    try { setData(await manageWatch("read", csrfToken)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The Watch archive service is unavailable."); }
    finally { setLoading(false); }
  }, [access.isMasterAdmin, csrfToken]);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (action: Exclude<WatchAction, "read">, episodeId?: string) => {
    if (!csrfToken || busy) return;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(episodeId || action); setError("");
    try { setData(await manageWatch(action, csrfToken, episodeId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The visibility change failed."); }
    finally { setBusy(""); window.requestAnimationFrame(() => focus?.focus()); }
  };

  const openBulkHide = () => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmDialog.current?.showModal();
    window.requestAnimationFrame(() => confirmButton.current?.focus());
  };
  const closeBulkHide = () => { confirmDialog.current?.close(); window.requestAnimationFrame(() => previousFocus.current?.focus()); };
  const confirmBulkHide = async () => { confirmDialog.current?.close(); await mutate("hide_all"); };

  if (!access.isMasterAdmin) {
    return <section className="watch-admin-page"><header className="page-heading"><div><p className="section-kicker">Broadcast authority</p><h1>Watch archive</h1><p>Visibility controls require an authenticated Master Admin session.</p></div></header><div className="notice-card"><AdminIcon name="shield" /><div><strong>Master Admin required</strong><p>This workspace does not expose archive state or mutation controls to Full Admin sessions.</p></div></div></section>;
  }

  const summary = data?.summary;
  return (
    <section className="watch-admin-page" aria-labelledby="watch-admin-title">
      <header className="page-heading watch-admin-heading"><div><p className="section-kicker">Broadcast authority</p><h1 id="watch-admin-title">Watch archive</h1><p>Manage visibility for episodes retained naturally from the signed Public broadcast ingest. No manual episode creation or provider lookup is available.</p></div><div className="status-stamp"><AdminIcon name="watch" size={30} /><span>ARCHIVE CAP</span><strong>{summary?.retained ?? 0} / 24</strong></div></header>
      {error && <div className="notice-card notice-card--danger" role="alert"><AdminIcon name="signal" /><div><strong>Watch service unavailable</strong><p>{error}</p></div><button className="button-link" type="button" onClick={() => void load()}>Retry</button></div>}

      <div className="watch-admin-metrics" aria-busy={loading}>
        <Metric label="Retained" value={loading ? "—" : summary?.retained ?? 0} detail="Includes hidden records" />
        <Metric label="Visible" value={loading ? "—" : summary?.visible ?? 0} detail="Publicly enumerable" />
        <Metric label="Hidden" value={loading ? "—" : summary?.hidden ?? 0} detail="Projected as placeholders" />
        <Metric label="Unfilled" value={loading ? "—" : summary?.remaining ?? 24} detail="Until future broadcasts" />
      </div>

      <section className="watch-admin-current" aria-labelledby="watch-current-title">
        <div><p className="section-kicker">Current signal</p><h2 id="watch-current-title">{data?.current?.primary?.title || (loading ? "Checking current broadcast…" : "No current broadcast snapshot")}</h2><p>{currentSummary(data)}</p></div>
        <div><span>Newest retained</span><strong>{summary?.newest?.title || "None yet"}</strong><small>{summary?.newest ? formatDate(summary.newest.date) : "Archive will fill naturally"}</small></div>
        <div><span>Oldest retained</span><strong>{summary?.oldest?.title || "None yet"}</strong><small>{summary?.oldest ? formatDate(summary.oldest.date) : "No retention pruning required"}</small></div>
      </section>

      <section className="watch-admin-archive" aria-labelledby="retained-title">
        <header><div><p className="section-kicker">Visibility controls</p><h2 id="retained-title">Retained episodes</h2></div><div><button className="secondary-button" type="button" disabled={!data?.episodes.length || Boolean(busy)} onClick={() => void mutate("show_all")}>Show all</button><button className="danger-button" type="button" disabled={!data?.episodes.length || Boolean(busy)} onClick={openBulkHide}>Hide all</button></div></header>
        {loading ? <div className="watch-admin-empty">Loading retained archive…</div> : !data?.episodes.length ? <div className="watch-admin-empty"><AdminIcon name="watch" size={36} /><strong>No retained episodes yet</strong><p>The first eligible completed broadcast will arrive through the existing signed ingest. Bulk actions are disabled.</p></div> : <div className="watch-admin-list">{data.episodes.map((episode) => <EpisodeRow key={episode.id} episode={episode} busy={busy === episode.id} onChange={(action) => void mutate(action, episode.id)} />)}</div>}
      </section>

      <dialog ref={confirmDialog} className="admin-confirm" onClose={() => window.requestAnimationFrame(() => previousFocus.current?.focus())}>
        <form method="dialog"><p className="section-kicker">Deliberate bulk action</p><h2>Hide every retained episode?</h2><p>All retained records stay inside the 24-record archive, but none will resolve publicly until shown again.</p><div><button type="button" className="secondary-button" onClick={closeBulkHide}>Cancel</button><button ref={confirmButton} type="button" className="danger-button" onClick={() => void confirmBulkHide()}>Hide all retained episodes</button></div></form>
      </dialog>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) { return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>; }

function EpisodeRow({ episode, busy, onChange }: { episode: WatchAdminEpisode; busy: boolean; onChange: (action: "show" | "hide") => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  return <article className="watch-admin-row"><div className="watch-admin-row__thumb">{episode.thumbnailUrl && !imageFailed ? <img src={episode.thumbnailUrl} alt="" loading="lazy" onError={() => setImageFailed(true)} /> : <AdminIcon name="watch" size={34} />}</div><div className="watch-admin-row__main"><span>#{String(episode.archiveOrder).padStart(2, "0")} · {episode.platform}</span><h3>{episode.title}</h3><p>{formatDate(episode.archiveDate)} · <code>{episode.identityKey}</code></p></div><span className={`watch-admin-status${episode.visible ? " is-visible" : ""}`}>{episode.visible ? "Visible" : "Hidden"}</span><div className="watch-admin-row__actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => onChange(episode.visible ? "hide" : "show")}>{busy ? "Saving…" : episode.visible ? "Hide" : "Show"}</button>{episode.visible ? <a className="button-link" href={episode.publicRoute} target="_blank" rel="noreferrer">Preview <AdminIcon name="external" size={15} /></a> : <span>Preview unavailable while hidden</span>}</div></article>;
}

function currentSummary(data: WatchAdminPayload | null) {
  if (!data?.current) return "The current-state service is unavailable or has not received a snapshot.";
  const primary = data.current.primary;
  if (!primary) return `Snapshot ${data.current.freshness}; no live, upcoming, or latest candidate is selected.`;
  const time = primary.actualStart || primary.scheduledStart || primary.publishedAt;
  return `${primary.presentationState} on ${primary.platform} · ${data.current.freshness} signal${time ? ` · ${formatDate(time)}` : ""}`;
}

function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
