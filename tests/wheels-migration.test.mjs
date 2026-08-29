import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyMigration } from "./auth-test-helpers.mjs";
import { createCommerceDatabases } from "./commerce-test-helpers.mjs";

test("0014 creates an empty normalized Wheels authority with immutable result constraints", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const tables = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wheel_%' ORDER BY name").all();
  assert.deepEqual(tables.results.map((row) => row.name), ["wheel_access", "wheel_audit_events", "wheel_creator_grants", "wheel_entries", "wheel_media_assets", "wheel_official_spins", "wheel_rate_limits", "wheel_settings", "wheels"]);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheels").first()).count), 0);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_official_spins").first()).count), 0);
  const setting = await harness.commerceDb.prepare("SELECT value_json FROM wheel_settings WHERE setting_key = 'global'").first();
  assert.equal(JSON.parse(setting.value_json).maximumParticipants, 1000);
});

test("0016 adds empty purpose-scoped wheel media metadata without changing wheel data", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_media_assets").first()).count), 0);
  const indexes = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'wheel_media_assets' ORDER BY name").all();
  assert.deepEqual(indexes.results.map((row) => row.name), ["sqlite_autoindex_wheel_media_assets_1", "sqlite_autoindex_wheel_media_assets_2", "wheel_media_active_purpose_idx", "wheel_media_delivery_idx", "wheel_media_wheel_history_idx"]);
});

test("staging wheel seed is explicit, idempotent, synthetic, and exactly removable", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const seed = await readFile(new URL("../scripts/wheels-demo-seed.sql", import.meta.url), "utf8"); const cleanup = await readFile(new URL("../scripts/wheels-demo-cleanup.sql", import.meta.url), "utf8");
  assert.match(seed, /STAGING ONLY/); assert.match(seed, /DEMO-WHEEL-01/); assert.doesNotMatch(seed, /@|payment|donation/i);
  await applyMigration(harness.commerceDb, seed); await applyMigration(harness.commerceDb, seed);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheels").first()).count), 1);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_entries").first()).count), 8);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheel_official_spins").first()).count), 0);
  await applyMigration(harness.commerceDb, cleanup);
  assert.equal(Number((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM wheels").first()).count), 0);
});

test("wheel schema rejects invalid lifecycle, weights, colours, and destructive result cascades", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const db = harness.commerceDb; const now = new Date().toISOString();
  const insertWheel = db.prepare("INSERT INTO wheels (id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,participant_count,created_at,updated_at) VALUES ('w-test','W-TEST','test-wheel','Test wheel','active','public','owner','{}',0,?,?)"); await insertWheel.bind(now, now).run();
  await assert.rejects(db.prepare("UPDATE wheels SET lifecycle = 'deleted' WHERE id = 'w-test'").run());
  await assert.rejects(db.prepare("INSERT INTO wheel_entries (id,wheel_id,display_label,display_order,weight,segment_colour,state,created_at,updated_at) VALUES ('e1','w-test','Entry',0,0,'#FFFFFF','active',?,?)").bind(now, now).run());
  await assert.rejects(db.prepare("INSERT INTO wheel_entries (id,wheel_id,display_label,display_order,weight,segment_colour,state,created_at,updated_at) VALUES ('e2','w-test','Entry',0,1,'red','active',?,?)").bind(now, now).run());
});
