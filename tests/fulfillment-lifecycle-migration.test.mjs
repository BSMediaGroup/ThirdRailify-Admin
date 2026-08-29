import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration } from "./auth-test-helpers.mjs";
import { createCommerceDatabases } from "./commerce-test-helpers.mjs";

test("0018 adds restrictive normalized fulfillment lifecycle authority without rewriting history", async (t) => {
  const harness = await createCommerceDatabases({ commerceMigrationCount: 17 }); t.after(harness.dispose);
  const db = harness.commerceDb;
  const encrypted = "x".repeat(80);
  await db.batch([
    db.prepare("INSERT INTO commerce_products (id,source_provider,slug,title,currency_code,status,safe_metadata_json,created_at,updated_at) VALUES ('historical-product','manual','historical-product','Historical product','CAD','active','{}','now','now')"),
    db.prepare(`INSERT INTO commerce_customers (id,customer_kind,contact_name_ciphertext,contact_email_ciphertext,contact_email_fingerprint,created_at,updated_at)
      VALUES ('cst_11111111-1111-4111-8111-111111111111','guest',?,?,?,'now','now')`).bind(encrypted, encrypted, "f".repeat(64)),
    db.prepare(`INSERT INTO commerce_orders (id,payment_status,fulfillment_provider,fulfillment_status,currency_code,customer_gross_amount,environment,checkout_status,customer_id,created_at,updated_at)
      VALUES ('ord-history','paid','printful','disabled','CAD',1500,'test','checkout_created','cst_11111111-1111-4111-8111-111111111111','now','now')`),
    db.prepare(`INSERT INTO commerce_order_items (id,order_id,line_number,product_id,product_name,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,fulfillment_provider,fulfillment_variant_id,created_at)
      VALUES ('item-history','ord-history',1,'historical-product','Historical item','CAD',1500,1,1500,1,'printful','variant-1','now')`),
  ]);
  await applyMigration(db, harness.commerceMigrations[17]);

  assert.equal((await db.prepare("SELECT COUNT(*) count FROM commerce_orders WHERE id='ord-history'").first()).count, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) count FROM commerce_customers WHERE id='cst_11111111-1111-4111-8111-111111111111'").first()).count, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) count FROM commerce_fulfillment_orders").first()).count, 0);
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'commerce_fulfillment%' ORDER BY name").all();
  assert.deepEqual(tables.results.map((row) => row.name), ["commerce_fulfillment_order_items", "commerce_fulfillment_orders", "commerce_fulfillment_shipment_items", "commerce_fulfillment_shipments"]);
  assert.equal((await db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='wheels'").first()).count, 1);

  await db.prepare(`INSERT INTO commerce_fulfillment_orders (id,order_id,provider,provider_store_id,provider_order_id,external_id,environment,provider_state,fulfillment_state,confirmation_state,provider_status,last_provider_evidence_at,created_at,updated_at)
    VALUES ('flo_22222222-2222-4222-8222-222222222222','ord-history','printful','18668025','9001','ord-history','test','draft','unfulfilled','unconfirmed','draft','2026-08-29T00:00:00Z','now','now')`).run();
  await assert.rejects(db.prepare(`INSERT INTO commerce_fulfillment_orders (id,order_id,provider,provider_store_id,provider_order_id,external_id,environment,provider_state,fulfillment_state,confirmation_state,provider_status,last_provider_evidence_at,created_at,updated_at)
    VALUES ('flo_33333333-3333-4333-8333-333333333333','ord-history','printful','18668025','9002','other','test','draft','unfulfilled','unconfirmed','draft','2026-08-29T00:00:00Z','now','now')`).run());
  await db.prepare(`INSERT INTO commerce_fulfillment_order_items (id,fulfillment_order_id,order_item_id,provider_order_item_id,ordered_quantity,created_at,updated_at)
    VALUES ('fli_44444444-4444-4444-8444-444444444444','flo_22222222-2222-4222-8222-222222222222','item-history','501',1,'now','now')`).run();
  await db.prepare(`INSERT INTO commerce_fulfillment_shipments (id,fulfillment_order_id,provider_shipment_id,shipment_state,last_provider_evidence_at,created_at,updated_at)
    VALUES ('fls_55555555-5555-4555-8555-555555555555','flo_22222222-2222-4222-8222-222222222222','7001','shipped','2026-08-29T01:00:00Z','now','now')`).run();
  await assert.rejects(db.prepare(`INSERT INTO commerce_fulfillment_shipments (id,fulfillment_order_id,provider_shipment_id,shipment_state,last_provider_evidence_at,created_at,updated_at)
    VALUES ('fls_66666666-6666-4666-8666-666666666666','flo_22222222-2222-4222-8222-222222222222','7001','shipped','2026-08-29T01:00:00Z','now','now')`).run());
  await db.prepare("INSERT INTO commerce_fulfillment_shipment_items (shipment_id,fulfillment_item_id,quantity,created_at) VALUES ('fls_55555555-5555-4555-8555-555555555555','fli_44444444-4444-4444-8444-444444444444',1,'now')").run();
  await db.prepare(`INSERT INTO commerce_provider_webhook_events (id,provider,event_type,occurred_at,provider_store_id,payload_sha256,processing_status,received_at)
    VALUES (?,'printful','order_updated','2026-08-29T01:00:00Z','18668025',?,'processed','now')`).bind(`pwe_${"a".repeat(64)}`, "a".repeat(64)).run();
  await assert.rejects(db.prepare(`INSERT INTO commerce_provider_webhook_events (id,provider,event_type,occurred_at,provider_store_id,payload_sha256,processing_status,received_at)
    VALUES (?,'printful','order_updated','2026-08-29T01:00:00Z','18668025',?,'processed','now')`).bind(`pwe_${"b".repeat(64)}`, "a".repeat(64)).run());
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  await assert.rejects(db.prepare("DELETE FROM commerce_orders WHERE id='ord-history'").run());
});
