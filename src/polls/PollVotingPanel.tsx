import { useAdminToast } from '../components/AdminToasts';
import { pollAdminRequest } from './admin-request';
import { Link } from 'react-router-dom';
import '../styles/poll-workspaces.css';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { getAdminPolls, type AdminPoll } from './admin-client';

type Policy = { rantEnabled: boolean; giftEnabled: boolean; centsPerVote: number; votesPerGift: number; maxMessages: number; timeoutSeconds: number };
type PolicyRow = { id: string; title: string; state: string; presentationType: string; sourceScope: string | null; revision: number; policy: Policy };
type Lot = { options?: AdminPoll['options']; observations?: Array<{ provider_event_at: string; evidence_json: string }>; audit?: Array<{ action: string; reason: string; actor_account_id: string | null; created_at: string }>; id: string; poll_id: string; title: string; kind: string; actor_label: string | null; source_scope: string; earned: number; waiting: number; unreconciled: number; committed: number; discarded: number; attempts_used: number; max_messages: number; expires_at: string; provider_event_at: string; reason: string | null; revision: number; evidence: Record<string, unknown> };
type Payload = { policies: PolicyRow[]; lots: Lot[]; source?: { scope: string; displayName: string }; livestreams?: Array<{ id: string; title: string; isLive: boolean }>; appliedPolicyRevision?: number; appliedWindowId?: string; botCompatible: boolean; protocol: number; heartbeatAt: string | null };
export function PollVotingPanel() {
  const { csrfToken, hasCapability } = useAuth();
  const { showToast } = useAdminToast();
  const allowed = hasCapability('automations.manage') && hasCapability('polls.manage');
  const [data, setData] = useState<Payload | null>(null), [polls, setPolls] = useState<AdminPoll[]>([]);
  const [selected, setSelected] = useState(''), [policy, setPolicy] = useState<Policy | null>(null);
  const [filter, setFilter] = useState({ pollId: '', type: '', source: '', actor: '', reason: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [testText, setTestText] = useState(''), [testRant, setTestRant] = useState(true), [match, setMatch] = useState('');
  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    try {
      const [value, library] = await Promise.all([pollAdminRequest<Payload>(`/api/admin/automations/poll-voting?${new URLSearchParams(filter)}`), getAdminPolls()]);
      setData(value); setPolls(library.items); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Poll voting is unavailable.'); }
    finally { setLoading(false); }
  }, [allowed, filter]);
  useEffect(() => { void load(); }, [load]);
  const row = data?.policies.find(p => p.id === selected);
  const options = polls.find(p => p.id === selected)?.options || [];
  const act = async (operation: () => Promise<unknown>, title: string | null = 'Poll voting saved') => { setBusy(true); setError(''); try { await operation(); await load(); if (title) showToast('Changes saved.', { title }); } catch (e) { setError(e instanceof Error ? e.message : 'The action failed.'); } finally { setBusy(false); } };
  if (!allowed) return <section className="poll-panel poll-voting-panel"><header><h2>Poll Voting</h2></header><div className="poll-workspace-body"><p className="poll-workspace-empty">Poll and automation management permissions are required to manage voting policies or reconciliation.</p></div></section>;
  return <section id="poll-voting" className="poll-panel poll-voting-panel">
    <header><div><p className="eyebrow">ORDINARY + ADDITIONAL VOTES</p><h2>Poll Voting</h2></div><button type="button" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing...' : 'Refresh'}</button></header>
    <div className="poll-workspace-body" aria-busy={loading}>
      {error ? <div className="poll-workspace-alert" role="alert"><strong>Unable to load Poll voting</strong><p>{error}</p></div> : null}
      {!data ? <p className="poll-workspace-empty">{loading ? 'Loading voting settings...' : 'Voting settings are unavailable. Refresh to try again.'}</p> : <>
        <div className="poll-runtime-grid">
          <div><span>Bot connection</span><strong className={data.botCompatible ? 'is-ready' : ''}>{data.botCompatible ? 'Compatible Bot connected' : 'Awaiting compatible Bot'}</strong><small>{data.heartbeatAt ? `Last heartbeat ${new Date(data.heartbeatAt).toLocaleString()}` : 'No current heartbeat'}</small></div>
          <div><span>Rumble source</span><strong>{data.source?.displayName || 'Awaiting discovery'}</strong><small>{data.livestreams?.filter(s => s.isLive).map(s => s.title).join(', ') || 'No live stream detected'}</small></div>
          <div><span>Applied voting policy</span><strong>{data.appliedPolicyRevision ? `Revision ${data.appliedPolicyRevision}` : 'Not yet applied'}</strong><small>Evidence protocol {data.protocol}</small></div>
        </div>
        <section className="poll-workspace-section" aria-labelledby="poll-policy-heading">
          <div className="poll-workspace-section-heading"><div><h3 id="poll-policy-heading">Voting settings</h3><p>Choose a Poll to manage its Rant and gift votes. Ordinary chat voting stays one vote per participant.</p></div></div>
          <div className="poll-policy-fields">
            <label>Poll target<select value={selected} onChange={e => { setSelected(e.target.value); setPolicy(data.policies.find(p => p.id === e.target.value)?.policy || null); }}><option value="">Choose a Poll</option>{data.policies.map(p => <option key={p.id} value={p.id}>{p.title} / {p.state}</option>)}</select></label>
            {!row && <div className="poll-workspace-empty"><strong>{data.policies.length ? 'Select a Poll to configure voting' : 'No Polls available yet'}</strong><p>{data.policies.length ? 'Existing credits retain their original settings when a policy changes.' : 'Create a matchup first, then return here to configure additional votes.'}</p>{!data.policies.length ? <Link to="/polls/abootnothing">Open Aboot Nothing</Link> : null}</div>}
            {row && policy ? <>
              <p className="poll-workspace-hint">{row.sourceScope || 'Website only: add a Rumble source in the Poll editor.'} / Saved policy {row.revision}</p>
              <div className="poll-policy-toggles">
                <label><input type="checkbox" checked={policy.rantEnabled} onChange={e => setPolicy({ ...policy, rantEnabled: e.target.checked })} /><span><strong>Collect Rant votes</strong><small>One additional vote per 100 cents, rounded down. One whole trigger phrase must match.</small></span></label>
                <label><input type="checkbox" checked={policy.giftEnabled} onChange={e => setPolicy({ ...policy, giftEnabled: e.target.checked })} /><span><strong>Collect gift credits</strong><small>Five additional votes per gifted subscription, allocated by the purchaser's following messages.</small></span></label>
              </div>
              <div className="poll-policy-grid">
                <fieldset><legend>Maximum following messages</legend><div className="poll-message-budget">{[1, 2, 3].map(n => <button key={n} type="button" aria-pressed={policy.maxMessages === n} onClick={() => setPolicy({ ...policy, maxMessages: n })}>{n}</button>)}</div><small>Each distinct purchaser message uses an attempt.</small></fieldset>
                <label>Waiting timeout (seconds)<input type="number" min={60} max={1800} value={policy.timeoutSeconds} onChange={e => setPolicy({ ...policy, timeoutSeconds: Number(e.target.value) })} /><small>Default: 300 seconds. Unused credits move to review.</small></label>
              </div>
              <div className="poll-workspace-actions"><button className="primary-button" type="button" disabled={busy} onClick={() => void act(() => pollAdminRequest('/api/admin/automations/poll-voting/policy', csrfToken || '', { pollId: selected, revision: row.revision, policy }))}>Save Poll voting policy</button></div>
              <details className="poll-matching-test"><summary>Test a message without voting</summary><div className="poll-policy-fields"><label>Try matching<input value={testText} maxLength={4000} onChange={e => setTestText(e.target.value)} /></label><label className="poll-workspace-toggle"><input type="checkbox" checked={testRant} onChange={e => setTestRant(e.target.checked)} />Rant phrase matching</label><div className="poll-workspace-actions"><button type="button" disabled={busy} onClick={() => void act(async () => { const result = await pollAdminRequest<{ matches: string[] }>('/api/admin/automations/poll-voting/test', csrfToken || '', { text: testText, rant: testRant, options }); setMatch(result.matches.length > 1 ? 'Ambiguous: review required' : result.matches.length ? options.find(o => o.id === result.matches[0])?.label || 'Matched' : 'No trigger matched'); }, null)}>Test without voting</button><output>{match}</output></div></div></details>
            </> : null}
          </div>
        </section>
        <section className="poll-workspace-section" aria-labelledby="poll-reconciliation">
          <div className="poll-workspace-section-heading"><div><h3 id="poll-reconciliation">Credit reconciliation</h3><p>Review unallocated credits, record a decision, or correct an earlier allocation.</p></div><span className="poll-workspace-count">{data.lots.length} shown</span></div>
          <div className="poll-credit-filters">
            <label>Poll<select value={filter.pollId} onChange={e => setFilter({ ...filter, pollId: e.target.value })}><option value="">All Polls</option>{data.policies.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
            <label>Collection<select value={filter.type} onChange={e => setFilter({ ...filter, type: e.target.value })}><option value="">All collections</option><option value="regular">Regular Polls</option><option value="abootnothing">Aboot Nothing</option></select></label>
            <label>Source<input placeholder="All sources" value={filter.source} onChange={e => setFilter({ ...filter, source: e.target.value })} /></label>
            <label>Participant<input placeholder="All participants" value={filter.actor} onChange={e => setFilter({ ...filter, actor: e.target.value })} /></label>
            <label>Review reason<select value={filter.reason} onChange={e => setFilter({ ...filter, reason: e.target.value })}><option value="">All reasons</option>{[...new Set(['timeout', 'window_ended', 'message_allowance_exhausted', 'ordering_ambiguous', 'provider_history_gap', 'purchaser_identity_missing', filter.reason, ...data.lots.map(l => l.reason || '')])].filter(Boolean).map(reason => <option key={reason} value={reason}>{reason.replaceAll('_', ' ')}</option>)}</select></label>
          </div>
          <p className="poll-workspace-hint">Showing up to 100 credit lots. Waiting and review balances are excluded from public totals. Every allocation or discard requires an audit reason.</p>
          <div className="poll-credit-queue">{data.lots.map(lot => <CreditLot key={`${lot.id}:${lot.revision}`} lot={lot} options={lot.options || polls.find(p => p.id === lot.poll_id)?.options || []} busy={busy} submit={body => act(() => pollAdminRequest('/api/admin/automations/poll-voting/reconcile', csrfToken || '', body), 'Poll credits updated')} />)}{!data.lots.length ? <div className="poll-workspace-empty"><strong>No credits to review</strong><p>Credits matching these filters will appear here when they are received.</p></div> : null}</div>
        </section>
      </>}
    </div>
  </section>;
}

function CreditLot({ lot, options, busy, submit }: { lot: Lot; options: AdminPoll['options']; busy: boolean; submit: (body: unknown) => Promise<void> }) {
  const [amount, setAmount] = useState(lot.waiting + lot.unreconciled), [option, setOption] = useState(options[0]?.id || ''), [reason, setReason] = useState('');
  const balance = lot.waiting + lot.unreconciled;
  const [fromOption, setFromOption] = useState(options[0]?.id || "");
  const [correction, setCorrection] = useState(1);
  const action = (kind: 'allocate' | 'discard') => { if (kind === 'discard' && !window.confirm(`Discard ${amount} credits from this lot? This decision will be audited.`)) return; void submit({ lotId: lot.id, revision: lot.revision, requestId: crypto.randomUUID(), amount, action: kind, optionId: option, reason }); };
  return <article><header><strong>{lot.title} · {lot.kind}</strong><span>{lot.actor_label || 'Purchaser identity unavailable'}</span></header><p>{lot.earned} earned · {lot.committed} committed · {lot.waiting} waiting · {lot.unreconciled} review · {lot.discarded} discarded</p><p>{lot.attempts_used}/{lot.max_messages} following messages · {balance ? lot.reason?.replaceAll('_', ' ') || 'Awaiting a message' : 'Settled'} · {new Date(lot.provider_event_at).toLocaleString()}</p><details><summary>Relevant provider evidence</summary><dl>{Object.entries(lot.evidence).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}</dl>{lot.observations?.length ? <><h4>Following message evidence</h4>{lot.observations.map((o, i) => <p key={i}><time>{new Date(o.provider_event_at).toLocaleString()}</time>: {JSON.parse(o.evidence_json).normalizedText}</p>)}</> : null}{lot.audit?.length ? <><h4>Audit history</h4>{lot.audit.map((a, i) => <p key={i}>{a.action}: {a.reason} ({a.actor_account_id || 'Automatic'}, {new Date(a.created_at).toLocaleString()})</p>)}</> : null}<p>Source {lot.source_scope} · expires {new Date(lot.expires_at).toLocaleString()}</p></details>{balance ? <div className="automation-fields"><label>Amount<input type="number" min={1} max={balance} value={amount} onChange={e => setAmount(Number(e.target.value))} /></label><label>Original Poll option<select value={option} onChange={e => setOption(e.target.value)}>{options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label><label>Audit reason<input required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label><button type="button" disabled={busy || !reason.trim() || amount < 1 || amount > balance || !option} onClick={() => action('allocate')}>Allocate credits</button><button type="button" disabled={busy || !reason.trim() || amount < 1 || amount > balance} onClick={() => action('discard')}>Discard credits</button></div> : null}{lot.committed > 0 ? <details><summary>Correct a committed allocation</summary><div className="automation-fields"><label>From option<select value={fromOption} onChange={e => setFromOption(e.target.value)}>{options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label><label>Corrected option<select value={option} onChange={e => setOption(e.target.value)}>{options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label><label>Correction amount<input type="number" min={1} max={lot.committed} value={correction} onChange={e => setCorrection(Number(e.target.value))} /></label><label>Correction reason<input value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label><button type="button" disabled={busy || !reason.trim() || fromOption === option || correction < 1} onClick={() => void submit({ lotId: lot.id, revision: lot.revision, requestId: crypto.randomUUID(), action: 'correct', amount: correction, fromOptionId: fromOption, optionId: option, reason })}>Record correction</button></div></details> : null}</article>;
}
