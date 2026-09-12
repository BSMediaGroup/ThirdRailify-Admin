import { useState } from 'react';
import { families, type Rule } from '../lib/automation-client';
import { defaultAction } from '../lib/automation-model.mjs';
import { useRuleStore } from '../lib/automation-rule-store';
import { FEATURE_PATHS } from '../lib/entrant-feature-drawing';
import { FeatureSlicePreview } from './EntrantAppearanceControls';
import '../styles/automation-rule-cards.css';
type Props = { rules: Rule[]; scoped?: boolean; truncated?: boolean; canManage: boolean; onEdit: (rule: Rule) => void; onToggle: (rule: Rule) => void; onDelete: (rule: Rule) => void; targetLink?: (id: string) => string };
export function AutomationRuleList(props: Props) {
  const [search, setSearch] = useState(''); const [family, setFamily] = useState(''); const states = useRuleStore();
  const groups = new Map<string, Rule[]>();
  for (const rule of [...props.rules].sort((a, b) => (a.id || '').localeCompare(b.id || ''))) { const key = `${rule.targetType || 'wheel'}:${rule.targetWheelId || 'missing'}`; groups.set(key, [...(groups.get(key) || []), rule]); }
  const ordered = [...groups].sort(([a], [b]) => a.localeCompare(b));
  const matches = (r: Rule) => (!family || r.eventType === family) && `${r.name} ${r.targetWheelTitle} ${r.sourceLabel || ''}`.toLowerCase().includes(search.toLowerCase());
  const cards = (rules: Rule[]) => <div className="automation-cards">{rules.filter(matches).map(rule => <AutomationRuleCard {...props} key={rule.id} rule={rule} pending={states.get(rule.id!)?.pending} pendingEnabled={states.get(rule.id!)?.enabled} error={states.get(rule.id!)?.error} />)}</div>;
  return <div className="automation-target-list"><div className="automation-filters"><label>Search rules<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label><label>Event family<select value={family} onChange={e => setFamily(e.target.value)}><option value="">All event families</option>{families.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><small>{props.rules.length} loaded rules{props.truncated ? ' · limit reached; counts cover loaded rules only' : ''}</small></div>
    {props.scoped ? cards(props.rules) : ordered.map(([key, rules]) => {
      const shown = rules.filter(matches); const first = rules[0]; const enabled = rules.filter(r => r.enabled).length;
      return <details className="automation-target" key={key} open hidden={!shown.length}><summary><span><strong>{first.targetWheelTitle || 'Unavailable Wheel'}</strong><small>{rules.length} rules · {enabled} enabled · {rules.length - enabled} paused{shown.length !== rules.length ? ` · ${shown.length} matching` : ''}</small></span><span className={first.targetAvailable === false || first.targetLocked || first.targetLifecycle === 'archived' ? 'automation-warning' : ''}>{first.targetAvailable === false ? 'Target unavailable' : first.targetLocked || first.targetLifecycle === 'archived' ? 'Entry awards blocked' : 'Wheel target'}</span></summary>{props.targetLink && first.targetAvailable !== false ? <a className="automation-target__link" href={props.targetLink(first.targetWheelId)}>Manage {first.targetWheelTitle}</a> : null}{cards(rules)}</details>;
    })}
    {!props.rules.some(matches) && <p>No rules match these filters.</p>}
  </div>;
}
function AutomationRuleCard({ rule, pending, pendingEnabled, error, canManage, scoped, onEdit, onToggle, onDelete }: Props & { rule: Rule; pending?: boolean; pendingEnabled?: boolean; error?: string }) {
  const action = rule.actionConfig || defaultAction(); const award = action.award; const enabled = pending ? pendingEnabled : rule.enabled;
  const icon = rule.eventType === 'rumble.gift_purchase' ? 'gift' : rule.eventType === 'rumble.raid.received' ? 'incoming' : rule.eventType === 'rumble.rant' ? 'coin' : 'star';
  const eventColor = icon === 'gift' ? '#CF74E9' : icon === 'incoming' ? '#9ADB72' : icon === 'coin' ? '#F2C364' : '#EE8795';
  const unit = award.mode === 'per_gift' ? 'gifted subscription' : award.mode === 'per_amount' ? `${award.unitCents} reported cents` : rule.eventType === 'rumble.raid.received' ? 'raid notification' : 'qualifying event';
  const conditions = Object.entries(rule.conditions).map(([key, value]) => `${({ exactText: 'Message', minAmountCents: 'Minimum cents', minGifts: 'Minimum gifts', giftType: 'Gift type', badge: 'Badge', livestreamId: 'Stream' } as Record<string,string>)[key] || key}: ${value}`).join(' · ');
  return <article className="automation-card" style={{ '--event-color': eventColor } as React.CSSProperties} aria-busy={pending || undefined}>
    <header><div className="automation-card__identity"><p className="automation-card__family"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={FEATURE_PATHS[icon]} /></svg>{families.find(f => f[0] === rule.eventType)?.[1] || rule.eventType}{rule.legacySubscriberRule ? ' · legacy rule' : ''}</p><h3>{rule.name}</h3></div><div className="automation-card__switch"><button type="button" role="switch" aria-label={`Enable automation ${rule.name}`} aria-checked={Boolean(enabled)} aria-disabled={!canManage || pending} disabled={!canManage} onClick={() => { if (!pending) onToggle(rule); }}><span>{enabled ? '✓' : ''}</span></button><span className={pending ? 'automation-warning' : enabled ? 'automation-enabled' : 'automation-paused'}>{pending ? 'Saving…' : enabled ? 'Enabled' : 'Paused'}</span></div></header>
    {error && <p className="automation-error" role="alert">{error}</p>}
    <p className="automation-card__award">{award.entriesPerUnit} {award.entriesPerUnit === 1 ? 'entry' : 'entries'} per {unit}</p>
    <p className="automation-card__condition">{conditions || 'Any new qualifying event'}</p>
    <p>{action.repeatActorPolicy === 'accumulate' ? 'Adds to matching entry type' : 'Skips matching entry type'}</p>
    {rule.eventType === 'subscriber_self_paid' ? <p className="automation-card__notice">500 cents only · event-driven · gifted recipients excluded</p> : null}
    {rule.eventType === 'rumble.gift_purchase' ? <p className="automation-card__notice">Purchaser award · total_gifts scaling available · recipients not added</p> : null}
    {rule.eventType === 'rumble.raid.received' && <p className="automation-card__notice">Chat-derived · Not independently verified</p>}
    <div className="automation-card__context"><span>{rule.sourceLabel || rule.sourceScope}</span>{scoped ? null : <span>{rule.targetWheelTitle}</span>}<small>Revision {rule.revision}</small></div>
    {rule.targetAvailable === false || rule.targetLocked || rule.targetLifecycle === 'archived' ? <p className="automation-warning">Target unavailable for entry awards</p> : null}
    {enabled && rule.runtimeStatus && rule.runtimeStatus !== 'ready' ? <p className="automation-warning">Execution: {rule.runtimeStatus.replaceAll('_', ' ')}</p> : null}
    {action.appearance ? <div className="automation-card__appearance"><FeatureSlicePreview value={action.appearance} /><span>Future award appearance</span></div> : <small className="automation-card__appearance-off">Wheel / existing entrant appearance</small>}
    <footer><div><strong>{rule.counters?.executed || 0}</strong> successful events <span>· {(rule.counters?.duplicateEvents || 0) + (rule.counters?.duplicateEntrants || 0)} no-ops</span><small>Last outcome: {rule.lastOutcome || 'No events yet'}{rule.lastFault ? ` · Last reported fault: ${rule.lastFault}` : ''}</small></div><div className="automation-card__actions"><button type="button" disabled={!canManage || pending} onClick={() => onEdit(rule)}>Edit</button><button type="button" className="automation-card__delete" disabled={!canManage || pending} onClick={() => onDelete(rule)}>Delete</button></div></footer>
  </article>;
}
