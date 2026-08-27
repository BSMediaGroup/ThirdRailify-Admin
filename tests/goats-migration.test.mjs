import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyMigration } from "./auth-test-helpers.mjs";
import { createCommerceDatabases, insertTestProduct } from "./commerce-test-helpers.mjs";

test("0004 adds empty community authority and idempotent email templates", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const tables = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'community_%' ORDER BY name").all();
  assert.deepEqual(tables.results.map((row) => row.name), ["community_comments", "community_email_outbox", "community_email_templates", "community_media", "community_moderation_events", "community_rate_limits", "community_reactions", "community_submissions"]);
  const templates = await harness.commerceDb.prepare("SELECT template_key, status FROM community_email_templates ORDER BY template_key").all();
  assert.equal(templates.results.length, 4); assert.ok(templates.results.every((row) => row.status === "draft"));
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM community_submissions").first()).count, 0);
});

test("community schema rejects invalid rating, reaction, duplicate user reaction, and published pending state", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await insertTestProduct(harness.commerceDb);
  const base = `INSERT INTO community_submissions (id, reference_code, public_slug, status, is_published, display_name, description, product_id, product_slug_snapshot, product_name_snapshot, rating, city, country_code, public_location_label, public_latitude, public_longitude, consent_version, consented_at, created_at, submitted_at, updated_at, approved_at) VALUES`;
  await assert.rejects(harness.commerceDb.prepare(`${base} ('10000000-0000-4000-8000-000000000001','BAD-RATING','bad-rating','approved',1,'Demo','Description','product-test-001','product-test-001','Product',6,'Toronto','CA','Toronto, CA',43,-79,'v','now','now','now','now','now')`).run());
  await assert.rejects(harness.commerceDb.prepare(`${base} ('10000000-0000-4000-8000-000000000002','BAD-PUBLISH','bad-publish','pending',1,'Demo','Description','product-test-001','product-test-001','Product',5,'Toronto','CA','Toronto, CA',43,-79,'v','now','now','now','now',NULL)`).run());
  await harness.commerceDb.prepare(`${base} ('10000000-0000-4000-8000-000000000003','GOOD-DEMO','good-demo','approved',1,'Demo','Description','product-test-001','product-test-001','Product',5,'Toronto','CA','Toronto, CA',43,-79,'v','now','now','now','now','now')`).run();
  await assert.rejects(harness.commerceDb.prepare("INSERT INTO community_reactions (submission_id, account_id, value, created_at, updated_at) VALUES ('10000000-0000-4000-8000-000000000003','user',0,'now','now')").run());
  await harness.commerceDb.prepare("INSERT INTO community_reactions (submission_id, account_id, value, created_at, updated_at) VALUES ('10000000-0000-4000-8000-000000000003','user',1,'now','now')").run();
  await assert.rejects(harness.commerceDb.prepare("INSERT INTO community_reactions (submission_id, account_id, value, created_at, updated_at) VALUES ('10000000-0000-4000-8000-000000000003','user',-1,'now','now')").run());
});

test("opt-in demo fixture seeds exactly two deletable records and cleanup removes only fixed demo identities", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const seed = await readFile(new URL("../scripts/goats-demo-seed.sql", import.meta.url), "utf8"); const cleanup = await readFile(new URL("../scripts/goats-demo-cleanup.sql", import.meta.url), "utf8");
  assert.match(seed, /LOCAL\/TEST ONLY/); assert.doesNotMatch(seed, /INSERT[^;]+submitter_email/is);
  await applyMigration(harness.commerceDb, seed);
  const records = await harness.commerceDb.prepare("SELECT reference_code FROM community_submissions ORDER BY reference_code").all(); assert.deepEqual(records.results.map((row) => row.reference_code), ["DEMO-GOAT-01", "DEMO-GOAT-02"]);
  await applyMigration(harness.commerceDb, seed); assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM community_submissions").first()).count), 2);
  await applyMigration(harness.commerceDb, cleanup); assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM community_submissions").first()).count), 0);
});
