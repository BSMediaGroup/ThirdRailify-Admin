import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { adminApi } from "../auth/client";
import { getAnalytics, type AnalyticsReport } from "../analytics/client";
import { useAuth } from "../auth/AuthProvider";
import { adminCapabilityIds } from "../auth/capabilities";
import { readBannerSettings, type BannerSettings } from "../banner/client";
import { getCommerceOverview, type CommerceOverviewPayload } from "../commerce/client";
import { AccountAccessIcon } from "../components/AccountAccessBadge";
import { AdminIcon } from "../components/AdminIcon";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { getGoatsOverview, type GoatAdminSummary } from "../goats/client";
import { manageWatch, type WatchAdminPayload } from "../watch/client";

type StatusPayload = {
  ok: boolean;
  authenticatedAccount: { displayName: string; adminLevel: string };
  access: { isAdmin: boolean; isMasterAdmin: boolean };
  configuration: { d1Configured: boolean; turnstileConfigured: boolean; resendConfigured: boolean; oauthProviders: string[] };
  accounts: { total: number; regular: number; admins: number; disabled: number; pending: number };
  checkedAt: string;
};

type GoatsOverviewPayload = Awaited<ReturnType<typeof getGoatsOverview>>;
type Snapshot = { status: StatusPayload | null; analytics: AnalyticsReport | null; watch: WatchAdminPayload | null; commerce: CommerceOverviewPayload | null; goats: GoatsOverviewPayload | null; banner: BannerSettings | null };
type Source = keyof Snapshot;
type SourceErrors = Partial<Record<Source, string>>;
type Priority = { title: string; detail: string; to: string; label: string; tone: "attention" | "danger" | "info" };

const EMPTY_SNAPSHOT: Snapshot = { status: null, analytics: null, watch: null, commerce: null, goats: null, banner: null };

export function OverviewPage() {
  const { startLoading, inboxSummary } = useOutletContext<AdminShellOutletContext>();
  const { access, csrfToken, hasCapability } = useAuth();
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [errors, setErrors] = useState<SourceErrors>({});
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState("");
  const requestSequence = useRef(0);
  const analyticsRead = hasCapability("analytics.view");
  const commerceRead = hasCapability("commerce.view");
  const watchRead = hasCapability("watch.view") && Boolean(csrfToken);
  const goatsRead = hasCapability("goats.view");
  const bannerRead = hasCapability("content.view");

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const stopLoading = startLoading("Refreshing operational overview");
    setLoading(true); setErrors({});
    const [status, analytics, commerce, watch, goats, banner] = await Promise.all([
      capture(adminApi<StatusPayload>("/api/admin/status")),
      analyticsRead ? capture(getAnalytics("24h")) : restricted<AnalyticsReport>(),
      commerceRead ? capture(getCommerceOverview()) : restricted<CommerceOverviewPayload>(),
      watchRead ? capture(manageWatch("read", csrfToken)) : restricted<WatchAdminPayload>(),
      goatsRead ? capture(getGoatsOverview()) : restricted<GoatsOverviewPayload>(),
      bannerRead ? capture(readBannerSettings()) : restricted<BannerSettings>(),
    ]);
    if (requestSequence.current === sequence) {
      setSnapshot({ status: status.value, analytics: analytics.value, commerce: commerce.value, watch: watch.value, goats: goats.value, banner: banner.value });
      setErrors(compactErrors({ status: status.error, analytics: analytics.error, commerce: commerce.error, watch: watch.error, goats: goats.error, banner: banner.error }));
      setRefreshedAt(new Date().toISOString());
      setLoading(false);
    }
    stopLoading();
  }, [analyticsRead, bannerRead, commerceRead, csrfToken, goatsRead, startLoading, watchRead]);

  useEffect(() => { void load(); return () => { requestSequence.current += 1; }; }, [load]);

  const expectedSources = 1 + [analyticsRead, commerceRead, watchRead, goatsRead, bannerRead].filter(Boolean).length;
  const reportingSources = Object.values(snapshot).filter(Boolean).length;
  const priorities = operationalPriorities(snapshot, errors);
  const hasSnapshot = reportingSources > 0;
  const errorCount = Object.keys(errors).filter((key) => errors[key as Source] !== "restricted").length;

  return <div className="overview-page">
    <section className="overview-hero" aria-labelledby="overview-title">
      <div className="overview-hero__signal" aria-hidden="true"><i /><i /><i /><span /></div>
      <div className="overview-hero__copy">
        <p className="eyebrow"><span /> Operational overview / authenticated authority</p>
        <h1 id="overview-title">Every signal.<br /><em>One control room.</em></h1>
        <p>Current state from the real account, broadcast, commerce, community, and site-content authorities—without placeholder metrics or deferred-era copy.</p>
        <div className="overview-hero__actions"><button className="primary-button" type="button" onClick={() => void load()} disabled={loading}><AdminIcon name="signal" size={17} />{loading ? "Refreshing…" : "Refresh overview"}</button><a className="secondary-button" href="https://thirdrailify.com/" target="_blank" rel="noreferrer">Open Public site <AdminIcon name="external" size={15} /></a></div>
      </div>
      <aside className="overview-pulse" aria-label="Operational snapshot summary">
        <div className="overview-pulse__top"><span><i className={errorCount ? "is-warning" : ""} />System pulse</span><small>{loading ? "Reading authorities" : refreshedAt ? formatTime(refreshedAt) : "Not checked"}</small></div>
        <div className="overview-pulse__body">
          <div className="overview-pulse__credential">
            <span className="overview-pulse__shield" data-access-icon={access.isMasterAdmin ? "master_admin" : "full_admin"} aria-hidden="true">{access.isMasterAdmin ? <AccountAccessIcon kind="master_admin" /> : <AdminIcon name="shield" size={28} />}</span>
            <div><small>Session role</small><strong>{access.isMasterAdmin ? "Master" : "Full Admin"}</strong><span>Account level / server verified</span></div>
          </div>
          <div className="overview-pulse__readout"><strong>{loading && !hasSnapshot ? "—" : `${reportingSources}/${expectedSources}`}</strong><span>sources reporting</span></div>
        </div>
        <dl><div><dt>Access</dt><dd>{access.isMasterAdmin ? "All workspaces" : access.capabilities.length === adminCapabilityIds.length - 1 ? "Default parity" : "Restricted policy"}</dd></div><div><dt>Attention</dt><dd>{hasSnapshot ? priorities.length : "—"}</dd></div><div><dt>Authority</dt><dd>Server</dd></div></dl>
      </aside>
    </section>

    {errorCount > 0 && <div className="overview-partial" role="alert"><AdminIcon name="signal" size={21} /><div><strong>Partial operational snapshot</strong><p>{errorCount} {errorCount === 1 ? "authority did" : "authorities did"} not report. Missing values remain unavailable rather than being replaced with zero.</p></div><button type="button" onClick={() => void load()} disabled={loading}>Retry</button></div>}

    <AnalyticsOverview data={snapshot.analytics} error={errors.analytics} loading={loading} />

    <section className="overview-section" aria-labelledby="operations-title">
      <OverviewHeading eyebrow="Current authority" title="Operational workspaces" id="operations-title" detail={refreshedAt ? `Refreshed ${formatTime(refreshedAt)}` : "Reading current state"} />
      <div className="overview-module-grid">
        <WatchModule data={snapshot.watch} error={errors.watch} loading={loading} restricted={!watchRead} />
        <CommerceModule data={snapshot.commerce} error={errors.commerce} loading={loading} />
        <GoatsModule data={snapshot.goats} error={errors.goats} loading={loading} restricted={!goatsRead} />
        <BannerModule data={snapshot.banner} error={errors.banner} loading={loading} restricted={!bannerRead} />
        <AccountsModule data={snapshot.status} error={errors.status} loading={loading} />
      </div>
    </section>

    <section className="overview-section overview-section--compact" aria-labelledby="posture-title">
      <OverviewHeading eyebrow="Security and delivery" title="Runtime posture" id="posture-title" detail={snapshot.status?.checkedAt ? `Server checked ${formatTime(snapshot.status.checkedAt)}` : "Server configuration"} />
      <div className="overview-posture">
        <Posture label="Account D1" value={configuredLabel(snapshot.status?.configuration.d1Configured, loading, errors.status)} tone={configuredTone(snapshot.status?.configuration.d1Configured, errors.status)} />
        <Posture label="Turnstile" value={configuredLabel(snapshot.status?.configuration.turnstileConfigured, loading, errors.status)} tone={configuredTone(snapshot.status?.configuration.turnstileConfigured, errors.status)} />
        <Posture label="Resend delivery" value={configuredLabel(snapshot.status?.configuration.resendConfigured, loading, errors.status)} tone={configuredTone(snapshot.status?.configuration.resendConfigured, errors.status)} />
        <Posture label="OAuth providers" value={snapshot.status ? snapshot.status.configuration.oauthProviders.length ? snapshot.status.configuration.oauthProviders.map(providerLabel).join(" · ") : "None configured" : sourceFallback(loading, errors.status)} tone={snapshot.status?.configuration.oauthProviders.length ? "safe" : errors.status ? "danger" : "muted"} />
        <Posture label="Commerce D1" value={configuredLabel(snapshot.commerce?.databaseConfigured, loading, errors.commerce)} tone={configuredTone(snapshot.commerce?.databaseConfigured, errors.commerce)} />
      </div>
    </section>

    <section className="overview-section overview-inbox" aria-labelledby="overview-inbox-title">
      <OverviewHeading eyebrow="Admin inbox" title="Latest notices" id="overview-inbox-title" detail={inboxSummary ? `${inboxSummary.unread} unread` : "Reading inbox"} />
      {inboxSummary?.latest.length ? <div className="overview-inbox__list">{inboxSummary.latest.map((message) => <Link key={message.id} className={message.unread ? "is-unread" : ""} to={message.actionUrl || "/inbox"}><i /><span><strong>{message.title}</strong><small>{message.preview}</small></span><time>{formatTime(message.createdAt)}</time><AdminIcon name="arrow" size={14} /></Link>)}</div> : <ModuleState text={inboxSummary ? "No Admin notices have been recorded yet." : "Loading the Admin inbox…"} />}
      <Link className="overview-section__link" to="/inbox">Open full inbox <AdminIcon name="arrow" size={15} /></Link>
    </section>

    <div className="overview-lower-grid">
      <section className="overview-section overview-priorities" aria-labelledby="priorities-title">
        <OverviewHeading eyebrow="Work requiring review" title="Operational priorities" id="priorities-title" detail={hasSnapshot ? `${priorities.length} current` : "Unavailable"} />
        <div className="overview-priority-list">{priorities.length ? priorities.map((priority) => <Link key={`${priority.to}-${priority.title}`} className={`overview-priority is-${priority.tone}`} to={priority.to}><i /><span><strong>{priority.title}</strong><small>{priority.detail}</small></span><b>{priority.label} <AdminIcon name="arrow" size={14} /></b></Link>) : hasSnapshot ? <div className="overview-clear"><AdminIcon name="shield" size={24} /><div><strong>No active queue flags</strong><p>The authorities that reported do not currently expose a pending account, moderation, delivery, or service-read issue.</p></div></div> : <ModuleState text="Priority state is unavailable until at least one authority reports." />}</div>
      </section>

      <section className="overview-section overview-activity" aria-labelledby="activity-title">
        <OverviewHeading eyebrow="Community activity" title="Recent GOATS" id="activity-title" detail={snapshot.goats ? `${snapshot.goats.recent.length} returned` : "Latest records"} />
        {snapshot.goats?.recent.length ? <div className="overview-activity-list">{snapshot.goats.recent.slice(0, 4).map((item) => <RecentGoat key={item.id} item={item} />)}</div> : snapshot.goats ? <ModuleState text="No recent GOATS submissions are available." /> : <ModuleState text={!goatsRead ? "GOATS viewing is restricted for this role." : errors.goats || (loading ? "Loading recent activity…" : "Recent activity is unavailable.")} />}
        <Link className="overview-section__link" to="/goats">Open GOATS workspace <AdminIcon name="arrow" size={15} /></Link>
      </section>
    </div>
  </div>;
}

function WatchModule({ data, error, loading, restricted }: { data: WatchAdminPayload | null; error?: string; loading: boolean; restricted: boolean }) {
  const primary = data?.current?.primary;
  const state = restricted ? "Restricted" : error ? "Unavailable" : primary ? presentationLabel(primary.presentationState) : data ? "No current signal" : loading ? "Checking" : "Unavailable";
  return <ModuleCard icon="watch" eyebrow="Broadcast" title="Watch / signal" status={state} tone={primary?.presentationState === "live" ? "live" : error ? "danger" : data ? "safe" : "muted"} to="/watch" linkLabel="Open broadcast control">
    {data ? <><div className="overview-module__metric"><strong>{data.summary.retained}<small>/ 24</small></strong><span>retained episodes</span></div><dl><Fact label="Visible" value={data.summary.visible} /><Fact label="Hidden" value={data.summary.hidden} /><Fact label="Open slots" value={data.summary.remaining} /></dl><p className="overview-module__note">{primary?.title || "No live, upcoming, or latest candidate is selected."}</p></> : <ModuleState text={restricted ? "Watch viewing is restricted for this role." : error || (loading ? "Reading Watch authority…" : "Watch authority is unavailable.")} />}
  </ModuleCard>;
}

function CommerceModule({ data, error, loading }: { data: CommerceOverviewPayload | null; error?: string; loading: boolean }) {
  const readiness = data?.readiness;
  return <ModuleCard icon="commerce" eyebrow="Store operations" title="Commerce" status={error ? "Unavailable" : readiness?.productionReady ? "Production ready" : data ? "Pre-cutover" : loading ? "Checking" : "Unavailable"} tone={error ? "danger" : readiness?.productionReady ? "safe" : data ? "attention" : "muted"} to="/commerce" linkLabel="Open commerce overview">
    {data ? <><div className="overview-module__metric"><strong>{displayNumber(data.counts.products)}</strong><span>catalogue products</span></div><dl><Fact label="Orders" value={displayNumber(data.counts.orders)} /><Fact label="Templates" value={displayNumber(data.counts.templates)} /><Fact label="Readiness" value={readiness?.productionReady ? "Ready" : "Blocked"} /></dl><div className="overview-guardrails"><span>Checkout <b>{postureValue(data, "checkout")}</b></span><span>Live payments <b>{postureValue(data, "livePaymentCapture")}</b></span><span>Fulfillment <b>{postureValue(data, "fulfillmentSubmission")}</b></span></div></> : <ModuleState text={error || (loading ? "Reading Commerce D1…" : "Commerce authority is unavailable.")} />}
  </ModuleCard>;
}

function GoatsModule({ data, error, loading, restricted }: { data: GoatsOverviewPayload | null; error?: string; loading: boolean; restricted: boolean }) {
  const failed = data ? numberOrNull(data.email.failed) : null;
  return <ModuleCard icon="goats" eyebrow="Community moderation" title="GOATS in the Wild" status={restricted ? "Restricted" : error ? "Unavailable" : data?.counts.pending ? `${data.counts.pending} pending` : data ? "Queue clear" : loading ? "Checking" : "Unavailable"} tone={error ? "danger" : data?.counts.pending || failed ? "attention" : data ? "safe" : "muted"} to={data?.counts.pending ? "/goats/pending" : "/goats"} linkLabel={data?.counts.pending ? "Review pending GOATS" : "Open GOATS workspace"}>
    {data ? <><div className="overview-module__metric"><strong>{data.counts.pending}</strong><span>awaiting moderation</span></div><dl><Fact label="Approved" value={data.counts.approved} /><Fact label="Hidden" value={data.counts.hidden} /><Fact label="Email failed" value={failed ?? "—"} /></dl><p className="overview-module__note">{data.recent[0] ? `Latest: ${data.recent[0].displayName}` : "No recent submissions."}</p></> : <ModuleState text={restricted ? "GOATS viewing is restricted for this role." : error || (loading ? "Reading moderation authority…" : "GOATS authority is unavailable.")} />}
  </ModuleCard>;
}

function BannerModule({ data, error, loading, restricted }: { data: BannerSettings | null; error?: string; loading: boolean; restricted: boolean }) {
  const active = Boolean(data?.config.normal.enabled || data?.config.live.enabled);
  return <ModuleCard icon="content" eyebrow="Public presentation" title="Site content" status={restricted ? "Restricted" : error ? "Unavailable" : data ? active ? "Configured active" : "Standing by" : loading ? "Checking" : "Unavailable"} tone={error ? "danger" : active ? "attention" : data ? "safe" : "muted"} to="/content" linkLabel="Open banner controls">
    {data ? <><div className="overview-module__metric"><strong>{data.config.normal.messages.length}</strong><span>announcement messages</span></div><dl><Fact label="Normal rail" value={enabledLabel(data.config.normal.enabled)} /><Fact label="Live takeover" value={enabledLabel(data.config.live.enabled)} /><Fact label="Revision" value={data.revision} /></dl><p className="overview-module__note">Updated {formatTime(data.updatedAt)}</p></> : <ModuleState text={restricted ? "Site-content viewing is restricted for this role." : error || (loading ? "Reading banner configuration…" : "Site-content authority is unavailable.")} />}
  </ModuleCard>;
}

function AccountsModule({ data, error, loading }: { data: StatusPayload | null; error?: string; loading: boolean }) {
  return <ModuleCard icon="users" eyebrow="Identity authority" title="Users / access" status={error ? "Unavailable" : data ? `${data.accounts.admins} admins` : loading ? "Checking" : "Unavailable"} tone={error ? "danger" : data ? "safe" : "muted"} to="/access" linkLabel="Open account controls">
    {data ? <><div className="overview-module__metric"><strong>{data.accounts.total}</strong><span>total accounts</span></div><dl><Fact label="Regular" value={data.accounts.regular} /><Fact label="Pending" value={data.accounts.pending} /><Fact label="Disabled" value={data.accounts.disabled} /></dl><p className="overview-module__note">Roles and session state resolve from Account D1.</p></> : <ModuleState text={error || (loading ? "Reading account authority…" : "Account authority is unavailable.")} />}
  </ModuleCard>;
}

function ModuleCard({ icon, eyebrow, title, status, tone, to, linkLabel, children }: { icon: "watch" | "commerce" | "goats" | "content" | "users"; eyebrow: string; title: string; status: string; tone: string; to: string; linkLabel: string; children: ReactNode }) {
  return <article className={`overview-module overview-module--${icon}`}><header><span className="overview-module__icon"><AdminIcon name={icon} size={21} /></span><div><p>{eyebrow}</p><h3>{title}</h3></div><b className={`overview-state is-${tone}`}><i />{status}</b></header><div className="overview-module__body">{children}</div><Link to={to}>{linkLabel}<AdminIcon name="arrow" size={15} /></Link></article>;
}

function AnalyticsOverview({ data, error, loading }: { data: AnalyticsReport | null; error?: string; loading: boolean }) {
  const [activePoint, setActivePoint] = useState<number | null>(null);
  const detail = error ? "Analytics authority unavailable" : data ? data.configured ? data.coverage.lastIngestedAt ? `Latest signal ${formatTime(data.coverage.lastIngestedAt)}` : "No retained events in this window" : "Collection not configured" : loading ? "Reading analytics authority" : "Analytics authority unavailable";
  const metrics = data?.configured ? [
    { label: "Page views", value: String(data.selected.views), note: "Exact first-party views" },
    { label: "Anonymous sessions", value: String(data.selected.sessions), note: "Mathematically valid sessions" },
    { label: "Pages / session", value: data.selected.pagesPerSession === null ? "—" : data.selected.pagesPerSession.toFixed(2), note: "Current 24-hour window" },
    { label: "Mapped regions", value: String(data.geography.length), note: "Coarse locations only" },
  ] : null;
  const rawMax = Math.max(1, ...(data?.series.flatMap((row) => [row.views, row.sessions]) || []));
  const max = overviewTrendAxisMax(rawMax);
  const views = overviewTrendPoints(data?.series.map((row) => row.views) || [], max);
  const sessions = overviewTrendPoints(data?.series.map((row) => row.sessions) || [], max);
  const viewsPath = smoothOverviewTrendPath(views);
  const sessionsPath = smoothOverviewTrendPath(sessions);
  const areaPath = views.length ? `${viewsPath} L ${views.at(-1)!.x} 158 L ${views[0].x} 158 Z` : "";
  const chartKey = data?.series.map((row) => `${row.views}:${row.sessions}`).join("|") || "empty";
  const yTicks = [0, 1, 2, 3, 4].map((index) => ({ y: 26 + index * 33, value: Math.round(max * (1 - index / 4)) }));
  const xTicks = overviewTrendTimeTicks(data?.series || []);
  const activeRow = activePoint === null ? null : data?.series[activePoint] || null;
  const activeViewPoint = activePoint === null ? null : views[activePoint] || null;
  const activeSessionPoint = activePoint === null ? null : sessions[activePoint] || null;
  const activePrevious = activePoint === null || activePoint === 0 ? null : data?.series[activePoint - 1] || null;

  return <section className="overview-section overview-analytics" aria-labelledby="overview-analytics-title">
    <OverviewHeading eyebrow="Audience analytics / last 24 hours" title="Analytics snapshot" id="overview-analytics-title" detail={detail} />
    {metrics ? <article className="overview-analytics__panel">
      <div className="overview-analytics__trend">
        <header>
          <div><h3>Audience trend</h3><span>Hourly buckets · UTC</span></div>
          <div className="overview-analytics__legend" aria-label="Chart legend"><span className="is-views"><i />Views</span><span className="is-sessions"><i />Sessions</span></div>
        </header>
        <div className="overview-analytics__plot">
          {views.length ? <svg key={chartKey} viewBox="0 0 1000 205" role="img" aria-label={`Views and sessions across ${data?.series.length || 0} hourly buckets in the last 24 hours`} onMouseLeave={() => setActivePoint(null)}>
            <title>24-hour audience activity trend</title>
            <desc>Interactive page-view and anonymous-session lines. Focus or hover a bucket for its timestamp and exact values.</desc>
            <defs>
              <linearGradient id="overview-trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd83d" stopOpacity=".42" /><stop offset=".5" stopColor="#d7a900" stopOpacity=".14" /><stop offset="1" stopColor="#f3c928" stopOpacity="0" /></linearGradient>
              <linearGradient id="overview-trend-line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#be8b00" /><stop offset=".45" stopColor="#ffe56f" /><stop offset="1" stopColor="#f3c928" /></linearGradient>
              <filter id="overview-trend-glow" x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            </defs>
            <g className="overview-analytics__grid" aria-hidden="true">{yTicks.map((tick) => <line key={tick.y} x1="68" x2="976" y1={tick.y} y2={tick.y} />)}</g>
            <g className="overview-analytics__y-axis" aria-hidden="true">
              <text className="overview-analytics__axis-title" x="11" y="92" transform="rotate(-90 11 92)">Events / bucket</text>
              {yTicks.map((tick) => <text key={tick.y} x="58" y={tick.y + 3}>{tick.value}</text>)}
            </g>
            <path className="overview-analytics__area" d={areaPath} fill="url(#overview-trend-fill)" />
            <path className="overview-analytics__glow" d={viewsPath} pathLength="1" />
            <path className="overview-analytics__line is-views" d={viewsPath} pathLength="1" />
            <path className="overview-analytics__line is-sessions" d={sessionsPath} pathLength="1" />
            {activeViewPoint ? <g className="overview-analytics__crosshair" aria-hidden="true"><line x1={activeViewPoint.x} x2={activeViewPoint.x} y1="26" y2="158" /><line x1="68" x2="976" y1={activeViewPoint.y} y2={activeViewPoint.y} /></g> : null}
            <g className="overview-analytics__points">
              {views.map((point, index) => {
                const row = data!.series[index]; const sessionPoint = sessions[index]; const selected = activePoint === index;
                return <g key={row.bucket} className={`overview-analytics__bucket${selected ? " is-active" : ""}`} role="button" tabIndex={0} aria-label={overviewTrendPointLabel(row)} aria-describedby={selected ? "overview-trend-tooltip" : undefined} onMouseEnter={() => setActivePoint(index)} onFocus={() => setActivePoint(index)} onBlur={() => setActivePoint(null)} onClick={() => setActivePoint(index)} onKeyDown={(event) => { if (event.key === "Escape") { setActivePoint(null); event.currentTarget.blur(); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActivePoint(index); } }}>
                  <rect className="overview-analytics__hit" x={point.x - 15} y="20" width="30" height="144" rx="8" />
                  <circle className="is-views" cx={point.x} cy={point.y} r={selected ? 5.5 : 4} />
                  <circle className="is-sessions" cx={sessionPoint.x} cy={sessionPoint.y} r={selected ? 4.5 : 3.2} />
                </g>;
              })}
            </g>
            <g className="overview-analytics__x-axis" aria-hidden="true">
              {xTicks.map((tick) => <text key={tick.index} className={tick.position} x={views[tick.index].x} y="190">{formatTrendAxisTime(tick.bucket)}</text>)}
              <text className="overview-analytics__axis-title" x="976" y="202">UTC · hourly</text>
            </g>
          </svg> : <div className="overview-analytics__empty"><AdminIcon name="signal" size={20} /><span>No audience events in this 24-hour window.</span></div>}
          {activeRow && activeViewPoint && activeSessionPoint ? <div id="overview-trend-tooltip" role="tooltip" className={`overview-analytics__tooltip${activeViewPoint.x < 220 ? " is-start" : activeViewPoint.x > 780 ? " is-end" : ""}${activeViewPoint.y < 76 ? " is-below" : ""}`} style={{ left: `${activeViewPoint.x / 10}%`, top: `${activeViewPoint.y / 2.05}%` }}>
            <strong>{formatTrendTooltipTime(activeRow.bucket)}</strong>
            <dl><div><dt>Views</dt><dd>{activeRow.views}</dd></div><div><dt>Sessions</dt><dd>{activeRow.sessions}</dd></div><div><dt>Pages / session</dt><dd>{activeRow.sessions ? (activeRow.views / activeRow.sessions).toFixed(2) : "—"}</dd></div></dl>
            <small>{activePrevious ? overviewTrendDelta(activeRow.views, activePrevious.views, "view") : "First retained bucket in this window"}</small>
          </div> : null}
        </div>
      </div>
      <dl className="overview-analytics__metrics">{metrics.map((metric, index) => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd><small>{metric.note}</small><i aria-hidden="true">0{index + 1}</i></div>)}</dl>
    </article> : <div className={`overview-analytics__state${error ? " is-error" : ""}`}><AdminIcon name="signal" size={22} /><div><strong>{error ? "Analytics unavailable" : data ? "Analytics collection is not configured" : loading ? "Reading audience authority" : "Analytics unavailable"}</strong><p>{error || (data ? "Configure the analytics database before collection and reporting can begin." : loading ? "The current 24-hour window is being requested." : "No analytics report is available.")}</p></div></div>}
    <Link className="overview-section__link" to="/analytics">Open Audience Analytics <AdminIcon name="arrow" size={15} /></Link>
  </section>;
}

type OverviewTrendPoint = { x: number; y: number };
function overviewTrendPoints(values: number[], max: number): OverviewTrendPoint[] {
  if (!values.length) return [];
  if (values.length === 1) return [{ x: 522, y: 158 - (values[0] / max) * 132 }];
  return values.map((value, index) => ({ x: 68 + (index / (values.length - 1)) * 908, y: 158 - (value / max) * 132 }));
}
function smoothOverviewTrendPath(points: OverviewTrendPoint[]) {
  if (!points.length) return "";
  return points.slice(1).reduce((path, point, index) => { const previous = points[index]; const middle = (previous.x + point.x) / 2; return `${path} C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`; }, `M ${points[0].x} ${points[0].y}`);
}
function overviewTrendAxisMax(value: number) { const roughStep = Math.max(value, 1) / 4; const magnitude = 10 ** Math.floor(Math.log10(roughStep)); const normalized = roughStep / magnitude; const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10; return step * magnitude * 4; }
function overviewTrendTimeTicks(series: AnalyticsReport["series"]) { if (!series.length) return []; const count = Math.min(5, series.length); const indices = Array.from({ length: count }, (_, index) => Math.round(index * (series.length - 1) / Math.max(count - 1, 1))); return [...new Set(indices)].map((index) => ({ index, bucket: series[index].bucket, position: index === 0 ? "is-start" : index === series.length - 1 ? "is-end" : "is-secondary" })); }
function formatTrendAxisTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown" : new Intl.DateTimeFormat("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(date); }
function formatTrendTooltipTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown bucket" : new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(date); }
function overviewTrendPointLabel(row: AnalyticsReport["series"][number]) { return `${formatTrendTooltipTime(row.bucket)}: ${row.views} views, ${row.sessions} sessions, ${row.sessions ? (row.views / row.sessions).toFixed(2) : "no"} pages per session`; }
function overviewTrendDelta(value: number, previous: number, noun: string) { const delta = value - previous; return delta === 0 ? `No change in ${noun}s from the previous bucket` : `${delta > 0 ? "+" : ""}${delta} ${noun}${Math.abs(delta) === 1 ? "" : "s"} from the previous bucket`; }

function OverviewHeading({ eyebrow, title, id, detail }: { eyebrow: string; title: string; id: string; detail: string }) { return <header className="overview-heading"><div><p>{eyebrow}</p><h2 id={id}>{title}</h2></div><span>{detail}</span></header>; }
function Fact({ label, value }: { label: string; value: string | number }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function ModuleState({ text }: { text: string }) { return <div className="overview-module__fallback"><span aria-hidden="true">—</span><p>{text}</p></div>; }
function Posture({ label, value, tone }: { label: string; value: string; tone: string }) { return <article className={`overview-posture__item is-${tone}`}><i /><span>{label}</span><strong>{value}</strong></article>; }
function RecentGoat({ item }: { item: GoatAdminSummary }) { const [imageFailed, setImageFailed] = useState(false); return <Link to={`/goats/${item.id}`}><span>{item.mainMediaUrl && !imageFailed ? <img src={item.mainMediaUrl} alt="" onError={() => setImageFailed(true)} /> : <i><AdminIcon name="goats" size={18} /></i>}</span><div><strong>{item.displayName}</strong><small>{item.product.name || "Product unavailable"} · {formatDate(item.submittedAt)}</small></div><b className={`goats-status goats-status--${item.status}`}>{item.status}{item.status === "approved" && !item.published ? " / hidden" : ""}</b></Link>; }

function operationalPriorities(snapshot: Snapshot, errors: SourceErrors): Priority[] {
  const priorities: Priority[] = [];
  if (snapshot.goats?.counts.pending) priorities.push({ title: `${snapshot.goats.counts.pending} GOATS ${snapshot.goats.counts.pending === 1 ? "submission" : "submissions"} awaiting review`, detail: "Validate media, product, consent, and approximate location before publication.", to: "/goats/pending", label: "Moderate", tone: "attention" });
  const failedEmails = snapshot.goats ? numberOrNull(snapshot.goats.email.failed) : null;
  if (failedEmails) priorities.push({ title: `${failedEmails} community ${failedEmails === 1 ? "email" : "emails"} failed`, detail: "Review the transactional outbox before attempting a protected retry.", to: "/goats/emails", label: "Inspect", tone: "danger" });
  if (snapshot.status?.accounts.pending) priorities.push({ title: `${snapshot.status.accounts.pending} ${snapshot.status.accounts.pending === 1 ? "account is" : "accounts are"} pending verification`, detail: "Review identity state without changing roles or sessions unnecessarily.", to: "/access", label: "Review", tone: "attention" });
  for (const [source, detail, to] of [["analytics", "Audience analytics authority did not report current state.", "/analytics"], ["watch", "Broadcast authority did not report current state.", "/watch"], ["commerce", "Commerce authority did not report current state.", "/commerce"], ["goats", "Community authority did not report current state.", "/goats"], ["banner", "Site-content authority did not report current state.", "/content"], ["status", "Account authority did not report current state.", "/access"]] as const) {
    if (errors[source] && errors[source] !== "restricted") priorities.push({ title: `${sourceLabel(source)} unavailable`, detail, to, label: "Open", tone: "danger" });
  }
  return priorities;
}

async function capture<T>(request: Promise<T>): Promise<{ value: T | null; error?: string }> { try { return { value: await request }; } catch (reason) { return { value: null, error: reason instanceof Error ? reason.message : "Authority unavailable." }; } }
async function restricted<T>(): Promise<{ value: T | null; error?: string }> { return { value: null, error: "restricted" }; }
function compactErrors(errors: Record<Source, string | undefined>) { return Object.fromEntries(Object.entries(errors).filter(([, value]) => value)) as SourceErrors; }
function sourceFallback(loading: boolean, error?: string) { return loading ? "Checking" : error ? error === "restricted" ? "Restricted" : "Unavailable" : "Unavailable"; }
function configuredLabel(value: boolean | undefined, loading: boolean, error?: string) { return value === true ? "Configured" : value === false ? "Not configured" : sourceFallback(loading, error); }
function configuredTone(value: boolean | undefined, error?: string) { return error ? error === "restricted" ? "muted" : "danger" : value === true ? "safe" : value === false ? "attention" : "muted"; }
function displayNumber(value: number | null | undefined) { return typeof value === "number" ? value : "—"; }
function numberOrNull(value: unknown) { if (value === null || value === undefined || value === "") return null; const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function enabledLabel(value: boolean) { return value ? "Enabled" : "Disabled"; }
function presentationLabel(value: string) { return value === "live" ? "Live now" : value === "upcoming" ? "Upcoming" : value === "archive" ? "Latest episode" : value.replaceAll("_", " "); }
function providerLabel(provider: string) { return provider === "twitter" ? "X" : provider.charAt(0).toUpperCase() + provider.slice(1); }
function postureValue(data: CommerceOverviewPayload, key: string) { const value = data.posture[key]; return value ? value.replaceAll("_", " ") : "Unavailable"; }
function sourceLabel(source: Source) { return source === "status" ? "Accounts" : source === "banner" ? "Site content" : source === "goats" ? "GOATS" : source.charAt(0).toUpperCase() + source.slice(1); }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "unknown" : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown date" : new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date); }
