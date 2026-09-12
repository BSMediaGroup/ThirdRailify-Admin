import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { adminApi } from '../auth/client';
import { AdminAvatar } from '../auth/AdminAccountWidget';
import { AccountAccessBadge } from '../components/AccountAccessBadge';
import type { AuthAccount } from '../auth/types';
import './workshop-access.css';
type Grant = { state: string; expires_at: string | null; revision: number; changed_by: string; changed_at: string; note: string };
type Policy = { allowed: boolean; source: string; canManageAccess: boolean; canManageProviders: boolean; grant: Grant | null };
type Item = { account: AuthAccount; workshop: Policy };
type Payload = { items: Item[]; total: number; page: number; canOpen: boolean };
export function WorkshopAccessPage() {
  const { csrfToken, account } = useAuth();
  const [payload, setPayload] = useState<Payload | null>(null), [query, setQuery] = useState(''), [page, setPage] = useState(1), [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => { let active = true; const timer = setTimeout(() => { adminApi<Payload>(`/api/workshop/accounts?q=${encodeURIComponent(query)}&page=${page}`).then(x => { if (active) { setPayload(x); setError(''); } }).catch(e => { if (active) setError(e.message); }); }, 180); return () => { active = false; clearTimeout(timer); }; }, [query, page, reload]);
  async function open() {
    const tab = window.open('about:blank', '_blank'); if (!tab) { setError('Allow pop-ups to open Lab.'); return; } tab.opener = null;
    try { const data = await adminApi<{ handoffUrl: string }>('/api/workshop/open', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, body: '{}' }); const url = new URL(data.handoffUrl); if (url.origin !== 'https://lab.thirdrailify.com' || !url.searchParams.get('handoff')) throw new Error('Invalid Lab handoff.'); tab.location.replace(url.href); } catch (e) { tab.close(); setError((e as Error).message); }
  }
  return <section className="workshop-access"><header><div><p>PRIVATE CREATIVE WORKSHOP</p><h1>Workshop Access</h1><p>Approve existing accounts. Site roles and private projects remain independently protected.</p></div><button className="button" onClick={open} disabled={!payload?.canOpen}>Open Lab ↗</button></header>
    <label>Search accounts<input type="search" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} placeholder="Name, email or account ID" /></label>
    {error && <p role="alert">{error}</p>}
    {!payload && !error && <p role="status">Loading accounts…</p>}
    <div className="workshop-rows">{payload?.items.map(item => <AccessRow key={item.account.id} item={item} csrf={csrfToken} current={account} onUpdate={workshop => setPayload(old => old && ({ ...old, items: old.items.map(x => x.account.id === item.account.id ? { ...x, workshop } : x) }))} />)}</div>
    <nav aria-label="Account pages"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} · {payload?.total || 0} accounts</span><button disabled={!payload || page * 20 >= payload.total} onClick={() => setPage(page + 1)}>Next</button><button onClick={() => setReload(x => x + 1)}>Refresh</button></nav>
  </section>;
}
function AccessRow({ item, csrf, current, onUpdate }: { item: Item; csrf: string; current: AuthAccount | null; onUpdate: (p: Policy) => void }) {
  const { account, workshop } = item;
  const [state, setState] = useState(workshop.grant?.state || 'revoked'), [expiry, setExpiry] = useState(workshop.grant?.expires_at?.slice(0, 16) || ''), [note, setNote] = useState(workshop.grant?.note || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [history, setHistory] = useState<Array<{ id: string; actor_name: string; created_at: string; next_json: string }> | null>(null);
  const locked = account.locked || account.adminLevel === 'master' || (current?.adminLevel !== 'master' && (account.id === current?.id || account.role === 'admin'));
  async function save(next = state) { setBusy(true); setError(''); try { const r = await adminApi<{ workshop: Policy }>(`/api/workshop/accounts/${encodeURIComponent(account.id)}`, { method: 'PUT', headers: { 'X-CSRF-Token': csrf }, body: JSON.stringify({ state: next, revision: workshop.grant?.revision || 0, expiresAt: expiry ? new Date(expiry + ':00Z').toISOString() : null, note }) }); setState(next); setHistory(null); onUpdate(r.workshop); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function audit() { try { const r = await adminApi<{ items: NonNullable<typeof history> }>(`/api/workshop/accounts/${encodeURIComponent(account.id)}/history`); setHistory(r.items); } catch (e) { setError((e as Error).message); } }
  return <article className="workshop-row"><div className="workshop-person"><AdminAvatar account={account} /><div><strong>{account.displayName}</strong><p>{account.email}</p><AccountAccessBadge account={account} /><small>{account.status}</small></div></div>
    <div><strong>{workshop.allowed ? 'Access enabled' : 'Access denied'}</strong><p>{workshop.source.replaceAll('_', ' ')}</p><small>Access administration: {workshop.canManageAccess ? 'Allowed' : 'Denied'} · Provider configuration: {workshop.canManageProviders ? 'Allowed' : 'Denied'}</small><p>{workshop.grant ? `Changed ${new Date(workshop.grant.changed_at).toLocaleString('en-US')} · Actor ${workshop.grant.changed_by}` : 'No explicit grant'}</p></div>
    <fieldset disabled={busy || locked}><label>Explicit access<select value={state} onChange={e => setState(e.target.value)}><option value="granted">Granted</option><option value="suspended">Suspended</option><option value="revoked">Revoked / default policy</option></select></label><label>Grant expiry (UTC, optional)<input type="datetime-local" value={expiry} onChange={e => setExpiry(e.target.value)} /></label><label>Audit note<input value={note} onChange={e => setNote(e.target.value)} maxLength={1000} /></label><div><button onClick={() => save()}>Save changes</button><button onClick={() => save('granted')}>Grant</button><button onClick={() => save(account.role === 'admin' ? 'suspended' : 'revoked')}>Revoke</button></div></fieldset>
    {locked && <p>Protected by Master recovery or administrator delegation policy.</p>}{error && <p role="alert">{error}</p>}<button onClick={audit}>Audit history</button>{history && <ol>{history.length ? history.map(h => <li key={h.id}>{h.actor_name} · {new Date(h.created_at).toLocaleString('en-US')} · {JSON.parse(h.next_json).state}</li>) : <li>No explicit changes.</li>}</ol>}
  </article>;
}
