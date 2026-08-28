import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { type BannerConfig, type BannerMessage, readBannerSettings, saveBannerSettings } from "../banner/client";
import { AdminIcon } from "../components/AdminIcon";

const EMPTY_MESSAGE: BannerMessage = { text: "", ctaLabel: null, href: null, newTab: false };
const FIXTURE_TITLE = "SAMPLE PREVIEW — Third Railify live broadcast title";

export function SiteContentPage() {
  const { access, csrfToken } = useAuth();
  const [config, setConfig] = useState<BannerConfig | null>(null);
  const [revision, setRevision] = useState(0);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const dirty = useMemo(() => Boolean(config && savedSnapshot && JSON.stringify(config) !== savedSnapshot), [config, savedSnapshot]);

  const load = useCallback(async () => {
    if (!access.isMasterAdmin) return;
    setLoading(true); setError(""); setSaved("");
    try { const result = await readBannerSettings(); setConfig(result.config); setRevision(result.revision); setSavedSnapshot(JSON.stringify(result.config)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Banner configuration is unavailable."); }
    finally { setLoading(false); }
  }, [access.isMasterAdmin]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || !csrfToken || saving || !dirty) return;
    setSaving(true); setError(""); setSaved("");
    try { const result = await saveBannerSettings(config, revision, csrfToken); setConfig(result.config); setRevision(result.revision); setSavedSnapshot(JSON.stringify(result.config)); setSaved(`Saved revision ${result.revision}.`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The banner configuration could not be saved."); }
    finally { setSaving(false); }
  };

  if (!access.isMasterAdmin) return <section className="site-content-page"><header className="page-heading"><div><p className="section-kicker">Site content / announcements</p><h1>Public banner</h1><p>Banner configuration requires an authenticated Master Admin session.</p></div></header><div className="notice-card"><AdminIcon name="shield" /><div><strong>Master Admin required</strong><p>Promotional and Live Now presentation settings are protected server-side.</p></div></div></section>;

  return (
    <section className="site-content-page" aria-labelledby="site-content-title">
      <header className="content-admin-heading"><div><p className="section-kicker">Site content / announcements</p><h1 id="site-content-title">Public banner</h1><p>Configure the normal announcement rail and the presentation used only when Watch confirms a genuine live broadcast.</p></div><a className="secondary-button content-admin-heading__public-link" href="https://thirdrailify.pages.dev/" target="_blank" rel="noreferrer" aria-label="Open Public site in a new tab"><span>Open Public site</span><AdminIcon name="external" size={16} /></a></header>
      {error && <div className="notice-card notice-card--danger" role="alert"><AdminIcon name="signal" /><div><strong>Banner configuration unavailable</strong><p>{error}</p></div><button className="button-link" type="button" onClick={() => void load()}>Reload</button></div>}
      {loading && <div className="content-admin-loading" role="status">Loading authoritative banner configuration…</div>}
      {!loading && !config && !error && <div className="content-admin-loading">Banner configuration is unavailable.</div>}
      {config && <form className="banner-editor" onSubmit={submit}>
        <NormalEditor config={config} setConfig={setConfig} />
        <LiveEditor config={config} setConfig={setConfig} />
        <div className="banner-savebar"><span className={dirty ? "is-dirty" : saved ? "is-saved" : ""}><i />{saving ? "Saving to server…" : dirty ? "Unsaved changes" : saved || "All changes saved"}</span><button className="primary-button" type="submit" disabled={!dirty || saving}>{saving ? "Saving…" : "Save banner settings"}</button></div>
      </form>}
    </section>
  );
}

function NormalEditor({ config, setConfig }: EditorProps) {
  const update = (patch: Partial<BannerConfig["normal"]>) => setConfig({ ...config, normal: { ...config.normal, ...patch } });
  const updateMessage = (index: number, patch: Partial<BannerMessage>) => update({ messages: config.normal.messages.map((message, position) => position === index ? { ...message, ...patch } : message) });
  return <section className="banner-editor__panel" aria-labelledby="normal-banner-title">
    <EditorHeading kicker="Normal promo / info" title="Announcement banner" description="Short, bounded messages shown when no genuine live takeover is active." enabled={config.normal.enabled} onEnabled={(enabled) => update({ enabled })} id="normal-banner-title" />
    <div className="banner-editor__controls"><label><span>Presentation mode</span><select value={config.normal.mode} onChange={(event) => update({ mode: event.target.value as BannerConfig["normal"]["mode"] })}><option value="static">Static</option><option value="ticker">Horizontal ticker</option><option value="crossfade">Crossfade</option></select></label><label><span>Animation speed</span><select value={config.normal.speed} onChange={(event) => update({ speed: event.target.value as BannerConfig["normal"]["speed"] })}><option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option></select></label></div>
    <div className="banner-message-editor"><header><div><span>Messages</span><small>{config.normal.messages.length} / 5</small></div><button className="secondary-button" type="button" disabled={config.normal.messages.length >= 5} onClick={() => update({ messages: [...config.normal.messages, { ...EMPTY_MESSAGE }] })}>Add message</button></header>
      {!config.normal.messages.length && <p className="banner-message-editor__empty">No messages configured. Add one before enabling the normal banner.</p>}
      {config.normal.messages.map((message, index) => <fieldset key={index}><legend>Message {index + 1}</legend><label className="is-wide"><span>Message text <small>{message.text.length}/160</small></span><input value={message.text} maxLength={160} required onChange={(event) => updateMessage(index, { text: event.target.value })} /></label><label><span>CTA label</span><input value={message.ctaLabel ?? ""} maxLength={40} placeholder="Optional" onChange={(event) => updateMessage(index, { ctaLabel: event.target.value || null })} /></label><label><span>CTA link</span><input value={message.href ?? ""} maxLength={1024} placeholder="/watch or https://…" onChange={(event) => updateMessage(index, { href: event.target.value || null })} /></label><label className="banner-check"><input type="checkbox" checked={message.newTab} disabled={Boolean(message.href?.startsWith("/"))} onChange={(event) => updateMessage(index, { newTab: event.target.checked })} /><span>Open external link in a new tab</span></label><button className="button-link is-danger" type="button" onClick={() => update({ messages: config.normal.messages.filter((_, position) => position !== index) })}>Remove</button></fieldset>)}
    </div>
    <NormalPreview config={config} />
  </section>;
}

function LiveEditor({ config, setConfig }: EditorProps) {
  const update = (patch: Partial<BannerConfig["live"]>) => setConfig({ ...config, live: { ...config.live, ...patch } });
  return <section className="banner-editor__panel banner-editor__panel--live" aria-labelledby="live-banner-title">
    <EditorHeading kicker="Automatic Live Now" title="Live takeover" description="Presentation only. Live truth and the real stream title always come from the authoritative Watch snapshot." enabled={config.live.enabled} onEnabled={(enabled) => update({ enabled })} id="live-banner-title" />
    <div className="banner-editor__controls banner-editor__controls--live"><label><span>Live prefix / label</span><input value={config.live.label} maxLength={32} required onChange={(event) => update({ label: event.target.value })} /></label><label><span>CTA label</span><input value={config.live.ctaLabel} maxLength={32} required onChange={(event) => update({ ctaLabel: event.target.value })} /></label><label className="is-wide"><span>Supporting text</span><input value={config.live.supportingText ?? ""} maxLength={120} placeholder="Optional supporting copy" onChange={(event) => update({ supportingText: event.target.value || null })} /></label><label><span>Animation treatment</span><select value={config.live.animation} onChange={(event) => update({ animation: event.target.value as BannerConfig["live"]["animation"] })}><option value="pulse">Pulse</option><option value="sweep">Sweep</option><option value="pulse-sweep">Pulse + sweep</option><option value="static">Restrained / static</option></select></label><label><span>Intensity / speed</span><select value={config.live.intensity} onChange={(event) => update({ intensity: event.target.value as BannerConfig["live"]["intensity"] })}><option value="subtle">Subtle</option><option value="normal">Normal</option><option value="strong">Strong</option></select></label><label className="banner-check"><input type="checkbox" checked={config.live.showTitle} onChange={(event) => update({ showTitle: event.target.checked })} /><span>Show the real active stream title</span></label><div className="banner-locked-route"><span>Locked destination</span><code>/watch/live</code></div></div>
    <LivePreview config={config} />
  </section>;
}

function EditorHeading({ kicker, title, description, enabled, onEnabled, id }: { kicker: string; title: string; description: string; enabled: boolean; onEnabled: (enabled: boolean) => void; id: string }) { return <header className="banner-editor__heading"><div><p className="section-kicker">{kicker}</p><h2 id={id}>{title}</h2><p>{description}</p></div><label className="admin-switch"><input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} /><span aria-hidden="true"><i /></span><b>{enabled ? "Enabled" : "Disabled"}</b></label></header>; }

function NormalPreview({ config }: { config: BannerConfig }) { const messages = config.normal.messages.length ? config.normal.messages : [{ ...EMPTY_MESSAGE, text: "Your normal announcement preview appears here." }]; return <PreviewShell label="Normal banner preview"><div className={`admin-banner-preview admin-banner-preview--normal is-${config.normal.mode}`}><div>{messages.map((message, index) => <span key={index}>{message.text}{message.ctaLabel && <b>{message.ctaLabel} ↗</b>}</span>)}</div></div></PreviewShell>; }
function LivePreview({ config }: { config: BannerConfig }) { return <PreviewShell label="Live banner fixture preview"><div className={`admin-banner-preview admin-banner-preview--live is-${config.live.animation} is-${config.live.intensity}`}><span className="admin-live-label"><i />{config.live.label || "LIVE NOW"}</span><span className="admin-live-title">{config.live.showTitle ? FIXTURE_TITLE : config.live.supportingText || "Live broadcast confirmed"}</span><b>{config.live.ctaLabel || "WATCH NOW"} ↗</b></div><small className="banner-fixture-note">Fixture preview only — this does not indicate or create a real live broadcast.</small></PreviewShell>; }
function PreviewShell({ label, children }: { label: string; children: ReactNode }) { return <div className="banner-preview-shell"><span>{label}</span>{children}</div>; }
type EditorProps = { config: BannerConfig; setConfig: (config: BannerConfig) => void };
