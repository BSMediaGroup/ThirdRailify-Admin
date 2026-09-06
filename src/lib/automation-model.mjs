// Shared editor/server contract. Wheel schema and validateEntries use this same ceiling.
export const MAX_ENTRY_WEIGHT = 100000;
export const EVENT_TYPES = Object.freeze(['rumble.chat.exact', 'rumble.rant', 'rumble.follow', 'rumble.subscribe', 'rumble.gift_purchase']);
export const CONDITION_FIELDS = {
  'rumble.chat.exact': ['exactText', 'badge', 'livestreamId'],
  'rumble.rant': ['exactText', 'badge', 'minAmountCents', 'livestreamId'],
  'rumble.follow': [], 'rumble.subscribe': ['minAmountCents'], 'rumble.gift_purchase': ['minGifts', 'giftType'],
};
export const defaultAction = () => ({ version: 2, repeatActorPolicy: 'skip', award: { mode: 'fixed', entriesPerUnit: 1, unitCents: 100 } });
const validText = (v, max, required = true) => typeof v === 'string' && v.length <= max && !/[\p{Cc}\p{Cf}]/u.test(v) && (!required || Boolean(v.trim()));
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
export function ruleFieldErrors(input) {
  const r = input || {}, errors = {};
  if (!validText(r.name, 100)) errors.name = 'Enter a rule name of 1–100 characters, without control characters.';
  if (!validText(r.description ?? '', 500, false)) errors.description = 'Use at most 500 characters, without control characters.';
  if (typeof r.sourceScope !== 'string' || !r.sourceScope.trim()) errors.sourceScope = 'Select a Rumble source.';
  else if (!validText(r.sourceScope, 200) || !/^(user|channel):[A-Za-z0-9_-]{1,180}$/.test(r.sourceScope.trim())) errors.sourceScope = 'Use user:<id> or channel:<id>, with letters, numbers, underscores or hyphens.';
  if (!validText(r.targetWheelId, 160)) errors.targetWheelId = 'Choose a target Wheel.';
  if (!EVENT_TYPES.includes(r.eventType)) errors.eventType = 'Choose an actor-bearing Rumble event. Livestream state cannot add an entrant.';
  if (r.actionType !== 'wheel.add_actor') errors.actionType = 'Choose Add actor to Wheel.';
  if (typeof r.enabled !== 'boolean') errors.enabled = 'Choose whether this rule is enabled.';
  const c = r.conditions;
  if (!c || typeof c !== 'object' || Array.isArray(c)) errors.conditions = 'Choose valid event conditions.';
  else {
    for (const [key, value] of Object.entries(c)) {
      if (!CONDITION_FIELDS[r.eventType]?.includes(key)) errors.conditions = 'Remove conditions that do not belong to this event family.';
      else if (['minGifts', 'minAmountCents'].includes(key)) {
        if (!integer(value, 0, 100000000)) errors[key] = 'Enter a whole number from 0 to 100,000,000.';
      } else if (!validText(value, key === 'exactText' ? 500 : 160)) errors[key] = `Enter valid text (at most ${key === 'exactText' ? 500 : 160} characters).`;
    }
  }
  if (r.eventType === 'rumble.chat.exact' && (typeof c?.exactText !== 'string' || !c.exactText.trim())) errors.exactText = 'Enter the complete chat message to match.';
  const a = r.actionConfig === undefined ? defaultAction() : r.actionConfig;
  if (!a || a.version !== 2 || Object.keys(a).some(k => !['version', 'repeatActorPolicy', 'award'].includes(k))) errors.actionConfig = 'Use a supported entry award configuration (version 2).';
  if (!['skip', 'accumulate'].includes(a?.repeatActorPolicy)) errors.repeatActorPolicy = 'Choose how to handle a repeat actor.';
  if (r.duplicatePolicy !== undefined && !['skip', 'accumulate'].includes(r.duplicatePolicy)) errors.repeatActorPolicy = 'Choose how to handle a repeat actor.';
  const award = a?.award;
  const modes = ['fixed', ...(r.eventType === 'rumble.gift_purchase' ? ['per_gift'] : []), ...(r.eventType === 'rumble.rant' ? ['per_amount'] : [])];
  if (!award || !modes.includes(award.mode) || Object.keys(award).some(k => !['mode', 'entriesPerUnit', 'unitCents'].includes(k))) errors.awardMode = 'Choose an award mode supported by this event.';
  if (!integer(award?.entriesPerUnit, 1, MAX_ENTRY_WEIGHT)) errors.entriesPerUnit = 'Enter a whole number greater than zero, up to 100,000.';
  if (!integer(award?.unitCents, 1, 100000000)) errors.unitCents = 'Enter a whole number of cents from 1 to 100,000,000.';
  return errors;
}
export function calculateAward(action, eventType, evidence = {}) {
  const a = action.award;
  let units = 1, calculation = `Each qualifying event × ${a.entriesPerUnit}`;
  if (a.mode === 'per_gift') {
    if (eventType !== 'rumble.gift_purchase' || !integer(evidence.totalGifts, 1, 100000000)) return { entries: 0, reason: 'invalid_gift_evidence', calculation: 'A positive integer gift count is required.' };
    units = evidence.totalGifts; calculation = `${units} gifts × ${a.entriesPerUnit}`;
  } else if (a.mode === 'per_amount') {
    if (eventType !== 'rumble.rant' || !integer(evidence.amountCents, 0, 100000000)) return { entries: 0, reason: 'invalid_amount_evidence', calculation: 'A nonnegative integer amount in cents is required.' };
    units = Math.floor(evidence.amountCents / a.unitCents); calculation = `floor(${evidence.amountCents} cents ÷ ${a.unitCents}) × ${a.entriesPerUnit}`;
  }
  const entries = units * a.entriesPerUnit;
  if (!Number.isSafeInteger(entries) || entries > MAX_ENTRY_WEIGHT) return { entries: 0, reason: 'award_limit_exceeded', calculation: `${calculation} exceeds the 100,000 entry weight limit.` };
  return { entries, reason: entries === 0 ? 'no_complete_units' : null, calculation: `${calculation} = ${entries} entries` };
}
