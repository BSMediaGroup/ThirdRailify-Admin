import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { adminApi } from "../auth/client";
import { useAuth } from "../auth/AuthProvider";
import { readBannerSettings, type BannerSettings } from "../banner/client";
import { getCommerceOverview, type CommerceOverviewPayload } from "../commerce/client";
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
type Snapshot = { status: StatusPayload | null; watch: WatchAdminPayload | null; commerce: CommerceOverviewPayload | null; goats: GoatsOverviewPayload | null; banner: BannerSettings | null };
type Source = keyof Snapshot;
type SourceErrors = Partial<Record<Source, string>>;
type Priority = { title: string; detail: string; to: string; label: string; tone: "attention" | "danger" | "info" };

const EMPTY_SNAPSHOT: Snapshot = { status: null, watch: null, commerce: null, goats: null, banner: null };

export function OverviewPage() {
  const { startLoading, inboxSummary } = useOutletContext<AdminShellOutletContext>();
  const { access, csrfToken } = useAuth();
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [errors, setErrors] = useState<SourceErrors>({});
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState("");
  const requestSequence = useRef(0);
  const masterRead = access.isMasterAdmin && Boolean(csrfToken);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const stopLoading = startLoading("Refreshing operational overview");
    setLoading(true); setErrors({});
    const [status, commerce, watch, goats, banner] = await Promise.all([
      capture(adminApi<StatusPayload>("/api/admin/status")),
      capture(getCommerceOverview()),
      masterRead ? capture(manageWatch("read", csrfToken)) : restricted<WatchAdminPayload>(),
      masterRead ? capture(getGoatsOverview()) : restricted<GoatsOverviewPayload>(),
      masterRead ? capture(readBannerSettings()) : restricted<BannerSettings>(),
    ]);
    if (requestSequence.current === sequence) {
      setSnapshot({ status: status.value, commerce: commerce.value, watch: watch.value, goats: goats.value, banner: banner.value });
      setErrors(compactErrors({ status: status.error, commerce: commerce.error, watch: watch.error, goats: goats.error, banner: banner.error }));
      setRefreshedAt(new Date().toISOString());
      setLoading(false);
    }
    stopLoading();
  }, [csrfToken, masterRead, startLoading]);

  useEffect(() => { void load(); return () => { requestSequence.current += 1; }; }, [load]);

  const expectedSources = masterRead ? 5 : 2;
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
        <div className="overview-hero__actions"><button className="primary-button" type="button" onClick={() => void load()} disabled={loading}><AdminIcon name="signal" size={17} />{loading ? "Refreshing…" : "Refresh overview"}</button><a className="secondary-button" href="https://thirdrailify.pages.dev/" target="_blank" rel="noreferrer">Open Public site <AdminIcon name="external" size={15} /></a></div>
      </div>
      <aside className="overview-pulse" aria-label="Operational snapshot summary">
        <div className="overview-pulse__top"><span><i className={errorCount ? "is-warning" : ""} />System pulse</span><small>{loading ? "Reading authorities" : refreshedAt ? formatTime(refreshedAt) : "Not checked"}</small></div>
        <div className="overview-pulse__body">
          <div className="overview-pulse__credential">
            <span className="overview-pulse__shield" aria-hidden="true"><AdminIcon name="shield" size={28} /></span>
            <div><small>Session role</small><strong>{access.isMasterAdmin ? "Master" : "Full Admin"}</strong><span>Account level / server verified</span></div>
          </div>
          <div className="overview-pulse__readout"><strong>{loading && !hasSnapshot ? "—" : `${reportingSources}/${expectedSources}`}</strong><span>sources reporting</span></div>
        </div>
        <dl><div><dt>Access</dt><dd>{access.isMasterAdmin ? "All workspaces" : "Core workspaces"}</dd></div><div><dt>Attention</dt><dd>{hasSnapshot ? priorities.length : "—"}</dd></div><div><dt>Authority</dt><dd>Server</dd></div></dl>
      </aside>
    </section>

    {errorCount > 0 && <div className="overview-partial" role="alert"><AdminIcon name="signal" size={21} /><div><strong>Partial operational snapshot</strong><p>{errorCount} {errorCount === 1 ? "authority did" : "authorities did"} not report. Missing values remain unavailable rather than being replaced with zero.</p></div><button type="button" onClick={() => void load()} disabled={loading}>Retry</button></div>}

    <section className="overview-section" aria-labelledby="operations-title">
      <OverviewHeading eyebrow="Current authority" title="Operational workspaces" id="operations-title" detail={refreshedAt ? `Refreshed ${formatTime(refreshedAt)}` : "Reading current state"} />
      <div className="overview-module-grid">
        <WatchModule data={snapshot.watch} error={errors.watch} loading={loading} restricted={!masterRead} />
        <CommerceModule data={snapshot.commerce} error={errors.commerce} loading={loading} />
        <GoatsModule data={snapshot.goats} error={errors.goats} loading={loading} restricted={!masterRead} />
        <BannerModule data={snapshot.banner} error={errors.banner} loading={loading} restricted={!masterRead} />
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
        {snapshot.goats?.recent.length ? <div className="overview-activity-list">{snapshot.goats.recent.slice(0, 4).map((item) => <RecentGoat key={item.id} item={item} />)}</div> : snapshot.goats ? <ModuleState text="No recent GOATS submissions are available." /> : <ModuleState text={!masterRead ? "Master Admin access is required." : errors.goats || (loading ? "Loading recent activity…" : "Recent activity is unavailable.")} />}
        <Link className="overview-section__link" to="/goats">Open GOATS workspace <AdminIcon name="arrow" size={15} /></Link>
      </section>
    </div>
  </div>;
}

function WatchModule({ data, error, loading, restricted }: { data: WatchAdminPayload | null; error?: string; loading: boolean; restricted: boolean }) {
  const primary = data?.current?.primary;
  const state = restricted ? "Restricted" : error ? "Unavailable" : primary ? presentationLabel(primary.presentationState) : data ? "No current signal" : loading ? "Checking" : "Unavailable";
  return <ModuleCard icon="watch" eyebrow="Broadcast" title="Watch / signal" status={state} tone={primary?.presentationState === "live" ? "live" : error ? "danger" : data ? "safe" : "muted"} to="/watch" linkLabel="Open broadcast control">
    {data ? <><div className="overview-module__metric"><strong>{data.summary.retained}<small>/ 24</small></strong><span>retained episodes</span></div><dl><Fact label="Visible" value={data.summary.visible} /><Fact label="Hidden" value={data.summary.hidden} /><Fact label="Open slots" value={data.summary.remaining} /></dl><p className="overview-module__note">{primary?.title || "No live, upcoming, or latest candidate is selected."}</p></> : <ModuleState text={restricted ? "Master Admin access is required for Watch authority." : error || (loading ? "Reading Watch authority…" : "Watch authority is unavailable.")} />}
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
    {data ? <><div className="overview-module__metric"><strong>{data.counts.pending}</strong><span>awaiting moderation</span></div><dl><Fact label="Approved" value={data.counts.approved} /><Fact label="Hidden" value={data.counts.hidden} /><Fact label="Email failed" value={failed ?? "—"} /></dl><p className="overview-module__note">{data.recent[0] ? `Latest: ${data.recent[0].displayName}` : "No recent submissions."}</p></> : <ModuleState text={restricted ? "Master Admin access is required for community authority." : error || (loading ? "Reading moderation authority…" : "GOATS authority is unavailable.")} />}
  </ModuleCard>;
}

function BannerModule({ data, error, loading, restricted }: { data: BannerSettings | null; error?: string; loading: boolean; restricted: boolean }) {
  const active = Boolean(data?.config.normal.enabled || data?.config.live.enabled);
  return <ModuleCard icon="content" eyebrow="Public presentation" title="Site content" status={restricted ? "Restricted" : error ? "Unavailable" : data ? active ? "Configured active" : "Standing by" : loading ? "Checking" : "Unavailable"} tone={error ? "danger" : active ? "attention" : data ? "safe" : "muted"} to="/content" linkLabel="Open banner controls">
    {data ? <><div className="overview-module__metric"><strong>{data.config.normal.messages.length}</strong><span>announcement messages</span></div><dl><Fact label="Normal rail" value={enabledLabel(data.config.normal.enabled)} /><Fact label="Live takeover" value={enabledLabel(data.config.live.enabled)} /><Fact label="Revision" value={data.revision} /></dl><p className="overview-module__note">Updated {formatTime(data.updatedAt)}</p></> : <ModuleState text={restricted ? "Master Admin access is required for content authority." : error || (loading ? "Reading banner configuration…" : "Site-content authority is unavailable.")} />}
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
  for (const [source, detail, to] of [["watch", "Broadcast authority did not report current state.", "/watch"], ["commerce", "Commerce authority did not report current state.", "/commerce"], ["goats", "Community authority did not report current state.", "/goats"], ["banner", "Site-content authority did not report current state.", "/content"], ["status", "Account authority did not report current state.", "/access"]] as const) {
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
