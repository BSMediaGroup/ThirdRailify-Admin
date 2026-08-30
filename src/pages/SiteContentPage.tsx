import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import tripleZapMark from "../../assets/icons/trzap-0.svg";
import { useAuth } from "../auth/AuthProvider";
import { type BannerConfig, type BannerMessage, readBannerSettings, saveBannerSettings } from "../banner/client";
import { AdminIcon } from "../components/AdminIcon";

const EMPTY_MESSAGE: BannerMessage = { text: "", ctaLabel: null, href: null, newTab: false };
const FIXTURE_TITLE = "SAMPLE PREVIEW — Third Railify live broadcast title";
const tripleZapMask = { "--triple-zap-mask": `url("${tripleZapMark}")` } as CSSProperties;

export function SiteContentPage() {
  const { csrfToken, hasCapability } = useAuth();
  const canManage = hasCapability("content.manage");
  const [config, setConfig] = useState<BannerConfig | null>(null);
  const [revision, setRevision] = useState(0);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const dirty = useMemo(() => Boolean(config && savedSnapshot && JSON.stringify(config) !== savedSnapshot), [config, savedSnapshot]);

  const load = useCallback(async () => {
    setLoading(true); setError(""); setSaved("");
    try { const result = await readBannerSettings(); setConfig(result.config); setRevision(result.revision); setSavedSnapshot(JSON.stringify(result.config)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Banner configuration is unavailable."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage || !config || !csrfToken || saving || !dirty) return;
    setSaving(true); setError(""); setSaved("");
    try { const result = await saveBannerSettings(config, revision, csrfToken); setConfig(result.config); setRevision(result.revision); setSavedSnapshot(JSON.stringify(result.config)); setSaved(`Saved revision ${result.revision}.`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The banner configuration could not be saved."); }
    finally { setSaving(false); }
  };

  return (
    <section className="site-content-page" aria-labelledby="site-content-title">
      <header className="content-admin-heading"><div><p className="section-kicker">Site content / announcements</p><h1 id="site-content-title">Public banner</h1><p>Configure the normal announcement rail and the presentation used only when Watch confirms a genuine live broadcast.</p></div><a className="secondary-button content-admin-heading__public-link" href="https://thirdrailify.com/" target="_blank" rel="noreferrer" aria-label="Open Public site in a new tab"><span>Open Public site</span><AdminIcon name="external" size={16} /></a></header>
      {error && <div className="notice-card notice-card--danger" role="alert"><AdminIcon name="signal" /><div><strong>Banner configuration unavailable</strong><p>{error}</p></div><button className="button-link" type="button" onClick={() => void load()}>Reload</button></div>}
      {loading && <div className="content-admin-loading" role="status">Loading authoritative banner configuration…</div>}
      {!loading && !config && !error && <div className="content-admin-loading">Banner configuration is unavailable.</div>}
      {config && <form className="banner-editor" onSubmit={submit}>
        <NormalEditor config={config} setConfig={setConfig} />
        <HomeRailEditor config={config} setConfig={setConfig} />
        <LiveEditor config={config} setConfig={setConfig} />
        <div className="banner-savebar"><span className={dirty ? "is-dirty" : saved ? "is-saved" : ""}><i />{saving ? "Saving to server…" : dirty ? "Unsaved changes" : saved || "All changes saved"}</span><button className="primary-button" type="submit" disabled={!dirty || saving}>{saving ? "Saving…" : "Save banner settings"}</button></div>
      </form>}
    </section>
  );
}

function HomeRailEditor({ config, setConfig }: EditorProps) {
  const update = (patch: Partial<BannerConfig["homeRail"]>) => setConfig({ ...config, homeRail: { ...config.homeRail, ...patch } });
  return <section className="banner-editor__panel banner-editor__panel--home-rail" aria-labelledby="home-rail-title">
    <EditorHeading kicker="Homepage / below hero" title="Homepage content rail" description="The narrow editorial rail directly below the main landing hero. Marquee mode uses two identical tracks for a seamless loop with no trailing blank space." enabled={config.homeRail.enabled} onEnabled={(enabled) => update({ enabled })} id="home-rail-title" />
    <div className="banner-editor__controls banner-editor__controls--rail">
      <label><span>Effect</span><select value={config.homeRail.mode} onChange={(event) => update({ mode: event.target.value as BannerConfig["homeRail"]["mode"] })}><option value="marquee">Seamless marquee scroll</option><option value="crossfade">Crossfade between items</option><option value="static">Static row</option></select></label>
      <label><span>Animation speed</span><select value={config.homeRail.speed} onChange={(event) => update({ speed: event.target.value as BannerConfig["homeRail"]["speed"] })}><option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option></select></label>
      <label><span>Motion easing</span><select value={config.homeRail.easing} onChange={(event) => update({ easing: event.target.value as BannerConfig["homeRail"]["easing"] })}><option value="linear">Linear / continuous</option><option value="ease-in-out">Ease in and out</option></select></label>
      <label><span>Divider glyph</span><select value={config.homeRail.glyph} onChange={(event) => update({ glyph: event.target.value as BannerConfig["homeRail"]["glyph"] })}><option value="zap">Third Railify triple zap</option><option value="arrow">Original wonky arrow</option><option value="diamond">Signal diamond</option><option value="dot">Signal dot</option></select></label>
      <label><span>Divider size</span><select value={config.homeRail.glyphSize} onChange={(event) => update({ glyphSize: event.target.value as BannerConfig["homeRail"]["glyphSize"] })}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label>
      <label className="is-wide"><span>Rail text · one item per line <small>{config.homeRail.items.length}/8</small></span><textarea rows={6} value={config.homeRail.items.join("\n")} maxLength={647} required onChange={(event) => update({ items: event.target.value.split(/\r?\n/).slice(0, 8) })} /><small>Up to eight non-empty items, 80 characters each. The Public rail repeats this exact sequence without exposing Admin metadata.</small></label>
    </div>
    <HomeRailPreview config={config} />
  </section>;
}

function NormalEditor({ config, setConfig }: EditorProps) {
  const update = (patch: Partial<BannerConfig["normal"]>) => setConfig({ ...config, normal: { ...config.normal, ...patch } });
  const updateMessage = (index: number, patch: Partial<BannerMessage>) => update({ messages: config.normal.messages.map((message, position) => position === index ? { ...message, ...patch } : message) });
  return <section className="banner-editor__panel" aria-labelledby="normal-banner-title">
    <EditorHeading kicker="Normal promo / info" title="Announcement banner" description="Short, bounded messages shown when no genuine live takeover is active." enabled={config.normal.enabled} onEnabled={(enabled) => update({ enabled })} id="normal-banner-title" />
    <div className="banner-editor__controls"><label><span>Presentation mode</span><select value={config.normal.mode} onChange={(event) => update({ mode: event.target.value as BannerConfig["normal"]["mode"] })}><option value="static">Static</option><option value="ticker">Horizontal ticker</option><option value="crossfade">Crossfade</option></select></label><label><span>Animation speed</span><select value={config.normal.speed} onChange={(event) => update({ speed: event.target.value as BannerConfig["normal"]["speed"] })}><option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option></select></label><label><span>Ticker divider icon</span><select value={config.normal.glyph} onChange={(event) => update({ glyph: event.target.value as BannerConfig["normal"]["glyph"] })}><option value="zap">Third Railify triple zap</option><option value="arrow">Original wonky arrow</option><option value="diamond">Signal diamond</option><option value="dot">Signal dot</option></select></label><label><span>Ticker divider size</span><select value={config.normal.glyphSize} onChange={(event) => update({ glyphSize: event.target.value as BannerConfig["normal"]["glyphSize"] })}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label><label className="banner-check is-wide"><input type="checkbox" checked={config.normal.dismissible} onChange={(event) => update({ dismissible: event.target.checked })} /><span>Allow visitors to dismiss this banner with a close button</span></label></div>
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

function NormalPreview({ config }: { config: BannerConfig }) {
  const messages = config.normal.messages.length ? config.normal.messages : [{ ...EMPTY_MESSAGE, text: "Your normal announcement preview appears here." }];
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [repetitions, setRepetitions] = useState(2);
  const tickerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const signature = JSON.stringify(config.normal);
  useEffect(() => { setActive(0); setDismissed(false); }, [signature]);
  useEffect(() => {
    if (config.normal.mode !== "crossfade" || messages.length < 2) return;
    const duration = config.normal.speed === "slow" ? 10_000 : config.normal.speed === "fast" ? 5_000 : 7_000;
    const timer = window.setInterval(() => setActive((index) => (index + 1) % messages.length), duration);
    return () => window.clearInterval(timer);
  }, [config.normal.mode, config.normal.speed, messages.length, signature]);
  useLayoutEffect(() => {
    if (config.normal.mode !== "ticker" || !tickerRef.current || !measureRef.current) return;
    const update = () => {
      const cycleWidth = measureRef.current?.scrollWidth || 1;
      const viewportWidth = tickerRef.current?.clientWidth || 1;
      setRepetitions((current) => {
        const next = Math.max(2, Math.ceil(viewportWidth / cycleWidth) + 1);
        return current === next ? current : next;
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tickerRef.current);
    observer.observe(measureRef.current);
    return () => observer.disconnect();
  }, [config.normal.glyph, config.normal.glyphSize, config.normal.mode, signature]);
  const content = (message: BannerMessage, duplicate = false) => <span aria-hidden={duplicate || undefined}>{message.text}{message.ctaLabel && <b>{message.ctaLabel}<PreviewArrowIcon /></b>}</span>;
  const cycleSeconds = config.normal.speed === "slow" ? 44 : config.normal.speed === "fast" ? 22 : 30;
  return <PreviewShell label="Normal banner preview">
    {dismissed ? <div className="admin-banner-preview admin-banner-preview--dismissed"><span>Dismissed for this preview</span><button type="button" onClick={() => setDismissed(false)}>Restore preview</button></div>
      : <div className={`admin-banner-preview admin-banner-preview--normal is-${config.normal.mode} is-${config.normal.speed} is-glyph-${config.normal.glyphSize}${config.normal.dismissible ? " is-dismissible" : ""}`}>
        {config.normal.mode === "ticker" ? <div ref={tickerRef} className="admin-banner-preview__ticker"><div ref={measureRef} className="admin-banner-preview__ticker-measure" aria-hidden="true"><AdminBannerTickerSegment messages={messages} glyph={config.normal.glyph} duplicate /></div><div className="admin-banner-preview__ticker-track" style={{ animationDuration: `${cycleSeconds * repetitions}s` }}><AdminBannerTickerSegment messages={messages} glyph={config.normal.glyph} repetitions={repetitions} /><AdminBannerTickerSegment messages={messages} glyph={config.normal.glyph} repetitions={repetitions} duplicate /></div></div>
          : config.normal.mode === "crossfade" ? <div className="admin-banner-preview__crossfade">{messages.map((message, index) => <span className={index === active ? "is-active" : ""} key={`${index}-${message.text}`}>{message.text}{message.ctaLabel && <b>{message.ctaLabel}<PreviewArrowIcon /></b>}</span>)}</div>
          : <div className="admin-banner-preview__inner">{content(messages[0])}</div>}
        {config.normal.dismissible && <button className="admin-banner-preview__dismiss" type="button" onClick={() => setDismissed(true)} aria-label="Dismiss announcement preview"><AdminIcon name="close" size={14} /></button>}
      </div>}
  </PreviewShell>;
}
function AdminBannerTickerSegment({ messages, glyph, repetitions = 1, duplicate = false }: { messages: BannerMessage[]; glyph: BannerConfig["normal"]["glyph"]; repetitions?: number; duplicate?: boolean }) { return <div className="admin-banner-preview__ticker-segment" aria-hidden={duplicate || undefined}>{Array.from({ length: repetitions }, (_, cycle) => messages.map((message, index) => <span className={`admin-banner-preview__ticker-item${duplicate || cycle > 0 ? " is-duplicate" : ""}`} key={`${cycle}-${message.text}-${index}`}><span aria-hidden={duplicate || cycle > 0 || undefined}>{message.text}{message.ctaLabel && <b>{message.ctaLabel}<PreviewArrowIcon /></b>}</span><AdminBannerDivider glyph={glyph} /></span>))}</div>; }
function AdminBannerDivider({ glyph }: { glyph: BannerConfig["normal"]["glyph"] }) { if (glyph === "zap") return <i className="admin-banner-preview__divider admin-banner-preview__divider--zap" style={tripleZapMask} aria-hidden="true" />; return <i className={`admin-banner-preview__divider admin-banner-preview__divider--${glyph}`} aria-hidden="true">{glyph === "arrow" ? "↯" : glyph === "diamond" ? "◆" : "•"}</i>; }
function LivePreview({ config }: { config: BannerConfig }) { return <PreviewShell label="Live banner fixture preview"><div className={`admin-banner-preview admin-banner-preview--live is-${config.live.animation} is-${config.live.intensity}`}><div className="admin-banner-preview__energy" aria-hidden="true" /><div className="admin-banner-preview__live-inner"><span className="admin-live-label"><i /><PreviewRadioIcon />{config.live.label || "LIVE NOW"}</span><span className="admin-live-title">{config.live.showTitle && <b>{FIXTURE_TITLE}</b>}{config.live.supportingText && <small>{config.live.supportingText}</small>}</span><b><PreviewPlayIcon />{config.live.ctaLabel || "WATCH NOW"}<PreviewArrowIcon /></b></div></div><small className="banner-fixture-note">Fixture preview only — this does not indicate or create a real live broadcast.</small></PreviewShell>; }
function HomeRailPreview({ config }: { config: BannerConfig }) {
  const items = config.homeRail.items.length ? config.homeRail.items : ["YOUR HOMEPAGE RAIL TEXT"];
  const [active, setActive] = useState(0);
  const [repetitions, setRepetitions] = useState(2);
  const previewRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const itemsKey = items.join("\u0000");
  useEffect(() => {
    if (!config.homeRail.enabled || config.homeRail.mode !== "crossfade" || items.length < 2) return;
    const delay = config.homeRail.speed === "slow" ? 6500 : config.homeRail.speed === "fast" ? 2600 : 4200;
    const timer = window.setInterval(() => setActive((value) => (value + 1) % items.length), delay);
    return () => window.clearInterval(timer);
  }, [config.homeRail.enabled, config.homeRail.mode, config.homeRail.speed, items.length]);
  useEffect(() => { setActive(0); }, [itemsKey]);
  useLayoutEffect(() => {
    if (!config.homeRail.enabled || config.homeRail.mode !== "marquee" || !previewRef.current || !measureRef.current) return;
    const update = () => {
      const cycleWidth = measureRef.current?.scrollWidth || 1;
      const viewportWidth = previewRef.current?.clientWidth || 1;
      setRepetitions((current) => {
        const next = Math.max(2, Math.ceil(viewportWidth / cycleWidth) + 1);
        return current === next ? current : next;
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(previewRef.current);
    observer.observe(measureRef.current);
    return () => observer.disconnect();
  }, [config.homeRail.enabled, config.homeRail.glyph, config.homeRail.glyphSize, config.homeRail.mode, itemsKey]);
  const cycleSeconds = config.homeRail.speed === "slow" ? 42 : config.homeRail.speed === "fast" ? 18 : 28;
  return <PreviewShell label="Homepage rail preview">
    {!config.homeRail.enabled ? <div className="admin-home-rail-preview admin-home-rail-preview--disabled">Disabled — no homepage rail is rendered.</div> : <div ref={previewRef} className={`admin-home-rail-preview admin-home-rail-preview--${config.homeRail.mode} is-${config.homeRail.speed} is-${config.homeRail.easing} is-glyph-${config.homeRail.glyphSize}`}>
      {config.homeRail.mode === "marquee" ? <><div ref={measureRef} className="admin-home-rail-preview__measure" aria-hidden="true"><AdminRailSegment items={items} glyph={config.homeRail.glyph} /></div><div className="admin-home-rail-preview__track" style={{ animationDuration: `${cycleSeconds * repetitions}s` }}><AdminRailSegment items={items} glyph={config.homeRail.glyph} repetitions={repetitions} /><AdminRailSegment items={items} glyph={config.homeRail.glyph} repetitions={repetitions} duplicate /></div></>
        : config.homeRail.mode === "crossfade" ? <div className="admin-home-rail-preview__crossfade" key={`${active}-${items[active]}`}>{items[active]}</div>
        : <AdminRailSegment items={items} glyph={config.homeRail.glyph} />}
    </div>}
  </PreviewShell>;
}
function AdminRailSegment({ items, glyph, repetitions = 1, duplicate = false }: { items: string[]; glyph: BannerConfig["homeRail"]["glyph"]; repetitions?: number; duplicate?: boolean }) { return <div className="admin-home-rail-preview__segment" aria-hidden={duplicate || undefined}>{Array.from({ length: repetitions }, (_, cycle) => items.map((item, index) => <span key={`${cycle}-${item}-${index}`}>{item}<RailGlyph glyph={glyph} /></span>))}</div>; }
function RailGlyph({ glyph }: { glyph: BannerConfig["homeRail"]["glyph"] }) { if (glyph === "zap") return <i className="admin-home-rail-preview__zap" style={tripleZapMask} aria-hidden="true" />; return <i aria-hidden="true">{glyph === "arrow" ? "↯" : glyph === "diamond" ? "◆" : "•"}</i>; }
function PreviewArrowIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 19 19 5M8 5h11v11" /></svg>; }
function PreviewPlayIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 7 8 5-8 5V7Z" /></svg>; }
function PreviewRadioIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.5 18.5a9 9 0 0 1 0-13M18.5 5.5a9 9 0 0 1 0 13" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /></svg>; }
function PreviewShell({ label, children }: { label: string; children: ReactNode }) { return <div className="banner-preview-shell"><span>{label}</span>{children}</div>; }
type EditorProps = { config: BannerConfig; setConfig: (config: BannerConfig) => void };
