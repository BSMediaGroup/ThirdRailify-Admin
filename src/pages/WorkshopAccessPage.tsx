import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { adminApi } from "../auth/client";
import { AdminAvatar } from "../auth/AdminAccountWidget";
import { AccountAccessBadge } from "../components/AccountAccessBadge";
import { AdminIcon } from "../components/AdminIcon";
import type { AuthAccount } from "../auth/types";
import "./workshop-access.css";

type Grant = { state: string; expires_at: string | null; revision: number; changed_by: string; changed_at: string; note: string };
type Policy = { allowed: boolean; source: string; canManageAccess: boolean; canManageProviders: boolean; canManageProfileRestrictions: boolean; grant: Grant | null };
type Item = { account: AuthAccount; workshop: Policy };
type Payload = { items: Item[]; total: number; page: number; canOpen: boolean };
type HistoryItem = { id: string; actor_name: string; created_at: string; next_json: string };
type Profile = { id: string; provider: string; label: string; enabled: boolean; is_default: boolean; verification_status: string; runtime: boolean };
type ProfileProvider = { provider: string; profiles: Profile[]; policy: { mode: "all" | "selected"; defaultProfileId: string | null; revision: number; allowedProfileIds: string[] } };
type ProfilePayload = { accountId: string; providers: ProfileProvider[]; audit: Array<{ id: string; provider: string; actor_name: string; created_at: string; next_json: string }> };

export function WorkshopAccessPage() {
  const { csrfToken, account } = useAuth();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      adminApi<Payload>(`/api/workshop/accounts?q=${encodeURIComponent(query)}&page=${page}`)
        .then((next) => { if (active) { setPayload(next); setError(""); } })
        .catch((reason) => { if (active) setError(reason.message); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, page, reload]);

  async function open() {
    const tab = window.open("about:blank", "_blank");
    if (!tab) { setError("Allow pop-ups to open Lab."); return; }
    tab.opener = null;
    try {
      const data = await adminApi<{ handoffUrl: string }>("/api/workshop/open", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: "{}" });
      const url = new URL(data.handoffUrl);
      if (url.origin !== "https://lab.thirdrailify.com" || !url.searchParams.get("handoff")) throw new Error("Invalid Lab handoff.");
      tab.location.replace(url.href);
    } catch (reason) {
      tab.close();
      setError((reason as Error).message);
    }
  }

  const visibleItems = payload?.items ?? [];
  const enabledCount = visibleItems.filter((item) => item.workshop.allowed).length;
  const explicitCount = visibleItems.filter((item) => item.workshop.grant).length;

  return <section className="workshop-access">
    <header className="workshop-access__hero">
      <div className="workshop-access__hero-copy">
        <p className="workshop-access__eyebrow"><AdminIcon name="workshop" size={17} /> Private creative control room</p>
        <h1>Workshop <em>Access</em></h1>
        <p className="workshop-access__lede">Approve who can enter the private creative Workshop while keeping site roles, provider authority, and account-owned projects independently protected.</p>
        <div className="workshop-access__hero-actions">
          <button className="workshop-access__open" type="button" onClick={open} disabled={!payload?.canOpen}>
            <span>Open Lab</span><AdminIcon name="external" size={17} />
          </button>
          <span className="workshop-access__security"><AdminIcon name="shield" size={16} /> Canonical account authority</span>
        </div>
      </div>
      <div className="workshop-access__portal" aria-hidden="true">
        <span className="workshop-access__orbit workshop-access__orbit--outer" />
        <span className="workshop-access__orbit workshop-access__orbit--inner" />
        <span className="workshop-access__scan" />
        <div><AdminIcon name="workshop" size={46} /></div>
        <p>Authority gateway</p>
      </div>
    </header>

    <section className="workshop-access__metrics" aria-label="Workshop access summary">
      <article><span>Account directory</span><strong>{payload ? payload.total : "—"}</strong><small>Matching canonical accounts</small></article>
      <article><span>Visible now</span><strong>{payload ? visibleItems.length : "—"}</strong><small>Accounts on this page</small></article>
      <article><span>Access enabled</span><strong>{payload ? enabledCount : "—"}</strong><small>Current page, effective policy</small></article>
      <article><span>Explicit records</span><strong>{payload ? explicitCount : "—"}</strong><small>Grants or suspensions shown</small></article>
    </section>

    <section className="workshop-directory" aria-labelledby="workshop-directory-title">
      <header className="workshop-directory__header">
        <div>
          <p>Account authority</p>
          <h2 id="workshop-directory-title">Access directory</h2>
          <span>Review effective policy, set explicit access, and inspect the audit trail.</span>
        </div>
        <span className="workshop-directory__scope"><i /> Live policy</span>
      </header>

      <label className="workshop-search">
        <span>Search accounts</span>
        <div><AdminIcon name="users" size={19} /><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Name, email or account ID" /></div>
      </label>

      {error && <div className="workshop-state workshop-state--error" role="alert"><AdminIcon name="rejected" /><div><strong>Workshop authority unavailable</strong><p>{error}</p></div></div>}
      {!payload && !error && <div className="workshop-state" role="status"><span className="workshop-state__pulse" /><div><strong>Reading account authority</strong><p>Loading current Workshop policy and grants…</p></div></div>}
      {payload && !visibleItems.length && !error && <div className="workshop-state"><AdminIcon name="users" /><div><strong>No matching accounts</strong><p>Try another name, email, or exact account ID.</p></div></div>}

      <div className="workshop-rows">{visibleItems.map((item) => <AccessRow key={item.account.id} item={item} csrf={csrfToken} current={account} onUpdate={(workshop) => setPayload((old) => old && ({ ...old, items: old.items.map((entry) => entry.account.id === item.account.id ? { ...entry, workshop } : entry) }))} />)}</div>

      <nav className="workshop-pagination" aria-label="Account pages">
        <div><strong>Page {page}</strong><span>{payload?.total ?? 0} matching accounts</span></div>
        <div>
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><span aria-hidden="true">←</span> Previous</button>
          <button type="button" disabled={!payload || page * 20 >= payload.total} onClick={() => setPage((value) => value + 1)}>Next <span aria-hidden="true">→</span></button>
          <button className="workshop-pagination__refresh" type="button" onClick={() => setReload((value) => value + 1)}>Refresh</button>
        </div>
      </nav>
    </section>
  </section>;
}

function AccessRow({ item, csrf, current, onUpdate }: { item: Item; csrf: string; current: AuthAccount | null; onUpdate: (policy: Policy) => void }) {
  const { account, workshop } = item;
  const [state, setState] = useState(workshop.grant?.state || "revoked");
  const [expiry, setExpiry] = useState(workshop.grant?.expires_at?.slice(0, 16) || "");
  const [note, setNote] = useState(workshop.grant?.note || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const locked = account.locked || account.adminLevel === "master" || (current?.adminLevel !== "master" && (account.id === current?.id || account.role === "admin"));

  async function save(next = state) {
    setBusy(true);
    setError("");
    try {
      const result = await adminApi<{ workshop: Policy }>(`/api/workshop/accounts/${encodeURIComponent(account.id)}`, { method: "PUT", headers: { "X-CSRF-Token": csrf }, body: JSON.stringify({ state: next, revision: workshop.grant?.revision || 0, expiresAt: expiry ? new Date(`${expiry}:00Z`).toISOString() : null, note }) });
      setState(next);
      setHistory(null);
      onUpdate(result.workshop);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleAudit() {
    if (history !== null) { setHistory(null); return; }
    try {
      const result = await adminApi<{ items: HistoryItem[] }>(`/api/workshop/accounts/${encodeURIComponent(account.id)}/history`);
      setHistory(result.items);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  return <article className={`workshop-row ${workshop.allowed ? "workshop-row--enabled" : "workshop-row--denied"}`}>
    <header className="workshop-row__header">
      <div className="workshop-person">
        <span className="workshop-person__avatar"><AdminAvatar account={account} /></span>
        <div>
          <span className="workshop-person__role"><AccountAccessBadge account={account} /> {roleLabel(account)}</span>
          <h3>{account.displayName}</h3>
          <p>{account.email || "No email address"}</p>
        </div>
      </div>
      <div className={`workshop-access-status ${workshop.allowed ? "is-enabled" : "is-denied"}`}>
        <span><AdminIcon name={workshop.allowed ? "approved" : "rejected"} size={18} /></span>
        <div><small>Effective access</small><strong>{workshop.allowed ? "Enabled" : "Denied"}</strong></div>
      </div>
    </header>

    <div className="workshop-policy-grid">
      <div><span>Policy source</span><strong>{policyLabel(workshop.source)}</strong><small>{workshop.grant ? `Revision ${workshop.grant.revision}` : "Inherited policy"}</small></div>
      <div><span>Access administration</span><strong>{workshop.canManageAccess ? "Allowed" : "Denied"}</strong><small>Account grant authority</small></div>
      <div><span>Provider configuration</span><strong>{workshop.canManageProviders ? "Allowed" : "Denied"}</strong><small>Separate provider authority</small></div>
      <div><span>Account state</span><strong>{account.status === "active" ? "Active" : account.status.replaceAll("_", " ")}</strong><small>{workshop.grant ? `Changed ${formatDate(workshop.grant.changed_at)}` : "No explicit grant"}</small></div>
    </div>

    <fieldset className="workshop-controls" disabled={busy || locked}>
      <legend>Explicit Workshop access</legend>
      <label><span>Access override</span><select value={state} onChange={(event) => setState(event.target.value)}><option value="granted">Granted</option><option value="suspended">Suspended</option><option value="revoked">Revoked / default policy</option></select><small>Effective policy is recalculated server-side.</small></label>
      <label><span>Grant expiry <em>UTC · optional</em></span><input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} /><small>Leave empty for no expiry.</small></label>
      <label className="workshop-controls__note"><span>Audit note</span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} placeholder="Reason for this access decision" /><small>Stored with the audited policy revision.</small></label>
      <div className="workshop-controls__actions">
        <button className="workshop-action workshop-action--primary" type="button" onClick={() => save()}>{busy ? "Saving…" : "Save changes"}</button>
        <button className="workshop-action workshop-action--grant" type="button" onClick={() => save("granted")}><AdminIcon name="approved" size={16} /> Grant access</button>
        <button className="workshop-action workshop-action--revoke" type="button" onClick={() => save(account.role === "admin" ? "suspended" : "revoked")}><AdminIcon name="rejected" size={16} /> Revoke</button>
      </div>
    </fieldset>

    {locked && <div className="workshop-row__locked"><AdminIcon name="shield" size={18} /><div><strong>Protected account</strong><p>Master recovery or administrator delegation policy prevents changes from this session.</p></div></div>}
    {error && <div className="workshop-row__error" role="alert"><AdminIcon name="rejected" size={17} /><span>{error}</span></div>}

    <footer className="workshop-row__footer">
      <div><AdminIcon name="shield" size={16} /><span>{workshop.grant ? `Last actor ${workshop.grant.changed_by}` : "No explicit access event"}</span></div>
      <div><button type="button" onClick={toggleAudit} aria-expanded={history !== null}><AdminIcon name="orders" size={16} /> Access audit <AdminIcon name="chevron" size={14} /></button>{current?.adminLevel === "master" && <ProfileRestrictions account={account} csrf={csrf} />}</div>
    </footer>
    {history !== null && <section className="workshop-audit" aria-label={`Audit history for ${account.displayName}`}>
      <header><span>Recorded access decisions</span><strong>{history.length} events</strong></header>
      <ol>{history.length ? history.map((entry) => <li key={entry.id}><span /><div><strong>{auditState(entry.next_json)}</strong><p>{entry.actor_name}</p></div><time>{formatDate(entry.created_at)}</time></li>) : <li className="workshop-audit__empty">No explicit changes recorded.</li>}</ol>
    </section>}
  </article>;
}

function ProfileRestrictions({ account, csrf }: { account: AuthAccount; csrf: string }) {
  const [open, setOpen] = useState(false), [payload, setPayload] = useState<ProfilePayload | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState("");
  async function load() { setError(""); try { setPayload(await adminApi<ProfilePayload>(`/api/workshop/accounts/${encodeURIComponent(account.id)}/profiles`)); setOpen(true); } catch (reason) { setError((reason as Error).message); } }
  async function save(item: ProfileProvider, mode: "all" | "selected", profileIds: string[], defaultProfileId: string | null) { setBusy(item.provider); setError(""); try { setPayload(await adminApi<ProfilePayload>(`/api/workshop/accounts/${encodeURIComponent(account.id)}/profiles`, { method: "PUT", headers: { "X-CSRF-Token": csrf }, body: JSON.stringify({ provider: item.provider, mode, profileIds, defaultProfileId, revision: item.policy.revision }) })); } catch (reason) { setError((reason as Error).message); } finally { setBusy(""); } }
  return <div className="profile-restrictions"><button type="button" onClick={() => open ? setOpen(false) : void (payload ? setOpen(true) : load())} aria-expanded={open}><AdminIcon name="shield" size={16} /> Provider profiles <AdminIcon name="chevron" size={14} /></button>{error && <p role="alert">{error}</p>}{open && payload && <section className="profile-restriction-panel"><header><div><strong>Provider profile access</strong><small>Master-only · applies on the next protected submission for {account.displayName}.</small></div><span>MASTER ONLY</span></header>{payload.providers.map((item) => <ProfilePolicyEditor key={item.provider} item={item} busy={busy === item.provider} onSave={save} />)}{payload.audit.length > 0 && <details><summary>Restriction audit</summary><ol>{payload.audit.slice(0, 12).map((row) => <li key={row.id}>{row.actor_name} · {row.provider} · {formatDate(row.created_at)}</li>)}</ol></details>}</section>}</div>;
}

function ProfilePolicyEditor({ item, busy, onSave }: { item: ProfileProvider; busy: boolean; onSave: (item: ProfileProvider, mode: "all" | "selected", ids: string[], defaultId: string | null) => Promise<void> }) {
  const [mode, setMode] = useState(item.policy.mode), [selected, setSelected] = useState(item.policy.allowedProfileIds), [defaultId, setDefaultId] = useState(item.policy.defaultProfileId || "");
  useEffect(() => { setMode(item.policy.mode); setSelected(item.policy.allowedProfileIds); setDefaultId(item.policy.defaultProfileId || ""); }, [item]);
  const available = item.profiles.filter((profile) => profile.enabled);
  const toggle = (profileId: string) => setSelected((current) => current.includes(profileId) ? current.filter((id) => id !== profileId) : [...current, profileId]);
  return <fieldset disabled={busy}><legend>{item.provider === "xai" ? "Grok / xAI" : item.provider[0].toUpperCase() + item.provider.slice(1)}</legend><label><span>Access</span><select value={mode} onChange={(event) => setMode(event.target.value as "all" | "selected")}><option value="all">All ordinary available profiles</option><option value="selected">Selected profiles only</option></select></label>{mode === "selected" && <div className="profile-choice-grid">{available.map((profile) => <label key={profile.id}><input type="checkbox" checked={selected.includes(profile.id)} onChange={() => toggle(profile.id)} /><span><strong>{profile.label}</strong><small>{profile.runtime ? "Immutable runtime source" : profile.verification_status}</small></span></label>)}</div>}<label><span>Account default</span><select value={defaultId} onChange={(event) => setDefaultId(event.target.value)}><option value="">Provider default</option>{available.filter((profile) => mode === "all" || selected.includes(profile.id)).map((profile) => <option value={profile.id} key={profile.id}>{profile.label}</option>)}</select></label><button type="button" disabled={mode === "selected" && !selected.length} onClick={() => void onSave(item, mode, mode === "selected" ? selected : [], defaultId || null)}>{busy ? "Saving…" : "Apply profile policy"}</button></fieldset>;
}

function roleLabel(account: AuthAccount) {
  if (account.adminLevel === "master") return "Master Admin";
  if (account.adminLevel === "full") return "Full Admin";
  return "Regular User";
}

function policyLabel(source: string) {
  return source.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function auditState(value: string) {
  try { return policyLabel(String(JSON.parse(value).state || "Updated")); }
  catch { return "Updated"; }
}
