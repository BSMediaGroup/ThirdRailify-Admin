import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { AdminIcon } from "../components/AdminIcon";
import { manageWatch, type WatchAction, type WatchAdminEpisode, type WatchAdminPayload } from "../watch/client";
import rumbleIcon from "../../assets/icons/rumble.svg";
import youtubeIcon from "../../assets/icons/youtube.svg";

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
  const archiveUnavailable = !loading && !data;
  const primary = data?.current?.primary ?? null;
  const signalState = loading ? "Checking" : archiveUnavailable ? "Unavailable" : primary ? primary.presentationState : "No current signal";
  const retainedCapacity = summary ? `${summary.retained} / 24` : "— / 24";
  return (
    <section className="watch-admin-page" aria-labelledby="watch-admin-title">
      <header className="watch-admin-heading"><div><p className="section-kicker">Broadcast authority / control room</p><h1 id="watch-admin-title">Watch / Broadcast</h1><p>Monitor the current Public signal and manage visibility for naturally retained episodes.</p></div><div className="watch-admin-heading__actions"><span className={`watch-admin-signal-badge${primary?.presentationState === "live" ? " is-live" : ""}`}><i />{signalState}</span><a className="secondary-button" href="https://thirdrailify.pages.dev/watch" target="_blank" rel="noreferrer">Public Watch <AdminIcon name="external" size={15} /></a></div></header>
      {error && <div className="notice-card notice-card--danger" role="alert"><AdminIcon name="signal" /><div><strong>Watch service unavailable</strong><p>{error}</p></div><button className="button-link" type="button" onClick={() => void load()}>Retry</button></div>}

      <div className="watch-admin-metrics" aria-busy={loading} aria-label={`Archive summary, retained ${retainedCapacity}`}>
        <Metric label="Retained" value={summary?.retained ?? "—"} suffix="/ 24" detail="Includes hidden" />
        <Metric label="Visible" value={summary?.visible ?? "—"} detail="Public archive" />
        <Metric label="Hidden" value={summary?.hidden ?? "—"} detail="Placeholder projection" />
        <Metric label="Unfilled" value={summary?.remaining ?? "—"} detail="Future capacity" />
        <Metric label="Current signal" value={signalState} detail={data?.current?.freshness ? `${data.current.freshness} snapshot` : "Authority read"} compact />
      </div>

      <section className="watch-admin-current" aria-labelledby="watch-current-title">
        <div className="watch-admin-current__main"><span className="watch-admin-current__icon"><AdminIcon name="signal" size={22} /></span><div><p className="section-kicker">Current signal</p><h2 id="watch-current-title">{primary?.title || (loading ? "Checking current broadcast…" : archiveUnavailable ? "Current signal unavailable" : "No current broadcast snapshot")}</h2><p>{currentSummary(data, archiveUnavailable)}</p></div></div>
        <dl className="watch-admin-current__facts"><div><dt>Status</dt><dd>{signalState}</dd></div><div><dt>Platform</dt><dd>{primary?.platform ?? "—"}</dd></div><div><dt>Timing</dt><dd>{primary ? currentTime(primary) : "—"}</dd></div></dl>
        <a className="button-link watch-admin-current__link" href="https://thirdrailify.pages.dev/watch" target="_blank" rel="noreferrer">Open Public Watch <AdminIcon name="external" size={15} /></a>
      </section>

      <section className="watch-admin-archive" aria-labelledby="retained-title">
        <header><div><p className="section-kicker">Visibility controls</p><h2 id="retained-title">Retained episodes</h2></div><div><button className="secondary-button" type="button" disabled={!data?.episodes.length || Boolean(busy)} onClick={() => void mutate("show_all")}>Show all</button><button className="danger-button" type="button" disabled={!data?.episodes.length || Boolean(busy)} onClick={openBulkHide}>Hide all</button></div></header>
        {loading && <div className="watch-admin-empty">Loading retained archive…</div>}
        {archiveUnavailable && <div className="watch-admin-empty"><AdminIcon name="signal" size={36} /><strong>Retained archive unavailable</strong><p>The authoritative archive could not be read. No zero counts are being inferred; retry when the service is available.</p></div>}
        {!loading && data && !data.episodes.length && <div className="watch-admin-empty"><AdminIcon name="watch" size={36} /><strong>No retained episodes yet</strong><p>The first eligible completed broadcast will arrive through the existing signed ingest. Bulk actions are disabled.</p></div>}
        {!loading && data && data.episodes.length > 0 && <div className="watch-admin-list">{data.episodes.map((episode) => <EpisodeRow key={episode.id} episode={episode} busy={busy === episode.id} onChange={(action) => void mutate(action, episode.id)} />)}</div>}
      </section>

      <dialog ref={confirmDialog} className="admin-confirm" onClose={() => window.requestAnimationFrame(() => previousFocus.current?.focus())}>
        <form method="dialog"><p className="section-kicker">Deliberate bulk action</p><h2>Hide every retained episode?</h2><p>All retained records stay inside the 24-record archive, but none will resolve publicly until shown again.</p><div><button type="button" className="secondary-button" onClick={closeBulkHide}>Cancel</button><button ref={confirmButton} type="button" className="danger-button" onClick={() => void confirmBulkHide()}>Hide all retained episodes</button></div></form>
      </dialog>
    </section>
  );
}

function Metric({ label, value, detail, compact = false, suffix = "" }: { label: string; value: string | number; detail: string; compact?: boolean; suffix?: string }) { return <article className={compact ? "is-compact" : ""}><span>{label}</span><strong>{value}{suffix ? ` ${suffix}` : ""}</strong><small>{detail}</small></article>; }

function EpisodeRow({ episode, busy, onChange }: { episode: WatchAdminEpisode; busy: boolean; onChange: (action: "show" | "hide") => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  const platformLabel = episode.platform === "rumble" ? "Rumble" : "YouTube";
  const platformIcon = episode.platform === "rumble" ? rumbleIcon : youtubeIcon;
  return <article className="watch-admin-row"><div className="watch-admin-row__thumb">{episode.thumbnailUrl && !imageFailed ? <img src={episode.thumbnailUrl} alt="" loading="lazy" onError={() => setImageFailed(true)} /> : <AdminIcon name="watch" size={34} />}</div><div className="watch-admin-row__main"><span>#{String(episode.archiveOrder).padStart(2, "0")} · {episode.platform}</span><h3>{episode.title}</h3><p>{formatDate(episode.archiveDate)} · <code>{episode.identityKey}</code></p></div><span className={`watch-admin-status${episode.visible ? " is-visible" : ""}`}>{episode.visible ? "Visible" : "Hidden"}</span><div className="watch-admin-row__actions"><a className={`watch-admin-source-link is-${episode.platform}`} href={episode.watchUrl} target="_blank" rel="noopener noreferrer" aria-label={`Watch on ${platformLabel}`} title={`Watch on ${platformLabel}`}><img src={platformIcon} alt="" /></a><button className="secondary-button" type="button" disabled={busy} onClick={() => onChange(episode.visible ? "hide" : "show")}>{busy ? "Saving…" : episode.visible ? "Hide" : "Show"}</button>{episode.visible && episode.publicRoute ? <a className="button-link" href={episode.publicRoute} target="_blank" rel="noreferrer">Preview <AdminIcon name="external" size={15} /></a> : <span>Preview unavailable while hidden</span>}</div></article>;
}

function currentSummary(data: WatchAdminPayload | null, archiveUnavailable: boolean) {
  if (archiveUnavailable) return "The current signal could not be read from the Watch authority.";
  if (!data?.current) return "The archive is available, but no current broadcast snapshot is available.";
  const primary = data.current.primary;
  if (!primary) return `Snapshot ${data.current.freshness}; no live, upcoming, or latest candidate is selected.`;
  const time = primary.actualStart || primary.scheduledStart || primary.publishedAt;
  return `${primary.presentationState} on ${primary.platform} · ${data.current.freshness} signal${time ? ` · ${formatDate(time)}` : ""}`;
}

function currentTime(primary: NonNullable<NonNullable<WatchAdminPayload["current"]>["primary"]>) {
  const time = primary.actualStart || primary.scheduledStart || primary.publishedAt;
  return time ? formatDate(time) : "Not supplied";
}

function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
