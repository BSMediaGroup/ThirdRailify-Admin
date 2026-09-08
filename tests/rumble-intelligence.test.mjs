import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { applyMigration } from './auth-test-helpers.mjs';
import { accounts, amountClass, projectProvider, validateObservation, ingestIntelligence, intelligenceReport, intelligenceTrend } from '../functions/_shared/rumble-intelligence.js';
import { onRequest as reportRoute } from '../functions/api/admin/rumble-intelligence/[[path]].js';

const row = (name, amount, date = '2026-01-01T00:00:00Z') => ({ username: name, user: name, amount_cents: amount, subscribed_on: date });
const snapshot = (rows, now = 1788749506, extra = {}) => ({ user_id: '1sl8zm', channel_id: null, username: 'ThirdRailify', type: 'user', since: null, max_num_results: 50, now, subscribers: { num_subscribers: rows.length, recent_subscribers: rows, latest_subscriber: rows[0] }, ...extra });
const project = s => projectProvider(s, new Date().toISOString());
const migration = await readFile(new URL('../commerce-migrations/0045_rumble_intelligence.sql', import.meta.url), 'utf8');
async function harness(t) { const h = await createCommerceDatabases(); t.after(() => h.dispose()); await applyMigration(h.commerceDb, migration); return { ...h, env: commerceEnvironment(h) }; }

test('trend covers 90 days beyond recent history, samples actual observations and pins source/snapshot', async t => {
  const h = await harness(t), now = Math.floor(Date.now() / 1000) - 60;
  const send = (rows, at, extra) => ingestIntelligence(h.env, project(snapshot(rows, at, extra)));
  const old = await send([row('Old', 500)], now - 60 * 86400);
  const oldRow = await h.commerceDb.prepare('SELECT * FROM rumble_intelligence_observations WHERE id=?').bind(old.observationId).first();
  // More than the report drawer's 180 checkpoints: the chart must still find day -60.
  await h.commerceDb.batch(Array.from({ length: 185 }, (_, i) => h.commerceDb.prepare('INSERT INTO rumble_intelligence_observations(id,source,provider_at,observed_at,received_at,provenance,qualified,set_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)').bind(i.toString(16).padStart(64, '0'), oldRow.source, new Date((now - 86400 + i * 60) * 1000).toISOString(), oldRow.observed_at, oldRow.received_at, 'live', 1, oldRow.set_id, oldRow.metadata_json)));
  const rows = [row('Paid', 500), row('Gift', 0), row('Mixed', 0), row('Mixed', 500), row('Unknown', 499)];
  const current = await send(rows, now);
  await send([], now + 10, { since: 1 }); // Degraded observations cannot erase the chart.
  await send([], now, { user_id: 'vmzw3', username: 'Other' });
  const trend = await intelligenceTrend(h.env, 'user:1sl8zm', '90d', current.observationId);
  assert.equal(trend.points[0].at, oldRow.provider_at);
  assert.deepEqual(trend.points.at(-1), { at: new Date(now * 1000).toISOString(), provenance: 'live', total: 4, paid: 1, gifted: 1, mixed: 1, unknown: 1 });
  assert.ok(trend.points.length <= 3, 'No daily zero-fill for missing observations');
  for (const range of ['24h', '7d', '30d']) {
    const result = await intelligenceTrend(h.env, 'user:1sl8zm', range, current.observationId);
    assert.ok(result.points.every(p => p.at !== oldRow.provider_at));
    assert.ok(result.points.every(p => p.total === p.paid + p.gifted + p.mixed + p.unknown));
    assert.equal(result.points.at(-1).total, 4);
  }
  await send([], now + 20);
  assert.equal((await intelligenceTrend(h.env, 'user:1sl8zm', '24h', current.observationId)).points.at(-1).total, 4, 'New snapshots cannot change a pinned chart');
  await assert.rejects(intelligenceTrend(h.env, 'user:1sl8zm', '365d', current.observationId));
  await assert.rejects(intelligenceTrend(h.env, 'user:vmzw3', '90d', current.observationId));
});

test('all original samples reconcile source, provider time, full counts and latest classifications', async () => {
  const expected = [['RUMBLE_API_OUTPUT_SAMPLE.json', 'user:1sl8zm', 132, 126], ['RUMBLE_OUTPUT_WITH_CHATS.json', 'user:vmzw3', 33, 33], ['RUMBLE_OUTPUT_WITH_EVENTS.json', 'user:1sl8zm', 137, 131], ['RUMBLE_OUTPUT_WITH_RAID.json', 'user:1sl8zm', 122, 116]];
  for (const [file, source, raw, names] of expected) {
    const input = JSON.parse(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    const v = await validateObservation(project(input));
    assert.equal(v.source, source); assert.equal(v.providerAt, new Date(input.now * 1000).toISOString()); assert.equal(v.qualified, true); assert.equal(v.metadata.rawCount, raw);
    const a = accounts(v.records); assert.equal(a.length, names);
    if (raw === 122) assert.deepEqual(['Self-paid', 'Gifted', 'Self-paid + gifted'].map(label => a.filter(p => p.classification === label).length), [9, 105, 2]);
  }
});

test('raw amount, duplicate normalization, multiple records and 30-day semantics', async () => {
  assert.deepEqual([500, 0, null, undefined, '500', false, 499, 500.1].map(amountClass), ['Self-paid', 'Gifted', 'Needs review', 'Needs review', 'Needs review', 'Needs review', 'Needs review', 'Needs review']);
  const v = await validateObservation(project(snapshot([row(' Person ', 500), row('PERSON', 500), row('Person', 0, '2026-02-01T00:00:00Z')])));
  assert.equal(v.records.length, 2); assert.equal(v.metadata.duplicateRows, 1); assert.equal(accounts(v.records)[0].classification, 'Self-paid + gifted');
  assert.equal(v.records.find(r => r.amount === 500).reviewAt, '2026-01-31T00:00:00.000Z'); assert.equal(v.qualified, true);
});

test('missing, malformed, filtered, truncated are degraded; valid empty qualifies', async () => {
  for (const extra of [{ subscribers: null }, { subscribers: { num_subscribers: 1, recent_subscribers: [] } }, { since: 123 }, { truncated: true }, { type: 'channel' }]) assert.equal((await validateObservation(project(snapshot([], undefined, extra)))).qualified, false);
  assert.equal((await validateObservation(project(snapshot([])))).qualified, true);
});

test('atomic history: paid plus gift, absence confirmation, return, retries, older history and source isolation', async t => {
  const h = await harness(t); const send = (rows, now, extra) => ingestIntelligence(h.env, project(snapshot(rows, now, extra)));
  const paid = row('Person', 500), gift = row('Person', 0, '2026-02-01T00:00:00Z');
  await send([paid, gift], 1788749506); let r = await intelligenceReport(h.env); assert.equal(r.accounts[0].classification, 'Self-paid + gifted'); assert.equal(r.history[0].arrivals, null);
  await send([gift], 1788749566); r = await intelligenceReport(h.env); assert.equal(r.accounts[0].classification, 'Gifted'); assert.equal(r.accounts[0].hadPaid, true);
  const unchanged = await send([gift], 1788749626); await Promise.all([send([gift], 1788749626), send([gift], 1788749626)]);
  assert.equal((await intelligenceReport(h.env)).history.length, 3);
  await send([], 1788749686, { since: 1 }); assert.equal((await intelligenceReport(h.env)).current.id, unchanged.observationId);
  await send([], 1788749746); r = await intelligenceReport(h.env); assert.equal(r.accounts[0].presence, 'Missing — awaiting confirmation');
  await send([], 1788749746); assert.equal((await intelligenceReport(h.env)).accounts[0].confirmedMissing, null);
  await send([], 1788749806); assert.equal((await intelligenceReport(h.env)).accounts[0].presence, 'No longer listed');
  await send([paid], 1788749866); r = await intelligenceReport(h.env); assert.equal(r.accounts[0].classification, 'Self-paid'); assert.equal(r.accounts[0].hadGifted, true);
  await ingestIntelligence(h.env, project(snapshot([gift], 1788749000)), { provenance: 'historical', accountId: 'local-importer' });
  assert.equal((await intelligenceReport(h.env)).current.id, r.current.id);
  await send([gift], 1788749900, { user_id: 'vmzw3', username: 'danielclancy' }); assert.equal((await intelligenceReport(h.env)).current.id, r.current.id);
  assert.equal((await intelligenceReport(h.env, 'user:vmzw3')).accounts[0].classification, 'Gifted');
  assert.equal((await h.commerceDb.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  for (const table of ['automation_receipts', 'poll_votes']) assert.equal((await h.commerceDb.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n, 0);
});

test('new unchanged observations reuse sets; older and failed batch cannot replace current', async t => {
  const h = await harness(t); const input = snapshot([row('Person', 500)]);
  await ingestIntelligence(h.env, project(input)); await ingestIntelligence(h.env, project({ ...input, now: input.now + 60 }));
  assert.equal((await h.commerceDb.prepare('SELECT COUNT(*) n FROM rumble_intelligence_sets').first()).n, 1);
  const before = await intelligenceReport(h.env);
  let batches = 0;
  const db = new Proxy(h.commerceDb, { get(target, key) { if (key === 'batch') return statements => target.batch(++batches > 1 ? [...statements, target.prepare('INSERT INTO rumble_intelligence_sets(id,source,records_json,created_at) VALUES(NULL,NULL,NULL,NULL)')] : statements); const v = target[key]; return typeof v === 'function' ? v.bind(target) : v; } });
  await assert.rejects(ingestIntelligence({ ...h.env, THIRDRAILIFY_COMMERCE_DB: db }, project(snapshot([], input.now + 120))));
  assert.equal((await intelligenceReport(h.env)).current.id, before.current.id);
});

test('private report rejects unsigned requests before reading the roster; schema unavailable writes nothing', async t => {
  const h = await createCommerceDatabases(); t.after(() => h.dispose()); const env = commerceEnvironment(h);
  const response = await reportRoute({ env, request: new Request('https://thirdrailify-admin.pages.dev/api/admin/rumble-intelligence') }); assert.equal(response.status, 401); assert.match(response.headers.get('content-type'), /json/);
  await assert.rejects(ingestIntelligence(env, project(snapshot([]))), e => e.code === 'intelligence_schema_unavailable');
});
