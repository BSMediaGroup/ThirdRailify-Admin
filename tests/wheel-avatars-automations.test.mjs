import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { createWheel, saveWheel, getPublicWheel, mutateCreatorGrant, validateEntries } from '../functions/_shared/wheels-core.js';
import { wheelAutomations } from '../functions/_shared/wheel-automations.js';
import { defaultAction } from '../src/lib/automation-model.mjs';

export async function fixture(t) {
  const h = await createCommerceDatabases(); t.after(h.dispose);
  const env = commerceEnvironment(h, { THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: 'avatar-test-rate', THIRDRAILIFY_COMMUNITY_API_SECRET: 'avatar-test-signing' });
  const now = new Date().toISOString();
  for (const id of ['master', 'creator', 'stranger']) await h.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,?)").bind(id, `${id}@example.test`, id, id === 'master' ? 'admin' : 'user', id === 'master' ? 'master' : 'none', now, now, now, id === 'master' ? 'env_master' : 'test').run();
  await mutateCreatorGrant(env, 'master', { accountId: 'creator', action: 'approve', mayCreate: true, maximumOwnedWheels: 4 });
  const wheel = (await createWheel(env, 'creator', { title: 'Avatar Draw', visibility: 'public', lifecycle: 'active', config: { entrantDisplay: 'both' }, entries: [{ label: 'Alpha', weight: 2, avatarUrl: 'https://cdn.thirdrailify.com/avatar-test.png' }, { label: 'Beta', weight: 1 }] })).wheel;
  return { h, env, wheel };
}

test('avatar persistence, old-client preservation and Wheel-scoped automation authority', async t => {
  const { h, env, wheel } = await fixture(t);
  assert.equal(wheel.config.entrantDisplay, 'both');
  assert.equal(wheel.entries[0].avatarUrl, 'https://cdn.thirdrailify.com/avatar-test.png');
  assert.equal(wheel.entries[1].avatarUrl, null);
  for (const avatarUrl of ['http://example.test/a', 'javascript:alert(1)', 'https://user:pass@example.test/a']) assert.throws(() => validateEntries([{ label: 'Bad', avatarUrl }]));
  const legacyEntries = wheel.entries.map(({ avatarUrl: _avatar, ...entry }) => entry);
  const saved = (await saveWheel(env, 'creator', wheel.slug, { ...wheel, entries: legacyEntries })).wheel;
  assert.equal(saved.entries[0].avatarUrl, wheel.entries[0].avatarUrl);
  const read = await wheelAutomations(env, 'creator', wheel.slug, 'read', {});
  assert.equal(read.wheels.length, 1);
  const rule = { name: 'All Rants', description: '', enabled: false, sourceScope: 'user:fixture', eventType: 'rumble.rant', conditions: { exactText: '', minAmountCents: 100 }, actionType: 'wheel.add_actor', targetWheelId: read.wheels[0].id, actionConfig: defaultAction() };
  await wheelAutomations(env, 'creator', wheel.slug, 'save', rule);
  const listed = await wheelAutomations(env, 'creator', wheel.slug, 'read', {});
  const stored = listed.rules[0]; assert.deepEqual(stored.conditions, { minAmountCents: 100 });
  assert.equal((await wheelAutomations(env, 'creator', wheel.slug, 'test', { rule, sample: { amountCents: 100, text: 'Any message' } })).matched, true);
  await assert.rejects(wheelAutomations(env, 'stranger', wheel.slug, 'read', {}), e => e.code === 'wheel_edit_forbidden');
  await assert.rejects(wheelAutomations(env, 'creator', wheel.slug, 'save', { ...rule, targetWheelId: 'other-wheel' }), e => e.code === 'automation_wheel_mismatch');
  const other = (await createWheel(env, 'creator', { title: 'Other Draw', config: {}, entries: [] })).wheel;
  await assert.rejects(wheelAutomations(env, 'creator', other.slug, 'delete', { id: stored.id, revision: stored.revision, confirm: 'DELETE' }), e => e.code === 'automation_not_found');
  await h.commerceDb.prepare('UPDATE wheels SET editing_locked=1 WHERE id=?').bind(read.wheels[0].id).run();
  await assert.rejects(wheelAutomations(env, 'creator', wheel.slug, 'save', rule), e => e.code === 'wheel_edit_locked');
  await wheelAutomations(env, 'master', wheel.slug, 'delete', { id: stored.id, revision: stored.revision, confirm: 'DELETE' });
  assert.equal((await getPublicWheel(env, wheel.slug)).wheel.entries[0].weight, 2);
});
