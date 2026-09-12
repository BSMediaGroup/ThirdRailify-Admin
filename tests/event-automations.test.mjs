import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { saveAutomationRule, deleteAutomationRule, listAutomationRules, botAutomationRules, ingestAutomationEvents, dryRunAutomation } from '../functions/_shared/automation-core.js';
import { validateRule, validateEvent } from '../functions/_shared/automation-contract.js';
import { onRequest as botRequest } from '../functions/api/internal/bot/[[path]].js';
import { onRequest as adminRequest } from '../functions/api/admin/automations/[[path]].js';
import { createSession } from '../functions/_shared/auth-core.js';
import { cookiePair, jsonRequest } from './auth-test-helpers.mjs';

const base = { name: 'New follower entries', description: '', enabled: true, sourceScope: 'user:fixture', eventType: 'rumble.follow', conditions: {}, actionType: 'wheel.add_actor', targetWheelId: 'wheel-fixture', duplicatePolicy: 'skip' };
test('confirmed redacted provider sample distinguishes gifted recipients from paid subscriber events', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/rumble-events-v1.json', import.meta.url), 'utf8'));
  const events = JSON.parse(await readFile(new URL('./fixtures/rumble-event-envelopes-v1.json', import.meta.url), 'utf8'));
  assert.equal(events.length, 5);
  for (const e of events.filter(item => item.eventType !== 'subscriber_gifted_recipient')) assert.equal(validateEvent(e), e);
  const giftedRecipient = events.find(e => e.eventType === 'subscriber_gifted_recipient');
  assert.throws(() => validateEvent(giftedRecipient), error => error.code === 'automation_event_invalid');
  const gift = events.find(e => e.eventType === 'rumble.gift_purchase');
  const raw = fixture.gifted_subs.recent_gifted_subs[0];
  const material = ['rumble-event-v1', 'rumble.gift_purchase', 'user:fixture', 'sample viewer', raw.gifted_on, raw.video_id, raw.total_gifts, raw.gift_type];
  assert.equal(gift.eventFingerprint, createHash('sha256').update(JSON.stringify(material)).digest('hex'));
  assert.equal(gift.evidence.videoId, 444666132);
  assert.equal(giftedRecipient.evidence.amountCents, 0);
  const selfPaid = { ...giftedRecipient, eventType: 'subscriber_self_paid', evidence: { amountCents: 500 } };
  assert.equal(validateEvent(selfPaid), selfPaid);
  assert.equal(events.find(e => e.eventType === 'rumble.rant').evidence.amountCents, 100);
});
const event = (r, n = 1, extra = {}) => ({ ruleId: r.id, ruleRevision: r.revision, eventType: r.eventType, sourceScope: r.sourceScope,
  eventFingerprint: createHash('sha256').update(String(n)).digest('hex'), actorKey: `rumble:user:fixture:${(extra.actorLabel || 'Sample Viewer').normalize('NFKC').trim().toLowerCase()}`, actorLabel: 'Sample Viewer',
  providerEventAt: new Date(Date.now() + 1000).toISOString(), evidence: {}, ...extra });

test('typed rules, conditions, exact normalization and dry run never execute', () => {
  for (const change of [{ eventType: 'rumble.livestream.started' }, { conditions: { minAmountCents: 1 } }, { actionType: 'webhook' }, { conditions: { regex: '.*' } }]) assert.throws(() => validateRule({ ...base, ...change }));
  const rant = { ...base, eventType: 'rumble.rant', conditions: { exactText: 'ＥＮＴＥＲ', minAmountCents: 500, badge: 'Subscriber' } };
  assert.equal(dryRunAutomation({ rule: rant, sample: { text: ' enter ', amountCents: 500, badge: 'subscriber' } }).matched, true);
  assert.equal(dryRunAutomation({ rule: rant, sample: { text: 'enter please', amountCents: 500, badge: 'subscriber' } }).matched, false);
  assert.equal(dryRunAutomation({ rule: rant, sample: { text: 'enter', amountCents: 100, badge: 'subscriber' } }).matched, false);
  assert.throws(() => validateEvent(event({ id: 'rule', revision: 1, ...base }, 1, { actorKey: 'wrong-source' })));
});

test('legacy generic subscriber rules project and execute as self-paid only, then normalize on deliberate save without replay', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const env = commerceEnvironment(h), db = h.commerceDb, now = new Date().toISOString();
  await db.prepare(`INSERT INTO wheels(id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,created_at,updated_at)
    VALUES ('wheel-fixture','W-LEGACY','legacy-subscriber','Legacy Subscriber','active','hidden','owner','{}',?,?)`).bind(now, now).run();
  await db.prepare(`INSERT INTO automation_rules(id,name,description,enabled,source_scope,event_type,conditions_json,action_type,target_wheel_id,duplicate_policy,activated_at,created_by_account_id,created_at,updated_at,action_config_json)
    VALUES ('legacy-subscriber','Legacy generic subscriber','',1,'user:fixture','rumble.subscribe','{"minAmountCents":0}','wheel.add_actor','wheel-fixture','skip','2000-01-01T00:00:00Z','admin',?,?,?)`).bind(now, now, JSON.stringify({ version: 2, repeatActorPolicy: 'skip', award: { mode: 'fixed', entriesPerUnit: 1, unitCents: 100 } })).run();
  let projected = (await listAutomationRules(env, '', 'legacy-subscriber')).rules[0];
  assert.equal(projected.eventType, 'subscriber_self_paid'); assert.equal(projected.legacySubscriberRule, true); assert.deepEqual(projected.conditions, {});
  assert.equal((await botAutomationRules(env)).rules[0].eventType, 'subscriber_self_paid');
  const paid = event(projected, 'legacy-paid', { evidence: { amountCents: 500 }, actorLabel: 'Paid Viewer', actorKey: 'rumble:user:fixture:paid viewer' });
  const send = async value => (await ingestAutomationEvents(env, { events: [value] })).results[0].outcome;
  assert.equal(await send(paid), 'added'); assert.equal(await send(paid), 'duplicate_event');
  assert.equal(await send(event(projected, 'legacy-gifted', { evidence: { amountCents: 0 }, actorLabel: 'Gifted Viewer', actorKey: 'rumble:user:fixture:gifted viewer' })), 'invalid_event');
  const receiptCount = (await db.prepare('SELECT COUNT(*) n FROM automation_receipts').first()).n;
  projected = (await saveAutomationRule(env, 'admin', { ...projected, name: 'Canonical self-paid subscriber' })).rule;
  const stored = await db.prepare("SELECT event_type,conditions_json,action_config_json FROM automation_rules WHERE id='legacy-subscriber'").first();
  assert.equal(stored.event_type, 'rumble.subscribe'); assert.equal(stored.conditions_json, '{}'); assert.equal(JSON.parse(stored.action_config_json).subscriberPolicy, 'self_paid_v1'); assert.equal(projected.legacySubscriberRule, false);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM automation_receipts').first()).n, receiptCount);
  assert.equal(await send(paid), 'stale_revision');
});

test('migration, CRUD, activation, atomic exactly-once entries, counters, receipts and Wheel locks', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const env = commerceEnvironment(h); const db = h.commerceDb;
  await db.prepare(`INSERT INTO wheels(id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,created_at,updated_at)
    VALUES ('wheel-fixture','W-FIXTURE','fixture','Fixture Wheel','active','public','owner','{}',?,?)`).bind(new Date().toISOString(), new Date().toISOString()).run();
  let r = (await saveAutomationRule(env, 'admin', base)).rule;
  assert.ok(r.activatedAt); assert.equal(r.revision, 1);
  const projection = await botAutomationRules(env); assert.equal(projection.rules.length, 1);
  assert.doesNotMatch(JSON.stringify(projection), /created_by|email|secret|owner|description/);
  const send = async e => (await ingestAutomationEvents(env, { events: [e] })).results[0].outcome;
  assert.equal(await send(event(r, 0, { providerEventAt: '2000-01-01T00:00:00Z' })), 'before_activation');
  const simultaneous = await Promise.all([send(event(r)), send(event(r))]);
  assert.equal(simultaneous.filter(x => x === 'added').length, 1);
  assert.equal(await send(event(r)), 'duplicate_event');
  assert.equal(await send(event(r, 2, { actorLabel: 'Ｓａｍｐｌｅ Ｖｉｅｗｅｒ' })), 'duplicate_entrant');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM wheel_entries').first()).n, 1);
  assert.equal((await db.prepare('SELECT revision FROM wheels').first()).revision, 2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM wheel_audit_events').first()).n, 2);
  assert.equal((await listAutomationRules(env, 'wheel-fixture')).rules[0].counters.executed, 1);
  assert.equal((await listAutomationRules(env, 'other')).rules.length, 0);
  await assert.rejects(saveAutomationRule(env, 'admin', { ...r, revision: 99 }), e => e.code === 'automation_revision_conflict');
  await assert.rejects(saveAutomationRule(env, 'admin', { ...base, targetWheelId: 'missing' }), e => e.code === 'automation_input_invalid' && e.issues[0].field === 'targetWheelId');
  const previous = r; r = (await saveAutomationRule(env, 'admin', { ...r, enabled: false })).rule;
  assert.equal(r.activatedAt, null); assert.equal((await botAutomationRules(env)).rules.length, 0);
  assert.equal(await send(event(r, 3)), 'inactive_rule');
  r = (await saveAutomationRule(env, 'admin', { ...r, enabled: true })).rule;
  assert.equal(await send(event(previous, 4)), 'stale_revision');
  await db.prepare('UPDATE wheels SET editing_locked=1,revision=revision+1').run();
  assert.equal(await send(event(r, 5, { actorLabel: 'New Viewer' })), 'wheel_unavailable');
  await db.prepare('UPDATE wheels SET editing_locked=0,revision=revision+1').run();
  for (const [kind, evidence] of [['rumble.chat.exact', { normalizedText: 'enter' }], ['rumble.rant', { amountCents: 500 }], ['subscriber_self_paid', { amountCents: 500 }], ['rumble.gift_purchase', { totalGifts: 5, giftType: 'random', videoId: 123 }]]) {
    const next = (await saveAutomationRule(env, 'admin', { ...base, eventType: kind, conditions: kind === 'rumble.chat.exact' ? { exactText: 'ENTER' } : {} })).rule;
    assert.equal(await send(event(next, kind, { evidence, livestreamId: 'stream', actorLabel: kind, actorKey: `rumble:user:fixture:${kind}` })), 'added');
  }
  const subscriber = (await saveAutomationRule(env, 'admin', { ...base, eventType: 'subscriber_self_paid', conditions: {} })).rule;
  assert.equal(await send(event(subscriber, 'gifted-zero', { evidence: { amountCents: 0 }, actorLabel: 'Gift Recipient', actorKey: 'rumble:user:fixture:gift recipient' })), 'invalid_event');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM wheel_entries').first()).n, 5);
  // A downstream audit failure rolls back the entry, revision, receipt and counters.
  await db.prepare("CREATE TRIGGER test_automation_rollback BEFORE INSERT ON wheel_audit_events BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END").run();
  const receiptCount = (await db.prepare('SELECT COUNT(*) AS n FROM automation_receipts').first()).n;
  await assert.rejects(send(event(r, 777, { actorLabel: 'Rollback Viewer' })));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM wheel_entries').first()).n, 5);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM automation_receipts').first()).n, receiptCount);
  await db.prepare('DROP TRIGGER test_automation_rollback').run();
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  const columns = (await db.prepare('PRAGMA table_info(automation_receipts)').all()).results.map(c => c.name);
  assert.ok(!columns.some(c => /text|payload|evidence/.test(c)));
  await assert.rejects(deleteAutomationRule(env, 'admin', { id: r.id, revision: r.revision }), e => e.code === 'automation_delete_confirmation');
  await deleteAutomationRule(env, 'admin', { id: r.id, revision: r.revision, confirm: 'DELETE' });
  assert.equal(await send(event(r, 6)), 'inactive_rule');
  assert.ok((await db.prepare('SELECT COUNT(*) AS n FROM automation_receipts WHERE rule_id=?').bind(r.id).first()).n > 0);
});

test('actual routes enforce session, both capabilities, CSRF, HMAC and request replay', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const secret = 'test-only-service-secret'; const env = commerceEnvironment(h, { THIRDRAILIFY_BOT_ADMIN_SECRET: secret });
  const origin = env.THIRDRAILIFY_ADMIN_ORIGIN;
  assert.equal((await adminRequest({ request: new Request(`${origin}/api/admin/automations/rules`), env })).status, 401);
  assert.equal((await botRequest({ request: new Request(`${origin}/api/internal/bot/rules`), env })).status, 401);
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'fixture-request-unique-01', path = '/api/internal/bot/rules';
  const signature = createHmac('sha256', secret).update(`GET\n${path}\n${timestamp}\n${nonce}\n${createHash('sha256').update('').digest('hex')}`).digest('base64url');
  const signed = () => new Request(origin + path, { headers: { 'X-ThirdRailify-Timestamp': timestamp, 'X-ThirdRailify-Request-Id': nonce, 'X-ThirdRailify-Signature': signature } });
  assert.equal((await botRequest({ request: signed(), env })).status, 200);
  assert.equal((await botRequest({ request: signed(), env })).status, 409);
  const now = new Date().toISOString();
  await h.authDb.prepare(`INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source)
    VALUES ('test-admin','test-admin@example.test','Admin','admin','full','active',?,?,?,'test')`).bind(now, now, now).run();
  const account = await h.authDb.prepare("SELECT * FROM accounts WHERE id='test-admin'").first();
  const session = await createSession(env, new Request(origin), account, 'test');
  const cookie = cookiePair(session.cookie);
  const call = csrfToken => adminRequest({ request: jsonRequest(`${origin}/api/admin/automations/test`, { method: 'POST', origin, cookie, csrfToken, body: { rule: base, sample: {} } }), env });
  assert.equal((await call(undefined)).status, 403);
  assert.equal((await call(session.csrfToken)).status, 200);
  await h.authDb.prepare(`INSERT INTO admin_role_capability_denials(role,capability,denied_by_account_id,created_at,updated_at) VALUES ('full','wheels.manage','test-admin',?,?)`).bind(now, now).run();
  assert.equal((await call(session.csrfToken)).status, 403);
});
