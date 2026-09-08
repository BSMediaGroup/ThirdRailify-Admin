import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaObject, hasSchemaObjects, SCHEMA_CACHE_MS } from '../functions/_shared/schema-capabilities.js';

function fixture() {
  const state = { reads: 0, fail: false, rows: [{ name: 'automation_rules', type: 'table', sql: 'CREATE TABLE automation_rules(...)' }, { name: 'poll_result_history', type: 'table', sql: '' }] };
  const db = { prepare() { return { bind() { return { async all() { state.reads++; if (state.fail) throw new Error('database unavailable'); return { results: state.rows }; } }; } }; } };
  return { db, state };
}

test('five minutes of fifteen-second reads reuse schema, not operational data', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { db, state } = fixture();
  for (let i = 0; i < 20; i++) {
    assert.equal(await hasSchemaObjects(db, ['automation_rules', 'poll_result_history'], 'table'), true);
    t.mock.timers.tick(15000);
  }
  assert.equal(state.reads, 1, '40 former catalogue scans collapse to one');
  await schemaObject(db, 'automation_rules');
  assert.equal(state.reads, 2, 'expired cache revalidates');
});

test('database identities remain isolated and returned metadata cannot be mutated', async () => {
  const a = fixture(), b = fixture();
  b.state.rows = [];
  const result = await schemaObject(a.db, 'automation_rules');
  assert.throws(() => { result.sql = 'forged'; });
  assert.equal(await schemaObject(b.db, 'automation_rules'), null);
  assert.equal(a.state.reads, 1); assert.equal(b.state.reads, 1);
});

test('missing schema and failed checks are never cached as success; migration recovers immediately', async () => {
  const { db, state } = fixture();
  state.rows = [];
  assert.equal(await schemaObject(db, 'automation_rules'), null);
  state.fail = true;
  await assert.rejects(schemaObject(db, 'automation_rules'), /unavailable/);
  state.fail = false;
  state.rows = [{ name: 'automation_rules', type: 'table', sql: 'new migration' }];
  assert.equal((await schemaObject(db, 'automation_rules')).sql, 'new migration');
  assert.equal(state.reads, 3);
});

test('expired success cannot hide an outage or a removed guard', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { db, state } = fixture();
  await schemaObject(db, 'automation_rules');
  t.mock.timers.tick(SCHEMA_CACHE_MS);
  state.fail = true;
  await assert.rejects(schemaObject(db, 'automation_rules'), /unavailable/);
  state.fail = false; state.rows = [];
  assert.equal(await schemaObject(db, 'automation_rules'), null);
});

test('object type checks and unknown capability names fail closed', async () => {
  const { db } = fixture();
  assert.equal(await schemaObject(db, 'automation_rules', 'trigger'), null);
  await assert.rejects(schemaObject(db, 'user-supplied-table'), /Unsupported/);
});
