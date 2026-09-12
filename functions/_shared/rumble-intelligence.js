import { AuthFailure } from './auth-core.js';

export const RULE = 'amount-v1';
export const PRIMARY_SOURCE = 'user:1sl8zm';
const MAX_ROWS = 5000;
const DAY = 86400000;
const ready = new WeakMap();
const encoder = new TextEncoder();
const fail = code => { throw new AuthFailure(400, code, 'Invalid subscriber observation.'); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 160) => typeof v === 'string' && v.length <= max ? v : null;
export const normalizeName = v => v.normalize('NFKC').trim().toLowerCase();
export async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))))].map(v => v.toString(16).padStart(2, '0')).join(''); }
export function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
  return new Date(value).toISOString();
}
export function amountClass(value) { return Number.isSafeInteger(value) && value === 500 ? 'Self-paid' : Number.isSafeInteger(value) && value === 0 ? 'Gifted' : 'Needs review'; }

// Allowlisted provider projection. This also supports the controlled historical import.
export function projectProvider(payload, observedAt = null) {
  if (!object(payload)) fail('intelligence_provider_shape');
  const channel = payload.channel_id;
  const scope = channel !== null && channel !== undefined && channel !== '' ? 'channel' : 'user';
  const id = scope === 'channel' ? channel : payload.user_id;
  if (!['string', 'number'].includes(typeof id) || !/^[\w-]{1,100}$/.test(String(id))) fail('intelligence_source');
  const sub = object(payload.subscribers) ? payload.subscribers : {};
  const row = v => object(v) ? Object.fromEntries(['user', 'username', 'profile_pic_url', 'amount_cents', 'subscribed_on'].filter(k => Object.hasOwn(v, k)).map(k => [k, v[k]])) : null;
  return { version: 1, source: `${scope}:${id}`, label: text(scope === 'channel' ? payload.channel_name : payload.username, 100), providerTime: payload.now, observedAt,
    context: { type: payload.type, since: payload.since ?? null, maxResults: payload.max_num_results, truncated: payload.truncated === true || sub.truncated === true || sub.has_more === true },
    reportedCount: sub.num_subscribers ?? null, rows: Array.isArray(sub.recent_subscribers) ? sub.recent_subscribers.map(row) : null, latest: row(sub.latest_subscriber) };
}

export async function validateObservation(body, provenance = 'live', now = new Date().toISOString()) {
  if (!object(body) || body.version !== 1 || !/^(user|channel):[\w-]{1,100}$/.test(body.source)) fail('intelligence_source');
  if (!['live', 'historical'].includes(provenance)) fail('intelligence_provenance');
  const observedAt = provenance === 'live' ? utc(body.observedAt) : null;
  if (provenance === 'live' && (!observedAt || Date.parse(observedAt) > Date.parse(now) + 300000)) fail('intelligence_observed_time');
  const validProvider = typeof body.providerTime === 'number' && Number.isFinite(body.providerTime) && body.providerTime > 0 && body.providerTime * 1000 <= Date.parse(now) + 300000;
  if (!validProvider) fail('intelligence_provider_time');
  const providerAt = new Date(body.providerTime * 1000).toISOString();
  const inputContext = object(body.context) ? body.context : {};
  const context = { type: text(inputContext.type, 20), since: inputContext.since ?? null, maxResults: inputContext.maxResults, truncated: inputContext.truncated === true };
  if (object(context.since) || Array.isArray(context.since) || (typeof context.since === 'string' && context.since.length > 100)) fail('intelligence_filter_shape');
  const reasons = [];
  if (observedAt && Date.parse(providerAt) > Date.parse(observedAt) + 300000) reasons.push('provider_time_after_fetch');
  if (context.type !== body.source.split(':')[0]) reasons.push('scope_context_mismatch');
  if (context.since !== null && context.since !== undefined && context.since !== '') reasons.push('filtered');
  if (!Number.isSafeInteger(context.maxResults) || context.maxResults < 1) reasons.push('invalid_result_context');
  if (context.truncated === true) reasons.push('truncated');
  if (!Array.isArray(body.rows)) reasons.push('missing_subscriber_array');
  const rows = Array.isArray(body.rows) ? body.rows : object(body.latest) ? [body.latest] : [];
  if (rows.length > MAX_ROWS) fail('intelligence_array_bound');
  if (!Number.isSafeInteger(body.reportedCount) || body.reportedCount < 0 || body.reportedCount !== rows.length) reasons.push('raw_count_mismatch');
  const records = new Map(); let invalidRows = 0; let unexpectedAmounts = 0;
  for (const raw of rows) {
    if (!object(raw) || !text(raw.username) || !normalizeName(raw.username)) { invalidRows++; continue; }
    const name = normalizeName(raw.username);
    const dateRaw = text(raw.subscribed_on, 100); const dateUtc = utc(dateRaw);
    if (!dateUtc) reasons.push('invalid_subscription_date');
    else if (Date.parse(dateUtc) > Date.parse(providerAt) + 300000) reasons.push('subscription_date_after_snapshot');
    // Preserve invalid scalar evidence without treating null/missing as zero.
    const amount = Object.hasOwn(raw, 'amount_cents') ? raw.amount_cents : null;
    if (object(amount) || Array.isArray(amount) || (typeof amount === 'string' && amount.length > 100)) fail('intelligence_amount_shape');
    const amountPresent = Object.hasOwn(raw, 'amount_cents');
    const classification = amountClass(amount); if (classification === 'Needs review') unexpectedAmounts++;
    const id = await hash(['record-v1', body.source, name, dateRaw, amountPresent, amount]);
    let avatar = null;
    try { const url = new URL(raw.profile_pic_url); if (url.protocol === 'https:' && /(^|\.)cdn\.rumble\.cloud$/.test(url.hostname) && !url.username && !url.password) avatar = url.href; } catch { /* optional */ }
    const record = { id, name, displayName: raw.username, user: text(raw.user), username: raw.username, avatar, amount, amountPresent, classification, dateRaw, dateUtc, reviewAt: dateUtc ? new Date(Date.parse(dateUtc) + 30 * DAY).toISOString() : null, rule: RULE };
    if (!records.has(id)) records.set(id, record);
  }
  if (invalidRows) reasons.push('malformed_rows');
  const sorted = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  const setId = await hash(['set-v1', body.source, sorted]);
  const id = await hash(['observation-v1', body.source, providerAt, provenance]);
  return { id, source: body.source, label: text(body.label, 100), providerAt, observedAt, provenance, qualified: reasons.length === 0, setId, records: sorted,
    metadata: { rule: RULE, reportedCount: body.reportedCount, rawCount: rows.length, duplicateRows: rows.length - invalidRows - sorted.length, invalidRows, unexpectedAmounts, reasons: [...new Set(reasons)], context, coverageGaps: Number.isSafeInteger(body.coverageGaps) ? Math.max(0, body.coverageGaps) : 0 } };
}

export async function intelligenceDb(env) {
  const db = env.THIRDRAILIFY_COMMERCE_DB;
  if (!db) throw new AuthFailure(503, 'intelligence_database_missing', 'Subscriber storage is unavailable.');
  if (!ready.has(db) || Date.now() - ready.get(db) > 300000) {
    try {
      // Zero-row column preparation checks the exact schema without scanning sqlite_master.
      await db.batch([
        db.prepare('SELECT source,current_id,current_at,attempt_at,attempt_json FROM rumble_intelligence_sources LIMIT 0'),
        db.prepare('SELECT id,source,records_json,created_at FROM rumble_intelligence_sets LIMIT 0'),
        db.prepare('SELECT id,source,provider_at,observed_at,received_at,provenance,qualified,set_id,metadata_json FROM rumble_intelligence_observations LIMIT 0'),
        db.prepare('SELECT observation_id,account_id,received_at FROM rumble_intelligence_imports LIMIT 0'),
      ]);
    } catch { throw new AuthFailure(503, 'intelligence_schema_unavailable', 'Subscriber schema is unavailable. Verify migration 0045 and D1 availability.'); }
    ready.set(db, Date.now());
  }
  return db;
}

export async function ingestIntelligence(env, body, { provenance = 'live', accountId = null } = {}) {
  const received = new Date().toISOString();
  if (provenance === 'live' && (body?.failure === true || typeof body?.providerTime !== 'number' || !Number.isFinite(body.providerTime) || body.providerTime <= 0 || body.providerTime * 1000 > Date.parse(received) + 300000)) {
    if (body?.version !== 1 || !/^(user|channel):[\w-]{1,100}$/.test(body?.source) || !utc(body?.observedAt) || Date.parse(body.observedAt) > Date.parse(received) + 300000) fail('intelligence_attempt_invalid');
    const db = await intelligenceDb(env);
    const attempt = { label: text(body.label, 100), observedAt: utc(body.observedAt), receivedAt: received, qualified: false, reasons: [body.failure ? 'provider_fetch_unavailable' : 'invalid_provider_time'], provenance: 'live', coverageGaps: Number.isSafeInteger(body.coverageGaps) ? body.coverageGaps : 0 };
    await db.prepare(`INSERT INTO rumble_intelligence_sources(source,attempt_at,attempt_json) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET attempt_at=excluded.attempt_at,attempt_json=excluded.attempt_json WHERE excluded.attempt_at>rumble_intelligence_sources.attempt_at`).bind(body.source, attempt.observedAt, JSON.stringify(attempt)).run();
    return { ok: true, observationId: await hash(['attempt-v1', body.source, attempt.observedAt]), qualified: false, source: body.source };
  }
  const v = await validateObservation(body, provenance, received);
  const db = await intelligenceDb(env);
  const previous = await db.prepare(`SELECT o.id,o.set_id FROM rumble_intelligence_sources s LEFT JOIN rumble_intelligence_observations o ON o.id=s.current_id WHERE s.source=?`).bind(v.source).first();
  const attemptAt = v.observedAt || received;
  const attempt = JSON.stringify({ label: v.label, providerAt: v.providerAt, observedAt: v.observedAt, receivedAt: received, qualified: v.qualified, reasons: v.metadata.reasons, provenance, coverageGaps: v.metadata.coverageGaps });
  const statements = [
    db.prepare('INSERT OR IGNORE INTO rumble_intelligence_sets(id,source,records_json,created_at) VALUES(?,?,?,?)').bind(v.setId, v.source, JSON.stringify(v.records), received),
    db.prepare('INSERT OR IGNORE INTO rumble_intelligence_observations(id,source,provider_at,observed_at,received_at,provenance,qualified,set_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)').bind(v.id, v.source, v.providerAt, v.observedAt, received, provenance, Number(v.qualified), v.setId, JSON.stringify(v.metadata)),
    db.prepare(`INSERT INTO rumble_intelligence_sources(source,attempt_at,attempt_json) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET attempt_at=excluded.attempt_at,attempt_json=excluded.attempt_json WHERE excluded.attempt_at>rumble_intelligence_sources.attempt_at`).bind(v.source, attemptAt, attempt),
    db.prepare(`UPDATE rumble_intelligence_sources SET current_id=?,current_at=? WHERE source=? AND (current_at IS NULL OR current_at<?) AND EXISTS(SELECT 1 FROM rumble_intelligence_observations WHERE id=? AND qualified=1)`).bind(v.id, v.providerAt, v.source, v.providerAt, v.id),
  ];
  if (accountId) statements.push(db.prepare('INSERT OR IGNORE INTO rumble_intelligence_imports(observation_id,account_id,received_at) VALUES(?,?,?)').bind(v.id, accountId, received));
  await db.batch(statements);
  // Roster membership follows semantic set changes, never Bot timer cadence.
  // A roster fault cannot reject the independently valid intelligence receipt.
  if (provenance === 'live' && v.qualified && previous?.set_id !== v.setId) {
    try { const { syncEnabledRosterRulesForSnapshot } = await import('./subscriber-roster.js'); await syncEnabledRosterRulesForSnapshot(env, v.source); }
    catch { /* schema may be pending or a target may be locked; manual preview exposes the fault */ }
  }
  return { ok: true, observationId: v.id, qualified: v.qualified, source: v.source, metadata: v.metadata };
}

export function accounts(records) {
  const grouped = new Map();
  for (const r of records) { if (!grouped.has(r.name)) grouped.set(r.name, { name: r.name, displayName: r.displayName, avatar: r.avatar, records: [], hasPaid: false, hasGifted: false, needsReview: false }); const a = grouped.get(r.name); a.records.push(r); a.hasPaid ||= r.classification === 'Self-paid'; a.hasGifted ||= r.classification === 'Gifted'; a.needsReview ||= r.classification === 'Needs review'; }
  return [...grouped.values()].map(a => ({ ...a, classification: a.needsReview ? 'Needs review' : a.hasPaid && a.hasGifted ? 'Self-paid + gifted' : a.hasPaid ? 'Self-paid' : 'Gifted' }));
}

export async function intelligencePerson(env, source, name) {
  if (!/^(user|channel):[\w-]{1,100}$/.test(source) || !text(name) || normalizeName(name) !== name) fail('intelligence_identity');
  const db = await intelligenceDb(env);
  // Aggregate set observation spans first; repeated identical memberships do not
  // repeatedly expand the complete JSON roster. This is an on-demand private read.
  const result = await db.prepare(`WITH spans AS (
    SELECT set_id,MIN(provider_at) first_provider_at,MAX(provider_at) last_provider_at,
      MIN(observed_at) first_bot_observed_at,MAX(observed_at) last_bot_observed_at,
      MIN(received_at) first_received_at,MAX(received_at) last_received_at
    FROM rumble_intelligence_observations WHERE source=? AND qualified=1 GROUP BY set_id
  ) SELECT j.value record_json,MIN(s.first_provider_at) firstProviderAt,MAX(s.last_provider_at) lastProviderAt,
    MIN(s.first_bot_observed_at) firstBotObservedAt,MAX(s.last_bot_observed_at) lastBotObservedAt,
    MIN(s.first_received_at) firstReceivedAt,MAX(s.last_received_at) lastReceivedAt
    FROM spans s JOIN rumble_intelligence_sets m ON m.id=s.set_id JOIN json_each(m.records_json) j
    WHERE json_extract(j.value,'$.name')=? GROUP BY json_extract(j.value,'$.id')
    ORDER BY lastProviderAt DESC LIMIT 501`).bind(source, name).all();
  return { ok: true, source, name, bounded: result.results.length > 500, records: result.results.slice(0, 500).map(({ record_json, ...span }) => ({ ...JSON.parse(record_json), ...span })) };
}

export async function intelligenceTrend(env, source, range = '7d', snapshotId) {
  const windows = { '24h': [1, 3600], '7d': [7, 3600], '30d': [30, 86400], '90d': [90, 86400] };
  if (!Object.hasOwn(windows, range) || !/^(user|channel):[\w-]{1,100}$/.test(source) || !/^[a-f0-9]{64}$/.test(snapshotId || '')) fail('intelligence_trend_range');
  const db = await intelligenceDb(env);
  const anchor = await db.prepare('SELECT provider_at FROM rumble_intelligence_observations WHERE id=? AND source=? AND qualified=1').bind(snapshotId, source).first();
  if (!anchor) throw new AuthFailure(404, 'intelligence_snapshot_missing', 'The requested subscriber snapshot is unavailable.');
  const [days, bucketSeconds] = windows[range];
  const to = new Date().toISOString(), from = new Date(Date.parse(to) - days * DAY).toISOString();
  // Select the latest actual observation in each UTC bucket BEFORE loading rosters.
  // This covers the full selected window, independent of the 180-checkpoint drawer.
  const rows = await db.prepare(`WITH selected AS (
    SELECT MAX(provider_at) at FROM rumble_intelligence_observations
    WHERE source=? AND qualified=1 AND provider_at>=? AND provider_at<=?
    GROUP BY CAST(unixepoch(provider_at)/? AS INTEGER)
  ) SELECT o.provider_at,o.provenance,o.set_id,m.records_json
    FROM selected s JOIN rumble_intelligence_observations o ON o.provider_at=s.at AND o.source=? AND o.qualified=1
    JOIN rumble_intelligence_sets m ON m.id=o.set_id ORDER BY o.provider_at,o.provenance LIMIT 340`).bind(source, from, anchor.provider_at < to ? anchor.provider_at : to, bucketSeconds, source).all();
  const sets = new Map(), points = new Map();
  for (const row of rows.results) {
    if (!sets.has(row.set_id)) {
      const roster = accounts(JSON.parse(row.records_json));
      sets.set(row.set_id, { total: roster.length, paid: roster.filter(a => a.classification === 'Self-paid').length, gifted: roster.filter(a => a.classification === 'Gifted').length, mixed: roster.filter(a => a.classification === 'Self-paid + gifted').length, unknown: roster.filter(a => a.classification === 'Needs review').length });
    }
    points.set(row.provider_at, { at: row.provider_at, provenance: row.provenance, ...sets.get(row.set_id) });
  }
  return { ok: true, source, snapshotId, range, from, to, bucketSeconds, points: [...points.values()] };
}

export async function intelligenceReport(env, source = PRIMARY_SOURCE) {
  if (!/^(user|channel):[\w-]{1,100}$/.test(source)) fail('intelligence_source');
  const db = await intelligenceDb(env);
  // One joined read pins the coherent current snapshot before any history read.
  const state = await db.prepare(`SELECT s.*,o.id,o.provider_at,o.observed_at,o.received_at,o.provenance,o.metadata_json,m.records_json FROM rumble_intelligence_sources s LEFT JOIN rumble_intelligence_observations o ON o.id=s.current_id LEFT JOIN rumble_intelligence_sets m ON m.id=o.set_id WHERE s.source=?`).bind(source).first();
  if (!state?.id) return { ok: true, source, health: 'unavailable', current: null, accounts: [], history: [], attempt: state ? JSON.parse(state.attempt_json) : null };
  const current = { id: state.id, providerAt: state.provider_at, observedAt: state.observed_at, receivedAt: state.received_at, provenance: state.provenance, ...JSON.parse(state.metadata_json) };
  const roster = accounts(JSON.parse(state.records_json));
  const rawHistory = await db.prepare(`SELECT o.id,o.provider_at,o.observed_at,o.provenance,o.metadata_json,m.records_json FROM rumble_intelligence_observations o JOIN rumble_intelligence_sets m ON m.id=o.set_id WHERE o.source=? AND o.qualified=1 AND o.provider_at<=? ORDER BY o.provider_at DESC LIMIT 180`).bind(source, state.provider_at).all();
  const checkpoints = rawHistory.results.map(h => ({ id: h.id, providerAt: h.provider_at, observedAt: h.observed_at, provenance: h.provenance, metadata: JSON.parse(h.metadata_json), accounts: accounts(JSON.parse(h.records_json)) })).reverse();
  // Live/import duplicates at the same provider time are one confirmation.
  const distinct = [...new Map(checkpoints.map(h => [h.providerAt, h])).values()];
  const timeline = new Map(); const history = []; let previous = null;
  for (const h of distinct) {
    const names = new Set(h.accounts.map(a => a.name));
    history.push({ id: h.id, providerAt: h.providerAt, observedAt: h.observedAt, provenance: h.provenance, count: names.size, rawCount: h.metadata.rawCount, arrivals: previous ? [...names].filter(n => !previous.has(n)).length : null, removals: previous ? [...previous].filter(n => !names.has(n)).length : null, gapBefore: history.length ? Date.parse(h.providerAt) - Date.parse(history.at(-1).providerAt) > DAY : false });
    for (const a of h.accounts) { if (!timeline.has(a.name)) timeline.set(a.name, []); timeline.get(a.name).push({ at: h.providerAt, observedAt: h.observedAt, provenance: h.provenance, classification: a.classification, records: a.records }); }
    previous = names;
  }
  const all = new Map(roster.map(a => [a.name, { ...a, presence: 'Currently listed', current: true }]));
  for (const [name, sightings] of timeline) {
    const last = sightings.at(-1); const first = sightings[0];
    const missing = distinct.filter(h => h.providerAt > last.at && !h.accounts.some(a => a.name === name));
    if (!all.has(name)) all.set(name, { name, displayName: last.records[0].displayName, avatar: last.records[0].avatar, records: [], classification: last.classification, hasPaid: false, hasGifted: false, needsReview: false, current: false, presence: missing.length >= 2 ? 'No longer listed' : 'Missing — awaiting confirmation' });
    Object.assign(all.get(name), { timeline: sightings, firstObserved: first.at, lastObserved: last.at, firstMissing: missing[0]?.providerAt || null, confirmedMissing: missing[1]?.providerAt || null, hadPaid: sightings.some(s => s.records.some(r => r.classification === 'Self-paid')), hadGifted: sightings.some(s => s.records.some(r => r.classification === 'Gifted')) });
  }
  const counts = Object.fromEntries(['Self-paid', 'Gifted', 'Self-paid + gifted', 'Needs review'].map(label => [label, roster.filter(a => a.classification === label).length]));
  const attempt = JSON.parse(state.attempt_json);
  return { ok: true, source, label: attempt.label || source, health: Date.now() - Date.parse(state.provider_at) > 15 * 60000 ? 'stale' : attempt.qualified ? 'qualified' : 'degraded', attempt, current, counts, distinctCount: roster.length, accounts: [...all.values()], history, coverage: { limit: 180, from: history[0]?.providerAt, to: state.provider_at, bounded: rawHistory.results.length === 180 }, rule: RULE };
}
