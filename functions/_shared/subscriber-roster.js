import { applyAutomaticAppearance } from '../../src/lib/entrant-appearance.mjs';
import { normalizeFeatureComponents } from '../../src/lib/entrant-appearance.mjs';
import { MAX_ENTRY_WEIGHT } from '../../src/lib/automation-model.mjs';
import { AuthFailure, nowIso, randomId } from './auth-core.js';
import { getSafeRumbleDiscovery, requirePollDb } from './polls-core.js';
import { automaticEntryIdentity, storedEntryIdentity } from './entrant-identity-storage.js';
import { hash, intelligenceReport, normalizeName } from './rumble-intelligence.js';
import { getWheelSettings, MAX_ENTRIES } from './wheels-core.js';

const SOURCE = /^(user|channel):[A-Za-z0-9_-]{1,180}$/;
const MODES = new Set(['add_missing', 'exact_managed']);
const QUALITY = 'qualified_live_current';
const text = (value, maximum, required = true) => {
  if (typeof value !== 'string' || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value) || (required && !value.trim())) throw new AuthFailure(400, 'subscriber_roster_invalid', 'Review the subscriber roster fields.');
  return value.trim();
};
const integer = value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_ENTRY_WEIGHT;

export function validateRosterRule(input) {
  const errors = {};
  if (typeof input?.name !== 'string' || !input.name.trim() || input.name.length > 100) errors.name = 'Enter a name of 1–100 characters.';
  if (typeof input?.sourceScope !== 'string' || !SOURCE.test(input.sourceScope.trim())) errors.sourceScope = 'Choose the detected ThirdRailify Rumble source.';
  if (typeof input?.targetWheelId !== 'string' || !input.targetWheelId.trim() || input.targetWheelId.length > 160) errors.targetWheelId = 'Choose a target Wheel.';
  if (typeof input?.enabled !== 'boolean') errors.enabled = 'Choose whether this roster is enabled.';
  if (!MODES.has(input?.syncMode)) errors.syncMode = 'Choose Add missing only or Exact managed roster.';
  if (!integer(input?.entriesPerMember)) errors.entriesPerMember = 'Enter a whole number from 1 to 100,000.';
  if ((input?.minimumQuality || QUALITY) !== QUALITY) errors.minimumQuality = 'Use qualified live current intelligence.';
  if (input?.appearance != null) { try { normalizeFeatureComponents(input.appearance); } catch (error) { errors.appearance = error.message; } }
  if (Object.keys(errors).length) { const failure = new AuthFailure(400, 'subscriber_roster_invalid', 'Review the subscriber roster fields.'); failure.issues = Object.entries(errors).map(([field, message]) => ({ field, message })); throw failure; }
  return { name: input.name.trim(), sourceScope: input.sourceScope.trim(), targetWheelId: input.targetWheelId.trim(), enabled: input.enabled,
    syncMode: input.syncMode, entriesPerMember: input.entriesPerMember, minimumQuality: QUALITY, appearance: input.appearance ?? null };
}

function projectRule(row) {
  return { id: row.id, name: row.name, sourceScope: row.source_scope, sourceLabel: row.source_label || null, targetWheelId: row.target_wheel_id,
    targetWheelTitle: row.wheel_title || 'Unavailable Wheel', targetAvailable: Boolean(row.wheel_title), targetLifecycle: row.wheel_lifecycle,
    targetLocked: Boolean(row.wheel_locked), enabled: Boolean(row.enabled), syncMode: row.sync_mode, entriesPerMember: Number(row.entries_per_member),
    minimumQuality: row.minimum_quality, appearance: row.appearance_json ? JSON.parse(row.appearance_json) : null,
    lastEvaluatedSnapshotId: row.last_evaluated_snapshot_id || null, lastRosterFingerprint: row.last_roster_fingerprint || null,
    lastSuccessfulSyncAt: row.last_successful_sync_at || null, lastResult: row.last_result || null, revision: Number(row.revision),
    counts: { eligible: Number(row.eligible), added: Number(row.added), unchanged: Number(row.unchanged), removed: Number(row.removed),
      giftedExcluded: Number(row.gifted_excluded), mixedCurrent: Number(row.mixed_current), reviewExcluded: Number(row.review_excluded), failures: Number(row.failures),
      managed: Number(row.managed_count || 0), managedWeight: Number(row.managed_weight || 0) }, updatedAt: row.updated_at };
}

async function rows(env, wheelId = '', ruleId = '') {
  return (await requirePollDb(env).prepare(`SELECT r.*,w.title wheel_title,w.lifecycle wheel_lifecycle,w.editing_locked wheel_locked,
    (SELECT COUNT(*) FROM wheel_entry_contributions c WHERE c.rule_id=r.id) managed_count,
    (SELECT COALESCE(SUM(weight),0) FROM wheel_entry_contributions c WHERE c.rule_id=r.id) managed_weight
    FROM subscriber_roster_rules r LEFT JOIN wheels w ON w.id=r.target_wheel_id
    WHERE r.deleted_at IS NULL AND (?='' OR r.target_wheel_id=?) AND (?='' OR r.id=?) ORDER BY r.created_at,r.id LIMIT 101`)
    .bind(wheelId, wheelId, ruleId, ruleId).all()).results;
}

export async function listRosterRules(env, wheelId = '', ruleId = '') {
  const db = requirePollDb(env), all = (await rows(env, wheelId, ruleId)).map(projectRule), result = all.slice(0, 100);
  const memberRows = (await db.prepare(`SELECT c.rule_id,c.entry_id,c.actor_label,c.weight,c.snapshot_id FROM wheel_entry_contributions c
    JOIN subscriber_roster_rules r ON r.id=c.rule_id WHERE r.deleted_at IS NULL AND (?='' OR c.wheel_id=?) AND (?='' OR c.rule_id=?)
    ORDER BY c.rule_id,c.actor_label,c.id LIMIT 1001`).bind(wheelId, wheelId, ruleId, ruleId).all()).results;
  const members = new Map();
  for (const member of memberRows.slice(0, 1000)) { if (!members.has(member.rule_id)) members.set(member.rule_id, []); members.get(member.rule_id).push({ entryId: member.entry_id, actorLabel: member.actor_label, weight: Number(member.weight), snapshotId: member.snapshot_id }); }
  for (const rule of result) rule.members = members.get(rule.id) || [];
  const wheels = (await requirePollDb(env).prepare('SELECT id,title,lifecycle,editing_locked FROM wheels ORDER BY title LIMIT 500').all()).results;
  const sources = new Map();
  for (const rule of result) if (!sources.has(rule.sourceScope)) sources.set(rule.sourceScope, await rosterAuthority(env, rule.sourceScope));
  const discovery = await getSafeRumbleDiscovery(env);
  if (discovery.source && !sources.has(discovery.source.scope)) sources.set(discovery.source.scope, await rosterAuthority(env, discovery.source.scope));
  return { ok: true, rules: result, wheels, discovery, authorities: Object.fromEntries(sources), list: { truncated: all.length > 100, membersTruncated: memberRows.length > 1000 } };
}

export async function saveRosterRule(env, actorId, input) {
  const db = requirePollDb(env), value = validateRosterRule(input), timestamp = nowIso();
  const wheel = await db.prepare('SELECT id FROM wheels WHERE id=?').bind(value.targetWheelId).first();
  if (!wheel) throw new AuthFailure(400, 'subscriber_roster_wheel_invalid', 'Choose an existing Wheel.');
  const prior = input.id ? await db.prepare('SELECT * FROM subscriber_roster_rules WHERE id=? AND deleted_at IS NULL').bind(input.id).first() : null;
  if (input.id && !prior) throw new AuthFailure(404, 'subscriber_roster_not_found', 'Subscriber roster automation not found.');
  if (prior && Number(input.revision) !== Number(prior.revision)) throw new AuthFailure(409, 'subscriber_roster_revision_conflict', 'The roster automation changed. Refresh before saving.');
  if (prior && (prior.source_scope !== value.sourceScope || prior.target_wheel_id !== value.targetWheelId)) {
    const managed = await db.prepare('SELECT COUNT(*) count FROM wheel_entry_contributions WHERE rule_id=?').bind(prior.id).first();
    if (Number(managed?.count || 0)) throw new AuthFailure(409, 'subscriber_roster_identity_locked', 'Remove this roster contribution before changing its Rumble source or target Wheel.');
  }
  const discovery = await getSafeRumbleDiscovery(env);
  const sourceLabel = discovery.source?.scope === value.sourceScope ? discovery.source.displayName : prior?.source_scope === value.sourceScope ? prior.source_label : null;
  const id = prior?.id || randomId();
  const statement = prior ? db.prepare(`UPDATE subscriber_roster_rules SET name=?,source_scope=?,source_label=?,target_wheel_id=?,enabled=?,sync_mode=?,entries_per_member=?,minimum_quality=?,appearance_json=?,updated_at=?,revision=revision+1
    WHERE id=? AND revision=? AND deleted_at IS NULL`).bind(value.name, value.sourceScope, sourceLabel, value.targetWheelId, Number(value.enabled), value.syncMode, value.entriesPerMember, value.minimumQuality, value.appearance ? JSON.stringify(value.appearance) : null, timestamp, id, prior.revision)
    : db.prepare(`INSERT INTO subscriber_roster_rules(id,name,source_scope,source_label,target_wheel_id,enabled,sync_mode,entries_per_member,minimum_quality,appearance_json,created_by_account_id,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM subscriber_roster_rules WHERE deleted_at IS NULL)<100`).bind(id, value.name, value.sourceScope, sourceLabel, value.targetWheelId, Number(value.enabled), value.syncMode, value.entriesPerMember, value.minimumQuality, value.appearance ? JSON.stringify(value.appearance) : null, actorId, timestamp, timestamp);
  const result = await db.batch([statement, db.prepare(`INSERT INTO poll_activity_events(id,poll_id,actor_account_id,event_type,result,metadata_json,created_at)
    SELECT ?,NULL,?,?, 'success',?,? WHERE changes()=1`).bind(randomId(), actorId, prior ? 'subscriber_roster_rule_edited' : 'subscriber_roster_rule_created', JSON.stringify({ ruleId: id }), timestamp)]);
  if (Number(result[0]?.meta?.changes) !== 1) throw new AuthFailure(409, 'subscriber_roster_revision_conflict', 'Refresh the roster automations before saving.');
  return { ok: true, rule: projectRule((await rows(env, '', id))[0]) };
}

export async function rosterAuthority(env, sourceScope) {
  const report = await intelligenceReport(env, sourceScope);
  const current = (report.accounts || []).filter(person => person.current);
  const eligible = current.filter(person => !person.needsReview && person.hasPaid).map(person => ({ name: person.name, displayName: person.displayName, avatar: person.avatar, classification: person.classification }));
  const attemptCurrent = report.current && report.attempt && (report.attempt.providerAt ? report.attempt.providerAt === report.current.providerAt : report.attempt.receivedAt >= report.current.receivedAt);
  const addAllowed = Boolean(report.current && report.current.provenance === 'live' && !report.current.reasons?.length);
  const removalAllowed = Boolean(addAllowed && report.health === 'qualified' && report.attempt?.provenance === 'live' && report.attempt?.reasons?.length === 0 && Number(report.attempt?.coverageGaps || 0) === 0 && attemptCurrent);
  const fingerprint = report.current ? await hash(['subscriber-roster-v1', sourceScope, eligible.map(person => person.name).sort()]) : null;
  return { source: sourceScope, label: report.label || sourceScope, health: report.health, current: report.current ? { id: report.current.id, providerAt: report.current.providerAt, provenance: report.current.provenance } : null,
    counts: { eligible: eligible.length, giftedExcluded: current.filter(person => !person.needsReview && !person.hasPaid && person.hasGifted).length,
      mixedCurrent: current.filter(person => !person.needsReview && person.hasPaid && person.hasGifted).length, reviewExcluded: current.filter(person => person.needsReview).length },
    eligible, fingerprint, addAllowed, removalAllowed, removalBlockReason: removalAllowed ? null : 'Removal blocked — subscriber roster is stale/degraded' };
}

async function managedRows(db, ruleId) {
  return (await db.prepare(`SELECT c.*,e.weight entry_weight,e.display_label,e.entrant_identity_json,e.state FROM wheel_entry_contributions c
    LEFT JOIN wheel_entries e ON e.id=c.entry_id AND e.wheel_id=c.wheel_id WHERE c.rule_id=? ORDER BY c.actor_key`).bind(ruleId).all()).results;
}

export async function previewRosterSync(env, ruleId) {
  const db = requirePollDb(env), row = (await rows(env, '', ruleId))[0];
  if (!row) throw new AuthFailure(404, 'subscriber_roster_not_found', 'Subscriber roster automation not found.');
  const rule = projectRule(row), authority = await rosterAuthority(env, rule.sourceScope), managed = await managedRows(db, rule.id);
  const byActor = new Map(managed.map(item => [item.actor_key, item]));
  const eligible = new Map(authority.eligible.map(person => [`rumble:${rule.sourceScope}:${person.name}`, person]));
  const added = [...eligible].filter(([actor]) => !byActor.has(actor)).map(([actorKey, person]) => ({ actorKey, ...person }));
  const updated = [...eligible].filter(([actor]) => byActor.has(actor) && Number(byActor.get(actor).weight) !== rule.entriesPerMember).map(([actorKey, person]) => ({ actorKey, ...person, entryId: byActor.get(actorKey).entry_id, previousWeight: Number(byActor.get(actorKey).weight), state: byActor.get(actorKey).state }));
  const ineligible = managed.filter(item => !eligible.has(item.actor_key));
  const removed = rule.syncMode === 'exact_managed' && authority.removalAllowed ? ineligible : [];
  const removalBlocked = rule.syncMode === 'exact_managed' && ineligible.length > 0 && !authority.removalAllowed;
  const unchanged = [...eligible].filter(([actor]) => byActor.has(actor) && !updated.some(item => item.actorKey === actor)).length;
  const failures = managed.filter(item => !item.entry_weight || !item.entrant_identity_json).length;
  return { ok: true, rule, authority, delta: { added, updated, removed, unchanged, retainedIneligible: ineligible.length - removed.length, failures }, removalBlocked,
    status: !authority.current ? 'needs_attention' : removalBlocked ? 'sync_blocked' : authority.health === 'qualified' ? 'current' : 'roster_stale' };
}

async function rosterIdentity(rule, actorKey) {
  return { version: 1, type: 'subscription', origin: 'automation', key: await hash(['subscriber-roster-entry-v1', rule.id, rule.sourceScope, actorKey]) };
}

async function existingActorEntry(entries, rule, item) {
  // Existing automation identities are cryptographic source+actor+family keys.
  // Reusing a single exact match lets event and roster contributions sum without
  // guessing from display labels or reconstructing ownership from receipts.
  const eventTypes = ['rumble.subscribe', 'rumble.rant', 'rumble.gift_purchase', 'rumble.raid.received', 'rumble.follow', 'rumble.chat.exact'];
  const keys = new Set();
  for (const eventType of eventTypes) keys.add((await automaticEntryIdentity({ sourceScope: rule.sourceScope, actorKey: item.actorKey, eventType })).key);
  const matches = entries.filter(entry => keys.has(storedEntryIdentity(entry.entrant_identity_json)?.key));
  return matches.length === 1 ? matches[0] : null;
}

async function performRosterSync(env, actorId, input) {
  const ruleId = text(input?.ruleId, 160), expectedRevision = Number(input?.revision);
  const plan = await previewRosterSync(env, ruleId), { rule, authority, delta } = plan;
  if (!rule.enabled) throw new AuthFailure(409, 'subscriber_roster_paused', 'Enable the subscriber roster automation before syncing.');
  if (!authority.current || !authority.addAllowed || !authority.fingerprint) throw new AuthFailure(409, 'subscriber_roster_unqualified', 'A qualified live Subscriber Intelligence snapshot is required.');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== rule.revision) throw new AuthFailure(409, 'subscriber_roster_revision_conflict', 'The roster automation changed. Refresh before syncing.');
  const changed = delta.added.length + delta.updated.length + delta.removed.length;
  const resultName = plan.removalBlocked ? 'removal_blocked' : changed ? 'changed' : 'no_op';
  const counts = { eligible: authority.counts.eligible, added: delta.added.length, updated: delta.updated.length, unchanged: delta.unchanged,
    removed: delta.removed.length, giftedExcluded: authority.counts.giftedExcluded, mixedCurrent: authority.counts.mixedCurrent,
    reviewExcluded: authority.counts.reviewExcluded, failures: delta.failures };
  if (!changed && !plan.removalBlocked && rule.lastEvaluatedSnapshotId === authority.current.id && rule.lastRosterFingerprint === authority.fingerprint) return { ...plan, synced: true, noOp: true, result: resultName, counts };
  const db = requirePollDb(env), wheel = await db.prepare('SELECT * FROM wheels WHERE id=?').bind(rule.targetWheelId).first();
  if (!wheel || wheel.lifecycle === 'archived' || wheel.editing_locked) throw new AuthFailure(409, 'subscriber_roster_wheel_unavailable', 'The target Wheel is unavailable for roster changes.');
  const settings = await getWheelSettings(env); const currentEntries = (await db.prepare('SELECT * FROM wheel_entries WHERE wheel_id=? ORDER BY display_order,id').bind(wheel.id).all()).results;
  const additions = [];
  for (const item of delta.added) additions.push({ ...item, existing: await existingActorEntry(currentEntries, rule, item) });
  const newEntryCount = additions.filter(item => !item.existing).length;
  if (newEntryCount && currentEntries.length + newEntryCount > Math.min(MAX_ENTRIES, settings.settings.maximumParticipants || MAX_ENTRIES)) throw new AuthFailure(409, 'subscriber_roster_capacity', 'The target Wheel does not have enough participant capacity.');
  const activeWeight = currentEntries.reduce((sum, entry) => sum + (entry.state === 'active' ? Number(entry.weight) : 0), 0);
  if (additions.some(item => item.existing && Number(item.existing.weight) + rule.entriesPerMember > MAX_ENTRY_WEIGHT)) throw new AuthFailure(409, 'subscriber_roster_weight_limit', 'A matching Wheel entrant would exceed the individual weight limit.');
  const weightDelta = additions.reduce((sum, item) => sum + (item.existing?.state === 'hidden' ? 0 : rule.entriesPerMember), 0)
    + delta.updated.reduce((sum, item) => sum + (item.state === 'hidden' ? 0 : rule.entriesPerMember - item.previousWeight), 0)
    - delta.removed.reduce((sum, item) => sum + (item.state === 'active' ? Number(item.weight) : 0), 0);
  if (activeWeight + weightDelta > 0xffffffff) throw new AuthFailure(409, 'subscriber_roster_weight_limit', 'The roster would exceed the Wheel weight limit.');
  const token = randomId(), timestamp = nowIso(); let order = currentEntries.reduce((maximum, entry) => Math.max(maximum, Number(entry.display_order)), -1);
  for (const item of additions) {
    item.identity = await rosterIdentity(rule, item.actorKey); item.entryId = item.existing?.id || randomId(); item.contributionId = randomId();
    if (!item.existing) { order += 1; item.order = order; item.appearance = rule.appearance ? applyAutomaticAppearance(null, rule.appearance, { providerEventAt: authority.current.providerAt }, item.identity.key) : null; }
  }
  const removedJson = JSON.stringify(delta.removed.map(item => ({ contributionId: item.id, entryId: item.entry_id, weight: Number(item.weight), deleteEntry: Number(item.entry_weight) === Number(item.weight) })));
  const existingJson = JSON.stringify(additions.filter(item => item.existing).map(item => ({ entryId: item.entryId })));
  const newJson = JSON.stringify(additions.filter(item => !item.existing).map(item => ({ contributionId: item.contributionId, entryId: item.entryId, actorKey: item.actorKey, actorLabel: item.displayName, order: item.order, identityJson: JSON.stringify(item.identity), avatar: item.avatar || null, appearanceJson: item.appearance ? JSON.stringify(item.appearance) : null })));
  const additionJson = JSON.stringify(additions.map(item => ({ contributionId: item.contributionId, entryId: item.entryId, actorKey: item.actorKey, actorLabel: item.displayName })));
  const updatedJson = JSON.stringify(delta.updated.map(item => ({ entryId: item.entryId, actorKey: item.actorKey, delta: rule.entriesPerMember - item.previousWeight })));
  const statements = [db.prepare(`UPDATE subscriber_roster_rules SET sync_token=?,revision=revision+1 WHERE id=? AND revision=? AND enabled=1 AND deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM wheels WHERE id=? AND revision=?)`).bind(token, rule.id, rule.revision, wheel.id, wheel.revision)];
  if (delta.removed.length) {
    statements.push(db.prepare(`UPDATE wheel_entries SET weight=weight-(SELECT json_extract(j.value,'$.weight') FROM json_each(?) j WHERE json_extract(j.value,'$.entryId')=wheel_entries.id),updated_at=?
      WHERE wheel_id=? AND id IN (SELECT json_extract(value,'$.entryId') FROM json_each(?))
      AND weight>(SELECT json_extract(j.value,'$.weight') FROM json_each(?) j WHERE json_extract(j.value,'$.entryId')=wheel_entries.id)
      AND EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(removedJson, timestamp, wheel.id, removedJson, removedJson, rule.id, token, rule.revision + 1));
    statements.push(db.prepare(`DELETE FROM wheel_entry_contributions WHERE rule_id=? AND id IN (SELECT json_extract(value,'$.contributionId') FROM json_each(?))
      AND EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(rule.id, removedJson, rule.id, token, rule.revision + 1));
    statements.push(db.prepare(`DELETE FROM wheel_entries WHERE wheel_id=? AND id IN (SELECT json_extract(value,'$.entryId') FROM json_each(?) WHERE json_extract(value,'$.deleteEntry')=1)
      AND json_extract(entrant_identity_json,'$.origin')='automation'
      AND NOT EXISTS(SELECT 1 FROM wheel_entry_contributions c WHERE c.entry_id=wheel_entries.id)
      AND EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(wheel.id, removedJson, rule.id, token, rule.revision + 1));
  }
  if (additions.some(item => item.existing)) statements.push(db.prepare(`UPDATE wheel_entries SET weight=weight+?,updated_at=? WHERE wheel_id=?
    AND id IN (SELECT json_extract(value,'$.entryId') FROM json_each(?)) AND EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(rule.entriesPerMember, timestamp, wheel.id, existingJson, rule.id, token, rule.revision + 1));
  if (additions.some(item => !item.existing)) statements.push(db.prepare(`INSERT INTO wheel_entries(id,wheel_id,display_label,display_order,weight,state,created_at,updated_at,entrant_identity_json,source_avatar_url,entrant_appearance_json)
    SELECT json_extract(value,'$.entryId'),?,json_extract(value,'$.actorLabel'),json_extract(value,'$.order'),?,'active',?,?,json_extract(value,'$.identityJson'),json_extract(value,'$.avatar'),json_extract(value,'$.appearanceJson') FROM json_each(?)
    WHERE EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(wheel.id, rule.entriesPerMember, timestamp, timestamp, newJson, rule.id, token, rule.revision + 1));
  if (additions.length) statements.push(db.prepare(`INSERT INTO wheel_entry_contributions(id,rule_id,wheel_id,entry_id,source_scope,actor_key,actor_label,contribution_type,weight,snapshot_id,created_at,updated_at)
    SELECT json_extract(value,'$.contributionId'),?,?,json_extract(value,'$.entryId'),?,json_extract(value,'$.actorKey'),json_extract(value,'$.actorLabel'),'subscriber_roster',?,?,?,? FROM json_each(?)
    WHERE EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(rule.id, wheel.id, rule.sourceScope, rule.entriesPerMember, authority.current.id, timestamp, timestamp, additionJson, rule.id, token, rule.revision + 1));
  if (delta.updated.length) {
    statements.push(db.prepare(`UPDATE wheel_entries SET weight=weight+(SELECT json_extract(j.value,'$.delta') FROM json_each(?) j WHERE json_extract(j.value,'$.entryId')=wheel_entries.id),updated_at=?
      WHERE wheel_id=? AND id IN (SELECT json_extract(value,'$.entryId') FROM json_each(?)) AND EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(updatedJson, timestamp, wheel.id, updatedJson, rule.id, token, rule.revision + 1));
    statements.push(db.prepare(`UPDATE wheel_entry_contributions SET weight=?,snapshot_id=?,updated_at=? WHERE rule_id=? AND actor_key IN (SELECT json_extract(value,'$.actorKey') FROM json_each(?))
      AND EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(rule.entriesPerMember, authority.current.id, timestamp, rule.id, updatedJson, rule.id, token, rule.revision + 1));
  }
  if (changed) statements.push(db.prepare(`UPDATE wheels SET participant_count=(SELECT COUNT(*) FROM wheel_entries WHERE wheel_id=? AND state='active'),revision=revision+1,updated_at=?
    WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(wheel.id, timestamp, wheel.id, wheel.revision, rule.id, token, rule.revision + 1));
  if (changed || plan.removalBlocked) statements.push(db.prepare(`INSERT INTO subscriber_roster_syncs(id,rule_id,snapshot_id,roster_fingerprint,outcome,counts_json,actor_account_id,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM subscriber_roster_rules WHERE id=? AND sync_token=? AND revision=?)`).bind(randomId(), rule.id, authority.current.id, authority.fingerprint, resultName, JSON.stringify(counts), actorId || null, timestamp, rule.id, token, rule.revision + 1));
  statements.push(db.prepare(`UPDATE subscriber_roster_rules SET last_evaluated_snapshot_id=?,last_roster_fingerprint=?,last_successful_sync_at=?,last_result=?,eligible=?,added=?,unchanged=?,removed=?,gifted_excluded=?,mixed_current=?,review_excluded=?,failures=?,sync_token=NULL,updated_at=?
    WHERE id=? AND sync_token=? AND revision=?`).bind(authority.current.id, authority.fingerprint, plan.removalBlocked ? rule.lastSuccessfulSyncAt : timestamp, resultName,
      counts.eligible, counts.added, counts.unchanged, counts.removed, counts.giftedExcluded, counts.mixedCurrent, counts.reviewExcluded, counts.failures,
      timestamp, rule.id, token, rule.revision + 1));
  const results = await db.batch(statements);
  if (Number(results[0]?.meta?.changes) !== 1 || Number(results.at(-1)?.meta?.changes) !== 1) throw new AuthFailure(409, 'subscriber_roster_revision_conflict', 'The Wheel or roster changed during sync. Refresh and preview again.');
  return { ...(await previewRosterSync(env, rule.id)), synced: true, noOp: !changed, result: resultName, counts };
}

export async function syncRosterRule(env, actorId, input) {
  try { return await performRosterSync(env, actorId, input); }
  catch (error) {
    if (error?.code !== 'subscriber_roster_revision_conflict' && typeof input?.ruleId === 'string') {
      try {
        const db = requirePollDb(env), timestamp = nowIso();
        const current = await db.prepare(`SELECT s.current_id FROM subscriber_roster_rules r LEFT JOIN rumble_intelligence_sources s ON s.source=r.source_scope WHERE r.id=?`).bind(input.ruleId).first();
        await db.batch([
          db.prepare("UPDATE subscriber_roster_rules SET failures=failures+1,last_result='failed',updated_at=? WHERE id=? AND deleted_at IS NULL").bind(timestamp, input.ruleId),
          db.prepare(`INSERT INTO subscriber_roster_syncs(id,rule_id,snapshot_id,roster_fingerprint,outcome,counts_json,actor_account_id,created_at)
            SELECT ?,?,?,COALESCE(last_roster_fingerprint,?), 'failed',?, ?,? FROM subscriber_roster_rules WHERE id=? AND deleted_at IS NULL AND ? IS NOT NULL`)
            .bind(randomId(), input.ruleId, current?.current_id || null, '0'.repeat(64), JSON.stringify({ error: error?.code || 'subscriber_roster_sync_failed' }), actorId || null, timestamp, input.ruleId, current?.current_id || null),
        ]);
      } catch { /* preserve the original sync failure */ }
    }
    throw error;
  }
}

export async function syncEnabledRosterRulesForSnapshot(env, sourceScope) {
  const active = (await rows(env)).filter(row => row.enabled && row.source_scope === sourceScope);
  const results = [];
  for (const row of active) {
    try { results.push(await syncRosterRule(env, null, { ruleId: row.id, revision: Number(row.revision) })); }
    catch (error) { results.push({ ok: false, ruleId: row.id, error: error?.code || 'subscriber_roster_sync_failed' }); }
  }
  return results;
}

export async function assertManagedEntriesPreserved(db, wheelId, requestedEntries) {
  const managed = (await db.prepare('SELECT entry_id,SUM(weight) weight FROM wheel_entry_contributions WHERE wheel_id=? GROUP BY entry_id').bind(wheelId).all()).results;
  if (!managed.length) return;
  const requested = new Map(requestedEntries.map(entry => [entry.id, entry]));
  if (managed.some(item => !requested.has(item.entry_id) || Number(requested.get(item.entry_id).weight) < Number(item.weight))) throw new AuthFailure(409, 'subscriber_roster_entry_managed', 'Subscriber roster membership and its minimum owned weight are managed by Automations. Preview or sync the roster instead.');
}
