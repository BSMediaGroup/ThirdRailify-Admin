import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createCommerceDatabases, importPermanentCatalogue } from "./commerce-test-helpers.mjs";
import { validatePermanentCatalogueEvidence } from "../scripts/validate-permanent-catalogue.mjs";

const importUrl = new URL("../commerce-import/permanent-catalogue-import.json", import.meta.url);

test("authoritative permanent catalogue evidence passes every final write gate", () => {
  const report = validatePermanentCatalogueEvidence();
  assert.deepEqual({ products: report.migrateProducts, active: report.eligibleVariants, deferred: report.deferredVariants, maximum: report.maximumVariantsPerProduct }, { products: 49, active: 1317, deferred: 5, maximum: 96 });
  assert.equal(report.targetNativeKeeps, 1);
  assert.equal(report.manualReview, 1);
  assert.equal(report.selectedDiscontinuedVariants, 90);
});

test("permanent catalogue import is exact, safe, and idempotent without erasing target mappings", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const manifest = JSON.parse(await readFile(importUrl, "utf8"));
  await importPermanentCatalogue(harness.commerceDb, manifest);
  await assertCatalogue(harness.commerceDb);

  await harness.commerceDb.prepare("UPDATE commerce_products SET target_printful_product_id = '999001', migration_status = 'target_verified' WHERE id = 'product-393219932'").run();
  await harness.commerceDb.prepare("UPDATE commerce_product_variants SET target_printful_product_id = '999001', target_printful_sync_variant_id = '999002', migration_status = 'target_verified', fulfillment_mapping_status = 'mapped' WHERE id = 'variant-4974393098'").run();
  await importPermanentCatalogue(harness.commerceDb, manifest);
  await assertCatalogue(harness.commerceDb);
  const product = await harness.commerceDb.prepare("SELECT target_printful_product_id, migration_status FROM commerce_products WHERE id = 'product-393219932'").first();
  const variant = await harness.commerceDb.prepare("SELECT target_printful_product_id, target_printful_sync_variant_id, migration_status, fulfillment_mapping_status FROM commerce_product_variants WHERE id = 'variant-4974393098'").first();
  assert.deepEqual(product, { target_printful_product_id: "999001", migration_status: "target_verified" });
  assert.deepEqual(variant, { target_printful_product_id: "999001", target_printful_sync_variant_id: "999002", migration_status: "target_verified", fulfillment_mapping_status: "mapped" });
});

async function assertCatalogue(db) {
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM commerce_products").first()).total, 50);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM commerce_product_variants").first()).total, 1323);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM commerce_products WHERE legacy_printful_source_product_id IS NOT NULL").first()).total, 49);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM commerce_product_variants WHERE legacy_source_variant_id IS NOT NULL AND availability_status = 'active'").first()).total, 1317);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM commerce_product_variants WHERE migration_status = 'deferred' AND availability_status = 'temporarily_out_of_stock' AND is_sellable = 0").first()).total, 5);
  assert.equal((await db.prepare("SELECT MAX(amount) AS maximum FROM (SELECT product_id, COUNT(*) AS amount FROM commerce_product_variants WHERE legacy_source_variant_id IS NOT NULL AND availability_status = 'active' GROUP BY product_id)").first()).maximum, 96);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM commerce_product_variants WHERE availability_status = 'discontinued' OR is_sellable = 1 OR visibility <> 'private'").first()).total, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM commerce_products WHERE legacy_printful_source_product_id = '454885552'").first()).total, 0, "Raider's Goblet is not imported into the create queue");
  const nativeProduct = await db.prepare("SELECT title, target_printful_product_id, migration_status, visibility FROM commerce_products WHERE id = 'product-target-native-459991347'").first();
  const nativeVariant = await db.prepare("SELECT target_printful_sync_variant_id, target_catalogue_product_id, target_catalogue_variant_id, unit_amount, is_sellable, migration_status FROM commerce_product_variants WHERE id = 'variant-target-native-5463409939'").first();
  assert.deepEqual(nativeProduct, { title: "My Balloon | classic tee", target_printful_product_id: "459991347", migration_status: "target_native", visibility: "private" });
  assert.deepEqual(nativeVariant, { target_printful_sync_variant_id: "5463409939", target_catalogue_product_id: "438", target_catalogue_variant_id: "11576", unit_amount: 1250, is_sellable: 0, migration_status: "target_native" });
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM commerce_orders").first()).total, 0);
  const settings = await db.prepare("SELECT setting_key, value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled','live_payment_capture_enabled','fulfillment_submission_enabled') ORDER BY setting_key").all();
  assert.deepEqual(settings.results.map((row) => row.value_json), ["false", "false", "false"]);
}
