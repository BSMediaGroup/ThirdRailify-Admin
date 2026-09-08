export type EntryType = 'regular' | 'chat' | 'follow' | 'subscription' | 'gift' | 'raid' | 'rant' | 'legacy';
export type EntryIdentity = { version: 1; type: EntryType; origin: 'manual' | 'imported' | 'automation' | 'legacy' };
export const ENTRY_TYPES: Readonly<Record<EntryType, string>>;
export const EVENT_ENTRY_TYPES: Readonly<Record<string, EntryType>>;
export function normalizeEntryIdentity(value: unknown): EntryIdentity | null;
export function importedEntryIdentity(value?: unknown): EntryIdentity;
export function entryIdentityLabel(value?: unknown): string;
