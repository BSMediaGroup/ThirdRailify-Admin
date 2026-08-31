import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { AdminAvatar } from "../auth/AdminAccountWidget";
import { AccountAccessBadge, AccountRoleChip } from "../components/AccountAccessBadge";
import { useAuth } from "../auth/AuthProvider";
import { adminApi, importAvatarUrl, updateDisplayName, uploadAvatar } from "../auth/client";
import type { AuthAccount } from "../auth/types";
import type { AdminShellOutletContext } from "../components/AdminShell";
import { DetailDrawer } from "../components/DetailDrawer";
import { useAdminToast } from "../components/AdminToasts";
import { resetResizableTable } from "../components/resizableTableEvents";

type AccountsPayload = { ok: boolean; accounts: AuthAccount[]; access: { isAdmin: boolean; isMasterAdmin: boolean }; checkedAt: string };
type AccountAction = "promote" | "demote" | "disable" | "enable" | "revoke-sessions";
type PendingAction = { account: AuthAccount; action: AccountAction };
type AccountDetailPayload = { ok: boolean; account: AuthAccount; sessions: Array<{ id: string; createdAt: string; expiresAt: string; lastSeenAt: string; revokedAt: string | null; sourceOrigin: string; userAgentRecorded: boolean }>; audit: Array<{ id: string; eventType: string; result: string; provider: string | null; createdAt: string }>; access: { isAdmin: boolean; isMasterAdmin: boolean }; checkedAt: string };

export function AccountsPage() {
  const { csrfToken, account: currentAccount, hasCapability, refresh } = useAuth();
  const canManage = hasCapability("users.manage");
  const { startLoading } = useOutletContext<AdminShellOutletContext>();
  const [payload, setPayload] = useState<AccountsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [detail, setDetail] = useState<AccountDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const selectedAccountId = searchParams.get("account");

  const load = useCallback(async () => {
    const stopLoading = startLoading("Loading D1 accounts");
    setLoading(true); setError("");
    try { setPayload(await adminApi<AccountsPayload>("/api/admin/accounts")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Accounts could not be loaded."); }
    finally { setLoading(false); stopLoading(); }
  }, [startLoading]);
  useEffect(() => { void load(); }, [load]);
  const closeDetail = useCallback(() => { setSearchParams((current) => { const next = new URLSearchParams(current); next.delete("account"); return next; }); }, [setSearchParams]);
  const openDetail = (accountId: string) => { const next = new URLSearchParams(searchParams); next.set("account", accountId); setSearchParams(next); };
  useEffect(() => {
    if (!selectedAccountId) { setDetail(null); setDetailLoading(false); return; }
    let active = true; setDetailLoading(true); setDetail(null); setError("");
    void adminApi<AccountDetailPayload>(`/api/admin/accounts/${encodeURIComponent(selectedAccountId)}`).then((result) => { if (active) setDetail(result); }).catch((reason) => { if (active) { setError(reason instanceof Error ? reason.message : "Account detail is unavailable."); closeDetail(); } }).finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [closeDetail, selectedAccountId]);

  const providers = useMemo(() => Array.from(new Set((payload?.accounts || []).flatMap((account) => account.providers))).sort(), [payload]);
  const visible = useMemo(() => (payload?.accounts || []).filter((account) => {
    const text = `${account.displayName} ${account.email || ""} ${account.username || ""} ${account.identities?.map((identity) => `${identity.username || ""} ${identity.subject}`).join(" ") || ""}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase())) && (provider === "all" || account.providers.includes(provider)) && (role === "all" || account.role === role) && (status === "all" || account.status === status);
  }), [payload, provider, query, role, status]);

  const mutate = async () => {
    if (!canManage || !pending || !csrfToken) return;
    const stopLoading = startLoading(`${actionLabel(pending.action)} in progress`);
    setBusyId(pending.account.id); setError("");
    try {
      const next = await adminApi<AccountsPayload>(`/api/admin/accounts/${encodeURIComponent(pending.account.id)}/${pending.action}`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: "{}" });
      setPayload(next); setPending(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The account action failed."); }
    finally { setBusyId(""); stopLoading(); }
  };

  return <>
    <section className="accounts-heading"><div><p className="eyebrow"><span /> D1 account authority</p><h1>Accounts &amp; access</h1><p>Review shared identities, roles, status, and active access controls. Accounts remain distinct from commerce Customers.</p></div><div className="accounts-heading__actions"><button className="secondary-button" type="button" onClick={() => resetResizableTable("accounts")}>Reset columns</button><button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>Refresh</button></div></section>
    {currentAccount && <AvatarSettings account={currentAccount} csrfToken={csrfToken} onUpdated={async () => { await refresh(); await load(); }} />}
    {error && <div className="admin-alert" role="alert">{error}</div>}
    <section className="account-filters" aria-label="Account filters">
      <label><span>Search</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, email, username or subject" /></label>
      <Filter label="Provider" value={provider} onChange={setProvider} options={providers} />
      <Filter label="Role" value={role} onChange={setRole} options={["user", "admin"]} />
      <Filter label="Status" value={status} onChange={setStatus} options={["active", "pending_email", "disabled"]} />
    </section>
    <div className="accounts-summary"><strong>{loading ? "Loading" : visible.length}</strong><span>of {payload?.accounts.length || 0} accounts</span><span>{canManage ? "Account controls enabled" : "Read-only access"}</span></div>
    <section className="accounts-table-wrap" aria-live="polite">
      {loading ? <p className="accounts-state">Loading D1 accounts...</p> : visible.length === 0 ? <p className="accounts-state">No accounts match these filters.</p> : <table className="accounts-table" data-resizable-key="accounts">
        <thead><tr><AccountHeader width={210}>Account</AccountHeader><AccountHeader width={150}>Identity</AccountHeader><AccountHeader width={125}>Access</AccountHeader><AccountHeader width={130}>State</AccountHeader><AccountHeader width={175}>Activity</AccountHeader><AccountHeader width={115}>Customer</AccountHeader><AccountHeader width={190}>Controls</AccountHeader></tr></thead>
        <tbody>{visible.map((account) => <tr key={account.id} tabIndex={0} aria-label={`Open account ${account.displayName}`} onClick={() => openDetail(account.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetail(account.id); } }}>
          <td data-label="Account"><div className="account-cell"><AdminAvatar account={account} /><div><strong>{account.displayName}</strong><span>{account.email || "No provider email"}</span></div></div></td>
          <td data-label="Identity"><ProviderList account={account} /></td>
          <td data-label="Access"><AccountRoleChip account={account} /><span>{account.source}</span></td>
          <td data-label="State"><strong className={`state-label state-label--${account.status}`}>{label(account.status)}</strong><span>{account.email ? account.emailVerified ? "Email verified" : "Email unverified" : "No email supplied"}</span></td>
          <td data-label="Activity"><strong>Created {formatDate(account.createdAt)}</strong><span>{account.lastLoginAt ? `Last login ${formatDate(account.lastLoginAt)}` : "Never signed in"}</span></td>
          <td data-label="Customer">{account.customer ? <Link className="account-customer-link" to={`/customers?customer=${encodeURIComponent(account.customer.id)}`} onClick={(event) => event.stopPropagation()}><strong>Customer</strong><span>{account.customer.orderCount} order{account.customer.orderCount === 1 ? "" : "s"}</span></Link> : <span className="control-note">No purchases</span>}</td>
          <td data-label="Controls"><AccountActions account={account} currentId={currentAccount?.id || ""} master={canManage} busy={busyId === account.id} onAction={(action) => setPending({ account, action })} /></td>
        </tr>)}</tbody>
      </table>}
    </section>
    {pending && <div className="confirm-backdrop" role="presentation"><div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><p className="eyebrow">Security action</p><h2 id="confirm-title">{actionLabel(pending.action)}?</h2><p>This will apply immediately to <strong>{pending.account.displayName}</strong> through the signed Admin API.</p><div><button type="button" className="secondary-button" onClick={() => setPending(null)} disabled={Boolean(busyId)}>Cancel</button><button type="button" className="danger-button" onClick={() => void mutate()} disabled={Boolean(busyId)}>{busyId ? "Applying..." : "Confirm"}</button></div></div></div>}
    {selectedAccountId && <DetailDrawer titleId="account-detail-title" onClose={closeDetail}><AccountDetailDrawer payload={detail} loading={detailLoading} close={closeDetail} master={canManage} currentId={currentAccount?.id || ""} busyId={busyId} action={(account, value) => setPending({ account, action: value })} /></DetailDrawer>}
  </>;
}

function AvatarSettings({ account, csrfToken, onUpdated }: { account: AuthAccount; csrfToken: string; onUpdated: () => Promise<void> }) {
  const { showToast } = useAdminToast();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [busy, setBusy] = useState<"name" | "file" | "url" | "">("");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setDisplayName(account.displayName), [account.displayName]);

  const saveDisplayName = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = displayName.replace(/\s+/g, " ").trim();
    if (!csrfToken || nextName.length < 2 || nextName.length > 80) {
      setError("Enter a display name between 2 and 80 characters."); return;
    }
    setBusy("name"); setError("");
    try { await updateDisplayName(csrfToken, nextName); await onUpdated(); setDisplayName(nextName); showToast("Display name updated.", { title: "Profile saved" }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The display name could not be updated."); }
    finally { setBusy(""); }
  };

  const saveFile = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !csrfToken) return;
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a JPG, PNG, or WebP image no larger than 5 MB."); return;
    }
    setBusy("file"); setError("");
    try {
      await uploadAvatar(csrfToken, file); await onUpdated(); setFile(null); if (fileInput.current) fileInput.current.value = ""; showToast("Avatar updated from your upload.", { title: "Profile saved" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The avatar could not be updated."); }
    finally { setBusy(""); }
  };

  const saveUrl = async (event: FormEvent) => {
    event.preventDefault();
    if (!imageUrl.trim() || !csrfToken) return;
    setBusy("url"); setError("");
    try { await importAvatarUrl(csrfToken, imageUrl.trim()); await onUpdated(); setImageUrl(""); showToast("Avatar updated from the image URL.", { title: "Profile saved" }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The avatar could not be updated."); }
    finally { setBusy(""); }
  };

  return <section className="avatar-settings" aria-labelledby="admin-avatar-settings-title">
    <div className="avatar-settings__intro"><AdminAvatar account={account} /><div><p className="eyebrow">Account settings</p><h2 id="admin-avatar-settings-title">Your account profile</h2><p>Change your display name or avatar. Profile changes are verified by the Admin account service and persisted to the shared account authority.</p></div></div>
    <div className="avatar-settings__forms">
      <form className="avatar-settings__name-form" onSubmit={saveDisplayName}><label><span>Display name</span><input type="text" autoComplete="name" minLength={2} maxLength={80} value={displayName} onChange={(event) => { setDisplayName(event.target.value); setError(""); }} /></label><button className="secondary-button" type="submit" disabled={displayName.replace(/\s+/g, " ").trim() === account.displayName || Boolean(busy)}>{busy === "name" ? "Saving..." : "Save display name"}</button></form>
      <form onSubmit={saveFile}><label><span>Upload image</span><input ref={fileInput} type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={(event) => { setFile(event.target.files?.[0] || null); setError(""); }} /></label><button className="secondary-button" type="submit" disabled={!file || Boolean(busy)}>{busy === "file" ? "Uploading..." : "Upload avatar"}</button></form>
      <form onSubmit={saveUrl}><label><span>Direct image URL</span><input type="url" inputMode="url" value={imageUrl} onChange={(event) => { setImageUrl(event.target.value); setError(""); }} placeholder="https://example.com/avatar.webp" /></label><button className="secondary-button" type="submit" disabled={!imageUrl.trim() || Boolean(busy)}>{busy === "url" ? "Importing..." : "Use image URL"}</button></form>
    </div>
    {error && <p className="avatar-settings__status is-error" role="alert">{error}</p>}
  </section>;
}

function Filter({ label: text, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) { return <label><span>{text}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="all">All</option>{options.map((option) => <option key={option} value={option}>{label(option)}</option>)}</select></label>; }
function ProviderList({ account }: { account: AuthAccount }) { return account.providers.length ? <div className="provider-list">{account.providers.map((provider) => <span key={provider}>{label(provider)}</span>)}{account.identities?.[0] && <small>{account.identities[0].username ? `@${account.identities[0].username}` : compactSubject(account.identities[0].subject)}</small>}</div> : <div className="provider-list"><span>Email</span><small>Password credential</small></div>; }
function AccountActions({ account, currentId, master, busy, onAction }: { account: AuthAccount; currentId: string; master: boolean; busy: boolean; onAction: (action: AccountAction) => void }) {
  if (!master) return <span className="control-note">Management permission restricted</span>;
  if (account.locked || account.adminLevel === "master") return <span className="control-note">Protected Master identity</span>;
  return <div className="account-actions">
    {account.role === "user" && account.status === "active" && (account.source !== "email" || account.emailVerified) && <button type="button" onClick={(event) => { event.stopPropagation(); onAction("promote"); }} disabled={busy || account.id === currentId}>Promote</button>}
    {account.role === "admin" && <button type="button" onClick={(event) => { event.stopPropagation(); onAction("demote"); }} disabled={busy}>Demote</button>}
    {account.status === "disabled" ? <button type="button" onClick={(event) => { event.stopPropagation(); onAction("enable"); }} disabled={busy}>Enable</button> : <button type="button" onClick={(event) => { event.stopPropagation(); onAction("disable"); }} disabled={busy}>Disable</button>}
    <button type="button" onClick={(event) => { event.stopPropagation(); onAction("revoke-sessions"); }} disabled={busy}>Revoke sessions</button>
  </div>;
}
function AccountDetailDrawer({ payload, loading, close, master, currentId, busyId, action }: { payload: AccountDetailPayload | null; loading: boolean; close: () => void; master: boolean; currentId: string; busyId: string; action: (account: AuthAccount, value: AccountAction) => void }) {
  if (loading || !payload) return <><header className="detail-drawer__header"><div><p className="eyebrow">Account detail</p><h2 id="account-detail-title">Loading account…</h2></div><button type="button" className="commerce-editor-close" onClick={close} data-autofocus>Close</button></header><div className="commerce-state">Loading safe account authority…</div></>;
  const account = payload.account;
  return <><header className="detail-drawer__header"><div><p className="eyebrow">Authentication Account</p><h2 id="account-detail-title" className="account-identity-name"><span>{account.displayName}</span><AccountAccessBadge account={account} /></h2><p>{account.email || "No account email"}</p></div><button type="button" className="commerce-editor-close" onClick={close} data-autofocus>Close</button></header><div className="detail-drawer__body">
    <AccountSection title="Identity"><div className="account-detail-identity"><AdminAvatar account={account} /><dl><AccountFact term="Display name" value={account.displayName} /><AccountFact term="Email" value={account.email || "Not supplied"} /><AccountFact term="Username" value={account.username ? `@${account.username}` : "Not supplied"} /><AccountFact term="Providers" value={account.providers.map(label).join(", ") || "Email credential"} /></dl></div></AccountSection>
    <AccountSection title="Access"><dl><AccountFact term="Role" value={account.adminLevel === "master" ? "Master Admin" : account.adminLevel === "full" ? "Full Admin" : "Regular user"} /><AccountFact term="State" value={label(account.status)} /><AccountFact term="Email verification" value={account.emailVerified ? `Verified${account.emailVerifiedAt ? ` ${formatDate(account.emailVerifiedAt)}` : ""}` : "Unverified"} /><AccountFact term="Authority" value={account.source} /></dl></AccountSection>
    <AccountSection title="Activity"><dl><AccountFact term="Created" value={formatDate(account.createdAt)} /><AccountFact term="Updated" value={account.updatedAt ? formatDate(account.updatedAt) : "Not recorded"} /><AccountFact term="Last login" value={account.lastLoginAt ? formatDate(account.lastLoginAt) : "Never signed in"} /><AccountFact term="Sessions" value={`${payload.sessions.filter((session) => !session.revokedAt && Date.parse(session.expiresAt) > Date.now()).length} active · ${payload.sessions.length} retained`} /></dl></AccountSection>
    <AccountSection title="Connected Customer">{account.customer ? <><dl><AccountFact term="Orders" value={String(account.customer.orderCount)} /><AccountFact term="Latest purchase" value={account.customer.lastOrderAt ? formatDate(account.customer.lastOrderAt) : "No order timestamp"} /></dl><Link className="secondary-button" to={`/customers?customer=${encodeURIComponent(account.customer.id)}`}>Open Customer details</Link></> : <div className="order-missing"><strong>No Customer</strong><span>This Account has no linked commerce purchase. No Customer was created merely for existing.</span></div>}</AccountSection>
    <AccountSection title="Admin controls"><AccountActions account={account} currentId={currentId} master={master} busy={busyId === account.id} onAction={(value) => action(account, value)} /></AccountSection>
    <details className="order-technical"><summary>Technical and audit metadata</summary><dl><AccountFact term="Account ID" value={account.id} /><AccountFact term="Provider subjects" value={account.identities?.map((identity) => `${label(identity.provider)}: ${compactSubject(identity.subject)}`).join(" · ") || "None"} /><AccountFact term="Audit events" value={String(payload.audit.length)} /><AccountFact term="Session tokens" value="Never exposed" /></dl></details>
  </div></>;
}
function AccountSection({ title, children }: { title: string; children: ReactNode }) { return <section className="detail-drawer__section"><h3>{title}</h3>{children}</section>; }
function AccountFact({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }
function AccountHeader({ width, children }: { width: number; children: ReactNode }) { return <th data-column-width={width} data-column-min={72} data-column-max={520}>{children}</th>; }
function label(value: string) { return value === "twitter" ? "X" : value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown" : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function compactSubject(value: string) { return value.length > 20 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value; }
function actionLabel(action: AccountAction) { return ({ promote: "Promote to Full Admin", demote: "Demote to Regular User", disable: "Disable account", enable: "Enable account", "revoke-sessions": "Revoke all sessions" })[action]; }
