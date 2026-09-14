import { AuthFailure } from './auth-core.js';
import { schemaTable } from './schema-capabilities.js';
import { normalizeAppearance, portableAppearance } from '../../src/lib/entrant-appearance.mjs';

export async function requireAppearanceStorage(db) {
  const table = await schemaTable(db, 'wheel_entries', ['entrant_appearance_json']);
  if (!table?.sql || !/\bentrant_appearance_json\b/i.test(table.sql)) throw new AuthFailure(503, 'entrant_appearance_schema_required', 'Apply migration 0040 before configuring entrant appearance. Existing awards remain available.');
}
export function storedAppearance(json) { return json ? normalizeAppearance(JSON.parse(json)) : null; }
export function validateEntryAppearance(value) {
  if (value === undefined) return undefined;
  try { return normalizeAppearance(value); }
  catch { throw new AuthFailure(400, 'entrant_appearance_invalid', 'Choose supported entrant appearance values and bounded effect settings.'); }
}
export function mergeEntryAppearance(input, prior) {
  if (input.appearance === undefined) return prior;
  const incoming = validateEntryAppearance(input.appearance);
  // Public cannot forge automation evidence or clear persisted automatic snapshots.
  if (!prior) return portableAppearance({ ...input, appearance: incoming }) || null;
  return { version: 1, manual: incoming?.manual || {}, ...(prior.automatic ? { automatic: prior.automatic } : {}) };
}
