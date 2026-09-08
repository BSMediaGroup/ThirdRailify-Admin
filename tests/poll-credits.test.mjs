import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { applyMigration } from './auth-test-helpers.mjs';
import { createPoll, changePollLifecycle, botActivePoll, submitWebVote, getPublicPoll, listPublicPolls, updatePoll } from '../functions/_shared/polls-core.js';
import { savePollPolicy, ingestPaidSnapshot, reconcilePollCredit, earnedVotes, matchPaidTrigger, expirePollCredits, pollVotingAdmin } from '../functions/_shared/poll-credits.js';
import { createSession } from '../functions/_shared/auth-core.js';
import { onRequest as botRequest } from '../functions/api/internal/bot/[[path]].js';
import { onRequest as adminRequest } from '../functions/api/admin/automations/[[path]].js';

const secret = 'offline-credit-test-secret-with-entropy';
const stamp = ms => new Date(ms).toISOString();
const sha = value => createHash('sha256').update(value).digest('hex');
const defaults = { rantEnabled: true, giftEnabled: true, centsPerVote: 100, votesPerGift: 5, maxMessages: 3, timeoutSeconds: 300 };
async function setup(t, count) {
  const h = await createCommerceDatabases(count ? { commerceMigrationCount: count } : {}); t.after(h.dispose);
  const env = commerceEnvironment(h, { THIRDRAILIFY_BOT_ADMIN_SECRET: secret, THIRDRAILIFY_POLL_VOTER_SECRET: secret });
  const now = stamp(Date.now());
  await h.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES ('credit-admin','credit@example.test','Credit Admin','admin','full','active',?,?,?,'test')").bind(now, now, now).run();
  const created = await createPoll(env, 'credit-admin', { title: 'Moon landing vs Deep ocean', presentationType: count ? undefined : 'abootnothing', rumbleEnabled: true, rumbleSourceScope: 'user:synthetic', options: [{ label: 'Moon landing', trigger: 'moon' }, { label: 'Deep ocean', trigger: '2' }] });
  return { h, env, created };
}
async function open(env, created, policy = defaults) {
  const opened = await changePollLifecycle(env, 'credit-admin', created.poll.slug, { revision: created.poll.revision, action: 'open' });
  await savePollPolicy(env, 'credit-admin', { pollId: created.poll.id, revision: 0, policy });
  return { opened, bot: (await botActivePoll(env)).activePoll };
}
function bridge(snapshot, poll, pendingActors = []) {
  const result = spawnSync('X:/GIT/THIRD-RAIL-BOT/.venv/Scripts/python.exe', ['-m', 'tests.poll_credit_bridge'], { cwd: 'X:/GIT/THIRD-RAIL-BOT', input: JSON.stringify({ snapshot, poll, pendingActors }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
async function signed(env, path, body) {
  const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000)), requestId = randomUUID();
  const signature = createHmac('sha256', secret).update(['POST', path, timestamp, requestId, sha(raw)].join('\n')).digest('base64url');
  return botRequest({ env, request: new Request(`https://thirdrailify-admin.pages.dev${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ThirdRailify-Timestamp': timestamp, 'X-ThirdRailify-Request-Id': requestId, 'X-ThirdRailify-Signature': signature }, body: raw }) });
}
function snapshot(time, { gifts = [], messages = [], rants = [], max = 50 } = {}) {
  return { user_id: 'synthetic', now: time / 1000, max_num_results: max, gifted_subs: { recent_gifted_subs: gifts }, livestreams: [{ id: 'synthetic-live', title: 'Synthetic offline stream', is_live: true, chat: { recent_messages: messages, recent_rants: rants } }] };
}
const gift = (time, actor = 'Synthetic Viewer', quantity = 1) => ({ total_gifts: quantity, purchased_by: actor, gifted_on: stamp(time), gift_type: 'subscription', remaining_gifts: 0, video_id: 12345 });
const chat = (time, text, actor = 'Synthetic Viewer') => ({ username: actor, text, created_on: stamp(time), badges: [] });
const rant = (time, text, cents = 1000) => ({ ...chat(time, text), amount_cents: cents, amount_dollars: cents / 100, expires_on: stamp(time + 60000) });
async function send(env, batch, bot, ordinary = true) {
  const response = await signed(env, '/api/internal/bot/poll-credits', batch.paid);
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.ok(body.acknowledged.includes(batch.paid.fingerprint));
  if (ordinary && batch.ordinary.length) { const r = await signed(env, '/api/internal/bot/votes', { pollId: bot.id, pollRevision: bot.revision, events: batch.ordinary }); assert.equal(r.status, 200, JSON.stringify(await r.json())); }
}
const lots = async h => (await h.commerceDb.prepare('SELECT * FROM poll_credit_lots ORDER BY created_at,id').all()).results;
async function conservation(h) { for (const l of await lots(h)) assert.equal(l.earned, l.committed + l.waiting + l.unreconciled + l.discarded); }

test('integer formulas and literal whole phrase matching reject substring and ambiguous choices', () => {
  assert.deepEqual([100, 1000, 650, 0].map(amountCents => earnedVotes('rant', { amountCents })), [1, 10, 6, 0]);
  for (const amountCents of [-1, 1.5, '100', NaN, 100000001]) assert.throws(() => earnedVotes('rant', { amountCents }));
  assert.equal(earnedVotes('gift', { totalGifts: 5 }), 25);
  const options = [{ id: 'a', normalizedTrigger: 'moon' }, { id: 'b', normalizedTrigger: '2' }];
  assert.deepEqual(matchPaidTrigger('I vote ＭＯＯＮ! moon.', options, true), ['a']);
  assert.deepEqual(matchPaidTrigger('12 20 honeymoon', options, true), []);
  assert.deepEqual(matchPaidTrigger('moon and 2', options, true), ['a', 'b']);
  assert.deepEqual(matchPaidTrigger('I vote moon', options), []);
});

test('actual Bot adapter -> signed Admin -> D1 -> Public: additive Rants, same-snapshot gift, ordinary replacement and replay', async t => {
  const { h, env, created } = await setup(t); const { bot } = await open(env, created); const base = Date.parse(bot.paidContext.activatedAt) + 1000;
  const first = bridge(snapshot(base, { rants: [rant(base, 'A vote for moon, please!')] }), bot);
  await send(env, first, bot); await send(env, first, bot);
  let p = (await getPublicPoll(env, created.poll.slug)).poll; assert.equal(p.totalVotes, 10); assert.equal(p.options[0].bonusVotes, 10); assert.equal(p.options[0].ordinaryVotes, 0);
  const combined = bridge(snapshot(base + 2000, { gifts: [gift(base + 1000)], messages: [chat(base + 2000, 'moon')] }), bot);
  await send(env, combined, bot); await send(env, combined, bot);
  p = (await getPublicPoll(env, created.poll.slug)).poll; assert.equal(p.totalVotes, 16); assert.equal(p.options[0].bonusVotes, 15); assert.equal(p.options[0].ordinaryVotes, 1);
  await send(env, bridge(snapshot(base + 3000, { messages: [chat(base + 3000, '2')] }), bot), bot);
  p = (await getPublicPoll(env, created.poll.slug)).poll; assert.deepEqual(p.options.map(o => o.votes), [15, 1]);
  await send(env, bridge(snapshot(base + 4000, { rants: [rant(base + 4000, 'moon')] }), bot), bot);
  p = (await getPublicPoll(env, created.poll.slug)).poll; assert.equal(p.totalVotes, 26);
  assert.equal((await listPublicPolls(env, { type: 'abootnothing', view: 'recent', pageSize: 4 })).items[0].id, p.id);
  const anon = { namespace: 'web_anonymous', key: 'anonymous:test', label: null };
  await submitWebVote(env, anon, p.slug, { optionId: p.options[0].id }); await submitWebVote(env, anon, p.slug, { optionId: p.options[0].id });
  p = (await submitWebVote(env, anon, p.slug, { optionId: p.options[1].id })).poll; assert.deepEqual(p.options.map(o => o.votes), [25, 2]);
  await conservation(h);
  await mkdir('.artifacts/poll-credits', { recursive: true }); await writeFile('.artifacts/poll-credits/public-projection.json', JSON.stringify(p, null, 2));
});

test('N=1/2/3 policies persist; every distinct purchaser nonmatch consumes an independent attempt', async t => {
  const { h, env, created } = await setup(t); let { bot } = await open(env, created, { ...defaults, maxMessages: 1 });
  for (const n of [1, 2, 3]) {
    if (n > 1) { await savePollPolicy(env, 'credit-admin', { pollId: bot.id, revision: n - 1, policy: { ...defaults, maxMessages: n } }); bot = (await botActivePoll(env)).activePoll; }
    assert.equal(bot.paidContext.policy.maxMessages, n);
    const base = Date.parse(bot.paidContext.activatedAt) + 1000;
    const events = bridge(snapshot(base + 5000, { gifts: [gift(base, `Viewer ${n}`)], messages: Array.from({ length: n }, (_, i) => chat(base + (i + 1) * 1000, i === n - 1 ? 'moon' : '😀', `Viewer ${n}`)).reverse() }), bot);
    await send(env, events, bot); await send(env, events, bot);
    const lot = (await lots(h)).find(l => l.actor_label === `Viewer ${n}`); assert.equal(lot.committed, 5); assert.equal(lot.attempts_used, n);
    // New lot: all messages fail, fourth never revives it; other user consumes nothing.
    const failed = bridge(snapshot(base + 9000, { gifts: [gift(base + 6000, `Failed ${n}`, 5)], messages: [chat(base + 8500, 'moon', 'Other user'), ...Array.from({ length: n }, (_, i) => chat(base + 6500 + i * 500, `no ${i}`, `Failed ${n}`))] }), bot);
    await send(env, failed, bot);
    await send(env, bridge(snapshot(base + 10000, { messages: [chat(base + 10000, 'moon', `Failed ${n}`)] }), bot, [`rumble:user:synthetic:failed ${n}`]), bot);
    const exhausted = (await lots(h)).find(l => l.actor_label === `Failed ${n}`); assert.equal(exhausted.unreconciled, 25); assert.equal(exhausted.committed, 0); assert.equal(exhausted.attempts_used, n);
  }
  await conservation(h);
});

test('closed reconciliation, partial discard/allocation, over-allocation, concurrent retries and rollback', async t => {
  const { h, env, created } = await setup(t); const { bot } = await open(env, created); const base = Date.parse(bot.paidContext.activatedAt) + 1000;
  await send(env, bridge(snapshot(base, { gifts: [gift(base, 'Review Viewer', 5)] }), bot), bot);
  const opened = (await getPublicPoll(env, created.poll.slug)).poll;
  // Synthetic event times above activation must precede the synthetic closing boundary.
  await h.commerceDb.prepare('UPDATE poll_voting_windows SET opened_at=? WHERE id=?').bind(stamp(base - 2000), bot.paidContext.windowId).run();
  const closed = await changePollLifecycle(env, 'credit-admin', opened.slug, { revision: opened.revision, action: 'close' });
  assert.equal(closed.poll.credits.review, 25); assert.equal(closed.poll.totalVotes, 0);
  let lot = (await lots(h))[0]; const input = { lotId: lot.id, revision: lot.revision, amount: 10, action: 'allocate', optionId: closed.poll.options[0].id, requestId: randomUUID(), reason: 'Reviewed synthetic evidence' };
  const race = await Promise.allSettled([reconcilePollCredit(env, 'credit-admin', input), reconcilePollCredit(env, 'credit-admin', { ...input, requestId: randomUUID() })]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await getPublicPoll(env, opened.slug)).poll.totalVotes, 10);
  lot = (await lots(h))[0]; const invalid = { ...input, revision: lot.revision, requestId: randomUUID(), optionId: 'outside_option', amount: 1 };
  await assert.rejects(reconcilePollCredit(env, 'credit-admin', invalid)); assert.equal((await lots(h))[0].revision, lot.revision, 'allocation failure rolls back guard, audit and balance');
  await assert.rejects(reconcilePollCredit(env, 'credit-admin', { ...input, revision: lot.revision, requestId: randomUUID(), amount: 16 }));
  await reconcilePollCredit(env, 'credit-admin', { ...input, revision: lot.revision, requestId: randomUUID(), action: 'discard', amount: 5 });
  lot = (await lots(h))[0]; await reconcilePollCredit(env, 'credit-admin', { ...input, revision: lot.revision, requestId: randomUUID(), amount: 10 });
  const p = (await getPublicPoll(env, opened.slug)).poll; assert.equal(p.state, 'closed'); assert.equal(p.totalVotes, 20); assert.equal(p.credits.settled, true);
  const queue = await pollVotingAdmin(env); assert.deepEqual(queue.lots[0].options.map(o => o.id), p.options.map(o => o.id));
  lot = (await lots(h))[0];
  const correction = { ...input, action: 'correct', revision: lot.revision, requestId: randomUUID(), amount: 4, fromOptionId: p.options[0].id, optionId: p.options[1].id };
  await reconcilePollCredit(env, 'credit-admin', correction); await reconcilePollCredit(env, 'credit-admin', correction);
  assert.deepEqual((await getPublicPoll(env, opened.slug)).poll.options.map(o => o.votes), [16, 4]);
  await assert.rejects(h.commerceDb.prepare('UPDATE poll_credit_allocations SET amount=99 WHERE lot_id=?').bind(lot.id).run(), /poll_credit_allocation_immutable/);
  await assert.rejects(h.commerceDb.prepare('DELETE FROM poll_credit_audit WHERE lot_id=?').bind(lot.id).run(), /poll_credit_audit_immutable/);
  lot = (await lots(h))[0]; await assert.rejects(reconcilePollCredit(env, 'credit-admin', { ...correction, revision: lot.revision, requestId: randomUUID(), amount: 17 }));
  await assert.rejects(submitWebVote(env, { namespace: 'web_anonymous', key: 'test' }, p.slug, { optionId: p.options[1].id }));
  await conservation(h); assert.equal((await h.commerceDb.prepare('SELECT COUNT(*) count FROM poll_credit_guards').first()).count, 0);
});

test('same-time ordering, overlapping lots, timeout, ambiguous Rants and history gaps conserve credits', async t => {
  const { h, env, created } = await setup(t); const { bot } = await open(env, created); const base = Date.parse(bot.paidContext.activatedAt) + 1000;
  await send(env, bridge(snapshot(base + 1000, { gifts: [gift(base)], messages: [chat(base + 1000, '😀'), chat(base + 1000, 'moon')] }), bot), bot);
  assert.equal((await lots(h))[0].reason, 'ordering_ambiguous');
  await send(env, bridge(snapshot(base + 4000, { gifts: [gift(base + 2000, 'Overlap'), gift(base + 3000, 'Overlap')], messages: [chat(base + 4000, '2', 'Overlap')] }), bot), bot);
  assert.deepEqual((await lots(h)).filter(l => l.actor_label === 'Overlap').map(l => l.committed), [5, 5]);
  await send(env, bridge(snapshot(base + 5000, { rants: [rant(base + 5000, 'moon or 2')] }), bot), bot);
  assert.ok((await lots(h)).some(l => l.reason === 'multiple_option_triggers' && l.unreconciled === 10));
  await send(env, bridge(snapshot(base + 6000, { gifts: [gift(base + 6000, 'Timeout')] }), bot), bot);
  await h.commerceDb.prepare("UPDATE poll_credit_lots SET expires_at=? WHERE actor_label='Timeout'").bind(stamp(Date.now() - 1000)).run(); await expirePollCredits(env);
  assert.equal((await lots(h)).find(l => l.actor_label === 'Timeout').reason, 'timeout');
  await send(env, bridge(snapshot(base + 8000, { gifts: [gift(base + 7000, 'Gap')], messages: [chat(base + 8000, 'moon', 'Gap')], max: 1 }), bot), bot);
  assert.equal((await lots(h)).find(l => l.actor_label === 'Gap').reason, 'provider_history_gap'); await conservation(h);
});

test('predecessor upgrade preserves existing Polls; missing paid schema rejects before creation; reconciliation endpoint rejects anonymous and Bot credentials', async t => {
  const { h, env, created } = await setup(t, 40);
  await assert.rejects(createPoll(env, 'credit-admin', { title: 'Must not be written', presentationType: 'abootnothing', options: [{ label: 'A', trigger: 'a' }, { label: 'B', trigger: 'b' }] }), e => e.code === 'poll_credit_schema_required');
  assert.equal((await h.commerceDb.prepare('SELECT COUNT(*) count FROM polls').first()).count, 1);
  await applyMigration(h.commerceDb, await readFile(new URL('../commerce-migrations/0041_poll_matchups_and_credits.sql', import.meta.url), 'utf8'));
  assert.equal((await getPublicPoll(env, created.poll.slug, 'credit-admin', true)).poll.presentationType, 'regular');
  await assert.rejects(updatePoll(env, 'credit-admin', created.poll.slug, { revision: created.poll.revision, presentationType: 'abootnothing', options: [{ label: 'a', trigger: 'a' }, { label: 'b', trigger: 'b' }, { label: 'c', trigger: 'c' }] }));
  for (const headers of [{}, { 'X-ThirdRailify-Signature': 'fake-bot-signature' }]) { const r = await adminRequest({ env, request: new Request('https://thirdrailify-admin.pages.dev/api/admin/automations/poll-voting/reconcile', { method: 'POST', headers: { Origin: 'https://thirdrailify-admin.pages.dev', 'Content-Type': 'application/json', ...headers }, body: '{}' }) }); assert.ok([401, 403].includes(r.status)); }
});

test('paid source/window isolation, reopen replay, close/matching race and approved-creator reconciliation denial', async t => {
  const { h, env, created } = await setup(t); const { bot } = await open(env, created); const base = Date.parse(bot.paidContext.activatedAt) + 1;
  const earned = bridge(snapshot(base, { gifts: [gift(base)] }), bot); await send(env, earned, bot);
  const incoming = bridge(snapshot(base + 1, { messages: [chat(base + 1, 'moon')] }), bot, ['rumble:user:synthetic:synthetic viewer']);
  const wrong = structuredClone(incoming.paid); wrong.events[0].sourceScope = 'user:another'; wrong.fingerprint = sha('wrong-source');
  await assert.rejects(ingestPaidSnapshot(env, wrong));
  const other = await createPoll(env, 'credit-admin', { title: 'Regular lease competitor', rumbleEnabled: true, rumbleSourceScope: 'user:synthetic', options: [{ label: 'Yes', trigger: 'yes' }, { label: 'No', trigger: 'no' }] });
  await assert.rejects(changePollLifecycle(env, 'credit-admin', other.poll.slug, { revision: other.poll.revision, action: 'open' }), e => e.code === 'rumble_source_poll_conflict');
  const current = (await getPublicPoll(env, created.poll.slug)).poll;
  await Promise.allSettled([ingestPaidSnapshot(env, incoming.paid), changePollLifecycle(env, 'credit-admin', current.slug, { revision: current.revision, action: 'close' })]);
  let p = (await getPublicPoll(env, current.slug)).poll; assert.equal(p.state, 'closed'); assert.ok([0, 5].includes(p.totalVotes)); assert.equal((await lots(h))[0].waiting, 0); await conservation(h);
  await changePollLifecycle(env, 'credit-admin', p.slug, { revision: p.revision, action: 'open' });
  const refreshed = (await botActivePoll(env)).activePoll; assert.notEqual(refreshed.paidContext.windowId, bot.paidContext.windowId);
  await send(env, earned, bot, false); assert.equal((await lots(h)).length, 1);
  p = (await getPublicPoll(env, p.slug)).poll;
  for (const id of ['approved-owner', 'ordinary-user']) {
    const now = new Date().toISOString();
    await h.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,'user','none','active',?,?,?,'test')").bind(id, `${id}@example.test`, id, now, now, now).run();
    if (id === 'approved-owner') {
      await h.commerceDb.prepare('INSERT INTO poll_creator_grants(account_id,active,may_create_polls,created_at,updated_at) VALUES (?,1,1,?,?)').bind(id, now, now).run();
      await h.commerceDb.prepare('UPDATE polls SET owner_account_id=? WHERE id=?').bind(id, p.id).run();
    }
    const account = await h.authDb.prepare('SELECT * FROM accounts WHERE id=?').bind(id).first();
    const session = await createSession(env, new Request('https://thirdrailify-admin.pages.dev'), account, 'https://thirdrailify-admin.pages.dev');
    const response = await adminRequest({ env, request: new Request('https://thirdrailify-admin.pages.dev/api/admin/automations/poll-voting/reconcile', { method: 'POST', headers: { Origin: 'https://thirdrailify-admin.pages.dev', Cookie: session.cookie.split(';')[0], 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' }, body: '{}' }) });
    assert.equal(response.status, 403);
  }
});


test('late equal-time messages, exact-stream mismatch and expiry races never double allocate', async t => {
  const { h, env, created } = await setup(t);
  const configured = await updatePoll(env, 'credit-admin', created.poll.slug, { revision: created.poll.revision, livestreamMode: 'exact', livestreamId: 'synthetic-live' });
  const { bot } = await open(env, configured); const base = Date.parse(bot.paidContext.activatedAt) + 1000;
  await send(env, bridge(snapshot(base + 1000, { gifts: [gift(base)], messages: [chat(base + 1000, 'hello')] }), bot), bot);
  let lot = (await lots(h))[0]; assert.equal(lot.attempts_used, 1);
  await send(env, bridge(snapshot(base + 1000, { messages: [chat(base + 1000, 'moon')] }), bot, [lot.actor_key]), bot, false);
  lot = (await lots(h))[0]; assert.equal(lot.committed, 0); assert.equal(lot.reason, 'late_message_history');
  await send(env, bridge(snapshot(base + 2000, { gifts: [gift(base + 2000, 'Expiry')] }), bot), bot);
  let expiry = (await lots(h)).find(l => l.actor_label === 'Expiry');
  const matching = bridge(snapshot(base + 3000, { messages: [chat(base + 3000, 'moon', 'Expiry')] }), bot, [expiry.actor_key]).paid;
  const wrong = structuredClone(matching); wrong.events[0].livestreamId = 'other-stream'; wrong.fingerprint = sha('wrong-stream');
  await ingestPaidSnapshot(env, wrong); expiry = (await lots(h)).find(l => l.id === expiry.id); assert.equal(expiry.attempts_used, 0);
  await h.commerceDb.prepare('UPDATE poll_credit_lots SET expires_at=? WHERE id=?').bind(stamp(Date.now() - 1000), expiry.id).run();
  await Promise.allSettled([expirePollCredits(env), ingestPaidSnapshot(env, matching)]);
  expiry = (await lots(h)).find(l => l.id === expiry.id); assert.equal(expiry.committed, 0); assert.equal(expiry.waiting, 0); assert.equal(expiry.unreconciled, 5);
  await conservation(h);
});
