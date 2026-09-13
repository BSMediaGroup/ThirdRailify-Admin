import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Miniflare } from 'miniflare';
import { applyMigration } from './auth-test-helpers.mjs';
import { intelligenceTrend } from '../functions/_shared/rumble-intelligence.js';

const source = 'user:1sl8zm';
const setId = index => (200_000 + index).toString(16).padStart(64, '0');

function meter(database) {
  const cost = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const record = result => {
    for (const item of Array.isArray(result) ? result : [result]) {
      cost.queries += 1;
      cost.rowsRead += Number(item?.meta?.rows_read || 0);
      cost.rowsWritten += Number(item?.meta?.rows_written || 0);
    }
    return result;
  };
  return {
    cost,
    prepare(sql) {
      let statement = database.prepare(sql);
      const wrapper = {
        bind(...values) { statement = statement.bind(...values); return wrapper; },
        async all() { return record(await statement.all()); },
        async run() { return record(await statement.run()); },
        async first(column) {
          const result = record(await statement.all());
          return column ? result.results[0]?.[column] ?? null : result.results[0] ?? null;
        },
        get raw() { return statement; },
      };
      return wrapper;
    },
    async batch(statements) { return record(await database.batch(statements.map(statement => statement.raw))); },
  };
}

const oldSql = `WITH selected AS (
  SELECT MAX(provider_at) at FROM rumble_intelligence_observations
  WHERE source=? AND qualified=1 AND provider_at>=? AND provider_at<=?
  GROUP BY CAST(unixepoch(provider_at)/? AS INTEGER)
) SELECT o.provider_at,o.provenance,o.set_id,m.records_json
FROM selected s
JOIN rumble_intelligence_observations o ON o.provider_at=s.at AND o.source=? AND o.qualified=1
JOIN rumble_intelligence_sets m ON m.id=o.set_id
ORDER BY o.provider_at,o.provenance LIMIT 340`;

const checkpointSql = `SELECT provider_at,provenance,total_count,paid_count,gifted_count,mixed_count,review_count
FROM rumble_intelligence_rollups
WHERE source=? AND grain=? AND bucket_start>=? AND bucket_start<=? AND provider_at>=? AND provider_at<=?
ORDER BY bucket_start DESC LIMIT ?`;

test('100k observations: history reads bounded rollups instead of regrouping and joining raw roster blobs', { timeout: 180_000 }, async t => {
  const miniflare = new Miniflare({
    compatibilityDate: '2026-08-11',
    d1Databases: ['THIRDRAILIFY_COMMERCE_DB'],
    modules: true,
    script: "export default { fetch() { return new Response('test'); } };",
  });
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database('THIRDRAILIFY_COMMERCE_DB');
  const initialMigration = await readFile(new URL('../commerce-migrations/0045_rumble_intelligence.sql', import.meta.url), 'utf8');
  const rollupMigration = await readFile(new URL('../commerce-migrations/0049_rumble_intelligence_rollups.sql', import.meta.url), 'utf8');
  await applyMigration(db, initialMigration);

  const anchorEpoch = Math.floor(Date.now() / 1000) - 60;
  for (let index = 0; index < 10; index++) {
    await db.prepare('INSERT INTO rumble_intelligence_sets(id,source,records_json,created_at) VALUES(?,?,?,?)')
      .bind(setId(index), source, JSON.stringify([{ name: `account-${index}`, classification: index % 2 ? 'Gifted' : 'Self-paid' }]), new Date(anchorEpoch * 1000).toISOString()).run();
  }
  const insertStarted = performance.now();
  await db.prepare(`WITH digits(n) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
    numbers(n) AS (
      SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n
      FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
    )
    INSERT INTO rumble_intelligence_observations
      (id,source,provider_at,observed_at,received_at,provenance,qualified,set_id,metadata_json)
    SELECT printf('%064x',n+1),?,strftime('%Y-%m-%dT%H:%M:%SZ',?-(99999-n)*5,'unixepoch'),
      strftime('%Y-%m-%dT%H:%M:%SZ',?-(99999-n)*5,'unixepoch'),
      strftime('%Y-%m-%dT%H:%M:%SZ',?-(99999-n)*5,'unixepoch'),'live',1,
      printf('%064x',200000+CAST(n/10000 AS INTEGER)),'{"rawCount":1}'
    FROM numbers`).bind(source, anchorEpoch, anchorEpoch, anchorEpoch).run();
  const insertDurationMs = performance.now() - insertStarted;
  const currentId = (100_000).toString(16).padStart(64, '0');
  const currentAt = new Date(anchorEpoch * 1000).toISOString();
  await db.prepare('INSERT INTO rumble_intelligence_sources(source,current_id,current_at,attempt_at,attempt_json) VALUES(?,?,?,?,?)')
    .bind(source, currentId, currentAt, currentAt, JSON.stringify({ qualified: true, setId: setId(9), providerAt: currentAt })).run();
  assert.equal(Number((await db.prepare('SELECT COUNT(*) count FROM rumble_intelligence_observations').first()).count), 100_000);

  const from = new Date((anchorEpoch - 7 * 86400) * 1000).toISOString();
  // One hour is enough to prove the source-cardinality join amplification but
  // keeps the known-bad query tolerable in CI. The production 7d shape has the
  // identical plan and roughly 168 times as many joined buckets.
  const oldMeasuredFrom = new Date((anchorEpoch - 3600) * 1000).toISOString();
  const oldPlan = (await db.prepare(`EXPLAIN QUERY PLAN ${oldSql}`).bind(source, oldMeasuredFrom, currentAt, 3600, source).all()).results.map(row => row.detail);
  const oldStarted = performance.now();
  const oldResult = await db.prepare(oldSql).bind(source, oldMeasuredFrom, currentAt, 3600, source).all();
  const oldDurationMs = performance.now() - oldStarted;
  const oldRowsRead = Number(oldResult.meta.rows_read);
  assert.ok(oldPlan.some(detail => /TEMP B-TREE FOR GROUP BY/i.test(detail)), oldPlan.join('\n'));
  assert.ok(oldRowsRead > 10_000_000, `former query unexpectedly read only ${oldRowsRead} rows`);

  const migrationStarted = performance.now();
  await applyMigration(db, rollupMigration);
  const migrationDurationMs = performance.now() - migrationStarted;
  const meterDb = meter(db);
  const env = { THIRDRAILIFY_COMMERCE_DB: meterDb };
  const measured = {};
  for (const range of ['24h', '7d', '30d', '90d']) {
    Object.assign(meterDb.cost, { queries: 0, rowsRead: 0, rowsWritten: 0 });
    const started = performance.now();
    const result = await intelligenceTrend(env, source, range, currentId);
    measured[range] = { ...meterDb.cost, durationMs: performance.now() - started, points: result.points.length, maxPoints: result.maxPoints };
    assert.ok(result.points.length <= result.maxPoints);
    assert.ok(meterDb.cost.rowsRead <= result.maxPoints * 2 + 12, `${range} read ${meterDb.cost.rowsRead} rows`);
    assert.equal(meterDb.cost.rowsWritten, 0);
  }
  const firstBucket = new Date(Math.floor(Date.parse(from) / 3_600_000) * 3_600_000).toISOString();
  const newPlan = (await db.prepare(`EXPLAIN QUERY PLAN ${checkpointSql}`).bind(source, 'hour', firstBucket, currentAt, from, currentAt, 169).all()).results.map(row => row.detail);
  assert.ok(newPlan.some(detail => /SEARCH rumble_intelligence_rollups USING PRIMARY KEY/i.test(detail)), newPlan.join('\n'));
  assert.ok(newPlan.every(detail => !/^SCAN\b/i.test(detail) && !/TEMP B-TREE/i.test(detail)), newPlan.join('\n'));
  assert.ok(oldRowsRead / measured['7d'].rowsRead > 1_000, `cost ratio was only ${oldRowsRead / measured['7d'].rowsRead}`);
  t.diagnostic(JSON.stringify({ observations: 100_000, insertDurationMs, old: { rowsRead: oldRowsRead, rowsReturned: oldResult.results.length, durationMs: oldDurationMs, plan: oldPlan }, rollupMigration: { durationMs: migrationDurationMs, rows: Number((await db.prepare('SELECT COUNT(*) count FROM rumble_intelligence_rollups').first()).count) }, new: measured, newPlan }));
});
