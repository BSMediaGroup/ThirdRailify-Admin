import { AuthFailure, nowIso, randomId } from './auth-core.js';
import { normalizePollTrigger } from './poll-normalization.js';

export const PAID_PROTOCOL = 2;
export const DEFAULT_POLL_POLICY = Object.freeze({ rantEnabled: false, giftEnabled: false, centsPerVote: 100, votesPerGift: 5, maxMessages: 3, timeoutSeconds: 300 });
const dbFor = env => env.THIRDRAILIFY_COMMERCE_DB;
const fail = (code, message, status = 400) => { throw new AuthFailure(status, code, message); };
const rows = async statement => (await statement.all()).results || [];
const parse = value => JSON.parse(value);
export async function paidSchema(env, required = true) {
  const found = await dbFor(env).prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name IN ('poll_credit_guards','poll_credit_lifecycle','poll_credit_allocation_guard','poll_credit_review_audit','poll_credit_structure_update')").first();
  const ready = found?.count === 5;
  if (!ready && required) fail('poll_credit_schema_required', 'Poll matchups and credits require the complete reviewed migration 0041 before saving.', 503);
  return ready;
}
export function validatePolicy(input) {
  const value = { ...DEFAULT_POLL_POLICY, ...input };
  if (typeof value.rantEnabled !== 'boolean' || typeof value.giftEnabled !== 'boolean' || ![1, 2, 3].includes(value.maxMessages)
    || !Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 60 || value.timeoutSeconds > 1800
    || value.centsPerVote !== 100 || value.votesPerGift !== 5) fail('poll_policy_invalid', 'Use 1, 2 or 3 messages and a waiting timeout from 60 to 1800 seconds.');
  return Object.fromEntries(Object.keys(DEFAULT_POLL_POLICY).map(key => [key, value[key]]));
}
export function matchPaidTrigger(text, options, rant = false) {
  const normalized = normalizePollTrigger(text);
  return options.filter(option => {
    const trigger = option.normalizedTrigger;
    if (typeof trigger !== 'string' || !trigger || trigger.length > 64) return false;
    if (!rant) return normalized === trigger;
    let offset = normalized.indexOf(trigger);
    while (offset >= 0) {
      const before = Array.from(normalized.slice(0, offset)).at(-1) || '';
      const after = Array.from(normalized.slice(offset + trigger.length))[0] || '';
      if (!/[\p{L}\p{N}\p{M}_]/u.test(before) && !/[\p{L}\p{N}\p{M}_]/u.test(after)) return true;
      offset = normalized.indexOf(trigger, offset + 1);
    }
    return false;
  }).map(option => option.id);
}
export function earnedVotes(kind, evidence) {
  const quantity = kind === 'gift' ? evidence.totalGifts : evidence.amountCents;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 100000000) fail('poll_paid_amount_invalid', 'A bounded non-negative integer provider amount is required.');
  return kind === 'gift' ? quantity * 5 : Math.floor(quantity / 100);
}
function guard(db, table, id, revision) {
  const token = randomId();
  return [db.prepare(`INSERT INTO poll_credit_guards(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=? AND revision=?) THEN 1 ELSE 0 END)`).bind(token, id, revision), db.prepare('DELETE FROM poll_credit_guards WHERE id=?').bind(token)];
}
async function atomic(db, statements) {
  try { await db.batch(statements); }
  catch (error) {
    if (/CHECK constraint failed: valid|UNIQUE constraint/i.test(String(error))) fail('poll_credit_conflict', 'This credit or policy changed. Refresh and retry.', 409);
    throw error;
  }
}
export async function savePollPolicy(env, actor, input) {
  await paidSchema(env);
  const db = dbFor(env), policy = validatePolicy(input.policy), timestamp = nowIso();
  const poll = await db.prepare('SELECT * FROM polls WHERE id=?').bind(String(input.pollId || '')).first();
  if (!poll) fail('poll_not_found', 'Choose an existing Poll.', 404);
  const current = await db.prepare('SELECT * FROM poll_voting_policies WHERE poll_id=?').bind(poll.id).first();
  if (input.revision !== (current?.revision || 0)) fail('poll_policy_conflict', 'Reload the current Poll policy.', 409);
  // Changes end the previous window; the next Bot config read creates a new frozen window.
  const statements = [db.prepare("UPDATE poll_voting_windows SET ended_at=?,revision=revision+1 WHERE poll_id=? AND ended_at IS NULL").bind(timestamp, poll.id)];
  if (current) {
    const token = randomId();
    statements.unshift(db.prepare('INSERT INTO poll_credit_guards VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM poll_voting_policies WHERE poll_id=? AND revision=?) THEN 1 ELSE 0 END)').bind(token, poll.id, current.revision));
    statements.push(db.prepare('UPDATE poll_voting_policies SET revision=revision+1,policy_json=?,updated_at=?,updated_by=? WHERE poll_id=?').bind(JSON.stringify(policy), timestamp, actor, poll.id), db.prepare('DELETE FROM poll_credit_guards WHERE id=?').bind(token));
  } else statements.push(db.prepare('INSERT INTO poll_voting_policies VALUES (?,1,?,?,?)').bind(poll.id, JSON.stringify(policy), timestamp, actor));
  await atomic(db, statements);
  return { ok: true, revision: (current?.revision || 0) + 1, policy };
}
export async function activePaidContext(env, poll, options) {
  if (!await paidSchema(env, false)) return null;
  const db = dbFor(env), saved = await db.prepare('SELECT * FROM poll_voting_policies WHERE poll_id=?').bind(poll.id).first();
  if (!saved) return null;
  const policy = parse(saved.policy_json);
  if (!policy.rantEnabled && !policy.giftEnabled) return null;
  let window = await db.prepare('SELECT * FROM poll_voting_windows WHERE poll_id=? AND ended_at IS NULL').bind(poll.id).first();
  if (!window) {
    const timestamp = nowIso(), id = `pcw_${randomId()}`;
    await db.prepare(`INSERT OR IGNORE INTO poll_voting_windows(id,poll_id,source_scope,opened_at,policy_revision,policy_json,options_json,livestream_id,stream_mode,created_at)
      SELECT ?,p.id,p.rumble_source_scope,?,?,?,?,p.rumble_livestream_id,p.rumble_livestream_mode,? FROM polls p JOIN poll_voting_policies v ON v.poll_id=p.id
      WHERE p.id=? AND p.state='open' AND p.rumble_enabled=1 AND v.revision=?`).bind(id, timestamp, saved.revision, saved.policy_json, JSON.stringify(options.map(o => ({ id: o.id, normalizedTrigger: o.normalizedTrigger }))), timestamp, poll.id, saved.revision).run();
    window = await db.prepare('SELECT * FROM poll_voting_windows WHERE poll_id=? AND ended_at IS NULL').bind(poll.id).first();
  }
  if (!window) return null;
  await expirePollCredits(env);
  const pending = await rows(db.prepare('SELECT DISTINCT actor_key FROM poll_credit_lots WHERE window_id=? AND waiting>0 LIMIT 501').bind(window.id));
  if (pending.length > 500) fail('poll_credit_backlog', 'Pending purchaser projection exceeds its safe bound.', 503);
  return { protocol: PAID_PROTOCOL, windowId: window.id, activatedAt: window.opened_at, policyRevision: window.policy_revision,
    policy: parse(window.policy_json), options: parse(window.options_json), pendingActors: pending.map(r => r.actor_key), streamAssociation: 'source_scoped_single_active_poll' };
}
export async function expirePollCredits(env) {
  if (!await paidSchema(env, false)) return;
  const timestamp = nowIso();
  await dbFor(env).prepare(`UPDATE poll_credit_lots SET unreconciled=unreconciled+waiting,waiting=0,reason='timeout',revision=revision+1,updated_at=? WHERE id IN (SELECT id FROM poll_credit_lots WHERE waiting>0 AND expires_at<=? LIMIT 200)`).bind(timestamp, timestamp).run();
}
async function resetCreditFilter(env, prefix = '') {
  return await dbFor(env).prepare("SELECT 1 FROM sqlite_master WHERE name='poll_result_history'").first() ? ` AND ${prefix}window_id NOT IN (SELECT window_id FROM poll_reset_windows)` : '';
}
export async function creditProjection(env, pollId) {
  if (!await paidSchema(env, false)) return null;
  const db = dbFor(env), totals = await db.prepare('SELECT COALESCE(SUM(waiting),0) waiting,COALESCE(SUM(unreconciled),0) review,COALESCE(SUM(committed),0) committed,COALESCE(SUM(discarded),0) discarded FROM poll_credit_lots WHERE poll_id=?' + await resetCreditFilter(env)).bind(pollId).first();
  return { waiting: totals.waiting, review: totals.review, unresolved: totals.waiting + totals.review, committed: totals.committed, settled: totals.waiting + totals.review === 0 };
}
export async function bonusOptions(env, pollId) {
  if (!await paidSchema(env, false)) return new Map();
  return new Map((await rows(dbFor(env).prepare('SELECT a.option_id,SUM(a.amount) votes FROM poll_credit_allocations a JOIN poll_credit_lots l ON l.id=a.lot_id WHERE l.poll_id=?' + await resetCreditFilter(env, 'l.') + ' GROUP BY a.option_id').bind(pollId))).map(r => [r.option_id, r.votes]));
}
export async function publicPollPolicy(env, pollId) {
  if (!await paidSchema(env, false)) return null;
  const row = await dbFor(env).prepare('SELECT revision,policy_json FROM poll_voting_policies WHERE poll_id=?').bind(pollId).first();
  return { revision: row?.revision || 0, policy: row ? parse(row.policy_json) : DEFAULT_POLL_POLICY };
}
function balances(lot) { return { committed: lot.committed, waiting: lot.waiting, unreconciled: lot.unreconciled, discarded: lot.discarded, attempts: lot.attempts_used }; }
function review(lot, reason) { if (lot.waiting) { lot.unreconciled += lot.waiting; lot.waiting = 0; lot.reason = reason; } }
function auditStatement(db, lot, before, action, reason, actor = null, id = randomId()) {
  return db.prepare('INSERT INTO poll_credit_audit VALUES (?,?,?,?,?,?,?,?)').bind(id, lot.id, actor, action, reason, JSON.stringify(before), JSON.stringify(balances(lot)), nowIso());
}
function allocationStatement(db, lot, optionId, amount, reason, actor = null) {
  return db.prepare('INSERT INTO poll_credit_allocations VALUES (?,?,?,?,?,?,?)').bind(randomId(), lot.id, optionId, amount, actor, reason, nowIso());
}
function updateLot(db, lot) {
  return db.prepare('UPDATE poll_credit_lots SET committed=?,waiting=?,unreconciled=?,discarded=?,attempts_used=?,reason=?,revision=revision+1,updated_at=? WHERE id=?')
    .bind(lot.committed, lot.waiting, lot.unreconciled, lot.discarded, lot.attempts_used, lot.reason, nowIso(), lot.id);
}
function validateEvidence(event, window) {
  if (!event || !/^[a-f0-9]{64}$/.test(event.eventFingerprint || '') || event.sourceScope !== window.source_scope
    || !['rumble.chat.exact', 'rumble.rant', 'rumble.gift_purchase'].includes(event.eventType)) fail('poll_paid_evidence_invalid', 'Invalid Poll event evidence.');
  if (!Number.isFinite(Date.parse(event.providerEventAt)) || Date.parse(event.providerEventAt) > Date.now() + 300000) fail('poll_paid_time_invalid', 'Invalid provider event time.');
  const actorLabel = typeof event.actorLabel === 'string' && event.actorLabel.length <= 120 ? event.actorLabel.trim() : '';
  const actorKey = actorLabel ? `rumble:${window.source_scope}:${normalizePollTrigger(actorLabel)}` : null;
  if (actorKey && event.actorKey !== actorKey) fail('poll_paid_actor_invalid', 'Purchaser identity does not match the source-scoped label.');
  const evidence = event.evidence || {};
  if (event.eventType === 'rumble.gift_purchase' && (!Number.isSafeInteger(evidence.videoId) || evidence.videoId < 0 || typeof evidence.giftType !== 'string' || !evidence.giftType || evidence.giftType.length > 160)) fail('poll_gift_evidence_invalid', 'Confirmed gift type and video evidence are required.');
  if (event.eventType !== 'rumble.gift_purchase' && (typeof evidence.normalizedText !== 'string' || evidence.normalizedText.length > 4000)) fail('poll_paid_text_invalid', 'Bounded matching evidence is required.');
  return { ...event, actorKey, actorLabel: actorLabel || null, providerEventAt: new Date(event.providerEventAt).toISOString(),
    evidence: { ...(typeof evidence.normalizedText === 'string' ? { normalizedText: normalizePollTrigger(evidence.normalizedText) } : {}),
      ...(event.eventType === 'rumble.rant' ? { amountCents: evidence.amountCents } : {}),
      ...(event.eventType === 'rumble.gift_purchase' ? { totalGifts: evidence.totalGifts, videoId: evidence.videoId, giftType: evidence.giftType } : {}) } };
}
export async function ingestPaidSnapshot(env, input) {
  await paidSchema(env);
  if (input.protocol !== PAID_PROTOCOL || !/^[a-f0-9]{64}$/.test(input.fingerprint || '') || !Array.isArray(input.events) || input.events.length > 200) fail('poll_paid_protocol_required', 'Poll evidence protocol 2 is required.');
  const db = dbFor(env), window = await db.prepare('SELECT * FROM poll_voting_windows WHERE id=?').bind(String(input.windowId || '')).first();
  if (!window) fail('poll_paid_context_unknown', 'Original Poll window cannot be established; evidence must remain in the outbox.', 409);
  if (await resetCreditFilter(env) && await db.prepare('SELECT 1 FROM poll_reset_windows WHERE window_id=?').bind(window.id).first()) return { ok:true,acknowledged:[input.fingerprint],historical:true };
  if (await db.prepare('SELECT 1 FROM poll_credit_batches WHERE fingerprint=?').bind(input.fingerprint).first()) return { ok: true, acknowledged: [input.fingerprint], duplicate: true };
  const poll = await db.prepare('SELECT * FROM polls WHERE id=?').bind(window.poll_id).first();
  const policy = parse(window.policy_json), options = parse(window.options_json), timestamp = nowIso();
  const events = input.events.map(e => validateEvidence(e, window)).sort((a, b) => a.providerEventAt.localeCompare(b.providerEventAt));
  const stored = await rows(db.prepare('SELECT * FROM poll_credit_lots WHERE window_id=? AND waiting>0 LIMIT 501').bind(window.id));
  if (stored.length > 500) fail('poll_credit_backlog', 'Pending ledger exceeds the processing bound.', 503);
  const [start, end] = guard(db, 'poll_voting_windows', window.id, window.revision), statements = [start];
  const lots = stored.map(l => ({ ...l })), originals = new Map(stored.map(l => [l.id, balances(l)]));
  for (const lot of stored) { const [a, b] = guard(db, 'poll_credit_lots', lot.id, lot.revision); statements.push(a, b); }
  const fingerprints = events.map(e => e.eventFingerprint);
  const knownMessages = new Set();
  // Stay below D1's bound-parameter limit even at the 200-event envelope limit.
  for (let offset = 0; offset < fingerprints.length; offset += 80) {
    const chunk = fingerprints.slice(offset, offset + 80);
    for (const row of await rows(db.prepare(`SELECT fingerprint FROM poll_credit_messages WHERE window_id=? AND fingerprint IN (${chunk.map(() => '?').join(',')})`).bind(window.id, ...chunk))) knownMessages.add(row.fingerprint);
  }
  const equalTimes = new Map();
  for (const e of events) if (e.actorKey && e.eventType === 'rumble.chat.exact' && !knownMessages.has(e.eventFingerprint)) {
    const key = `${e.actorKey}|${e.providerEventAt}`; const group = equalTimes.get(key) || new Set(); group.add(e.eventFingerprint); equalTimes.set(key, group);
  }
  for (const event of events) {
    if (event.providerEventAt < window.opened_at || (window.ended_at && event.providerEventAt > window.ended_at)) continue;
    const gift = event.eventType === 'rumble.gift_purchase', rant = event.eventType === 'rumble.rant';
    const matches = gift ? [] : matchPaidTrigger(event.evidence.normalizedText, options, rant);
    const streamMismatch = !gift && (!event.livestreamId || (window.stream_mode === 'exact' && event.livestreamId !== window.livestream_id));
    if (gift || rant) {
      if (!(gift ? policy.giftEnabled : policy.rantEnabled) || (rant && !matches.length)) continue;
      const earned = earnedVotes(gift ? 'gift' : 'rant', event.evidence);
      if (!earned || await db.prepare('SELECT 1 FROM poll_credit_lots WHERE event_fingerprint=?').bind(event.eventFingerprint).first() || lots.some(l => l.event_fingerprint === event.eventFingerprint)) continue;
      const lot = { id: `pcl_${randomId()}`, event_fingerprint: event.eventFingerprint, poll_id: poll.id, window_id: window.id, kind: gift ? 'gift' : 'rant',
        source_scope: window.source_scope, livestream_id: event.livestreamId || null, actor_key: event.actorKey, actor_label: event.actorLabel, provider_event_at: event.providerEventAt,
        evidence_json: JSON.stringify(event.evidence), policy_json: window.policy_json, earned, committed: 0, waiting: earned, unreconciled: 0, discarded: 0, attempts_used: 0,
        max_messages: policy.maxMessages, expires_at: new Date(Date.parse(event.providerEventAt) + policy.timeoutSeconds * 1000).toISOString(), reason: null, revision: 1 };
      if (!event.actorKey) review(lot, 'purchaser_identity_missing');
      else if (window.ended_at || poll.state !== 'open') review(lot, 'late_preclose_evidence');
      else if (input.streamEnded === true) review(lot, 'stream_ended');
      else if (streamMismatch || (gift && input.streamAssociation !== 'source_scoped_single_active_poll')) review(lot, 'stream_context_uncertain');
      else if (window.observed_through && event.providerEventAt <= window.observed_through) review(lot, 'late_event_history');
      else if (rant && matches.length > 1) review(lot, 'multiple_option_triggers');
      else if (gift && equalTimes.has(`${event.actorKey}|${event.providerEventAt}`)) review(lot, 'ordering_ambiguous');
      else if (input.coverageGap) review(lot, 'provider_history_gap');
      // Paid Rants allocate only bonus units; no ordinary row is invented.
      if (rant && lot.waiting) { lot.committed = lot.waiting; lot.waiting = 0; }
      const keys = Object.keys(lot);
      statements.push(db.prepare(`INSERT INTO poll_credit_lots(${keys.join(',')},created_at,updated_at) VALUES (${keys.map(() => '?').join(',')},?,?)`).bind(...Object.values(lot), timestamp, timestamp));
      if (lot.committed) statements.push(allocationStatement(db, lot, matches[0], lot.committed, 'matching_rant'));
      statements.push(auditStatement(db, lot, { earned: 0 }, 'earned', lot.reason || 'provider_event'));
      lots.push(lot); originals.set(lot.id, balances(lot));
      continue;
    }
    if (knownMessages.has(event.eventFingerprint) || !event.actorKey || streamMismatch) continue;
    const eligible = lots.filter(l => l.kind === 'gift' && l.actor_key === event.actorKey && l.waiting && l.provider_event_at <= event.providerEventAt);
    if (!eligible.length) continue; // No unrelated chat archive.
    knownMessages.add(event.eventFingerprint);
    statements.push(db.prepare('INSERT INTO poll_credit_messages VALUES (?,?,?,?,?,?)').bind(window.id, event.eventFingerprint, event.actorKey, event.providerEventAt, matches.length === 1 ? matches[0] : null, JSON.stringify(event.evidence)));
    for (const lot of eligible) {
      if (window.ended_at || poll.state !== 'open' || input.streamEnded === true) { review(lot, 'window_ended'); continue; }
      if (input.coverageGap) { review(lot, 'provider_history_gap'); continue; }
      if (event.providerEventAt === lot.provider_event_at || equalTimes.get(`${event.actorKey}|${event.providerEventAt}`)?.size > 1) { review(lot, 'ordering_ambiguous'); continue; }
      if (window.observed_through && event.providerEventAt <= window.observed_through) { review(lot, 'late_message_history'); continue; }
      if (event.providerEventAt > lot.expires_at) { review(lot, 'timeout'); continue; }
      lot.attempts_used += 1;
      statements.push(db.prepare('INSERT INTO poll_credit_attempts VALUES (?,?,?)').bind(lot.id, event.eventFingerprint, timestamp));
      if (matches.length === 1) { const amount = lot.waiting; lot.committed += amount; lot.waiting = 0; statements.push(allocationStatement(db, lot, matches[0], amount, 'gift_followup')); }
      else if (lot.attempts_used >= lot.max_messages) review(lot, 'message_allowance_exhausted');
    }
  }
  for (const lot of lots) {
    if (input.streamEnded === true) review(lot, 'stream_ended');
    else if (input.coverageGap === true) review(lot, 'provider_history_gap');
    else if (lot.expires_at <= timestamp) review(lot, 'timeout');
    if (JSON.stringify(originals.get(lot.id)) !== JSON.stringify(balances(lot))) statements.push(updateLot(db, lot), auditStatement(db, lot, originals.get(lot.id), 'automatic_transition', lot.reason || 'gift_followup'));
  }
  const through = events.at(-1)?.providerEventAt || window.observed_through;
  statements.push(db.prepare('UPDATE poll_voting_windows SET revision=revision+1,observed_through=CASE WHEN observed_through IS NULL OR observed_through<? THEN ? ELSE observed_through END,ended_at=CASE WHEN ?=1 THEN COALESCE(ended_at,?) ELSE ended_at END WHERE id=?').bind(through, through, input.streamEnded === true ? 1 : 0, timestamp, window.id),
    db.prepare('INSERT INTO poll_credit_batches VALUES (?,?,?)').bind(input.fingerprint, window.id, timestamp), end);
  await atomic(db, statements);
  return { ok: true, acknowledged: [input.fingerprint] };
}
export async function reconcilePollCredit(env, actor, input) {
  await paidSchema(env);
  const db = dbFor(env);
  if (!actor || !/^[A-Za-z0-9_-]{8,180}$/.test(input.requestId || '') || !Number.isSafeInteger(input.amount) || input.amount < 1
    || !['allocate', 'discard', 'correct'].includes(input.action) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) fail('poll_reconciliation_invalid', 'Provide a positive amount, action and audit reason.');
  const prior = await db.prepare('SELECT * FROM poll_credit_audit WHERE id=?').bind(input.requestId).first();
  if (prior) {
    if (prior.lot_id !== input.lotId || prior.actor_account_id !== actor) fail('poll_credit_conflict', 'This request ID was already used.', 409);
    return { ok: true, repeated: true };
  }
  const lot = await db.prepare('SELECT * FROM poll_credit_lots WHERE id=?').bind(input.lotId).first();
  if (await resetCreditFilter(env) && await db.prepare('SELECT 1 FROM poll_reset_credit_lots WHERE lot_id=?').bind(input.lotId).first()) fail('poll_credit_historical', 'These credits belong to a saved result history.', 409);
  if (!lot || lot.revision !== input.revision) fail('poll_credit_conflict', 'Reload the current credit balance.', 409);
  if (input.action !== 'correct' && input.amount > lot.waiting + lot.unreconciled) fail('poll_credit_overallocation', 'The amount exceeds the unresolved balance.', 409);
  const [start, end] = guard(db, 'poll_credit_lots', lot.id, lot.revision), before = balances(lot), statements = [start];
  if (input.action === 'correct') {
    if (!input.fromOptionId || input.fromOptionId === input.optionId) fail('poll_correction_invalid', 'Choose the original and corrected options.');
    statements.push(allocationStatement(db, lot, input.fromOptionId, -input.amount, input.reason, actor), allocationStatement(db, lot, input.optionId, input.amount, input.reason, actor), updateLot(db, lot), auditStatement(db, lot, before, 'correct_allocation', input.reason, actor, input.requestId), end);
    await atomic(db, statements);
    return { ok: true, balance: balances(lot), revision: lot.revision + 1 };
  }
  const fromReview = Math.min(lot.unreconciled, input.amount); lot.unreconciled -= fromReview; lot.waiting -= input.amount - fromReview;
  if (input.action === 'allocate') { lot.committed += input.amount; statements.push(allocationStatement(db, lot, input.optionId, input.amount, input.reason, actor)); }
  else lot.discarded += input.amount;
  // Remaining balances require deliberate review after manual intervention.
  review(lot, 'partially_reconciled');
  statements.push(updateLot(db, lot), auditStatement(db, lot, before, input.action, input.reason, actor, input.requestId), end);
  await atomic(db, statements);
  return { ok: true, balance: balances(lot), revision: lot.revision + 1 };
}
export async function pollVotingAdmin(env, filter = {}) {
  await paidSchema(env); await expirePollCredits(env);
  const db = dbFor(env);
  const policies = await rows(db.prepare('SELECT p.id,p.public_slug slug,p.title,p.state,p.presentation_type presentationType,p.rumble_source_scope sourceScope,v.revision,v.policy_json FROM polls p LEFT JOIN poll_voting_policies v ON v.poll_id=p.id ORDER BY p.updated_at DESC LIMIT 250'));
  const lots = await rows(db.prepare(`SELECT l.*,p.title,p.public_slug slug,p.presentation_type FROM poll_credit_lots l JOIN polls p ON p.id=l.poll_id
    WHERE (?='' OR l.poll_id=?) AND (?='' OR l.source_scope=?) AND (?='' OR l.actor_label=?) AND (?='' OR l.reason=?) AND (?='' OR p.presentation_type=?)
    ORDER BY (l.unreconciled+l.waiting>0) DESC,l.created_at DESC LIMIT 100`).bind(...['pollId', 'source', 'actor', 'reason', 'type'].flatMap(k => [String(filter[k] || ''), String(filter[k] || '')])));
  const heartbeat = await db.prepare('SELECT runtime_json,heartbeat_at FROM bot_runtime_heartbeat WHERE singleton_id=1').first();
  const runtime = parse(heartbeat?.runtime_json || '{}');
  const queue = await Promise.all(lots.map(async l => ({ ...l, evidence: parse(l.evidence_json), evidence_json: undefined, policy: parse(l.policy_json), policy_json: undefined,
    options: await rows(db.prepare('SELECT id,label,trigger_normalized normalizedTrigger FROM poll_options WHERE poll_id=? ORDER BY display_position').bind(l.poll_id)),
    observations: await rows(db.prepare('SELECT provider_event_at,option_id,evidence_json FROM poll_credit_messages WHERE window_id=? AND actor_key=? AND provider_event_at>=? AND provider_event_at<=? ORDER BY provider_event_at LIMIT 10').bind(l.window_id, l.actor_key, l.provider_event_at, l.expires_at)),
    audit: await rows(db.prepare('SELECT actor_account_id,action,reason,before_json,after_json,created_at FROM poll_credit_audit WHERE lot_id=? ORDER BY created_at DESC LIMIT 20').bind(l.id)) })));
  return { ok: true, defaults: DEFAULT_POLL_POLICY, protocol: PAID_PROTOCOL, botCompatible: runtime.pollCreditProtocol === PAID_PROTOCOL && Date.now() - Date.parse(heartbeat?.heartbeat_at) < 45000,
    appliedWindowId: runtime.pollCreditWindowId || null, appliedPolicyRevision: runtime.pollCreditPolicyRevision || 0,
    source: runtime.rumbleDiscovery?.source || null, livestreams: runtime.rumbleDiscovery?.livestreams || [],
    heartbeatAt: heartbeat?.heartbeat_at || null, policies: policies.map(p => ({ ...p, revision: p.revision || 0, policy: p.policy_json ? parse(p.policy_json) : DEFAULT_POLL_POLICY, policy_json: undefined })),
    lots: queue, limit: 100 };
}
