import { AutomationRuleList } from './AutomationRuleList';
import { mergeRules, publishRule, removeRule, toggleRule, useRuleStore } from '../lib/automation-rule-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import '../styles/trigger-studio.css';

import { AutomationRuleEditor } from './AutomationRuleEditor';
import { SubscriberRosterPanel } from './SubscriberRosterPanel';
import { AutomationRequestError, automationRequest as request, families, type Rule, type Discovery, type WheelChoice, type Readiness } from '../lib/automation-client';
import { defaultAction } from '../lib/automation-model.mjs';
type Payload = { list?: { truncated: boolean }; readiness?: Readiness; rules: Rule[]; wheels: WheelChoice[]; discovery?: Discovery; activity: { id: string; rule_id: string; event_type?: string; actor_label: string; outcome: string; awarded_entries: number; action_result: string | null; created_at: string }[] };
const initial = (wheelId: string, scope = ''): Rule => ({ name: '', description: '', enabled: false, sourceScope: scope, eventType: 'rumble.chat.exact', conditions: { exactText: '' }, actionType: 'wheel.add_actor', targetWheelId: wheelId, duplicatePolicy: 'skip', actionConfig: defaultAction() });
const label = (kind: string) => families.find(f => f[0] === kind)?.[1] || kind;
const date = (value?: string) => value ? new Date(value).toLocaleString() : 'Not recorded';

export function TriggerStudio({ wheelId = '', runtime }: { wheelId?: string; runtime?: Record<string, unknown> }) {
  useRuleStore();
  const { csrfToken, hasCapability } = useAuth(); const [params] = useSearchParams();
  const canRead = hasCapability('automations.view') && hasCapability('wheels.view');
  const canManage = hasCapability('automations.manage') && hasCapability('wheels.manage');
  const [payload, setPayload] = useState<Payload | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [editor, setEditor] = useState<Rule | null>(null); const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const load = useCallback(async () => { if (!canRead) return; setLoading(true); setLoadError(''); try { setPayload(await request<Payload>(`rules?wheelId=${encodeURIComponent(wheelId)}`)); } catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not load rules.'); } finally { setLoading(false); } }, [canRead, wheelId]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30000); return () => window.clearInterval(timer); }, [load]);
  const autoOpened = useRef(false);
  useEffect(() => { if (params.get('create') === '1' && canManage && payload && !autoOpened.current) { autoOpened.current = true; setEditor(initial(params.get('wheelId') || wheelId, payload.discovery?.source?.scope || '')); } }, [params, canManage, wheelId, payload]);
  const mutate = async (path: string, body: unknown, close = false) => { if (!csrfToken || !canManage) return; setBusy(true); setError(''); setFieldErrors({}); try { const response = await request<{ rule?: Rule }>(path, csrfToken, body); if (response.rule) { publishRule(response.rule); setPayload(p => p ? { ...p, rules: mergeRules(p.rules, wheelId) } : p); } else if (path === 'rules/delete') removeRule((body as Rule).id!); if (close) setEditor(null); } catch (e) { if (e instanceof AutomationRequestError && e.issues.length) setFieldErrors(Object.fromEntries(e.issues.map(i => [i.field, i.message]))); else setError(e instanceof Error ? e.message : 'Save failed.'); } finally { setBusy(false); } };
  if (!canRead) return <section className="event-studio"><h2>Rumble automation</h2><p>Automations and Wheels viewing access are required.</p></section>;
  const rules = mergeRules(payload?.rules || [], wheelId); const totals = (key: string) => rules.reduce((sum, r) => sum + (r.counters?.[key] || 0), 0);
  return <section className="event-studio" aria-label={wheelId ? 'Wheel Rumble automation' : 'Trigger Studio'}>
    <header className="event-studio__heading"><div><p className="eyebrow">RUMBLE AUTOMATION</p><h2>{wheelId ? 'Wheel automation' : 'Trigger Studio'}</h2><p>Connect Rumble events to your Wheels. Choose what qualifies, review the action, and track the results.</p></div><div className="event-actions"><button type="button" className="secondary-button" disabled={loading || busy} onClick={() => void load()}>{loading ? "Refreshing..." : "Refresh rules"}</button><button type="button" className="primary-button" disabled={!canManage || busy || !payload || Boolean(loadError)} onClick={() => { setEditor(initial(wheelId, payload?.discovery?.source?.scope || '')); setFieldErrors({}); setError(''); }}>Create automation</button>{wheelId ? <Link to="/automations">Open in Automations</Link> : null}</div></header>
    {loadError && <div className="admin-alert" role="alert"><strong>Rules unavailable</strong><p>{loadError}</p><p>{payload ? "Showing the last loaded rules. Refresh before making changes." : "Rules and activity could not be loaded. Refresh rules to try again."}</p></div>}
    {error ? <div className="admin-alert" role="alert">{error}</div> : null}
    {runtime ? <div className="event-runtime"><strong>Event engine</strong><span className="poll-status">{runtime.lastFault ? 'Needs attention' : runtime.lastSnapshotAt ? 'Reporting' : 'Awaiting Bot report'}</span><span>{Number(runtime.pending || 0)} queued</span><span>{Number(runtime.transitions || 0)} stream transitions</span><small>Last transition: {runtime.lastTransition ? label(String(runtime.lastTransition)) : 'None'} | Last snapshot: {date(runtime.lastSnapshotAt as string | undefined)}{runtime.lastFault ? ` | ${String(runtime.lastFault).replaceAll('_', ' ')}` : ''}</small></div> : <p className="event-runtime">Event engine telemetry is available in Automations. Enabling a rule starts with new events.</p>}
    <div className="event-metrics" aria-label="Loaded rule metrics">{[['Enabled', rules.filter(r => r.enabled).length], ['Paused', rules.filter(r => !r.enabled).length], ['Target Wheels', new Set(rules.map(r => r.targetWheelId)).size], ['Matches', totals('matched')], ['Successful adds', totals('executed')], ['Duplicates / no-op', totals('duplicateEvents') + totals('duplicateEntrants')], ['Failures', totals('failed') + totals('rejected')]].map(([name, value]) => <div key={name}><strong>{payload ? value : '—'}</strong><span>{name}</span></div>)}</div>
    {editor ? <AutomationRuleEditor key={editor.id || 'new'} rule={editor} rules={rules} readiness={payload?.readiness} wheels={payload?.wheels || []} discovery={payload?.discovery} csrf={csrfToken || ''} busy={busy} canManage={canManage} serverErrors={fieldErrors} onChange={r => { setEditor(r); setFieldErrors({}); }} onSave={() => void mutate('rules', editor, true)} onClose={() => { setEditor(null); setFieldErrors({}); setError(''); }} /> : null}
    <AutomationRuleList rules={rules} scoped={Boolean(wheelId)} truncated={payload?.list?.truncated} canManage={canManage && !loadError} targetLink={id => `/wheels/${id}`} onEdit={rule => { setEditor(rule); setFieldErrors({}); setError(''); }} onToggle={rule => { if (csrfToken) void toggleRule(rule, csrfToken, request); }} onDelete={rule => { if (window.confirm(`Delete automation ${rule.name}? Existing entries and receipts are retained.`)) void mutate('rules/delete', { id: rule.id, revision: rule.revision, confirm: 'DELETE' }); }} />
    {!rules.length && !loadError ? <p className="event-empty" role="status">{loading ? 'Loading rules…' : payload ? 'No rules yet. Create an automation to connect new Rumble events to a Wheel.' : 'Rules have not loaded.'}</p> : null}
    <div className="event-activity"><h3>Recent Wheel actions</h3>{payload?.activity.length ? payload.activity.map(a => <p key={a.id}><strong>{a.actor_label}</strong>{a.event_type === 'rumble.raid.received' ? ' | Raid Received | Chat-derived' : ''} · {(a.action_result || a.outcome).replaceAll('_', ' ')} · +{a.awarded_entries || 0} entries · {date(a.created_at)}</p>) : <p>{loadError ? "Activity unavailable until rules reload successfully." : loading && !payload ? "Loading recent actions..." : "No event receipts recorded."}</p>}</div>
    <SubscriberRosterPanel wheelId={wheelId} csrf={csrfToken || ''} canManage={canManage} />
  </section>;
}
