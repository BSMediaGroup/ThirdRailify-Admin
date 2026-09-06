import { AuthFailure, nowIso, randomId } from './auth-core.js';
import { requirePollDb } from './polls-core.js';
import { executeAutomationWheelEntry } from './wheels-core.js';
import { invalid, matches, validateEvent, validateRule } from './automation-contract.js';
import { normalizePollTrigger } from './poll-normalization.js';

export function projectRule(row) {
  return { id: row.id, name: row.name, description: row.description, enabled: Boolean(row.enabled), sourceScope: row.source_scope,
    eventType: row.event_type, conditions: JSON.parse(row.conditions_json), actionType: row.action_type, targetWheelId: row.target_wheel_id,
    targetWheelTitle: row.wheel_title || 'Unavailable Wheel', duplicatePolicy: row.duplicate_policy, revision: row.revision, activatedAt: row.activated_at,
    updatedAt: row.updated_at, counters: { matched: row.matched, executed: row.executed, duplicateEvents: row.duplicate_events,
      duplicateEntrants: row.duplicate_entrants, rejected: row.rejected, failed: row.failed }, lastMatchAt: row.last_match_at, lastOutcome: row.last_outcome, lastFault: row.last_fault };
}
export async function listAutomationRules(env, wheelId = '') {
  const db = requirePollDb(env);
  const rows = await db.prepare(`SELECT r.*, w.title AS wheel_title FROM automation_rules r LEFT JOIN wheels w ON w.id=r.target_wheel_id
    WHERE r.deleted_at IS NULL AND (?='' OR r.target_wheel_id=?) ORDER BY r.updated_at DESC LIMIT 200`).bind(wheelId, wheelId).all();
  const wheels = await db.prepare("SELECT id,title,lifecycle,editing_locked FROM wheels ORDER BY title LIMIT 500").all();
  const activity = await db.prepare(`SELECT a.id,a.rule_id,a.actor_label,a.outcome,a.created_at FROM automation_receipts a
    WHERE (?='' OR a.target_wheel_id=?) ORDER BY a.created_at DESC LIMIT 40`).bind(wheelId, wheelId).all();
  return { ok: true, rules: rows.results.map(projectRule), wheels: wheels.results, activity: activity.results };
}
export async function botAutomationRules(env) {
  const rows = await requirePollDb(env).prepare(`SELECT * FROM automation_rules WHERE enabled=1 AND deleted_at IS NULL AND target_wheel_id IS NOT NULL ORDER BY id LIMIT 201`).all();
  if (rows.results.length > 200) throw new AuthFailure(503, 'automation_projection_limit', 'Rule projection exceeds its limit.');
  return { ok: true, rules: rows.results.map(row => { const r = projectRule(row); return { id: r.id, revision: r.revision, activatedAt: r.activatedAt,
    sourceScope: r.sourceScope, eventType: r.eventType, conditions: r.conditions, actionType: r.actionType, targetWheelId: r.targetWheelId, duplicatePolicy: r.duplicatePolicy }; }), fetchedAt: nowIso() };
}
export async function saveAutomationRule(env, actorId, input) {
  const db = requirePollDb(env), rule = validateRule(input), timestamp = nowIso();
  const wheel = await db.prepare('SELECT id FROM wheels WHERE id=?').bind(rule.targetWheelId).first();
  if (!wheel) throw new AuthFailure(404, 'wheel_not_found', 'Choose an existing Wheel.');
  const id = input.id || randomId();
  const prior = input.id ? await db.prepare('SELECT * FROM automation_rules WHERE id=? AND deleted_at IS NULL').bind(id).first() : null;
  if (input.id && !prior) throw new AuthFailure(404, 'automation_not_found', 'This rule no longer exists.');
  if (prior && input.revision !== prior.revision) throw new AuthFailure(409, 'automation_revision_conflict', 'The rule changed. Refresh before saving.');
  // Every semantic edit creates a fresh boundary, including edits while enabled.
  const activated = rule.enabled ? timestamp : null;
  const values = [rule.name, rule.description, Number(rule.enabled), rule.sourceScope, rule.eventType, JSON.stringify(rule.conditions), rule.targetWheelId, activated, timestamp];
  const statement = prior ? db.prepare(`UPDATE automation_rules SET name=?,description=?,enabled=?,source_scope=?,event_type=?,conditions_json=?,target_wheel_id=?,activated_at=?,updated_at=?,revision=revision+1
    WHERE id=? AND revision=? AND deleted_at IS NULL`).bind(...values, id, prior.revision)
    : db.prepare(`INSERT INTO automation_rules(name,description,enabled,source_scope,event_type,conditions_json,target_wheel_id,activated_at,updated_at,id,created_by_account_id,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM automation_rules WHERE deleted_at IS NULL)<200`).bind(...values, id, actorId, timestamp);
  const result = await db.batch([statement, db.prepare(`INSERT INTO poll_activity_events(id,poll_id,actor_account_id,event_type,result,metadata_json,created_at)
    SELECT ?,NULL,?,?, 'success',?,? WHERE changes()=1`).bind(randomId(), actorId, prior ? 'automation_rule_edited' : 'automation_rule_created', JSON.stringify({ ruleId: id, enabled: rule.enabled, revision: (prior?.revision || 0) + 1 }), timestamp)]);
  if (result[0].meta.changes !== 1) throw new AuthFailure(409, 'automation_revision_conflict', 'Refresh the rules; the revision or 200-rule limit changed.');
  return { ok: true, rule: projectRule(await db.prepare('SELECT * FROM automation_rules WHERE id=?').bind(id).first()) };
}
export async function deleteAutomationRule(env, actorId, input) {
  if (input.confirm !== 'DELETE') invalid('automation_delete_confirmation', 'Confirm rule deletion.');
  const db = requirePollDb(env), timestamp = nowIso();
  const result = await db.batch([
    db.prepare('UPDATE automation_rules SET enabled=0,deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND deleted_at IS NULL').bind(timestamp, timestamp, input.id, input.revision),
    db.prepare(`INSERT INTO poll_activity_events(id,poll_id,actor_account_id,event_type,result,metadata_json,created_at)
      SELECT ?,NULL,?,'automation_rule_deleted','success',?,? WHERE changes()=1`).bind(randomId(), actorId, JSON.stringify({ ruleId: input.id }), timestamp),
  ]);
  if (result[0].meta.changes !== 1) throw new AuthFailure(409, 'automation_revision_conflict', 'The rule changed or was deleted.');
  return { ok: true };
}
export function dryRunAutomation(input) {
  const rule = validateRule(input.rule), sample = input.sample || {};
  const actorLabel = typeof sample.actorLabel === 'string' ? sample.actorLabel.trim().slice(0, 120) : 'Sample Viewer';
  const normalizedText = normalizePollTrigger(String(sample.text || '').slice(0, 500));
  const event = { eventType: rule.eventType, sourceScope: rule.sourceScope, livestreamId: sample.livestreamId || '', evidence: {
    normalizedText, amountCents: Number(sample.amountCents || 0), totalGifts: Number(sample.totalGifts || 0), giftType: String(sample.giftType || ''), badges: String(sample.badge || '').split(',').map(s => s.trim()) } };
  return { ok: true, dryRun: true, matched: Boolean(actorLabel) && matches(rule, event), normalizedText,
    actorKey: `rumble:${rule.sourceScope}:${normalizePollTrigger(actorLabel)}`, actorLabel, action: 'One add attempt; skip an existing entrant. No action will be executed.' };
}
export async function ingestAutomationEvents(env, input) {
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 50) invalid('automation_batch_invalid');
  const db = requirePollDb(env), results = [];
  for (const item of input.events) {
    let event;
    try { event = validateEvent(item); } catch { results.push({ ruleId: item?.ruleId, eventFingerprint: item?.eventFingerprint, outcome: 'invalid_event' }); continue; }
    const row = await db.prepare('SELECT * FROM automation_rules WHERE id=?').bind(event.ruleId).first();
    let outcome;
    if (!row || row.deleted_at || !row.enabled) outcome = 'inactive_rule';
    else if (row.revision !== event.ruleRevision) outcome = 'stale_revision';
    else if (!Number.isFinite(Date.parse(row.activated_at)) || Date.parse(event.providerEventAt) < Date.parse(row.activated_at)) outcome = 'before_activation';
    else if (!matches(projectRule(row), event)) outcome = 'condition_rejected';
    if (outcome) {
      if (row) await db.batch([
        db.prepare('UPDATE automation_rules SET rejected=rejected+1,last_fault=? WHERE id=?').bind(outcome, row.id),
        db.prepare(`INSERT INTO poll_activity_events(id,poll_id,actor_account_id,event_type,result,metadata_json,created_at)
          VALUES (?,NULL,NULL,'automation_event_rejected',?,?,?)`).bind(randomId(), outcome, JSON.stringify({ ruleId: row.id, ruleRevision: event.ruleRevision }), nowIso()),
      ]);
    } else outcome = await executeAutomationWheelEntry(env, row, event);
    results.push({ ruleId: event.ruleId, eventFingerprint: event.eventFingerprint, outcome });
  }
  return { ok: true, results, refreshRules: results.some(r => ['inactive_rule', 'stale_revision'].includes(r.outcome)) };
}
