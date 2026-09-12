import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { applyMigration } from './auth-test-helpers.mjs';
import { ingestIntelligence, projectProvider } from '../functions/_shared/rumble-intelligence.js';
import { listRosterRules, previewRosterSync, saveRosterRule, syncRosterRule } from '../functions/_shared/subscriber-roster.js';

const source = 'user:fixture';
const record = (username, amount, second = 0) => ({ user: `${username}-id`, username, amount_cents: amount, subscribed_on: new Date(Date.UTC(2026, 8, 12, 0, 0, second)).toISOString() });
const ruleInput = (wheelId, extra = {}) => ({ name: 'Fixture self-paid roster', sourceScope: source, targetWheelId: wheelId, enabled: true, syncMode: 'add_missing', entriesPerMember: 1, minimumQuality: 'qualified_live_current', appearance: null, ...extra });

function meter(db) {
  const cost = { queries: 0, writes: 0, reads: 0, mutations: 0 };
  const record = result => { for (const row of Array.isArray(result) ? result : [result]) { cost.queries++; cost.writes += row?.meta?.rows_written || 0; cost.reads += row?.meta?.rows_read || 0; cost.mutations += row?.meta?.changes || 0; } return result; };
  return { cost, prepare: (...args) => { let statement = db.prepare(...args); const wrapper = { bind: (...values) => { statement = statement.bind(...values); return wrapper; }, run: async () => record(await statement.run()), all: async () => record(await statement.all()), first: async (...values) => { const result = record(await statement.all()); return values.length ? result.results[0]?.[values[0]] ?? null : result.results[0] ?? null; }, get raw() { return statement; } }; return wrapper; }, batch: async statements => record(await db.batch(statements.map(statement => statement.raw))) };
}

async function setup(t) {
  const h = await createCommerceDatabases(); t.after(h.dispose); const env = commerceEnvironment(h), db = h.commerceDb;
  for (const file of ['0045_rumble_intelligence.sql', '0048_subscriber_roster_automation.sql']) await applyMigration(db, await readFile(new URL(`../commerce-migrations/${file}`, import.meta.url), 'utf8'));
  const now = new Date().toISOString();
  for (const id of ['roster-wheel', 'second-wheel', 'rollback-wheel']) await db.prepare(`INSERT INTO wheels(id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,created_at,updated_at)
    VALUES (?,?,?,?, 'active','hidden','owner','{}',?,?)`).bind(id, `W-${id}`, id, id, now, now).run();
  let tick = Math.floor(Date.now() / 1000) - 120;
  const ingest = async (records, extra = {}, targetEnv = env) => {
    tick += 1;
    const payload = { user_id: 'fixture', channel_id: null, username: 'Fixture', type: 'user', since: null, max_num_results: 50, now: tick, subscribers: { num_subscribers: records.length, recent_subscribers: records, latest_subscriber: records[0] }, ...extra };
    return ingestIntelligence(targetEnv, projectProvider(payload, new Date(tick * 1000 + 1000).toISOString()));
  };
  return { ...h, env, db, ingest };
}

test('roster classifies, deduplicates, writes only deltas and preserves unrelated weight and styling', async t => {
  const h = await setup(t);
  await h.ingest([record('Alice', 500), record('Alice', 500, 1), record('Mixed', 500), record('Mixed', 0, 1), record('Gifted', 0), record('Review', 499)]);
  let rule = (await saveRosterRule(h.env, 'admin', ruleInput('roster-wheel'))).rule;
  let plan = await previewRosterSync(h.env, rule.id);
  assert.deepEqual(plan.authority.counts, { eligible: 2, giftedExcluded: 1, mixedCurrent: 1, reviewExcluded: 1 });
  assert.deepEqual(plan.delta.added.map(item => item.displayName).sort(), ['Alice', 'Mixed']);
  let applied = await syncRosterRule(h.env, 'admin', { ruleId: rule.id, revision: rule.revision });
  assert.equal(applied.counts.added, 2);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM wheel_entries WHERE wheel_id=?').bind('roster-wheel').first()).n, 2);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM wheel_entry_contributions WHERE rule_id=?').bind(rule.id).first()).n, 2);

  rule = (await listRosterRules(h.env, '', rule.id)).rules[0];
  const stable = await h.db.prepare('SELECT revision,updated_at FROM wheels WHERE id=?').bind('roster-wheel').first();
  const contributionStable = (await h.db.prepare('SELECT id,entry_id,weight,updated_at FROM wheel_entry_contributions WHERE rule_id=? ORDER BY id').bind(rule.id).all()).results;
  const syncCount = (await h.db.prepare('SELECT COUNT(*) n FROM subscriber_roster_syncs WHERE rule_id=?').bind(rule.id).first()).n;
  const measuredDb = meter(h.db), measuredEnv = { ...h.env, THIRDRAILIFY_COMMERCE_DB: measuredDb };
  await syncRosterRule(measuredEnv, 'admin', { ruleId: rule.id, revision: rule.revision }); // warm readiness
  Object.keys(measuredDb.cost).forEach(key => { measuredDb.cost[key] = 0; }); const started = performance.now();
  for (let index = 0; index < 100; index += 1) {
    const result = await syncRosterRule(measuredEnv, 'admin', { ruleId: rule.id, revision: rule.revision });
    assert.equal(result.noOp, true);
  }
  const unchangedCost = { ...measuredDb.cost, durationMs: performance.now() - started };
  assert.equal(unchangedCost.writes, 0); assert.equal(unchangedCost.mutations, 0); t.diagnostic(`100 unchanged roster evaluations: ${JSON.stringify(unchangedCost)}`);
  assert.deepEqual(await h.db.prepare('SELECT revision,updated_at FROM wheels WHERE id=?').bind('roster-wheel').first(), stable, '100 unchanged evaluations perform zero Wheel writes');
  assert.deepEqual((await h.db.prepare('SELECT id,entry_id,weight,updated_at FROM wheel_entry_contributions WHERE rule_id=? ORDER BY id').bind(rule.id).all()).results, contributionStable);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM subscriber_roster_syncs WHERE rule_id=?').bind(rule.id).first()).n, syncCount, 'no per-poll audit growth');

  Object.keys(measuredDb.cost).forEach(key => { measuredDb.cost[key] = 0; });
  await h.ingest([record('Alice', 500), record('Mixed', 500), record('Mixed', 0, 1), record('Different Gift', 0), record('Review', 499)], {}, measuredEnv);
  t.diagnostic(`one gifted-only snapshot change: ${JSON.stringify(measuredDb.cost)}`);
  const afterGiftOnly = await h.db.prepare('SELECT revision,updated_at FROM wheels WHERE id=?').bind('roster-wheel').first();
  assert.deepEqual(afterGiftOnly, stable, 'gift-only semantic changes perform zero Wheel membership writes');
  await h.ingest([record('Mixed', 500), record('Different Gift', 0)]);
  assert.ok(await h.db.prepare('SELECT id FROM wheel_entry_contributions WHERE rule_id=? AND actor_key=?').bind(rule.id, `rumble:${source}:alice`).first(), 'Add Missing mode never removes');
  Object.keys(measuredDb.cost).forEach(key => { measuredDb.cost[key] = 0; });
  await h.ingest([record('Alice', 500), record('Mixed', 500), record('New Paid', 500), record('Different Gift', 0)], {}, measuredEnv);
  t.diagnostic(`one self-paid addition snapshot: ${JSON.stringify(measuredDb.cost)}`);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM wheel_entry_contributions WHERE rule_id=?').bind(rule.id).first()).n, 3, 'one new self-paid member creates one contribution');

  rule = (await listRosterRules(h.env, '', rule.id)).rules[0];
  rule = (await saveRosterRule(h.env, 'admin', { ...rule, enabled: false })).rule;
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM wheel_entry_contributions WHERE rule_id=?').bind(rule.id).first()).n, 3, 'disabling does not destroy contributions');
  rule = (await saveRosterRule(h.env, 'admin', { ...rule, enabled: true })).rule;
  rule = (await saveRosterRule(h.env, 'admin', { ...rule, syncMode: 'exact_managed' })).rule;
  const alice = await h.db.prepare("SELECT e.* FROM wheel_entries e JOIN wheel_entry_contributions c ON c.entry_id=e.id WHERE c.rule_id=? AND c.actor_key=?").bind(rule.id, `rumble:${source}:alice`).first();
  await h.db.prepare("UPDATE wheel_entries SET weight=3,segment_colour='#ABCDEF',display_label='Styled Alice' WHERE id=?").bind(alice.id).run();
  Object.keys(measuredDb.cost).forEach(key => { measuredDb.cost[key] = 0; });
  await h.ingest([record('Mixed', 500), record('New Paid', 500), record('Gifted', 0)], {}, measuredEnv);
  t.diagnostic(`one exact managed removal snapshot: ${JSON.stringify(measuredDb.cost)}`);
  const retained = await h.db.prepare('SELECT * FROM wheel_entries WHERE id=?').bind(alice.id).first();
  assert.equal(retained.weight, 2, 'only the roster-owned weight was removed');
  assert.equal(retained.display_label, 'Styled Alice'); assert.equal(retained.segment_colour, '#ABCDEF');
  assert.equal(await h.db.prepare('SELECT id FROM wheel_entry_contributions WHERE rule_id=? AND entry_id=?').bind(rule.id, alice.id).first(), null);
  assert.equal((await h.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});

test('roster reuses one exact event identity, blocks unsafe removals, and serializes competing syncs', async t => {
  const h = await setup(t);
  await h.ingest([record('Event Actor', 500), record('Stale Actor', 500)]);
  // Exact automation identity for a Rant by Event Actor; no receipt-history inference is needed.
  const material = JSON.stringify([1, source, `rumble:${source}:event actor`, 'rumble.rant']);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
  const key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  await h.db.prepare(`INSERT INTO wheel_entries(id,wheel_id,display_label,display_order,weight,state,created_at,updated_at,entrant_identity_json)
    VALUES ('event-entry','second-wheel','Event Actor',0,4,'active','now','now',?)`).bind(JSON.stringify({ version: 1, type: 'rant', origin: 'automation', key })).run();
  let rule = (await saveRosterRule(h.env, 'admin', ruleInput('second-wheel', { syncMode: 'exact_managed', entriesPerMember: 2 }))).rule;
  const raced = await Promise.allSettled([syncRosterRule(h.env, 'admin-a', { ruleId: rule.id, revision: rule.revision }), syncRosterRule(h.env, 'admin-b', { ruleId: rule.id, revision: rule.revision })]);
  assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await h.db.prepare("SELECT weight FROM wheel_entries WHERE id='event-entry'").first()).weight, 6, 'event plus roster weight is summed on one entrant');
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM wheel_entry_contributions WHERE rule_id=?').bind(rule.id).first()).n, 2, 'no double contribution');

  rule = (await listRosterRules(h.env, '', rule.id)).rules[0];
  rule = (await saveRosterRule(h.env, 'admin', { ...rule, enabled: false })).rule;
  await h.ingest([record('Event Actor', 500)]);
  rule = (await saveRosterRule(h.env, 'admin', { ...rule, enabled: true })).rule;
  await h.ingest([], { since: 1 });
  const blocked = await previewRosterSync(h.env, rule.id);
  assert.equal(blocked.removalBlocked, true);
  await syncRosterRule(h.env, 'admin', { ruleId: rule.id, revision: rule.revision });
  assert.ok(await h.db.prepare('SELECT id FROM wheel_entry_contributions WHERE rule_id=? AND actor_key LIKE ?').bind(rule.id, '%stale actor').first(), 'degraded attempt cannot remove roster weight');
});

test('failed roster batch rolls back rule, Wheel, entry and contribution changes', async t => {
  const h = await setup(t); await h.ingest([record('Rollback', 500)]);
  const rule = (await saveRosterRule(h.env, 'admin', ruleInput('rollback-wheel'))).rule;
  const beforeRule = await h.db.prepare('SELECT * FROM subscriber_roster_rules WHERE id=?').bind(rule.id).first();
  const beforeWheel = await h.db.prepare('SELECT * FROM wheels WHERE id=?').bind('rollback-wheel').first();
  await h.db.prepare("CREATE TRIGGER roster_rollback BEFORE INSERT ON wheel_entry_contributions BEGIN SELECT RAISE(ABORT,'rollback'); END").run();
  await assert.rejects(syncRosterRule(h.env, 'admin', { ruleId: rule.id, revision: rule.revision }));
  const failedRule = await h.db.prepare('SELECT * FROM subscriber_roster_rules WHERE id=?').bind(rule.id).first();
  assert.equal(failedRule.revision, beforeRule.revision); assert.equal(failedRule.failures, beforeRule.failures + 1); assert.equal(failedRule.last_result, 'failed');
  assert.deepEqual(await h.db.prepare('SELECT * FROM wheels WHERE id=?').bind('rollback-wheel').first(), beforeWheel);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM wheel_entries WHERE wheel_id=?').bind('rollback-wheel').first()).n, 0);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM wheel_entry_contributions WHERE rule_id=?').bind(rule.id).first()).n, 0);
});
