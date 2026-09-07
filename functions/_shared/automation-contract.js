import { AuthFailure } from './auth-core.js';
import { normalizePollTrigger } from './poll-normalization.js';

import { EVENT_TYPES, RAID_TYPE, RAID_METHOD, RAID_TEXT, defaultAction, ruleFieldErrors } from '../../src/lib/automation-model.mjs';
export { EVENT_TYPES };
export function invalid(code = 'automation_invalid', message = 'The automation input is invalid.') { throw new AuthFailure(400, code, message); }
export function text(value, maximum, required = true) {
  if (typeof value !== 'string' || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) return invalid();
  const result = value.trim(); if (required && !result) return invalid(); return result;
}
export function fieldFailure(fields) {
  const error = new AuthFailure(400, 'automation_input_invalid', 'Review the highlighted rule fields.');
  error.issues = Object.entries(fields).map(([field, message]) => ({ field, message }));
  throw error;
}
export function validateRule(input) {
  const errors = ruleFieldErrors(input);
  if (Object.keys(errors).length) fieldFailure(errors);
  const actionConfig = input.actionConfig ?? defaultAction();
  return { name: input.name.trim(), description: (input.description ?? '').trim(), enabled: input.enabled,
    sourceScope: input.sourceScope.trim(), eventType: input.eventType,
    conditions: Object.fromEntries(Object.entries(input.conditions).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])),
    actionType: 'wheel.add_actor', targetWheelId: input.targetWheelId.trim(), actionConfig,
    duplicatePolicy: actionConfig.repeatActorPolicy };
}
export function matches(rule, event) {
  const c = rule.conditions, d = event.evidence || {};
  return (event.eventType !== RAID_TYPE || (d.detectionMethod === RAID_METHOD && normalizePollTrigger(d.announcement || '') === RAID_TEXT))
    && event.eventType === rule.eventType && event.sourceScope === rule.sourceScope
    && (!c.livestreamId || c.livestreamId === event.livestreamId)
    && (!c.exactText || normalizePollTrigger(c.exactText) === d.normalizedText)
    && (!c.badge || (d.badges || []).some(b => normalizePollTrigger(b) === normalizePollTrigger(c.badge)))
    && (c.minAmountCents === undefined || d.amountCents >= c.minAmountCents)
    && (c.minGifts === undefined || d.totalGifts >= c.minGifts)
    && (!c.giftType || c.giftType === d.giftType);
}
export function validateEvent(event) {
  if (!event || !EVENT_TYPES.includes(event.eventType) || !/^[a-f0-9]{64}$/.test(event.eventFingerprint || '')) invalid('automation_event_invalid');
  text(event.ruleId, 160); if (!Number.isSafeInteger(event.ruleRevision) || event.ruleRevision < 1) invalid();
  text(event.actorKey, 500); text(event.actorLabel, 120); text(event.sourceScope, 200);
  if (!event.actorKey.startsWith(`rumble:${event.sourceScope}:`)) invalid('automation_actor_invalid');
  const usernameKey = `rumble:${event.sourceScope}:${normalizePollTrigger(event.actorLabel)}`;
  if (event.actorKey !== usernameKey && !(event.eventType === 'rumble.subscribe' && event.actorKey.startsWith(`rumble:${event.sourceScope}:user:`) && event.actorKey.length > `rumble:${event.sourceScope}:user:`.length)) invalid('automation_actor_invalid');
  if (typeof event.providerEventAt !== 'string' || !Number.isFinite(Date.parse(event.providerEventAt)) || Date.parse(event.providerEventAt) > Date.now() + 300000) invalid('automation_timestamp_invalid');
  const d = event.evidence;
  if (!d || typeof d !== 'object' || Array.isArray(d)) invalid();
  if (Object.keys(d).some(key => !['normalizedText', 'badges', 'amountCents', 'totalGifts', 'giftType', 'videoId', 'announcement', 'detectionMethod'].includes(key))) invalid('automation_evidence_invalid');
  if (d.normalizedText !== undefined && (typeof d.normalizedText !== 'string' || d.normalizedText.length > 500 || normalizePollTrigger(d.normalizedText) !== d.normalizedText)) invalid();
  if (d.badges !== undefined && (!Array.isArray(d.badges) || d.badges.length > 20 || d.badges.some(b => typeof b !== 'string' || b.length > 80))) invalid();
  for (const key of ['amountCents', 'totalGifts']) if (d[key] !== undefined && (!Number.isSafeInteger(d[key]) || d[key] < 0 || d[key] > 100000000)) invalid();
  if (['rumble.rant', 'rumble.subscribe'].includes(event.eventType) && d.amountCents === undefined) invalid();
  if (event.eventType === 'rumble.gift_purchase') { if ((!Number.isSafeInteger(d.totalGifts) || d.totalGifts < 1) || !Number.isSafeInteger(d.videoId) || d.videoId < 0) invalid(); text(d.giftType, 160); }
  if (['rumble.chat.exact', 'rumble.rant'].includes(event.eventType)) text(event.livestreamId, 160);
  if (event.eventType === RAID_TYPE) {
    text(event.livestreamId, 160);
    if (typeof d.announcement !== 'string' || d.announcement.length > 500) invalid('automation_raid_evidence_invalid');
    if (d.detectionMethod !== RAID_METHOD || normalizePollTrigger(d.announcement) !== RAID_TEXT
      || Object.keys(d).some(k => !['announcement', 'detectionMethod'].includes(k))) invalid('automation_raid_evidence_invalid');
  } else if (d.announcement !== undefined || d.detectionMethod !== undefined) invalid('automation_evidence_invalid');
  return event;
}
