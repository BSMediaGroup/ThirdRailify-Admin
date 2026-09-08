// Entry classification is independent of decorative icons, colours and presets.
export const ENTRY_TYPES = Object.freeze({ regular: 'Regular entry', chat: 'Chat entry', follow: 'Follow', subscription: 'Subscription', gift: 'Gift purchase', raid: 'Raid received', rant: 'Rant', legacy: 'Legacy / unclassified' });
export const EVENT_ENTRY_TYPES = Object.freeze({ 'rumble.chat.exact': 'chat', 'rumble.follow': 'follow', 'rumble.subscribe': 'subscription', 'rumble.gift_purchase': 'gift', 'rumble.raid.received': 'raid', 'rumble.rant': 'rant' });
export function normalizeEntryIdentity(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || typeof value.type !== 'string' || !Object.hasOwn(ENTRY_TYPES, value.type) || !['manual', 'imported', 'automation', 'legacy'].includes(value.origin) || Object.keys(value).some(key => !['version', 'type', 'origin'].includes(key))) throw new Error('Invalid entry identity.');
  return { version: 1, type: value.type, origin: value.origin };
}
export function importedEntryIdentity(value) {
  return { version: 1, type: normalizeEntryIdentity(value)?.type || 'regular', origin: 'imported' };
}
export function entryIdentityLabel(value) {
  const identity = normalizeEntryIdentity(value);
  return identity ? `${ENTRY_TYPES[identity.type]} / ${identity.origin === 'automation' ? 'Automatic' : identity.origin === 'imported' ? 'Imported' : identity.origin === 'legacy' ? 'Legacy' : 'Manual'}` : ENTRY_TYPES.legacy;
}
