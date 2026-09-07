import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { saveAutomationRule, listAutomationRules, botAutomationRules, ingestAutomationEvents, dryRunAutomation } from '../functions/_shared/automation-core.js';
import { validateRule, validateEvent } from '../functions/_shared/automation-contract.js';
import { defaultAction, calculateAward } from '../src/lib/automation-model.mjs';
import { errorResponse } from '../functions/_shared/auth-core.js';
import { applyMigration } from './auth-test-helpers.mjs';

const base = { name: 'Award rule', description: '', enabled: true, sourceScope: 'user:1sl8zm', eventType: 'rumble.gift_purchase', conditions: {}, actionType: 'wheel.add_actor', targetWheelId: 'award-wheel', duplicatePolicy: 'skip' };
const config = (mode = 'fixed', entries = 1, repeatActorPolicy = 'accumulate', unitCents = 100) => ({ version: 2, repeatActorPolicy, award: { mode, entriesPerUnit: entries, unitCents } });
const event = (rule, key, evidence, actorLabel = 'Alice') => ({ ruleId: rule.id, ruleRevision: rule.revision, eventType: rule.eventType, sourceScope: rule.sourceScope,
  actorLabel, actorKey: `rumble:${rule.sourceScope}:${actorLabel.normalize('NFKC').trim().toLowerCase()}`, eventFingerprint: createHash('sha256').update(String(key)).digest('hex'),
  providerEventAt: new Date(Date.now() + 1000).toISOString(), livestreamId: 'live-one', evidence });
const gifts = n => ({ totalGifts: n, giftType: 'random', videoId: 444666132 });
async function wheel(db) { await db.prepare(`INSERT INTO wheels(id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,created_at,updated_at)
  VALUES ('award-wheel','AWARD','award','Award Wheel','active','public','owner','{}',?,?)`).bind(new Date().toISOString(), new Date().toISOString()).run(); }

test('typed field errors, family restrictions, integer arithmetic and dry-run calculations', async () => {
  const missing = { ...base, name: '', sourceScope: '', targetWheelId: '', eventType: 'rumble.chat.exact', actionConfig: config('fixed', 0) };
  let failure; try { validateRule(missing); } catch (e) { failure = e; }
  const response = errorResponse(failure, new Request('https://admin.example.test'), {});
  assert.equal(response.status, 400);
  const json = await response.json(); assert.equal(json.error, 'automation_input_invalid');
  const fields = Object.fromEntries(json.issues.map(i => [i.field, i.message]));
  assert.equal(fields.sourceScope, 'Select a Rumble source.'); assert.equal(fields.targetWheelId, 'Choose a target Wheel.');
  assert.equal(fields.exactText, 'Enter the complete chat message to match.'); assert.ok(fields.name); assert.ok(fields.entriesPerUnit);
  for (const sourceScope of ['user:1sl8zm', 'channel:abc_123']) assert.equal(validateRule({ ...base, sourceScope }).sourceScope, sourceScope);
  for (const sourceScope of ['', '1788174504', 'user:', 'user:a b', 123, {}, 'user:a\n']) assert.throws(() => validateRule({ ...base, sourceScope }), e => e.code === 'automation_input_invalid');
  for (const entries of [-1, 0, .5, 100001, Number.MAX_SAFE_INTEGER, '5', null]) assert.throws(() => validateRule({ ...base, actionConfig: config('per_gift', entries) }));
  for (const unit of [0, -1, .5, 100000001, null]) assert.throws(() => validateRule({ ...base, eventType: 'rumble.rant', actionConfig: config('per_amount', 1, 'accumulate', unit) }));
  for (const eventType of ['rumble.follow', 'rumble.subscribe', 'rumble.chat.exact']) assert.throws(() => validateRule({ ...base, eventType, actionConfig: config('per_gift', 5) }));
  assert.throws(() => validateRule({ ...base, actionConfig: { ...config(), version: 99 } }));
  assert.throws(() => validateRule({ ...base, conditions: { livestreamId: '444666132' } }));
  for (const eventType of ['rumble.follow', 'rumble.subscribe']) assert.throws(() => validateRule({ ...base, eventType, conditions: { livestreamId: 'live-one' } }));
  assert.equal(calculateAward(config('per_gift', 3), base.eventType, gifts(10)).entries, 30);
  assert.equal(calculateAward(config('per_amount', 1), 'rumble.rant', { amountCents: 650 }).entries, 6);
  assert.equal(calculateAward(config('per_amount', 2), 'rumble.rant', { amountCents: 650, amountDollars: 99999 }).entries, 12);
  assert.equal(calculateAward(config('per_amount', 1), 'rumble.rant', { amountCents: 99 }).reason, 'no_complete_units');
  assert.equal(calculateAward(config('per_gift', 100000), base.eventType, gifts(2)).reason, 'award_limit_exceeded');
  for (const evidence of [{}, gifts(0), gifts(-1), gifts(1.5)]) assert.throws(() => validateEvent(event({ ...base, id: 'r', revision: 1 }, 'bad', evidence)));
  const dry = dryRunAutomation({ rule: { ...base, actionConfig: config('per_gift', 5) }, sample: { actorLabel: 'ExampleUser', totalGifts: 5 } });
  assert.equal(dry.entries, 25); assert.match(dry.action, /25 entries to purchaser/); assert.match(dry.calculation, /5 gifts × 5 = 25/);
  assert.equal(dryRunAutomation({ rule: { ...base, eventType: 'rumble.rant', actionConfig: config('per_amount', 3) }, sample: { amountCents: 500 } }).entries, 15);
});

test('local additive migration defaults, source discovery/cache and no raw runtime projection', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const env = commerceEnvironment(h), db = h.commerceDb;
  await wheel(db);
  assert.ok((await db.prepare('PRAGMA table_info(automation_rules)').all()).results.some(c => c.name === 'action_config_json'));
  assert.ok((await db.prepare('PRAGMA table_info(automation_receipts)').all()).results.some(c => c.name === 'awarded_entries'));
  assert.equal((await listAutomationRules(env)).discovery.source, null);
  const now = new Date().toISOString();
  const runtime = { pollingIntervalSeconds: 60, secret: 'must-never-project', rumbleDiscovery: { source: { scope: 'user:1sl8zm', id: '1sl8zm', type: 'user', displayName: 'ThirdRailify' }, observedAt: now, providerResponseAt: now, livestreams: [{ id: 'live-one', title: 'Third Rail Live', isLive: true }] } };
  await db.prepare(`INSERT INTO bot_runtime_heartbeat(singleton_id,startup_instance_id,bot_version,desired_revision,applied_revision,runtime_json,heartbeat_at,updated_at) VALUES (1,'test','test',1,1,?,?,?)`).bind(JSON.stringify(runtime), now, now).run();
  let result = await listAutomationRules(env); assert.equal(result.discovery.source.displayName, 'ThirdRailify'); assert.equal(result.discovery.discoveryState, 'online');
  assert.doesNotMatch(JSON.stringify(result.discovery), /must-never-project|secret|runtime_json/);
  let r = (await saveAutomationRule(env, 'admin', { ...base, sourceLabel: 'Forged label' })).rule;
  assert.deepEqual(r.actionConfig, defaultAction()); assert.equal(r.sourceLabel, 'ThirdRailify');
  await db.prepare('UPDATE bot_runtime_heartbeat SET heartbeat_at=?').bind(new Date(Date.now() - 100000).toISOString()).run();
  assert.equal((await listAutomationRules(env)).discovery.botState, 'stale');
  await db.prepare('UPDATE bot_runtime_heartbeat SET heartbeat_at=?').bind(new Date(Date.now() - 300000).toISOString()).run();
  assert.equal((await listAutomationRules(env)).discovery.botState, 'offline');
  await db.prepare('DELETE FROM bot_runtime_heartbeat').run();
  r = (await saveAutomationRule(env, 'admin', { ...r, sourceLabel: 'Forged again' })).rule;
  assert.equal(r.sourceLabel, 'ThirdRailify');
  r = (await saveAutomationRule(env, 'admin', { ...r, sourceScope: 'channel:custom' })).rule; assert.equal(r.sourceLabel, null);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});

test('0035 upgrades existing V1 rules and receipts without rewriting 0034 or losing history', async t => {
  const h = await createCommerceDatabases({ commerceMigrationCount: 34 }); t.after(h.dispose); const db = h.commerceDb;
  await wheel(db); const now = new Date().toISOString();
  const before = (await db.prepare('PRAGMA table_info(automation_rules)').all()).results;
  assert.ok(!before.some(c => c.name === 'action_config_json'));
  await db.prepare(`INSERT INTO automation_rules(id,name,description,source_scope,event_type,target_wheel_id,created_by_account_id,created_at,updated_at)
    VALUES ('legacy','Legacy','','user:1sl8zm','rumble.follow','award-wheel','admin',?,?)`).bind(now, now).run();
  await db.prepare(`INSERT INTO automation_receipts(id,rule_id,rule_revision,event_fingerprint,event_type,provider_event_at,actor_key,actor_label,outcome,target_wheel_id,created_at)
    VALUES ('legacy-receipt','legacy',1,?,'rumble.follow',?,'rumble:user:1sl8zm:alice','Alice','added','award-wheel',?)`).bind('a'.repeat(64), now, now).run();
  await applyMigration(db, h.commerceMigrations[34]);
  const rule = (await listAutomationRules(commerceEnvironment(h))).rules[0];
  assert.equal(rule.id, 'legacy'); assert.equal(rule.revision, 1); assert.deepEqual(rule.actionConfig, defaultAction());
  const receipt = await db.prepare("SELECT * FROM automation_receipts WHERE id='legacy-receipt'").first();
  assert.equal(receipt.event_fingerprint, 'a'.repeat(64)); assert.equal(receipt.awarded_entries, 1); assert.equal(receipt.action_result, 'created');
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});

test('weighted awards, distinct events, replay, thresholds, hidden normalization, limits, concurrency and atomic rollback', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const env = commerceEnvironment(h), db = h.commerceDb;
  await wheel(db);
  const save = async input => (await saveAutomationRule(env, 'admin', { ...base, ...input })).rule;
  const send = async e => (await ingestAutomationEvents(env, { events: [e] })).results[0].outcome;
  const row = async () => db.prepare("SELECT * FROM wheel_entries WHERE display_label='Alice'").first();
  let r = await save({ actionConfig: config('per_gift', 5), conditions: { minGifts: 2 } });
  assert.equal((await botAutomationRules(env)).rules[0].duplicatePolicy, 'skip', 'unchanged Bot projection accepts V1.1 rules; this token never executes awards');
  assert.equal(await send(event(r, 'too-small', gifts(1))), 'condition_rejected');
  const first = event(r, 'gift-a', gifts(2)), second = event(r, 'gift-b', gifts(3));
  assert.equal(await send(first), 'added'); assert.equal((await row()).weight, 10);
  assert.equal(await send(second), 'added'); assert.equal((await row()).weight, 25);
  assert.equal(await send(first), 'duplicate_event'); assert.equal(await send(second), 'duplicate_event'); assert.equal((await row()).weight, 25);
  const receipts = (await db.prepare('SELECT * FROM automation_receipts ORDER BY created_at,id').all()).results;
  assert.deepEqual(receipts.map(x => x.awarded_entries).sort((a,b) => a-b), [10, 15]); assert.ok(receipts.some(x => x.action_result === 'accumulated'));
  assert.equal((await db.prepare('SELECT revision FROM wheels').first()).revision, 3);
  assert.equal((await listAutomationRules(env)).rules[0].counters.executed, 2);
  r = await save({ eventType: 'rumble.rant', actionConfig: config('per_amount', 1), conditions: { minAmountCents: 100 } });
  assert.equal(await send(event(r, 'rant-a', { amountCents: 650 })), 'added');
  assert.equal(await send(event(r, 'rant-b', { amountCents: 250 })), 'added'); assert.equal((await row()).weight, 33);
  assert.equal(await send(event(r, 'rant-b', { amountCents: 250 })), 'duplicate_event');
  assert.equal(await send(event(r, 'rant-small', { amountCents: 99 })), 'condition_rejected');
  assert.equal(await send(event(r, 'rant-negative', { amountCents: -1 })), 'invalid_event');
  for (const [eventType, evidence] of [['rumble.chat.exact', { normalizedText: 'enter' }], ['rumble.follow', {}], ['rumble.subscribe', { amountCents: 0 }], ['rumble.rant', { amountCents: 0 }], ['rumble.gift_purchase', gifts(20)]]) {
    const rule = await save({ eventType, conditions: eventType === 'rumble.chat.exact' ? { exactText: 'ENTER' } : {}, actionConfig: config('fixed', 5) });
    assert.equal(await send(event(rule, eventType, evidence)), 'added');
  }
  assert.equal((await row()).weight, 58);
  const skip = await save({ actionConfig: config('fixed', 5, 'skip') });
  assert.equal(await send(event(skip, 'skip', gifts(5))), 'duplicate_entrant'); assert.equal((await row()).weight, 58);
  await db.prepare("UPDATE wheel_entries SET state='hidden',segment_colour='#ABCDEF'").run();
  await db.prepare('UPDATE wheels SET revision=revision+1,participant_count=0').run();
  assert.equal(await send(event(r, 'hidden', { amountCents: 200 }, 'Ａｌｉｃｅ')), 'added');
  assert.equal((await row()).weight, 60); assert.equal((await row()).state, 'hidden'); assert.equal((await row()).segment_colour, '#ABCDEF');
  assert.equal((await db.prepare('SELECT participant_count FROM wheels').first()).participant_count, 0);
  // A forced audit failure must roll back weight, receipt, counters and Wheel revision together.
  const snapshot = async () => ({ entry: await row(), wheel: await db.prepare('SELECT * FROM wheels').first(), rule: await db.prepare('SELECT * FROM automation_rules WHERE id=?').bind(r.id).first(), receipts: (await db.prepare('SELECT COUNT(*) n FROM automation_receipts').first()).n });
  const before = await snapshot();
  await db.prepare("CREATE TRIGGER award_rollback BEFORE INSERT ON wheel_audit_events BEGIN SELECT RAISE(ABORT,'rollback'); END").run();
  await assert.rejects(send(event(r, 'rollback', { amountCents: 200 }))); assert.deepEqual(await snapshot(), before);
  await db.prepare('DROP TRIGGER award_rollback').run();
  const simultaneous = await Promise.all([send(event(r, 'concurrent', { amountCents: 200 })), send(event(r, 'concurrent', { amountCents: 200 }))]);
  assert.equal(simultaneous.filter(x => x === 'added').length, 1); assert.equal((await row()).weight, 62);
  assert.equal((await db.prepare('SELECT duplicate_events FROM automation_rules WHERE id=?').bind(r.id).first()).duplicate_events, 2, 'both sequential and racing Rant replays are counted');
  const distinct = [event(r, 'distinct-a', { amountCents: 200 }), event(r, 'distinct-b', { amountCents: 300 })];
  const outcomes = await Promise.all(distinct.map(send)); for (let i=0; i<outcomes.length; i++) if (outcomes[i] === 'retry') assert.equal(await send(distinct[i]), 'added');
  assert.equal((await row()).weight, 67);
  await db.prepare('UPDATE wheel_entries SET weight=99999').run(); await db.prepare('UPDATE wheels SET revision=revision+1').run();
  assert.equal(await send(event(r, 'overweight', { amountCents: 200 })), 'wheel_unavailable'); assert.equal((await row()).weight, 99999);
  assert.equal((await db.prepare("SELECT action_result FROM automation_receipts WHERE event_fingerprint=?").bind(event(r,'overweight',{}).eventFingerprint).first()).action_result, 'weight_limit_exceeded');
  const huge = await save({ actionConfig: config('per_gift', 100000) }); assert.equal(await send(event(huge, 'huge', gifts(2), 'Bob')), 'wheel_unavailable');
  const partial = await save({ eventType: 'rumble.rant', actionConfig: config('per_amount', 1) }); assert.equal(await send(event(partial, 'partial', { amountCents: 99 }, 'Bob')), 'wheel_unavailable');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM wheel_entries').first()).n, 1);
  await db.prepare(`INSERT INTO wheel_settings(setting_key,value_json,revision,updated_at) VALUES ('global','{"maximumParticipants":1}',1,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1`).bind(new Date().toISOString()).run();
  const fixed = await save({ actionConfig: config('fixed', 1) });
  assert.equal(await send(event(fixed, 'capacity', gifts(1), 'Bob')), 'wheel_unavailable');
  assert.equal(await send(event(fixed, 'existing-at-capacity', gifts(1))), 'added'); assert.equal((await row()).weight, 100000);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});


test('optional Rant exact text accepts blank, omits its filter, and retains minimum cents', () => {
  for (const exactText of ['', '   ']) {
    const rule = { ...base, eventType: 'rumble.rant', conditions: { exactText, minAmountCents: 100 }, actionConfig: config('per_amount', 1) };
    assert.deepEqual(validateRule(rule).conditions, { minAmountCents: 100 });
    assert.equal(dryRunAutomation({ rule, sample: { actorLabel: 'ExampleUser', text: 'Any rant message', amountCents: 100 } }).matched, true);
    assert.equal(dryRunAutomation({ rule, sample: { actorLabel: 'ExampleUser', text: 'Different message', amountCents: 99 } }).matched, false);
    assert.throws(() => validateRule({ ...rule, eventType: 'rumble.chat.exact', conditions: { exactText }, actionConfig: config('fixed', 1) }));
  }
});
