import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ensureEnvironmentMasters } from '../functions/_shared/auth-core.js';
import { onRequest } from '../functions/api/internal/bot/[[path]].js';
import { recordBotHeartbeat } from '../functions/_shared/polls-core.js';
import { createAuthDatabase, authEnvironment } from './auth-test-helpers.mjs';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';

function meter(db) {
  const cost = { queries: 0, writes: 0, reads: 0, mutations: 0 };
  const record = result => {
    for (const row of Array.isArray(result) ? result : [result]) {
      cost.queries++; cost.writes += row?.meta?.rows_written || 0;
      cost.reads += row?.meta?.rows_read || 0; cost.mutations += row?.meta?.changes || 0;
    }
    return result;
  };
  return { cost, prepare: (...args) => {
    let statement = db.prepare(...args);
    const wrapper = { bind: (...values) => { statement = statement.bind(...values); return wrapper; },
      run: async () => record(await statement.run()), all: async () => record(await statement.all()),
      first: async (...values) => { const result = record(await statement.all()); return values.length ? result.results[0]?.[values[0]] ?? null : result.results[0] ?? null; },
      get raw() { return statement; } };
    return wrapper;
  }, batch: async statements => record(await db.batch(statements.map(s => s.raw))) };
}

test('100 unchanged master reconciliations write zero rows; authoritative changes repair immediately', async t => {
  const h = await createAuthDatabase(); t.after(() => h.dispose());
  const db = meter(h.db); const env = authEnvironment(db);
  await ensureEnvironmentMasters(env);
  const initial = await h.db.prepare('SELECT * FROM accounts ORDER BY id').all();
  db.cost.writes = 0;
  for (let i = 0; i < 100; i++) await ensureEnvironmentMasters(env);
  assert.equal(db.cost.writes, 0);
  assert.deepEqual((await h.db.prepare('SELECT * FROM accounts ORDER BY id').all()).results, initial.results);
  await h.db.prepare("UPDATE accounts SET role='user',admin_level='none',status='disabled',source='other',email_verified_at=NULL,display_name='' WHERE id='env-master-1'").run();
  await ensureEnvironmentMasters(env);
  const repaired = await h.db.prepare("SELECT * FROM accounts WHERE id='env-master-1'").first();
  assert.equal(repaired.role, 'admin'); assert.equal(repaired.status, 'active'); assert.equal(repaired.admin_level, 'master');
  assert.equal(repaired.source, 'env_master'); assert.ok(repaired.email_verified_at); assert.ok(repaired.display_name);
  await h.db.prepare("UPDATE accounts SET display_name='Personal name' WHERE id='env-master-1'").run();
  env.ADMIN_EMAIL_1 = 'changed@example.test';
  await Promise.all(Array.from({ length: 10 }, () => ensureEnvironmentMasters(env)));
  const changed = await h.db.prepare("SELECT * FROM accounts WHERE id='env-master-1'").first();
  assert.equal(changed.email_normalized, env.ADMIN_EMAIL_1); assert.equal(changed.display_name, 'Personal name');
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n, 2);
  t.diagnostic(JSON.stringify(db.cost));
});

const secret = 'local-write-budget-test-secret';
function request(path, id = randomUUID(), timestamp = String(Math.floor(Date.now() / 1000))) {
  const route = `/api/internal/bot/${path}`;
  const digest = createHash('sha256').update('').digest('hex');
  const signature = createHmac('sha256', secret).update(`GET\n${route}\n${timestamp}\n${id}\n${digest}`).digest('base64url');
  return new Request(`https://admin.example${route}`, { headers: { 'x-thirdrailify-timestamp': timestamp,
    'x-thirdrailify-request-id': id, 'x-thirdrailify-signature': signature } });
}

test('100 control cycles preserve projections with one nonce instead of three; replay stays rejected', async t => {
  const h = await createCommerceDatabases(); t.after(() => h.dispose());
  const db = meter(h.commerceDb); const env = commerceEnvironment(h, { THIRDRAILIFY_COMMERCE_DB: db, THIRDRAILIFY_BOT_ADMIN_SECRET: secret });
  const run = async path => { const response = await onRequest({ request: request(path), env }); assert.equal(response.status, 200); return response.json(); };
  const legacy = {};
  const start = performance.now();
  for (let i = 0; i < 100; i++) for (const path of ['config', 'poll', 'rules-v2']) legacy[path] = await run(path);
  const before = { ...db.cost, duration: performance.now() - start };
  Object.keys(db.cost).forEach(k => { db.cost[k] = 0; });
  const afterStart = performance.now();
  for (let i = 0; i < 100; i++) {
    const control = await run('control');
    assert.equal(control.version, 1);
    for (const [key, path] of [['config', 'config'], ['poll', 'poll'], ['rules', 'rules-v2']]) {
      assert.equal(control[key].status, 200);
      // Server clocks are freshness metadata, not configuration or rule content.
      const omitClock = value => JSON.parse(JSON.stringify(value, (k, v) => ['serverTime', 'generatedAt', 'fetchedAt'].includes(k) ? undefined : v));
      assert.deepEqual(omitClock(control[key].body), omitClock(legacy[path]));
    }
  }
  const after = { ...db.cost, duration: performance.now() - afterStart };
  assert.equal(after.writes * 3, before.writes);
  assert.ok(after.queries < before.queries); assert.ok(after.reads <= before.reads);
  assert.equal((await h.commerceDb.prepare('SELECT COUNT(*) AS n FROM bot_service_nonces').first()).n, 400);
  const repeated = request('control');
  const concurrent = await Promise.all([onRequest({ request: repeated.clone(), env }), onRequest({ request: repeated.clone(), env })]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  const invalid = request('control'); invalid.headers.set('x-thirdrailify-signature', 'invalid');
  assert.equal((await onRequest({ request: invalid, env })).status, 401);
  await h.commerceDb.prepare("UPDATE bot_automation_config SET desired_revision=desired_revision+1 WHERE singleton_id=1").run();
  assert.equal((await run('control')).config.body.revision, legacy.config.revision + 1);
  const heartbeatsBefore = db.cost.writes;
  const heartbeat = { startupInstanceId: 'budget-instance', botVersion: '1.1.0', desiredRevision: 2, appliedRevision: 2, runtime: { discordConnected: true } };
  for (let i = 0; i < 100; i++) assert.equal((await recordBotHeartbeat(env, heartbeat)).ok, true);
  assert.equal(db.cost.writes - heartbeatsBefore, 100);
  heartbeat.runtime.discordConnected = false;
  await recordBotHeartbeat(env, heartbeat);
  assert.equal(JSON.parse((await h.commerceDb.prepare('SELECT runtime_json FROM bot_runtime_heartbeat WHERE singleton_id=1').first()).runtime_json).discordConnected, false);
  await h.commerceDb.prepare("DELETE FROM automation_rules").run();
  await h.commerceDb.prepare("DROP TABLE automation_rules").run();
  const partial = await run('control');
  assert.equal(partial.config.status, 200); assert.equal(partial.poll.status, 200); assert.equal(partial.rules.status, 503);
  t.diagnostic(JSON.stringify({ before, after }));
});
