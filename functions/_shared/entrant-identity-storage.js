import { AuthFailure } from './auth-core.js';
import { EVENT_ENTRY_TYPES, normalizeEntryIdentity } from '../../src/lib/entrant-identity.mjs';

export async function requireIdentityStorage(db, columns) {
  columns ||= (await db.prepare('PRAGMA table_info(wheel_entries)').all()).results;
  if (!columns.some(column => column.name === 'entrant_identity_json')) throw new AuthFailure(503, 'entrant_identity_schema_required', 'Wheel entry identity storage is unavailable. Apply migration 0042 before processing automation awards or saving typed entries.');
}
export function storedEntryIdentity(json) { return json ? JSON.parse(json) : null; }
export function publicEntryIdentity(json) {
  const value = storedEntryIdentity(json);
  return value ? normalizeEntryIdentity({ version: value.version, type: value.type, origin: value.origin }) : { version: 1, type: 'legacy', origin: 'legacy' };
}
export function validateEntryIdentity(value) {
  try { return normalizeEntryIdentity(value); }
  catch { throw new AuthFailure(400, 'entrant_identity_invalid', 'Choose a supported entry type. Automation identity is managed by the server.'); }
}
export function manualEntryIdentity(input, prior) {
  // An existing ID retains its authoritative classification even with an old client,
  // renamed label, changed preset, or a forged incoming automation classification.
  if (prior) return storedEntryIdentity(prior.entrant_identity_json);
  const incoming = validateEntryIdentity(input.identity);
  return { version: 1, type: incoming?.type || 'regular', origin: incoming?.origin === 'imported' ? 'imported' : 'manual' };
}
export async function automaticEntryIdentity(event) {
  const type = EVENT_ENTRY_TYPES[event.eventType];
  if (!type || !event.actorKey || !event.sourceScope) throw new AuthFailure(400, 'entrant_identity_invalid', 'An automation entry requires a validated actor, source and event type.');
  // Preserve the pre-canonicalization event-family material so a deliberate
  // legacy subscriber-rule save cannot create a second identity for one actor.
  const identityEventType = event.eventType === 'subscriber_self_paid' ? 'rumble.subscribe' : event.eventType;
  // Tuple encoding avoids delimiter collisions; do not use a mutable display label,
  // avatar or appearance. Source and event family remain distinct across rules.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([1, event.sourceScope, event.actorKey, identityEventType])));
  const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { version: 1, type, origin: 'automation', key };
}

export async function provenLegacyIdentity(db, wheelId, identityKey) {
  // Only an explicit creation audit plus a complete, single-actor/type receipt
  // history can establish ownership. An old name match alone proves nothing.
  const rows = (await db.prepare(`SELECT e.id, MIN(r.actor_key) AS actor_key, MIN(r.event_type) AS event_type
    FROM wheel_entries e JOIN wheel_audit_events a ON a.wheel_id=e.wheel_id
      AND a.event_type='automation_entry_action' AND json_extract(a.metadata_json,'$.entryId')=e.id
    LEFT JOIN automation_receipts r ON r.id=json_extract(a.metadata_json,'$.receiptId')
      AND r.target_wheel_id=e.wheel_id AND r.outcome='added'
    WHERE e.wheel_id=? AND e.entrant_identity_json IS NULL AND json_extract(a.metadata_json,'$.outcome')='added'
    GROUP BY e.id
    HAVING COUNT(*)=COUNT(r.id)
      AND COUNT(DISTINCT json_array(r.actor_key,r.event_type))=1
      AND SUM(CASE WHEN r.action_result='created' AND json_extract(a.metadata_json,'$.actionResult')='created' THEN 1 ELSE 0 END)=1
    LIMIT 1000`).bind(wheelId).all()).results;
  const matches = [];
  for (const row of rows) {
    const sourceScope = /^rumble:((?:user|channel):[A-Za-z0-9_-]{1,180}):.+$/u.exec(row.actor_key)?.[1];
    if (!sourceScope || !EVENT_ENTRY_TYPES[row.event_type]) continue;
    const candidate = await automaticEntryIdentity({ sourceScope, actorKey: row.actor_key, eventType: row.event_type });
    if (candidate.key === identityKey) matches.push(row.id);
  }
  return matches.length === 1 ? matches[0] : null;
}
