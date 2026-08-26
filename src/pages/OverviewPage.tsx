import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { adminApi } from "../auth/client";
import { AdminIcon } from "../components/AdminIcon";
import type { AdminShellOutletContext } from "../components/AdminShell";

type StatusPayload = {
  ok: boolean;
  authenticatedAccount: { displayName: string; adminLevel: string };
  access: { isAdmin: boolean; isMasterAdmin: boolean };
  configuration: { d1Configured: boolean; turnstileConfigured: boolean; resendConfigured: boolean; oauthProviders: string[] };
  accounts: { total: number; regular: number; admins: number; disabled: number; pending: number };
  checkedAt: string;
};

const deferredAreas = [
  ["Content authority", "Deferred", "Editorial writes remain outside this milestone."],
  ["Commerce authority", "Deferred", "Products and orders remain provider-neutral shells."],
  ["Editorial media", "Deferred", "Profile avatars are bounded account media; the broader asset library remains deferred."],
];

export function OverviewPage() {
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const stopLoading = startLoading("Loading Admin status");
    adminApi<StatusPayload>("/api/admin/status", { signal: controller.signal }).then(setStatus).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Status could not be loaded.");
    }).finally(stopLoading);
    return () => controller.abort();
  }, [startLoading]);

  return <>
    <section className="page-hero page-hero--status">
      <div><p className="eyebrow"><span /> Authenticated foundation</p><h1>Control room,<br /><em>with real access.</em></h1><p className="hero-copy">Shared D1 accounts, server-resolved roles, bounded sessions, and signed Admin controls now protect this operational surface. Other modules remain explicitly deferred.</p></div>
      <div className="status-stamp"><AdminIcon name="shield" size={30} /><span>SESSION ROLE</span><strong>{status ? status.access.isMasterAdmin ? "MASTER" : "ADMIN" : error ? "UNAVAILABLE" : "CHECKING"}</strong></div>
    </section>
    {error && <div className="admin-alert" role="alert">Admin status unavailable: {error}</div>}
    <section className="boundary-section" aria-labelledby="authority-title">
      <div className="section-heading"><div><p className="eyebrow">Current authority</p><h2 id="authority-title">Authenticated system posture</h2></div><span className="tag">{status ? `Checked ${formatTime(status.checkedAt)}` : "Checking server"}</span></div>
      <div className="boundary-grid">
        <StatusCard label="D1 account database" value={status ? status.configuration.d1Configured ? "Configured" : "Unavailable" : "Checking"} tone={status?.configuration.d1Configured ? "safe" : "muted"} />
        <StatusCard label="Turnstile" value={status ? status.configuration.turnstileConfigured ? "Configured" : "Not configured" : "Checking"} tone={status?.configuration.turnstileConfigured ? "safe" : "blocked"} />
        <StatusCard label="Account email" value={status ? status.configuration.resendConfigured ? "Configured" : "Not configured" : "Checking"} tone={status?.configuration.resendConfigured ? "safe" : "blocked"} />
        <StatusCard label="OAuth providers" value={status ? status.configuration.oauthProviders.length ? status.configuration.oauthProviders.map(providerLabel).join(", ") : "None configured" : "Checking"} tone={status?.configuration.oauthProviders.length ? "safe" : "muted"} />
      </div>
      {status && <div className="account-counts" aria-label="Account counts"><Count label="Total" value={status.accounts.total} /><Count label="Regular" value={status.accounts.regular} /><Count label="Admins" value={status.accounts.admins} /><Count label="Pending" value={status.accounts.pending} /><Count label="Disabled" value={status.accounts.disabled} /></div>}
      <div className="notice-card"><AdminIcon name="shield" size={24} /><div><strong>Server-enforced access</strong><p>Dashboard hydration and every account API resolve the current D1 session and role. Full Admins may read accounts; only environment Master Admins may change roles, status, or sessions.</p></div></div>
    </section>
    <section className="roadmap-section" aria-labelledby="deferred-title">
      <div className="section-heading"><div><p className="eyebrow">Preserved boundaries</p><h2 id="deferred-title">Still intentionally deferred</h2></div><Link className="text-link" to="/access">Open accounts <AdminIcon name="arrow" size={16} /></Link></div>
      <div className="roadmap-list">{deferredAreas.map(([title, state, detail], index) => <article key={title}><span>0{index + 1}</span><div><h3>{title}</h3><p>{detail}</p></div><strong>{state}</strong></article>)}</div>
    </section>
  </>;
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone: string }) { return <article className="boundary-card"><span className={`boundary-indicator boundary-indicator--${tone}`} aria-hidden="true" /><p>{label}</p><strong>{value}</strong></article>; }
function Count({ label, value }: { label: string; value: number }) { return <div><strong>{value}</strong><span>{label}</span></div>; }
function providerLabel(provider: string) { return provider === "twitter" ? "X" : provider.charAt(0).toUpperCase() + provider.slice(1); }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "unknown" : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date); }
