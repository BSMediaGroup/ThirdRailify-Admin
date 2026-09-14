import { AuthFailure } from './auth-core.js';
import { schemaTable } from './schema-capabilities.js';
import { generateEntrantCode, normalizeEntrantCode } from '../../src/lib/entrant-code.mjs';

export async function requireEntrantCodeStorage(db) {
  const table = await schemaTable(db, 'wheel_entries', ['entrant_code', 'display_suffix', 'provenance_origin']);
  if (!table?.sql || !/\bentrant_code\b/i.test(table.sql) || !/\bdisplay_suffix\b/i.test(table.sql)) {
    throw new AuthFailure(503, 'entrant_code_schema_required', 'Wheel entrant codes require migration 0050 before participants can be created or changed.');
  }
}

export async function allocateEntrantCodes(db, count, options = {}) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new AuthFailure(400, 'entrant_code_count_invalid', 'The entrant code allocation is invalid.');
  const generate = options.generate || generateEntrantCode;
  const allocated = [];
  const used = new Set(options.used || []);
  for (let round = 0; allocated.length < count && round < 8; round += 1) {
    const candidates = [];
    while (candidates.length < count - allocated.length) {
      const code = normalizeEntrantCode(generate());
      if (!code || used.has(code) || candidates.includes(code)) continue;
      candidates.push(code);
    }
    const rows = (await db.prepare(`SELECT entrant_code FROM wheel_entries
      WHERE entrant_code IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(candidates)).all()).results || [];
    const collisions = new Set(rows.map((row) => row.entrant_code));
    for (const code of candidates) if (!collisions.has(code)) { allocated.push(code); used.add(code); }
  }
  if (allocated.length !== count) throw new AuthFailure(503, 'entrant_code_allocation_failed', 'A unique entrant code could not be allocated. Try the save again.');
  return allocated;
}

export function entryCode(value) {
  return normalizeEntrantCode(value);
}
