import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { featureFixture } from './entrant-features-fixture.mjs';
import { saveWheel, createWheel, applyWinnerAction } from '../functions/_shared/wheels-core.js';
import { saveAutomationRule, automationReadiness, ingestAutomationEvents } from '../functions/_shared/automation-core.js';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { applyMigration } from './auth-test-helpers.mjs';
import { createPortableWheel, parseWheelImport } from '../../ThirdRailify/src/wheels/portable.mjs';
import { createPortableStage, parsePortableStage } from '../../ThirdRailify/src/wheels/stagePortable.mjs';
import { normalizeEntryIdentity } from '../src/lib/entrant-identity.mjs';

test('identity validation rejects forged keys, malformed types and unsupported versions', () => {
  for (const value of [{ version: 1, type: ['gift'], origin: 'manual' }, { version: 1, type: 'invented', origin: 'manual' }, { version: 2, type: 'gift', origin: 'imported' }, { version: 1, type: 'gift', origin: 'automation', key: 'forged' }]) assert.throws(() => normalizeEntryIdentity(value));
});

test('same name remains distinct across all six event types, manual rows and sources; skip and accumulate use typed identity', async t => {
  const f = await featureFixture(); t.after(f.h.dispose);
  const rules = [...f.rules];
  for (const eventType of ['rumble.follow', 'rumble.chat.exact']) rules.push((await saveAutomationRule(f.env, 'master', { ...f.rules[0], id: undefined, eventType, conditions: eventType === 'rumble.chat.exact' ? { exactText: 'enter' } : {} })).rule);
  let wheel = (await f.read()).wheel;
  wheel = (await saveWheel(f.env, 'creator', f.slug, { ...wheel, entries: [{ label: 'Same Person', weight: 7 }] })).wheel;
  const manualId = wheel.entries[0].id;
  for (const rule of rules) {
    const e = f.event(rule, 'Same Person');
    if (rule.eventType === 'rumble.chat.exact') e.evidence = { normalizedText: 'enter', badges: [] };
    assert.equal(await f.send(e), 'added', rule.eventType);
  }
  wheel = (await f.read()).wheel;
  assert.equal(wheel.entries.length, 7);
  assert.equal(new Set(wheel.entries.map(e => e.identity.type)).size, 7);
  assert.equal(wheel.entries.find(e => e.id === manualId).weight, 7);
  const subscription = wheel.entries.find(e => e.identity.type === 'subscription');
  const gift = wheel.entries.find(e => e.identity.type === 'gift');
  const repeat = f.event(f.rules[2], 'Same Person');
  assert.equal(await f.send(repeat), 'added');
  assert.equal(await f.send(repeat), 'duplicate_event');
  wheel = (await f.read()).wheel;
  assert.equal(wheel.entries.find(e => e.id === gift.id).weight, 40);
  assert.equal(wheel.entries.find(e => e.id === subscription.id).weight, 150);
  const sameFamily = (await saveAutomationRule(f.env, 'master', { ...f.rules[2], id: undefined, name: 'Second gift rule' })).rule;
  assert.equal(await f.send(f.event(sameFamily, 'Same Person')), 'added');
  assert.equal((await f.read()).wheel.entries.find(e => e.id === gift.id).weight, 60);
  const skip = (await saveAutomationRule(f.env, 'master', { ...sameFamily, actionConfig: { ...sameFamily.actionConfig, repeatActorPolicy: 'skip' } })).rule;
  assert.equal(await f.send(f.event(skip, 'Same Person')), 'duplicate_entrant');
  const elsewhere = (await saveAutomationRule(f.env, 'master', { ...f.rules[2], id: undefined, sourceScope: 'channel:elsewhere' })).rule;
  assert.equal(await f.send(f.event(elsewhere, 'Same Person')), 'added');
  assert.equal((await f.read()).wheel.entries.length, 8);
  assert.doesNotMatch(JSON.stringify(await f.read()), /"key"|actorKey|sourceScope/);
});

test('entry IDs preserve private identity through rename, reordering, hiding, old clients and forged classification', async t => {
  const f = await featureFixture(); t.after(f.h.dispose);
  const e = f.event(f.rules[0], 'First Name'); e.actorKey = `rumble:${e.sourceScope}:user:123`;
  assert.equal(await f.send(e), 'added');
  let wheel = (await f.read()).wheel; const id = wheel.entries[0].id;
  const { identity, ...oldClient } = wheel.entries[0];
  wheel = (await saveWheel(f.env, 'creator', f.slug, { ...wheel, entries: [{ ...oldClient, label: 'Edited Label', state: 'hidden' }] })).wheel;
  assert.deepEqual(wheel.entries[0].identity, identity);
  const renamed = f.event(f.rules[0], 'New Provider Name'); renamed.actorKey = e.actorKey;
  assert.equal(await f.send(renamed), 'added');
  wheel = (await f.read()).wheel;
  assert.equal(wheel.entries.length, 1); assert.equal(wheel.entries[0].id, id);
  assert.equal(wheel.entries[0].weight, 300); assert.equal(wheel.entries[0].state, 'hidden');
  const forged = { version: 1, type: 'gift', origin: 'automation' };
  wheel = (await saveWheel(f.env, 'creator', f.slug, { ...wheel, entries: [{ ...wheel.entries[0], identity: forged }, { ...wheel.entries[0], identity: forged }] })).wheel;
  assert.deepEqual(wheel.entries[0].identity, identity);
  assert.notEqual(wheel.entries[1].id, id); assert.deepEqual(wheel.entries[1].identity, { ...forged, origin: 'manual' });
  const raw = (await f.h.commerceDb.prepare('SELECT entrant_identity_json FROM wheel_entries WHERE id=?').bind(id).first()).entrant_identity_json;
  await assert.rejects(f.h.commerceDb.prepare('UPDATE wheel_entries SET entrant_identity_json=? WHERE id=?').bind(raw, wheel.entries[1].id).run(), /UNIQUE/);
  await assert.rejects(saveWheel(f.env, 'creator', f.slug, { ...wheel, entries: [{ ...wheel.entries[0], identity: { ...identity, key: 'forged' } }] }), error => error.code === 'entrant_identity_invalid');
});

test('wheel and Stage imports preserve typed same-name rows with fresh IDs and no automatic binding', async t => {
  const f = await featureFixture(); t.after(f.h.dispose);
  for (const rule of f.rules.slice(0, 3)) await f.send(f.event(rule, 'Same'));
  const source = (await f.read()).wheel;
  const exported = await createPortableWheel(source);
  assert.equal(exported.formatVersion, 3);
  assert.doesNotMatch(JSON.stringify(exported), /"key"|actorKey|sourceScope/);
  const proposal = (await parseWheelImport(JSON.stringify(exported))).proposals[0];
  assert.equal(proposal.entries.length, 3); assert.equal(proposal.summary.duplicateLabelCount, 3);
  assert.equal(new Set(proposal.entries.map(e => e.identity.type)).size, 3);
  for (const entry of proposal.entries) { assert.equal(entry.identity.origin, 'imported'); assert.ok(!source.entries.some(e => e.id === entry.id)); }
  let imported = (await createWheel(f.env, 'creator', { ...source, title: 'Imported identity', entries: proposal.entries })).wheel;
  const target = (await f.h.commerceDb.prepare('SELECT id FROM wheels WHERE public_slug=?').bind(imported.slug).first()).id;
  const rule = (await saveAutomationRule(f.env, 'master', { ...f.rules[0], id: undefined, targetWheelId: target })).rule;
  await f.send(f.event(rule, 'Same'));
  const { getPublicWheel } = await import('../functions/_shared/wheels-core.js');
  imported = (await getPublicWheel(f.env, imported.slug, 'creator')).wheel;
  assert.equal(imported.entries.length, 4); assert.equal(imported.entries.filter(e => e.identity.origin === 'imported').length, 3);
  const generic = await parseWheelImport(JSON.stringify([{ name: 'Same' }, { name: 'Same', identity: { version: 1, type: 'gift', origin: 'automation' } }]));
  assert.deepEqual(generic.proposals[0].entries.map(e => e.identity.type), ['regular', 'gift']);
  assert.ok(generic.proposals[0].entries.every(e => e.identity.origin === 'imported'));
  const stage = await createPortableStage({ title: 'Typed Stage', wheels: [{ wheel: source }, { wheel: imported }] });
  const parsedStage = await parsePortableStage(JSON.stringify(stage));
  assert.equal(parsedStage.proposals.length, 2);
  assert.deepEqual(parsedStage.proposals[0].proposal.entries.map(e => e.identity.type), proposal.entries.map(e => e.identity.type));
  assert.ok(parsedStage.proposals.flatMap(p => p.proposal.entries).every(e => e.identity.origin === 'imported'));
  const ids = parsedStage.proposals.flatMap(p => p.proposal.entries.map(e => e.id)); assert.equal(new Set(ids).size, ids.length);
});

test('concurrent distinct events retry without double slices; all-matching removal respects type and source', async t => {
  const f = await featureFixture(); t.after(f.h.dispose);
  const events = [f.event(f.rules[2], 'Same'), f.event(f.rules[2], 'Same')];
  const outcomes = await Promise.all(events.map(f.send));
  for (const [i, outcome] of outcomes.entries()) { assert.ok(['added', 'retry'].includes(outcome)); if (outcome === 'retry') assert.equal(await f.send(events[i]), 'added'); }
  let wheel = (await f.read()).wheel; assert.equal(wheel.entries.length, 1); assert.equal(wheel.entries[0].weight, 40);
  await f.send(f.event(f.rules[0], 'Same'));
  const other = (await saveAutomationRule(f.env, 'master', { ...f.rules[2], id: undefined, sourceScope: 'user:other' })).rule;
  await f.send(f.event(other, 'Same'));
  wheel = (await f.read()).wheel; const gift = wheel.entries.find(e => e.identity.type === 'gift');
  wheel = (await applyWinnerAction(f.env, 'creator', f.slug, { entryId: gift.id, action: 'remove-matching' })).wheel;
  assert.equal(wheel.entries.length, 2); assert.ok(wheel.entries.some(e => e.identity.type === 'subscription')); assert.ok(wheel.entries.some(e => e.identity.type === 'gift'));
  wheel = (await saveWheel(f.env, 'creator', f.slug, { ...wheel, entries: [...wheel.entries, ...['regular', 'regular', 'gift'].map(type => ({ label: 'Same', weight: 1, identity: { version: 1, type, origin: 'imported' } }))] })).wheel;
  const regular = wheel.entries.find(e => e.identity.type === 'regular');
  wheel = (await applyWinnerAction(f.env, 'creator', f.slug, { entryId: regular.id, action: 'remove-matching' })).wheel;
  assert.equal(wheel.entries.length, 3); assert.equal(wheel.entries.filter(e => e.identity.origin === 'automation').length, 2); assert.equal(wheel.entries.filter(e => e.identity.origin === 'imported' && e.identity.type === 'gift').length, 1);
  wheel = (await saveWheel(f.env, 'creator', f.slug, { ...wheel, entries: [...wheel.entries, ...[0, 1].map(() => ({ label: 'Unknown', weight: 1, identity: { version: 1, type: 'legacy', origin: 'imported' } }))] })).wheel;
  const unknown = wheel.entries.find(e => e.label === 'Unknown');
  wheel = (await applyWinnerAction(f.env, 'creator', f.slug, { entryId: unknown.id, action: 'remove-matching' })).wheel;
  assert.equal(wheel.entries.filter(e => e.label === 'Unknown').length, 1, 'unknown types cannot establish that two rows match');
});

test('0042 preserves legacy rows and fails before awards on unmigrated storage', async t => {
  const h = await createCommerceDatabases({ commerceMigrationCount: 40 }); t.after(h.dispose);
  const db = h.commerceDb, env = commerceEnvironment(h); const now = new Date().toISOString();
  await db.prepare("INSERT INTO wheels(id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,created_at,updated_at) VALUES ('legacy-wheel','LEGACY','legacy-wheel','Legacy','active','public','creator','{}',?,?)").bind(now, now).run();
  await db.prepare("INSERT INTO wheel_entries(id,wheel_id,display_label,display_order,weight,state,created_at,updated_at) VALUES ('legacy-entry','legacy-wheel','Same',0,75,'active',?,?)").bind(now, now).run();
  const rule = (await saveAutomationRule(env, 'master', { name: 'Gift', description: '', enabled: true, sourceScope: 'user:fixture', eventType: 'rumble.gift_purchase', conditions: {}, actionType: 'wheel.add_actor', targetWheelId: 'legacy-wheel' })).rule;
  const event = { ruleId: rule.id, ruleRevision: rule.revision, eventType: rule.eventType, sourceScope: rule.sourceScope, eventFingerprint: 'e'.repeat(64), actorLabel: 'Same', actorKey: 'rumble:user:fixture:same', providerEventAt: new Date(Date.now() + 1000).toISOString(), evidence: { totalGifts: 1, giftType: 'random', videoId: 123 } };
  assert.equal((await automationReadiness(env)).entryIdentity, false);
  await assert.rejects(ingestAutomationEvents(env, { events: [event] }), error => error.code === 'entrant_identity_schema_required');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM automation_receipts').first()).n, 0);
  const before = await db.prepare('SELECT * FROM wheel_entries').first();
  // Isolated migration: no dependency on the unrelated 0041 Poll migration.
  await applyMigration(db, h.commerceMigrations[41]);
  const after = await db.prepare('SELECT * FROM wheel_entries').first(); assert.equal(after.entrant_identity_json, null); delete after.entrant_identity_json; assert.deepEqual(after, before);
  assert.equal((await automationReadiness(env)).entryIdentity, true);
  assert.equal((await ingestAutomationEvents(env, { events: [event] })).results[0].outcome, 'added');
  assert.equal((await db.prepare("SELECT weight FROM wheel_entries WHERE id='legacy-entry'").first()).weight, 75);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM wheel_entries').first()).n, 2);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  for (const file of ['entrant-identity.mjs', 'entrant-identity.d.mts']) assert.equal(await readFile(new URL(`../src/lib/${file}`, import.meta.url), 'utf8'), await readFile(new URL(`../../ThirdRailify/src/lib/${file}`, import.meta.url), 'utf8'));
});

test('legacy reuse requires complete single-type creation evidence; mixed histories never receive guessed awards', async t => {
  const f = await featureFixture(); t.after(f.h.dispose); const db = f.h.commerceDb;
  await f.send(f.event(f.rules[0], 'Known'));
  let wheel = (await f.read()).wheel; const known = wheel.entries[0];
  await db.prepare("UPDATE wheel_entries SET entrant_identity_json=NULL,display_label='Renamed legacy',state='hidden' WHERE id=?").bind(known.id).run();
  const retry = f.event(f.rules[0], 'Known');
  await db.prepare("CREATE TRIGGER identity_rollback BEFORE INSERT ON wheel_audit_events BEGIN SELECT RAISE(ABORT,'identity rollback'); END").run();
  await assert.rejects(f.send(retry), /identity rollback/);
  assert.equal((await db.prepare('SELECT entrant_identity_json FROM wheel_entries WHERE id=?').bind(known.id).first()).entrant_identity_json, null);
  await db.prepare('DROP TRIGGER identity_rollback').run();
  assert.equal(await f.send(retry), 'added');
  wheel = (await f.read()).wheel;
  assert.equal(wheel.entries.length, 1); assert.equal(wheel.entries[0].id, known.id); assert.equal(wheel.entries[0].weight, 300); assert.equal(wheel.entries[0].state, 'hidden'); assert.equal(wheel.entries[0].identity.type, 'subscription');
  await f.send(f.event(f.rules[0], 'Mixed')); await f.send(f.event(f.rules[2], 'Mixed'));
  wheel = (await f.read()).wheel; const sub = wheel.entries.find(e => e.label === 'Mixed' && e.identity.type === 'subscription'), gift = wheel.entries.find(e => e.label === 'Mixed' && e.identity.type === 'gift');
  // Reconstruct the old name-only engine's combined slice from its real receipts.
  await db.prepare("UPDATE wheel_audit_events SET metadata_json=json_set(metadata_json,'$.entryId',?) WHERE json_extract(metadata_json,'$.entryId')=?").bind(sub.id, gift.id).run();
  await db.prepare('DELETE FROM wheel_entries WHERE id=?').bind(gift.id).run();
  await db.prepare('UPDATE wheel_entries SET entrant_identity_json=NULL,weight=170 WHERE id=?').bind(sub.id).run();
  assert.equal(await f.send(f.event(f.rules[2], 'Mixed')), 'added');
  wheel = (await f.read()).wheel;
  assert.equal(wheel.entries.find(e => e.id === sub.id).weight, 170); assert.equal(wheel.entries.find(e => e.id === sub.id).identity.type, 'legacy');
  assert.equal(wheel.entries.find(e => e.label === 'Mixed' && e.identity.type === 'gift').weight, 20);
  await f.send(f.event(f.rules[2], 'Skip'));
  wheel = (await f.read()).wheel; const skipEntry = wheel.entries.find(e => e.label === 'Skip');
  await db.prepare('UPDATE wheel_entries SET entrant_identity_json=NULL WHERE id=?').bind(skipEntry.id).run();
  const skip = (await saveAutomationRule(f.env, 'master', { ...f.rules[2], actionConfig: { ...f.rules[2].actionConfig, repeatActorPolicy: 'skip' } })).rule;
  assert.equal(await f.send(f.event(skip, 'Skip')), 'duplicate_entrant');
  wheel = (await f.read()).wheel; assert.equal(wheel.entries.find(e => e.id === skipEntry.id).weight, 20); assert.equal(wheel.entries.find(e => e.id === skipEntry.id).identity.origin, 'automation');
});
