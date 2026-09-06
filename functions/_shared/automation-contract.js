import { AuthFailure } from './auth-core.js';
import { normalizePollTrigger } from './poll-normalization.js';

export const EVENT_TYPES = Object.freeze(['rumble.chat.exact', 'rumble.rant', 'rumble.follow', 'rumble.subscribe', 'rumble.gift_purchase']);
const fields = {
  'rumble.chat.exact': ['exactText', 'badge', 'livestreamId'],
  'rumble.rant': ['exactText', 'badge', 'minAmountCents', 'livestreamId'],
  'rumble.follow': [],
  'rumble.subscribe': ['minAmountCents'],
  'rumble.gift_purchase': ['minGifts', 'giftType'],
};
export function invalid(code = 'automation_invalid', message = 'The automation input is invalid.') { throw new AuthFailure(400, code, message); }
export function text(value, maximum, required = true) {
  if (typeof value !== 'string' || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) return invalid();
  const result = value.trim(); if (required && !result) return invalid(); return result;
}
export function validateRule(input) {
  if (!input || typeof input !== 'object' || !EVENT_TYPES.includes(input.eventType)) invalid('automation_event_invalid', 'Choose an actor-bearing Rumble event. Livestream state cannot add an entrant.');
  if (typeof input.enabled !== 'boolean' || input.actionType !== 'wheel.add_actor' || input.duplicatePolicy !== 'skip') invalid();
  const sourceScope = text(input.sourceScope, 200);
  if (!/^(channel|user):[A-Za-z0-9_-]{1,180}$/.test(sourceScope)) invalid('automation_source_invalid');
  const raw = input.conditions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields[input.eventType].includes(key))) invalid('automation_conditions_invalid');
  const conditions = {};
  for (const [key, value] of Object.entries(raw)) {
    if (['minAmountCents', 'minGifts'].includes(key)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 100000000) invalid('automation_threshold_invalid');
      conditions[key] = value;
    } else { conditions[key] = text(value, key === 'exactText' ? 500 : 160); }
  }
  if (input.eventType === 'rumble.chat.exact' && !conditions.exactText) invalid('automation_text_required', 'Enter the complete chat message to match.');
  return { name: text(input.name, 100), description: text(input.description ?? '', 500, false), enabled: input.enabled,
    sourceScope, eventType: input.eventType, conditions, actionType: 'wheel.add_actor', targetWheelId: text(input.targetWheelId, 160), duplicatePolicy: 'skip' };
}
export function matches(rule, event) {
  const c = rule.conditions, d = event.evidence || {};
  return event.eventType === rule.eventType && event.sourceScope === rule.sourceScope
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
  if (Object.keys(d).some(key => !['normalizedText', 'badges', 'amountCents', 'totalGifts', 'giftType', 'videoId'].includes(key))) invalid('automation_evidence_invalid');
  if (d.normalizedText !== undefined && (typeof d.normalizedText !== 'string' || d.normalizedText.length > 500 || normalizePollTrigger(d.normalizedText) !== d.normalizedText)) invalid();
  if (d.badges !== undefined && (!Array.isArray(d.badges) || d.badges.length > 20 || d.badges.some(b => typeof b !== 'string' || b.length > 80))) invalid();
  for (const key of ['amountCents', 'totalGifts']) if (d[key] !== undefined && (!Number.isSafeInteger(d[key]) || d[key] < 0 || d[key] > 100000000)) invalid();
  if (['rumble.rant', 'rumble.subscribe'].includes(event.eventType) && d.amountCents === undefined) invalid();
  if (event.eventType === 'rumble.gift_purchase') { if (d.totalGifts === undefined || !Number.isSafeInteger(d.videoId) || d.videoId < 0) invalid(); text(d.giftType, 160); }
  if (['rumble.chat.exact', 'rumble.rant'].includes(event.eventType)) text(event.livestreamId, 160);
  return event;
}
