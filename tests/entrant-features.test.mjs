import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { featureFixture } from './entrant-features-fixture.mjs';
import { FEATURE_PRESETS, normalizeAppearance, normalizeFeatureComponents, effectiveAppearance } from '../src/lib/entrant-appearance.mjs';
import { saveWheel, participantSnapshotHash } from '../functions/_shared/wheels-core.js';
import { saveAutomationRule, deleteAutomationRule, botAutomationRules } from '../functions/_shared/automation-core.js';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { applyMigration } from './auth-test-helpers.mjs';
import { ingestAutomationEvents } from '../functions/_shared/automation-core.js';

test('bounded appearance validation, independent precedence and mirrored contract', async () => {
  for (const value of [{ fill: { colors: ['red', 'url(x)'] } }, { icons: ['<svg>'] }, { effects: { kinds: ['sparkles'], intensity: 8, speed: 1, density: 1 } }, { css: 'evil' }, { edge: { color: '#FFFFFF', placement: 'outside' } }]) assert.throws(() => normalizeFeatureComponents(value));
  assert.throws(() => normalizeAppearance({ version: 2, manual: {} }));
  const automatic = Object.fromEntries(Object.entries(FEATURE_PRESETS.gift.components).map(([key, value]) => [key, { value, source: 'automation' }]));
  const a = effectiveAppearance({ colour: '#123456', appearance: { version: 1, manual: { icons: [], effects: null }, automatic } });
  assert.equal(a.fill, undefined); assert.equal(a.sources.fill, 'manual'); assert.deepEqual(a.icons, []); assert.equal(a.effects, null); assert.equal(a.edge.color, '#F4ABFF');
  for (const file of ['lib/entrant-appearance.mjs', 'lib/entrant-appearance.d.mts', 'lib/entrant-feature-drawing.ts', 'components/EntrantAppearanceControls.tsx', 'components/AutomationRuleList.tsx', 'lib/automation-rule-store.ts']) assert.equal(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'), await readFile(new URL(`../../ThirdRailify/src/${file}`, import.meta.url), 'utf8'));
});

test('real executor -> persisted snapshot -> public projection -> manual save -> later awards and reload', async t => {
  const f = await featureFixture(); t.after(f.h.dispose); const { env, h, rules, event, send, read, slug } = f;
  for (const [i, rule] of rules.entries()) assert.equal(await send(event(rule, ['Subscriber', 'Raid', 'Gift', 'Rant'][i])), 'added');
  let payload = await read(); let entrant = payload.wheel.entries[0];
  assert.equal(payload.wheel.entries.length, 4); assert.equal(entrant.appearance.automatic.fill.value.colors[0], '#690E27');
  assert.doesNotMatch(JSON.stringify(payload), /eventFingerprint|providerEventAt|ruleId|\"at\":|\"key\":/);
  assert.equal((await botAutomationRules(env, true)).rules.some(r => 'actionConfig' in r || 'appearance' in r), false);
  const acceptedHash = await participantSnapshotHash(payload.wheel.entries);
  const entries = payload.wheel.entries.map((e, i) => i === 0 ? { ...e, appearance: { ...e.appearance, manual: { fill: { colors: ['#123456', '#654321'] }, icons: [], effects: null } } } : e);
  assert.equal(await participantSnapshotHash(entries), acceptedHash, 'appearance excluded from winner snapshot');
  payload = await saveWheel(env, 'creator', slug, { ...payload.wheel, entries });
  const later = event(rules[2], 'Subscriber'); assert.equal(await send(later), 'added');
  const after = await read(); entrant = after.wheel.entries.find(e => e.label === 'Subscriber');
  assert.equal(entrant.weight, 170); assert.deepEqual(effectiveAppearance(entrant).fill.colors, ['#123456', '#654321']); assert.deepEqual(effectiveAppearance(entrant).icons, []); assert.equal(effectiveAppearance(entrant).effects, null);
  const beforeReplay = JSON.stringify((await h.commerceDb.prepare('SELECT * FROM wheel_entries ORDER BY id').all()).results);
  assert.equal(await send(later), 'duplicate_event'); assert.equal(JSON.stringify((await h.commerceDb.prepare('SELECT * FROM wheel_entries ORDER BY id').all()).results), beforeReplay);
  const older = event(rules[1], 'Subscriber', { at: new Date(Date.parse(later.providerEventAt) - 1).toISOString() }); assert.equal(await send(older), 'added');
  entrant = (await read()).wheel.entries.find(e => e.label === 'Subscriber'); assert.equal(entrant.weight, 190); assert.deepEqual(entrant.appearance.automatic.fill.value.colors, FEATURE_PRESETS.gift.components.fill.colors);
  const oldClient = await read(); const omitted = oldClient.wheel.entries.map(({ appearance, ...e }) => ({ ...e, label: e.label, weight: e.weight + 1 }));
  await saveWheel(env, 'creator', slug, { ...oldClient.wheel, entries: omitted.reverse() });
  entrant = (await read()).wheel.entries.find(e => e.label === 'Subscriber'); assert.deepEqual(entrant.appearance.manual.icons, []);
  const cosmetic = await saveAutomationRule(env, 'master', { ...rules[0], actionConfig: { ...rules[0].actionConfig, appearance: FEATURE_PRESETS.rant.components } });
  assert.equal(cosmetic.rule.activatedAt, rules[0].activatedAt); assert.equal(cosmetic.rule.enabled, true);
  const oldPayloadRule = structuredClone(cosmetic.rule); delete oldPayloadRule.actionConfig.appearance;
  const retained = await saveAutomationRule(env, 'master', oldPayloadRule); assert.deepEqual(retained.rule.actionConfig.appearance, FEATURE_PRESETS.rant.components);
  const zero = event(retained.rule, 'Zero subscriber', { evidence: { amountCents: 0 } }); assert.equal(await send(zero), 'added'); assert.equal((await read()).wheel.entries.find(e => e.label === 'Zero subscriber').appearance, null);
  const beforeDelete = JSON.stringify((await read()).wheel.entries);
  await deleteAutomationRule(env, 'master', { id: retained.rule.id, revision: retained.rule.revision, confirm: 'DELETE' }); assert.equal(JSON.stringify((await read()).wheel.entries), beforeDelete);
  await mkdir('.artifacts/entrant-features', { recursive: true }); await writeFile('.artifacts/entrant-features/executor-public-projection.json', JSON.stringify(await read(), null, 2));
});

test('stable ties, manual suppression, rejected awards and transaction rollback', async t => {
  const f = await featureFixture(); t.after(f.h.dispose); const { h, env, rules, event, send, read } = f;
  const at = new Date(Date.now() + 2000).toISOString();
  const a = event(rules[2], 'One', { at }), b = event(rules[3], 'One', { at });
  await send(a); await send(b); const first = (await read()).wheel.entries.find(e => e.label === 'One').appearance;
  await h.commerceDb.prepare('DELETE FROM automation_receipts').run(); await h.commerceDb.prepare('DELETE FROM wheel_entries').run();
  await send(b); await send(a); assert.deepEqual((await read()).wheel.entries.find(e => e.label === 'One').appearance, first);
  const before = (await read()).wheel;
  await h.commerceDb.prepare("CREATE TRIGGER fail_feature BEFORE UPDATE OF entrant_appearance_json ON wheel_entries BEGIN SELECT RAISE(ABORT,'feature rollback'); END").run();
  const blocked = event(rules[2], 'One'); await assert.rejects(send(blocked), /feature rollback/);
  assert.deepEqual((await read()).wheel, before); assert.equal(await h.commerceDb.prepare('SELECT id FROM automation_receipts WHERE event_fingerprint=?').bind(blocked.eventFingerprint).first(), null);
  await h.commerceDb.prepare('DROP TRIGGER fail_feature').run();
  const skip = (await saveAutomationRule(env, 'master', { ...rules[2], actionConfig: { ...rules[2].actionConfig, repeatActorPolicy: 'skip' }, duplicatePolicy: 'skip' })).rule;
  const snapshot = JSON.stringify((await read()).wheel.entries); assert.equal(await send(event(skip, 'One')), 'duplicate_entrant'); assert.equal(JSON.stringify((await read()).wheel.entries), snapshot);
});

test('0040 is additive, old awards execute, and appearance readiness rejects before writes', async t => {
  const h = await createCommerceDatabases({ commerceMigrationCount: 39 }); t.after(h.dispose); const env = commerceEnvironment(h), db = h.commerceDb;
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO wheels(id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,created_at,updated_at) VALUES ('compat-wheel','W-COMPAT','compat-wheel','Compatibility','active','public','creator','{}',?,?)").bind(now, now).run();
  let rule = (await saveAutomationRule(env, 'master', { name: 'Old rule', description: '', enabled: true, sourceScope: 'user:fixture', eventType: 'rumble.follow', conditions: {}, actionType: 'wheel.add_actor', targetWheelId: 'compat-wheel' })).rule;
  const e = { ruleId: rule.id, ruleRevision: rule.revision, eventType: rule.eventType, sourceScope: rule.sourceScope, eventFingerprint: 'a'.repeat(64), actorLabel: 'Old entrant', actorKey: 'rumble:user:fixture:old entrant', providerEventAt: new Date(Date.now() + 1000).toISOString(), evidence: {} };
  assert.equal((await ingestAutomationEvents(env, { events: [e] })).results[0].outcome, 'added');
  const before = JSON.stringify((await db.prepare('SELECT * FROM automation_rules').all()).results);
  await assert.rejects(saveAutomationRule(env, 'master', { ...rule, actionConfig: { ...rule.actionConfig, appearance: FEATURE_PRESETS.gift.components } }), err => err.code === 'entrant_appearance_schema_required');
  assert.equal(JSON.stringify((await db.prepare('SELECT * FROM automation_rules').all()).results), before);
  const oldEntry = await db.prepare('SELECT * FROM wheel_entries').first();
  await applyMigration(db, h.commerceMigrations[39]);
  const upgraded = await db.prepare('SELECT * FROM wheel_entries').first(); assert.equal(upgraded.entrant_appearance_json, null); delete upgraded.entrant_appearance_json; assert.deepEqual(upgraded, oldEntry);
  rule = (await saveAutomationRule(env, 'master', { ...rule, actionConfig: { ...rule.actionConfig, appearance: FEATURE_PRESETS.gift.components } })).rule;
  assert.equal(rule.actionConfig.appearance.preset, 'gift'); assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
});
