import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminAvatar } from "../auth/AdminAccountWidget";
import { useAuth } from "../auth/AuthProvider";
import { adminApi } from "../auth/client";
import type { AuthAccount } from "../auth/types";

type AccountsPayload = { ok: boolean; accounts: AuthAccount[]; access: { isAdmin: boolean; isMasterAdmin: boolean }; checkedAt: string };
type AccountAction = "promote" | "demote" | "disable" | "enable" | "revoke-sessions";
type PendingAction = { account: AuthAccount; action: AccountAction };

export function AccountsPage() {
  const { csrfToken, account: currentAccount, access } = useAuth();
  const [payload, setPayload] = useState<AccountsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setPayload(await adminApi<AccountsPayload>("/api/admin/accounts")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Accounts could not be loaded."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const providers = useMemo(() => Array.from(new Set((payload?.accounts || []).flatMap((account) => account.providers))).sort(), [payload]);
  const visible = useMemo(() => (payload?.accounts || []).filter((account) => {
    const text = `${account.displayName} ${account.email || ""} ${account.username || ""} ${account.identities?.map((identity) => `${identity.username || ""} ${identity.subject}`).join(" ") || ""}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase())) && (provider === "all" || account.providers.includes(provider)) && (role === "all" || account.role === role) && (status === "all" || account.status === status);
  }), [payload, provider, query, role, status]);

  const mutate = async () => {
    if (!pending || !csrfToken) return;
    setBusyId(pending.account.id); setError("");
    try {
      const next = await adminApi<AccountsPayload>(`/api/admin/accounts/${encodeURIComponent(pending.account.id)}/${pending.action}`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: "{}" });
      setPayload(next); setPending(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The account action failed."); }
    finally { setBusyId(""); }
  };

  return <>
    <section className="accounts-heading"><div><p className="eyebrow"><span /> D1 account authority</p><h1>Accounts &amp; access</h1><p>Review shared identities, roles, status, and active access controls. Authority is enforced by the server on every request.</p></div><button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>Refresh</button></section>
    {error && <div className="admin-alert" role="alert">{error}</div>}
    <section className="account-filters" aria-label="Account filters">
      <label><span>Search</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, email, username or subject" /></label>
      <Filter label="Provider" value={provider} onChange={setProvider} options={providers} />
      <Filter label="Role" value={role} onChange={setRole} options={["user", "admin"]} />
      <Filter label="Status" value={status} onChange={setStatus} options={["active", "pending_email", "disabled"]} />
    </section>
    <div className="accounts-summary"><strong>{loading ? "Loading" : visible.length}</strong><span>of {payload?.accounts.length || 0} accounts</span><span>{access.isMasterAdmin ? "Master controls enabled" : "Read-only Full Admin view"}</span></div>
    <section className="accounts-table-wrap" aria-live="polite">
      {loading ? <p className="accounts-state">Loading D1 accounts...</p> : visible.length === 0 ? <p className="accounts-state">No accounts match these filters.</p> : <table className="accounts-table">
        <thead><tr><th>Account</th><th>Identity</th><th>Access</th><th>State</th><th>Activity</th><th>Controls</th></tr></thead>
        <tbody>{visible.map((account) => <tr key={account.id}>
          <td><div className="account-cell"><AdminAvatar account={account} /><div><strong>{account.displayName}</strong><span>{account.email || "No provider email"}</span></div></div></td>
          <td><ProviderList account={account} /></td>
          <td><strong>{account.adminLevel === "master" ? "Master Admin" : account.adminLevel === "full" ? "Full Admin" : "Regular user"}</strong><span>{account.source}</span></td>
          <td><strong className={`state-label state-label--${account.status}`}>{label(account.status)}</strong><span>{account.email ? account.emailVerified ? "Email verified" : "Email unverified" : "No email supplied"}</span></td>
          <td><strong>Created {formatDate(account.createdAt)}</strong><span>{account.lastLoginAt ? `Last login ${formatDate(account.lastLoginAt)}` : "Never signed in"}</span></td>
          <td><AccountActions account={account} currentId={currentAccount?.id || ""} master={access.isMasterAdmin} busy={busyId === account.id} onAction={(action) => setPending({ account, action })} /></td>
        </tr>)}</tbody>
      </table>}
    </section>
    {pending && <div className="confirm-backdrop" role="presentation"><div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><p className="eyebrow">Security action</p><h2 id="confirm-title">{actionLabel(pending.action)}?</h2><p>This will apply immediately to <strong>{pending.account.displayName}</strong> through the signed Admin API.</p><div><button type="button" className="secondary-button" onClick={() => setPending(null)} disabled={Boolean(busyId)}>Cancel</button><button type="button" className="danger-button" onClick={() => void mutate()} disabled={Boolean(busyId)}>{busyId ? "Applying..." : "Confirm"}</button></div></div></div>}
  </>;
}

function Filter({ label: text, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) { return <label><span>{text}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="all">All</option>{options.map((option) => <option key={option} value={option}>{label(option)}</option>)}</select></label>; }
function ProviderList({ account }: { account: AuthAccount }) { return account.providers.length ? <div className="provider-list">{account.providers.map((provider) => <span key={provider}>{label(provider)}</span>)}{account.identities?.[0] && <small>{account.identities[0].username ? `@${account.identities[0].username}` : compactSubject(account.identities[0].subject)}</small>}</div> : <div className="provider-list"><span>Email</span><small>Password credential</small></div>; }
function AccountActions({ account, currentId, master, busy, onAction }: { account: AuthAccount; currentId: string; master: boolean; busy: boolean; onAction: (action: AccountAction) => void }) {
  if (!master) return <span className="control-note">Master Admin required</span>;
  if (account.locked || account.adminLevel === "master") return <span className="control-note">Environment locked</span>;
  return <div className="account-actions">
    {account.role === "user" && account.status === "active" && (account.source !== "email" || account.emailVerified) && <button type="button" onClick={() => onAction("promote")} disabled={busy || account.id === currentId}>Promote</button>}
    {account.role === "admin" && <button type="button" onClick={() => onAction("demote")} disabled={busy}>Demote</button>}
    {account.status === "disabled" ? <button type="button" onClick={() => onAction("enable")} disabled={busy}>Enable</button> : <button type="button" onClick={() => onAction("disable")} disabled={busy}>Disable</button>}
    <button type="button" onClick={() => onAction("revoke-sessions")} disabled={busy}>Revoke sessions</button>
  </div>;
}
function label(value: string) { return value === "twitter" ? "X" : value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown" : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function compactSubject(value: string) { return value.length > 20 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value; }
function actionLabel(action: AccountAction) { return ({ promote: "Promote to Full Admin", demote: "Demote to Regular User", disable: "Disable account", enable: "Enable account", "revoke-sessions": "Revoke all sessions" })[action]; }
