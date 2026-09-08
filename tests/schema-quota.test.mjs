import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyMigration } from './auth-test-helpers.mjs';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { paidSchema } from '../functions/_shared/poll-credits.js';
import { automationReadiness } from '../functions/_shared/automation-core.js';
import { bracketReady } from '../functions/_shared/brackets-core.js';

test('real D1 schema checks share one scan while runtime observations stay live', async t => {
  const h = await createCommerceDatabases(); t.after(() => h.dispose());
  await applyMigration(h.commerceDb, await readFile(new URL('../commerce-migrations/0043_aboot_matchup_studio.sql', import.meta.url), 'utf8'));
  let scans = 0, schemaRows = 0, heartbeats = 0;
  const db = new Proxy(h.commerceDb, { get(target, key) {
    if (key !== 'prepare') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    return sql => {
      if (/FROM bot_runtime_heartbeat/.test(sql)) heartbeats++;
      const statement = target.prepare(sql);
      if (!/sqlite_master/.test(sql)) return statement;
      scans++;
      return { bind(...args) { const bound = statement.bind(...args); return { async all() { const result = await bound.all(); schemaRows += result.meta.rows_read; return result; } }; } };
    };
  } });
  const env = commerceEnvironment(h, { THIRDRAILIFY_COMMERCE_DB: db });
  const first = await automationReadiness(env);
  assert.equal(first.raidSchema, true); assert.equal(first.raidRuntime, false);
  const timestamp = new Date().toISOString();
  await h.commerceDb.prepare(`INSERT INTO bot_runtime_heartbeat(singleton_id,startup_instance_id,bot_version,desired_revision,applied_revision,runtime_json,heartbeat_at,updated_at)
    VALUES (1,'quota-fixture','1.1.0',1,1,?,?,?)`).bind(JSON.stringify({ eventAutomation: { raidNoticeVersion: 1 } }), timestamp, timestamp).run();
  for (let i = 0; i < 40; i++) {
    assert.equal(await paidSchema(env), true);
    await bracketReady(env);
    const current = await automationReadiness(env);
    assert.equal(current.raidSchema, true);
    assert.equal(current.raidRuntime, true, 'new heartbeat is visible with warm schema metadata');
  }
  assert.equal(scans, 1);
  assert.equal(heartbeats, 41, 'heartbeat is read on every readiness check');
  const baseline = await h.commerceDb.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name IN ('poll_credit_guards','poll_credit_lifecycle','poll_credit_allocation_guard','poll_credit_review_audit','poll_credit_structure_update')").all();
  // Even just the former paid-schema check ran twice per iteration here.
  const baselineRows = baseline.meta.rows_read * 80;
  assert.ok(schemaRows < baselineRows / 20, `${schemaRows} vs ${baselineRows} rows`);
  t.diagnostic(JSON.stringify({ cycles: 40, metadataScans: scans, schemaRows, oldPaidChecksAloneRows: baselineRows, liveHeartbeatReads: heartbeats }));
});
