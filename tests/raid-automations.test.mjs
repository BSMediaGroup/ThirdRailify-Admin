import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { applyMigration } from './auth-test-helpers.mjs';
import { saveAutomationRule, listAutomationRules, botAutomationRules, ingestAutomationEvents, dryRunAutomation, automationReadiness } from '../functions/_shared/automation-core.js';
import { validateRule, validateEvent } from '../functions/_shared/automation-contract.js';
import { onRequest } from '../functions/api/internal/bot/[[path]].js';
import { recordBotHeartbeat } from '../functions/_shared/polls-core.js';

const base = { name: 'Raid notice', description: '', enabled: false, sourceScope: 'user:fixture', eventType: 'rumble.raid.received', conditions: {}, actionType: 'wheel.add_actor', targetWheelId: 'raid-wheel', actionConfig: { version: 2, repeatActorPolicy: 'accumulate', award: { mode: 'fixed', entriesPerUnit: 10, unitCents: 100 } } };
async function wheel(db) {
  await db.prepare(`INSERT INTO wheels(id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,created_at,updated_at)
    VALUES ('raid-wheel','W-RAID','raid','Raid local','active','public','owner','{}',?,?)`).bind(new Date().toISOString(), new Date().toISOString()).run();
}
const event = (r, timestamp = new Date().toISOString(), text = 'has raided this stream!') => {
  const e = { ruleId: r.id, ruleRevision: r.revision, eventType: r.eventType, sourceScope: r.sourceScope, livestreamId: 'fixture-stream', actorLabel: 'ExampleRaider', actorKey: 'rumble:user:fixture:exampleraider', providerEventAt: timestamp, evidence: { announcement: text, detectionMethod: 'chat-announcement-v1' } };
  e.eventFingerprint = createHash('sha256').update(JSON.stringify(['rumble-raid-notice-v1', e.sourceScope, e.livestreamId, 'exampleraider', timestamp, text])).digest('hex'); return e;
};
const signed = input => JSON.parse(execFileSync('X:/GIT/THIRD-RAIL-BOT/.venv/Scripts/python.exe', ['-m', 'tests.emit_raid_envelope'], { cwd: 'X:/GIT/THIRD-RAIL-BOT', input: JSON.stringify(input), encoding: 'utf8' }));

test('fixed-only raid contract and exact dry run, with no authenticity claim', () => {
  assert.equal(validateRule(base).actionConfig.award.entriesPerUnit, 10);
  for (const mode of ['per_gift', 'per_amount']) assert.throws(() => validateRule({ ...base, actionConfig: { ...base.actionConfig, award: { ...base.actionConfig.award, mode } } }));
  for (const text of ['has raided this stream!', ' HAS RAIDED THIS STREAM! ', 'ｈａｓ ｒａｉｄｅｄ ｔｈｉｓ ｓｔｒｅａｍ！']) {
    const result = dryRunAutomation({ rule: base, sample: { text, actorLabel: 'ExampleRaider', livestreamId: 'fixture-stream' } });
    assert.equal(result.matched, true); assert.equal(result.entries, 10); assert.match(result.classification, /not independently verified/);
  }
  for (const text of ['I think someone has raided this stream!', 'wesrev has raided this stream!', 'has raided this stream', 'has raided this stream!!', ':RAID: :RAID:', ':RUMBLERAID:', '@wesrev is raiding the channel! BRR BRR BRR BRRRRRRR!!']) assert.equal(dryRunAutomation({ rule: base, sample: { text } }).matched, false);
  const e = event({ ...base, id: 'r', revision: 1 });
  for (const patch of [{ actorKey: 'rumble:user:fixture:streambot' }, { evidence: { ...e.evidence, detectionMethod: 'native' } }, { evidence: { ...e.evidence, totalGifts: 10 } }, { evidence: { ...e.evidence, announcement: 'has raided this stream!!' } }, { livestreamId: '' }]) assert.throws(() => validateEvent({ ...e, ...patch }));
});

test('0036 preserves 0035 awards, receipts, foreign keys, constraints and reports readiness', async t => {
  const h = await createCommerceDatabases({ commerceMigrationCount: 35 }); t.after(h.dispose); const db = h.commerceDb, env = commerceEnvironment(h);
  await wheel(db);
  const old = (await saveAutomationRule(env, 'admin', { ...base, eventType: 'rumble.follow', enabled: true })).rule;
  await ingestAutomationEvents(env, { events: [{ ...event(old), evidence: {} }] });
  const before = await db.prepare('SELECT * FROM automation_receipts').all();
  assert.equal((await automationReadiness(env)).raidSchema, false);
  await assert.rejects(saveAutomationRule(env, 'admin', base), e => e.issues?.[0].field === 'eventType');
  await applyMigration(db, h.commerceMigrations[35]);
  assert.deepEqual((await db.prepare('SELECT * FROM automation_receipts').all()).results, before.results);
  assert.deepEqual((await listAutomationRules(env)).rules[0].actionConfig, base.actionConfig);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  await assert.rejects(db.prepare("UPDATE automation_rules SET event_type='invented'").run());
  assert.equal((await automationReadiness(env)).raidStatus, 'pending_capable_bot');
  await recordBotHeartbeat(env, { startupInstanceId: 'local-instance', botVersion: '1.1.0', desiredRevision: 0, appliedRevision: 0, runtime: { eventAutomation: { raidNoticeVersion: 1 } } });
  assert.equal((await automationReadiness(env)).raidStatus, 'ready');
});

test('actual Python adapter/matcher/signed client to Admin HMAC and local D1; replay with fresh nonce', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const db = h.commerceDb;
  const env = commerceEnvironment(h, { THIRDRAILIFY_BOT_ADMIN_SECRET: 'raid-local-test-secret' }); await wheel(db);
  let r = (await saveAutomationRule(env, 'admin', base)).rule;
  assert.equal((await listAutomationRules(env)).rules[0].runtimeStatus, 'pending_capable_bot');
  const oldNotice = event(r, '2000-01-01T00:00:00Z');
  r = (await saveAutomationRule(env, 'admin', { ...r, enabled: true })).rule;
  assert.equal((await botAutomationRules(env)).rules.length, 0, 'legacy Bot never sees new enum');
  const projection = await botAutomationRules(env, true); assert.equal(projection.rules.length, 1);
  const activation = r.activatedAt;
  assert.equal((await botAutomationRules(env, true)).rules[0].activatedAt, activation);
  const snapshot = JSON.parse(await readFile('X:/GIT/THIRD-RAIL-BOT/tests/fixtures/rumble-raid-notice-v1.json', 'utf8'));
  const rows = snapshot.livestreams[0].chat.recent_messages;
  rows[0].created_on = new Date(Date.now() + 1000).toISOString();
  snapshot.livestreams[0].chat.latest_message = rows[0];
  const [envelope] = signed({ snapshot, rules: projection.rules }); assert.ok(envelope);
  assert.equal(JSON.parse(envelope.body).events.length, 1);
  const dispatch = value => onRequest({ request: new Request(env.THIRDRAILIFY_ADMIN_ORIGIN + '/api/internal/bot/events', { method: 'POST', headers: value.headers, body: value.body }), env });
  const firstResponse = await dispatch(envelope); assert.equal(firstResponse.status, 200); assert.equal((await firstResponse.json()).results[0].outcome, 'added');
  assert.equal((await dispatch(envelope)).status, 409, 'request nonce replay');
  const parsed = JSON.parse(envelope.body);
  const [replay] = signed(parsed); assert.notEqual(replay.headers['X-ThirdRailify-Request-Id'], envelope.headers['X-ThirdRailify-Request-Id']);
  assert.equal((await (await dispatch(replay)).json()).results[0].outcome, 'duplicate_event');
  rows[0].created_on = new Date(Date.now() + 2000).toISOString();
  const [later] = signed({ snapshot, rules: projection.rules });
  assert.equal((await (await dispatch(later)).json()).results[0].outcome, 'added');
  assert.equal((await db.prepare('SELECT weight FROM wheel_entries').first()).weight, 20);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM automation_receipts').first()).n, 2);
  assert.equal((await db.prepare('SELECT executed FROM automation_rules').first()).executed, 2);
  const bad = { ...replay, body: replay.body.replace('ExampleRaider', 'ForgedRaider') };
  assert.notEqual((await dispatch(bad)).status, 200);
  const send = async e => (await ingestAutomationEvents(env, { events: [e] })).results[0].outcome;
  assert.equal(await send({ ...oldNotice, ruleRevision: r.revision }), 'before_activation');
  assert.equal(await send({ ...parsed.events[0], eventFingerprint: 'f'.repeat(64) }), 'invalid_event');
  assert.equal(await send({ ...parsed.events[0], ruleRevision: 1 }), 'stale_revision');
  r = (await saveAutomationRule(env, 'admin', { ...r, enabled: false })).rule;
  assert.equal(await send({ ...parsed.events[0], ruleRevision: r.revision }), 'inactive_rule');
  r = (await saveAutomationRule(env, 'admin', { ...r, enabled: true, conditions: { livestreamId: 'other-stream' } })).rule;
  assert.equal(await send(event(r, new Date(Date.now() + 3000).toISOString())), 'condition_rejected');
});

test('raid concurrent duplicate, later actor accumulation, hidden state and atomic rollback', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const env = commerceEnvironment(h), db = h.commerceDb; await wheel(db);
  const r = (await saveAutomationRule(env, 'admin', { ...base, enabled: true })).rule;
  const send = async e => (await ingestAutomationEvents(env, { events: [e] })).results[0].outcome;
  const e = event(r, new Date(Date.now() + 1000).toISOString());
  const results = await Promise.all([send(e), send(e)]); assert.equal(results.filter(x => x === 'added').length, 1);
  await db.prepare("UPDATE wheel_entries SET state='hidden'").run();
  await send(event(r, new Date(Date.now() + 2000).toISOString()));
  assert.deepEqual(await db.prepare('SELECT weight,state FROM wheel_entries').first(), { weight: 20, state: 'hidden' });
  const prior = await db.prepare('SELECT revision FROM wheels').first();
  await db.prepare("CREATE TRIGGER raid_rollback BEFORE INSERT ON wheel_audit_events BEGIN SELECT RAISE(ABORT, 'rollback'); END").run();
  await assert.rejects(send(event(r, new Date(Date.now() + 3000).toISOString())));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM automation_receipts').first()).n, 2);
  assert.deepEqual(await db.prepare('SELECT revision FROM wheels').first(), prior);
  assert.equal((await db.prepare('SELECT weight FROM wheel_entries').first()).weight, 20);
});

test('per-rule overlap, pre-activation history after re-enable, and fresh schema batch upgrade', async t => {
  const h = await createCommerceDatabases({ commerceMigrationCount: 35 }); t.after(h.dispose); const env = commerceEnvironment(h), db = h.commerceDb;
  // Exercise the complete upgrade as one D1 batch, as well as the maintained sequential migration harness above.
  const statements = h.commerceMigrations[35].split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean);
  await db.batch(statements.map(s => db.prepare(s)));
  await wheel(db);
  let r = (await saveAutomationRule(env, 'admin', { ...base, enabled: true })).rule;
  const e = event(r, new Date(Date.now() + 1000).toISOString(), '\t HAS RAIDED THIS STREAM! \n');
  const send = async value => (await ingestAutomationEvents(env, { events: [value] })).results[0].outcome;
  assert.equal(await send(e), 'added');
  const exact = (await saveAutomationRule(env, 'admin', { ...base, name: 'Deliberate overlap', eventType: 'rumble.chat.exact', conditions: { exactText: 'has raided this stream!' }, enabled: true })).rule;
  assert.equal(await send({ ...e, ruleId: exact.id, ruleRevision: exact.revision, eventType: exact.eventType, evidence: { normalizedText: 'has raided this stream!' } }), 'added');
  assert.equal((await db.prepare('SELECT weight FROM wheel_entries').first()).weight, 20);
  r = (await saveAutomationRule(env, 'admin', { ...r, enabled: false })).rule;
  r = (await saveAutomationRule(env, 'admin', { ...r, enabled: true })).rule;
  const before = event(r, new Date(Date.parse(r.activatedAt) - 1).toISOString());
  assert.equal(await send(before), 'before_activation');
  // Dedupe remains per rule and independent of its revision; the old event cannot award again.
  assert.equal(await send({ ...e, ruleRevision: r.revision }), 'duplicate_event');
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});
