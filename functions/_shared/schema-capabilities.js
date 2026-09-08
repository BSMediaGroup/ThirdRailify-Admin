// Schema metadata only: never cache accounts, permissions, rules or live results.
// Weak binding identity prevents cross-database reuse. Store completed values only:
// Workers must not await another request's in-flight D1 I/O.
export const SCHEMA_CACHE_MS = 5 * 60 * 1000;
const cache = new WeakMap();
const names = Object.freeze([
  'automation_rules', 'poll_credit_guards', 'poll_credit_lifecycle',
  'poll_credit_allocation_guard', 'poll_credit_review_audit', 'poll_credit_structure_update',
  'poll_result_history', 'poll_manual_votes', 'poll_media_assets',
  'aboot_brackets', 'aboot_publications', 'aboot_poll_links', 'aboot_decisions',
  'aboot_audit', 'aboot_guards', 'aboot_media',
]);
const sql = `SELECT name,type,sql FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')})`;

export function invalidateSchemaCapabilities(db) { cache.delete(db); }

export async function schemaObject(db, name, type) {
  if (!names.includes(name)) throw new TypeError('Unsupported schema capability');
  const now = Date.now();
  const previous = cache.get(db);
  let object = previous?.objects.get(name);
  if (!object || now < previous.checkedAt || now - previous.checkedAt >= SCHEMA_CACHE_MS) {
    // Missing capabilities and errors are retried, so applying a migration is
    // visible immediately. An expired value never masks a failed database read.
    const result = await db.prepare(sql).bind(...names).all();
    if (!Array.isArray(result.results) || result.success === false) throw new Error('Invalid schema metadata response');
    const objects = new Map(result.results.map(row => [row.name, Object.freeze({ ...row })]));
    // A slower older check must not replace a newer completed observation.
    if (!cache.has(db) || cache.get(db).checkedAt <= now) cache.set(db, { checkedAt: now, objects });
    object = objects.get(name);
  }
  return object && (!type || object.type === type) ? object : null;
}

export async function hasSchemaObjects(db, required, type) {
  // Sequential lookup deliberately reuses the first completed catalogue read.
  for (const name of required) if (!await schemaObject(db, name, type)) return false;
  return true;
}
