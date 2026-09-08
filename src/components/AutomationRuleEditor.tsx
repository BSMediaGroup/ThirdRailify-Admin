import { EntrantAppearanceControls } from './EntrantAppearanceControls';
import { useEffect, useState } from 'react';
import { CONDITION_FIELDS, RAID_TYPE, RAID_TEXT, calculateAward, defaultAction, ruleFieldErrors, type ActionConfig } from '../lib/automation-model.mjs';

import { families, automationRequest, AutomationRequestError, type Rule, type Conditions, type WheelChoice, type Discovery, type TestResult, type Readiness } from '../lib/automation-client';

export function AutomationRuleEditor({ rule, wheels, discovery, readiness, rules, csrf, busy, canManage, serverErrors, onChange, onSave, onClose, request = automationRequest }: {
  request?: typeof automationRequest; rule: Rule; rules?: Rule[]; readiness?: Readiness; wheels: WheelChoice[]; discovery?: Discovery; csrf: string; busy: boolean; canManage: boolean;
  serverErrors: Record<string, string>; onChange: (rule: Rule) => void; onSave: () => void; onClose: () => void;
}) {
  const [custom, setCustom] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [streamMode, setStreamMode] = useState(rule.conditions.livestreamId ? 'detected' : 'any');
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [sample, setSample] = useState({ actorLabel: 'ExampleUser', text: '', amountCents: 500, totalGifts: 5, giftType: 'random', badge: '', livestreamId: '' });
  const action = rule.actionConfig || defaultAction();
  const localErrors = ruleFieldErrors(rule);
  const errors = { ...localErrors, ...serverErrors };
  const valid = !Object.keys(localErrors).length;
  const textEvent = ['rumble.chat.exact', 'rumble.rant'].includes(rule.eventType);
  const raid = rule.eventType === RAID_TYPE;
  const streamEvent = textEvent || raid;
  const overlap = rules?.some(r => r.id !== rule.id && r.enabled && r.targetWheelId === rule.targetWheelId && r.sourceScope === rule.sourceScope && ((raid && r.eventType === 'rumble.chat.exact' && r.conditions.exactText?.normalize('NFKC').trim().toLowerCase() === RAID_TEXT) || (rule.eventType === 'rumble.chat.exact' && rule.conditions.exactText?.normalize('NFKC').trim().toLowerCase() === RAID_TEXT && r.eventType === RAID_TYPE)));
  const gift = rule.eventType === 'rumble.gift_purchase', rant = rule.eventType === 'rumble.rant';
  const stateOnly = rule.eventType.startsWith('rumble.livestream.');
  const source = discovery?.source;
  const sourceName = source?.scope === rule.sourceScope ? source.displayName : rule.sourceLabel || (rule.sourceScope ? 'Saved / custom source' : 'Select a Rumble source');
  const streams = source?.scope === rule.sourceScope ? discovery?.livestreams || [] : [];
  const live = streams.filter(s => s.isLive);
  const current = discovery?.botState === 'healthy' && discovery?.discoveryState === 'online';
  const freshness = current ? 'Current' : discovery?.botState === 'stale' || discovery?.discoveryState === 'stale' ? 'Delayed · cached discovery' : source ? 'Offline · cached discovery' : 'Offline · discovery unavailable';
  const preview = calculateAward(action, rule.eventType, { totalGifts: 5, amountCents: 500 });
  useEffect(() => { setTest(null); }, [rule]);
  const update = (patch: Partial<Rule>) => onChange({ ...rule, ...patch });
  const condition = (key: keyof Conditions, value: string, numeric = false) => {
    const next = { ...rule.conditions }; if (!value) delete next[key]; else Object.assign(next, { [key]: numeric ? Number(value) : value }); update({ conditions: next });
  };
  const award = (patch: Partial<ActionConfig['award']>) => update({ actionConfig: { ...action, award: { ...action.award, ...patch } } });
  const hint = (key: string) => errors[key] ? <small className="event-field-error" id={`rule-error-${key}`}>{errors[key]}</small> : null;
  const invalid = (key: string) => ({ 'aria-invalid': Boolean(errors[key]), 'aria-describedby': errors[key] ? `rule-error-${key}` : undefined });
  const dryRun = async () => {
    setTesting(true); setTestError(''); setTest(null);
    try { setTest(await request<TestResult>('test', csrf, { rule, sample })); }
    catch (e) { setTestError(e instanceof AutomationRequestError && e.issues.length ? e.issues.map(i => i.message).join(' ') : e instanceof Error ? e.message : 'Dry run unavailable.'); }
    finally { setTesting(false); }
  };
  return <form className="event-editor" aria-label="Automation rule editor" noValidate onSubmit={e => { e.preventDefault(); if (valid && !busy && canManage && !(streamEvent && streamMode !== 'any' && !rule.conditions.livestreamId)) onSave(); }}>
    <header><div><p className="eyebrow">RULE SETUP</p><h3>{rule.id ? 'Edit automation' : 'Create automation'}</h3></div><button type="button" className="secondary-button" onClick={onClose}>Close editor</button></header>
    <div className="event-fields">
      <label>Rule name<input aria-label="Rule name" required maxLength={100} value={rule.name} {...invalid('name')} onChange={e => update({ name: e.target.value })} />{hint('name')}</label>
      <label>Description<input aria-label="Description" maxLength={500} value={rule.description} {...invalid('description')} onChange={e => update({ description: e.target.value })} />{hint('description')}</label>
    </div>
    <fieldset className="event-source"><legend>Rumble source</legend>
      <div className="event-source__status"><span className="poll-status">{freshness}</span><small>{source ? 'Detected from Third Railify Bot' : 'Discovery unavailable. Use Advanced to configure a source.'}</small></div>
      <button type="button" className="event-source__choice" aria-label="Rumble source" aria-expanded={sourceOpen} onClick={() => setSourceOpen(!sourceOpen)}><strong>{sourceName}</strong><span aria-hidden="true">▾</span></button>
      {sourceOpen ? <div className="event-source__options" aria-label="Detected sources">
        {source ? <button type="button" onClick={() => { update({ sourceScope: source.scope, sourceLabel: source.displayName, conditions: Object.fromEntries(Object.entries(rule.conditions).filter(([key]) => key !== 'livestreamId')) }); setStreamMode('any'); setCustom(false); setSourceOpen(false); }}><strong>{source.displayName}</strong><small>Detected from Bot · {freshness}</small></button> : <p>No detected source available.</p>}
        {rule.sourceScope && rule.sourceScope !== source?.scope ? <p>{sourceName} · Saved selection retained</p> : null}
      </div> : null}
      {hint('sourceScope')}
      <details open={custom} onToggle={e => setCustom(e.currentTarget.open)}><summary>Advanced / Custom source</summary><div className="event-fields"><label>Custom Rumble source<input placeholder="user:<id> or channel:<id>" value={rule.sourceScope} {...invalid('sourceScope')} onChange={e => { update({ sourceScope: e.target.value, sourceLabel: null, conditions: Object.fromEntries(Object.entries(rule.conditions).filter(([key]) => key !== 'livestreamId')) }); setStreamMode('any'); }} /></label></div><p>Use an authoritative user or channel ID. Provider timestamps are not source IDs.</p></details>
    </fieldset>
    <div className="event-fields"><label>Event family<select aria-label="Event family" value={rule.eventType} onChange={e => { const eventType = e.target.value; const conditions = Object.fromEntries(Object.entries(rule.conditions).filter(([key]) => CONDITION_FIELDS[eventType]?.includes(key))); update({ eventType, conditions, actionConfig: { ...action, award: { ...action.award, mode: 'fixed' } } }); if (!conditions.livestreamId) setStreamMode('any'); }}>{families.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select>{hint('eventType')}</label></div>
    <p className="event-family-note">{families.find(f => f[0] === rule.eventType)?.[2]}</p>
    {raid ? <div className="event-incompatible" role="status"><strong className="poll-status">Chat-derived</strong><p>Entries are awarded to the account named on the notification. Individual raid participants and raid size are not supplied.</p><p>An identical user-authored message cannot be distinguished from a system announcement. Not independently verified.</p><p>{!readiness?.raidSchema ? 'Storage readiness is not confirmed. Saving will check the current server schema.' : !readiness?.raidRuntime ? 'Pending capable Bot: save is available, execution awaits the updated Bot and a current support report.' : 'Capable Bot reporting. Only enabled rules can execute.'}</p></div> : null}
    {overlap ? <p role="status">Overlap: another enabled rule can match this announcement for this Wheel. Replay protection is per rule; both rules may deliberately award entries.</p> : null}
    {stateOnly ? <div className="event-incompatible" role="status"><strong>Wheel entry action incompatible</strong><p>Livestream transitions have no actor. Add actor to Wheel is unavailable.</p></div> : <>
      <fieldset><legend>Conditions</legend><div className="event-fields">
        {textEvent ? <><label>{rule.eventType === 'rumble.chat.exact' ? 'Exact message (required)' : 'Exact rant message (optional)'}<input aria-label={rule.eventType === 'rumble.chat.exact' ? 'Exact message (required)' : 'Exact rant message (optional)'} maxLength={500} value={rule.conditions.exactText || ''} {...invalid('exactText')} onChange={e => condition('exactText', e.target.value)} />{hint('exactText')}</label><label>Required badge (optional)<input value={rule.conditions.badge || ''} {...invalid('badge')} onChange={e => condition('badge', e.target.value)} />{hint('badge')}</label></> : null}
        {rant || rule.eventType === 'rumble.subscribe' ? <label>Minimum amount in cents (optional)<input type="number" min={0} max={100000000} step={1} value={rule.conditions.minAmountCents ?? ''} {...invalid('minAmountCents')} onChange={e => condition('minAmountCents', e.target.value, true)} />{hint('minAmountCents')}</label> : null}
        {gift ? <><label>Minimum gifts (optional)<input type="number" min={0} max={100000000} step={1} value={rule.conditions.minGifts ?? ''} {...invalid('minGifts')} onChange={e => condition('minGifts', e.target.value, true)} />{hint('minGifts')}</label><label>Gift type (optional)<input value={rule.conditions.giftType || ''} {...invalid('giftType')} onChange={e => condition('giftType', e.target.value)} />{hint('giftType')}</label></> : null}
        {rule.eventType === 'rumble.follow' ? <p>Any new follower from this source. No stream or amount condition.</p> : null}
      </div>{hint('conditions')}
      {streamEvent ? <div className="event-stream"><div className="event-fields"><label>Livestream<select aria-label="Livestream" value={streamMode} onChange={e => { const mode = e.target.value; setStreamMode(mode); condition('livestreamId', mode === 'current' ? live[0]?.id || '' : ''); }}><option value="any">Any eligible livestream</option><option value="current" disabled={!current || live.length !== 1}>Current detected livestream{!current || live.length !== 1 ? ' (unavailable)' : ''}</option><option value="detected">Choose detected livestream</option><option value="custom">Advanced custom stream ID</option></select></label>
        {streamMode === 'detected' ? <label>Detected livestream<select aria-label="Detected livestream" value={rule.conditions.livestreamId || ''} onChange={e => condition('livestreamId', e.target.value)}><option value="">Choose a stream</option>{streams.map(s => <option key={s.id} value={s.id}>{s.isLive ? 'LIVE · ' : ''}{s.title}</option>)}{rule.conditions.livestreamId && !streams.some(s => s.id === rule.conditions.livestreamId) ? <option value={rule.conditions.livestreamId}>Saved stream · {rule.conditions.livestreamId}</option> : null}</select></label> : null}
        {streamMode === 'custom' ? <label>Custom stream ID<input value={rule.conditions.livestreamId || ''} {...invalid('livestreamId')} onChange={e => condition('livestreamId', e.target.value)} /></label> : null}
      </div>{rule.conditions.livestreamId ? <p>{streams.find(s => s.id === rule.conditions.livestreamId)?.title} · Stream reference: {rule.conditions.livestreamId}</p> : streamMode !== 'any' ? <p className="event-field-error">Choose a livestream or select Any eligible livestream.</p> : <p>Matches any containing livestream. This does not select a particular live broadcast.</p>}{hint('livestreamId')}</div> : null}
      </fieldset>
      <fieldset className="event-award"><legend>Entry award</legend><div className="event-fields">
        <label>Target Wheel<select aria-label="Target Wheel" required value={rule.targetWheelId} {...invalid('targetWheelId')} onChange={e => update({ targetWheelId: e.target.value })}><option value="">Choose a Wheel</option>{wheels.map(w => <option key={w.id} value={w.id}>{w.title}{w.editing_locked || w.lifecycle === 'archived' ? ' (entry edits unavailable)' : ''}</option>)}</select>{hint('targetWheelId')}</label>
        <label>Award based on<select aria-label="Award based on" value={action.award.mode} {...invalid('awardMode')} onChange={e => award({ mode: e.target.value as ActionConfig['award']['mode'] })}><option value="fixed">{gift ? 'Purchase event' : rant ? 'Rant event' : 'Each qualifying event'}</option>{gift ? <option value="per_gift">Number of gifted subscriptions</option> : null}{rant ? <option value="per_amount">Reported currency units</option> : null}</select>{hint('awardMode')}</label>
        <label>{action.award.mode === 'per_gift' ? 'Entries per gift' : action.award.mode === 'per_amount' ? 'Entries per unit' : gift ? 'Entries per purchase' : rant ? 'Entries per Rant' : raid ? 'Entries per raid notification' : 'Entries per event'}<input aria-label={action.award.mode === 'per_gift' ? 'Entries per gift' : action.award.mode === 'per_amount' ? 'Entries per unit' : gift ? 'Entries per purchase' : rant ? 'Entries per Rant' : raid ? 'Entries per raid notification' : 'Entries per event'} type="number" min={1} max={100000} step={1} value={action.award.entriesPerUnit || ''} {...invalid('entriesPerUnit')} onChange={e => award({ entriesPerUnit: Number(e.target.value) })} />{hint('entriesPerUnit')}</label>
        {action.award.mode === 'per_amount' ? <label>Cents per complete unit<input type="number" min={1} max={100000000} step={1} value={action.award.unitCents || ''} {...invalid('unitCents')} onChange={e => award({ unitCents: Number(e.target.value) })} />{hint('unitCents')}</label> : null}
        <label>Repeat actor behavior<select aria-label="Repeat actor behavior" value={action.repeatActorPolicy} {...invalid('repeatActorPolicy')} onChange={e => update({ actionConfig: { ...action, repeatActorPolicy: e.target.value as ActionConfig['repeatActorPolicy'] }, duplicatePolicy: e.target.value })}><option value="skip">Skip if already on Wheel</option><option value="accumulate">Add new entries to existing entrant</option></select>{hint('repeatActorPolicy')}</label>
      </div>{hint('actionConfig')}<div className="event-award__preview"><span className="eyebrow">EXAMPLE · {gift ? '5 GIFTS' : rant ? '500 CENTS' : 'ONE EVENT'}</span><strong>{preview.calculation}{gift && !preview.reason ? ' to purchaser' : ''}</strong></div>
        {action.award.mode === 'per_amount' ? <p>Rumble reports integer cents; 100 cents equals one calculation unit by default. Only complete configured units award entries. No currency code is inferred.</p> : null}
        <p>Event replay protection is always enabled. This setting controls what happens when the same actor generates a different qualifying event later.</p>
        <p>1 weight unit = 1 entry/chance unit. Maximum weight: 100,000 per entrant. Existing hidden entrants remain hidden; accumulation does not reactivate them. Awards that exceed Wheel limits are rejected in full.</p>
      </fieldset>
      <label className="event-enable"><input type="checkbox" checked={action.appearance != null} onChange={e => update({ actionConfig: { ...action, appearance: e.target.checked ? {} : null } })} />Apply entrant appearance on future successful awards</label>
      {action.appearance != null ? <EntrantAppearanceControls value={action.appearance} onChange={appearance => update({ actionConfig: { ...action, appearance } })} /> : <p>Optional appearance is off. Choose components explicitly to decorate future awards.</p>}
      {rule.eventType === 'rumble.subscribe' && action.appearance != null ? <p>Subscriber decoration applies only when reported amount_cents is positive. Zero-value subscriber awards retain their existing eligibility and appearance.</p> : null}
      {action.appearance != null && readiness?.appearance === false ? <p role="status">Entrant appearance requires migration 0040. Saving checks readiness before changing this rule.</p> : null}
      {hint('appearance')}
      <label className="event-enable"><input type="checkbox" checked={rule.enabled} onChange={e => update({ enabled: e.target.checked })} />Enable on save</label><p>Enabling or changing award conditions starts a new activation boundary. Appearance-only edits preserve activation and affect future events.</p>
      <fieldset className="event-tester"><legend>Dry run — no action will be executed</legend><div className="event-fields">
        <label>Sample actor<input value={sample.actorLabel} onChange={e => { setSample({ ...sample, actorLabel: e.target.value }); setTest(null); }} /></label>
        {streamEvent ? <label>Sample message<input value={sample.text} onChange={e => { setSample({ ...sample, text: e.target.value }); setTest(null); }} /></label> : null}
        {rant || rule.eventType === 'rumble.subscribe' ? <label>Sample amount (cents)<input type="number" min={0} step={1} value={sample.amountCents} onChange={e => { setSample({ ...sample, amountCents: Number(e.target.value) }); setTest(null); }} /></label> : null}
        {gift ? <><label>Sample gifts<input type="number" min={1} step={1} value={sample.totalGifts} onChange={e => { setSample({ ...sample, totalGifts: Number(e.target.value) }); setTest(null); }} /></label><label>Sample gift type<input value={sample.giftType} onChange={e => { setSample({ ...sample, giftType: e.target.value }); setTest(null); }} /></label></> : null}
        {rule.conditions.badge ? <label>Sample badge<input value={sample.badge} onChange={e => { setSample({ ...sample, badge: e.target.value }); setTest(null); }} /></label> : null}
        {rule.conditions.livestreamId ? <label>Sample livestream<select aria-label="Sample livestream" value={sample.livestreamId} onChange={e => { setSample({ ...sample, livestreamId: e.target.value }); setTest(null); }}><option value="">No stream selected</option><option value={rule.conditions.livestreamId}>Rule's selected livestream</option></select></label> : null}
      </div><div className="event-actions"><button type="button" className="secondary-button" onClick={() => { setSample({ actorLabel: 'ExampleUser', text: raid ? RAID_TEXT : rule.conditions.exactText || 'ENTER', amountCents: 500, totalGifts: 5, giftType: rule.conditions.giftType || 'random', badge: rule.conditions.badge || '', livestreamId: rule.conditions.livestreamId || '' }); setTest(null); }}>Load redacted sample</button><button type="button" className="secondary-button" disabled={testing || busy || !valid || !canManage || (streamEvent && streamMode !== 'any' && !rule.conditions.livestreamId)} onClick={() => void dryRun()}>Test rule</button></div>
      {testError ? <p role="alert" className="event-field-error">{testError}</p> : null}
      {test ? <div className="event-test-result" role="status"><strong>{test.matched ? 'Matched' : 'No match'}</strong><p>Source: {sourceName} · {families.find(f => f[0] === rule.eventType)?.[1]}</p><p>Actor: {test.actorLabel}{gift ? ' (purchaser)' : ''}</p>{test.classification ? <p>{test.classification} | Receiving source: {test.sourceScope} | Livestream: {test.livestreamId || 'Any containing livestream'}</p> : null}<p>{test.calculation}</p><p>Repeat actor: {test.repeatActorPolicy === 'accumulate' ? 'Accumulate' : 'Skip existing'}</p><p>{test.action}</p></div> : null}
      </fieldset>
      {(!valid || (streamEvent && streamMode !== 'any' && !rule.conditions.livestreamId)) ? <p className="event-field-error" role="status">Complete the highlighted fields before saving or testing.</p> : null}
      {raid && !readiness?.raidSchema ? <p className="event-field-error" role="status">Save will check storage again. If migration 0036 is missing, it must be applied after 0035 before this rule can be stored.</p> : null}
      {Object.keys(serverErrors).length ? <div className="event-field-error" role="alert"><strong>Rule was not saved.</strong>{Object.entries(serverErrors).map(([field, message]) => <p key={field}>{message}</p>)}</div> : null}
      <button className="primary-button" disabled={busy || !canManage || !valid || (streamEvent && streamMode !== 'any' && !rule.conditions.livestreamId)} type="submit">{busy ? 'Working…' : rule.enabled ? 'Save and enable' : 'Save paused rule'}</button>
    </>}
  </form>;
}
