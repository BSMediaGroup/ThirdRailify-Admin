import assert from 'node:assert/strict';
import test from 'node:test';
import { commerceEnvironment, createCommerceDatabases } from './commerce-test-helpers.mjs';
import { closeAndCreateNextWheel, createWheel, getPublicWheel, listPublicWheels, mutateCreatorGrant, performOfficialSpin } from '../functions/_shared/wheels-core.js';
import { listPublicWheelActivity } from '../functions/_shared/wheels-core.js';
import { getAutomationReceiptDetail } from '../functions/_shared/automation-core.js';
import { featureFixture } from './entrant-features-fixture.mjs';

test('0050 codes, suffixes, official snapshots and close/create-next preserve authority without carrying ledgers', async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness, { THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: 'identity-v2-test-rate' });
  await account(harness.authDb, 'master', 'Master', 'master@test.invalid', 'admin', 'master'); await account(harness.authDb, 'creator', 'Creator', 'creator@test.invalid');
  await mutateCreatorGrant(env, 'master', { accountId: 'creator', action: 'approve', mayCreate: true, maximumOwnedWheels: 4 });
  const created = await createWheel(env, 'creator', { title: 'Identity final', description: 'synthetic', visibility: 'public', lifecycle: 'active', config: { themePreset: 'third-rail-gold', palette: ['#F3C928','#B8182F'], pointerAccent: '#F3C928', spinDurationMs: 3000 }, entries: [{ label: 'Same', suffix: 'Subscriber', weight: 2 }, { label: 'Same', suffix: 'Raid', weight: 1 }] });
  const codes = created.wheel.entries.map((entry) => entry.code); assert.equal(new Set(codes).size, 2); assert.ok(codes.every((code) => /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{7}$/.test(code)));
  const spin = await performOfficialSpin(env, 'creator', created.wheel.slug, { revision: created.wheel.revision, idempotencyKey: 'identity-v2-official-result' });
  assert.equal(spin.spin.winningEntry.code, created.wheel.entries.find((entry) => entry.id === spin.spin.winningEntryId).code); assert.ok(spin.spin.winningEntry.suffix);
  const closed = await closeAndCreateNextWheel(env, 'creator', created.wheel.slug, { revision: created.wheel.revision, resultId: spin.spin.id, title: 'Identity next', copyParticipants: true, idempotencyKey: 'identity-v2-close-successor' });
  const oldWheel = await getPublicWheel(env, created.wheel.slug, 'creator'); const nextWheel = await getPublicWheel(env, closed.successorSlug, 'creator');
  assert.ok(oldWheel.wheel.closedAt); assert.equal(oldWheel.access.canEdit, false); assert.equal(oldWheel.access.canSpinOfficially, false); assert.equal(nextWheel.wheel.lifecycle, 'draft'); assert.equal(nextWheel.wheel.visibility, 'hidden');
  assert.deepEqual(nextWheel.wheel.entries.map((entry) => [entry.label,entry.suffix,entry.weight]), created.wheel.entries.map((entry) => [entry.label,entry.suffix,entry.weight])); assert.equal(nextWheel.wheel.entries.some((entry) => codes.includes(entry.code)), false); assert.equal(nextWheel.wheel.entries.some((entry) => created.wheel.entries.some((old) => old.id === entry.id)), false);
  assert.equal(Number((await harness.commerceDb.prepare('SELECT COUNT(*) count FROM wheel_official_spins WHERE wheel_id=(SELECT id FROM wheels WHERE public_slug=?)').bind(closed.successorSlug).first()).count), 0);
  assert.equal((await listPublicWheels(env, { view: 'current' })).items.some((item) => item.slug === created.wheel.slug), false); assert.equal((await listPublicWheels(env, { view: 'past' })).items.some((item) => item.slug === created.wheel.slug), true);
  const repeated = await closeAndCreateNextWheel(env, 'creator', created.wheel.slug, { revision: created.wheel.revision, resultId: spin.spin.id, title: 'ignored', copyParticipants: false, idempotencyKey: 'identity-v2-close-successor' }); assert.equal(repeated.idempotent, true); assert.equal(repeated.successorSlug, closed.successorSlug);
  assert.equal((await harness.commerceDb.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});

test('receipt detail and public activity use bounded historical snapshots without raw messages or actor keys', async (t) => {
  const fixture = await featureFixture(); t.after(fixture.h.dispose); const rule = fixture.rules[1];
  assert.equal(await fixture.send(fixture.event(rule, 'Safe Raider')), 'added');
  const receipt = await fixture.h.commerceDb.prepare('SELECT id FROM automation_receipts ORDER BY created_at DESC LIMIT 1').first();
  const admin = await getAutomationReceiptDetail(fixture.env, receipt.id); assert.equal(admin.receipt.historical.chatDerived, true); assert.equal(admin.receipt.historical.entrantCode.length, 7); assert.equal(Object.hasOwn(admin.receipt.historical, 'actorKey'), false);
  const publicActivity = await listPublicWheelActivity(fixture.env, fixture.slug); assert.equal(publicActivity.items.length, 1); assert.equal(publicActivity.items[0].entrant.label, 'Safe Raider'); assert.equal(publicActivity.items[0].eventType, 'Raid entry'); assert.equal(Object.hasOwn(publicActivity.items[0], 'actorKey'), false); assert.doesNotMatch(JSON.stringify(publicActivity), /has raided this stream/i);
});

async function account(db,id,name,email,role='user',level='none'){const now=new Date().toISOString();await db.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES(?,?,?,?,?,'active',?,?,?,'test')").bind(id,email,name,role,level,now,now,now).run();}
