import assert from "node:assert/strict";
import test from "node:test";
import { createCommerceDatabases, commerceEnvironment } from "./commerce-test-helpers.mjs";
import {
  deriveFulfillmentState,
  mapPrintfulProviderState,
  normalizePrintfulOrderEvidence,
  normalizePrintfulShipmentEvidence,
  reconcilePrintfulOrderEvidence,
  reconcileStoredPrintfulOrder,
  reducePrintfulProviderState,
} from "../functions/_shared/printful-fulfillment.js";

async function seedOrder(db, id = "ord-lifecycle") {
  await db.batch([
    db.prepare("INSERT INTO commerce_products (id,source_provider,slug,title,currency_code,status,safe_metadata_json,created_at,updated_at) VALUES ('p-a','manual','p-a','Product A','CAD','active','{}','now','now')"),
    db.prepare("INSERT INTO commerce_products (id,source_provider,slug,title,currency_code,status,safe_metadata_json,created_at,updated_at) VALUES ('p-b','manual','p-b','Product B','CAD','active','{}','now','now')"),
  ]);
  await db.prepare(`INSERT INTO commerce_orders (id,payment_status,fulfillment_provider,fulfillment_status,currency_code,customer_gross_amount,environment,checkout_status,created_at,updated_at)
    VALUES (?,'paid','printful','disabled','CAD',3000,'test','checkout_created','2026-08-29T00:00:00Z','2026-08-29T00:00:00Z')`).bind(id).run();
  await db.batch([
    db.prepare(`INSERT INTO commerce_order_items (id,order_id,line_number,product_id,product_name,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,fulfillment_provider,fulfillment_variant_id,created_at)
      VALUES ('item-a',?,1,'p-a','Item A','CAD',1000,1,1000,1,'printful','variant-a','now')`).bind(id),
    db.prepare(`INSERT INTO commerce_order_items (id,order_id,line_number,product_id,product_name,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,fulfillment_provider,fulfillment_variant_id,created_at)
      VALUES ('item-b',?,2,'p-b','Item B','CAD',1000,2,2000,1,'printful','variant-b','now')`).bind(id),
  ]);
}

function order(status, updated, shipments = []) {
  return { code: 200, result: { id: 9001, external_id: "ord-lifecycle", store: 18668025, status, created: 1787961600, updated, items: [
    { id: 501, external_id: "item-a", sync_variant_id: "variant-a", quantity: 1 },
    { id: 502, external_id: "item-b", sync_variant_id: "variant-b", quantity: 2 },
  ], shipments } };
}

test("documented Printful states normalize through one monotonic reducer", () => {
  assert.deepEqual(["draft", "inreview", "pending", "failed", "canceled", "inprocess", "onhold", "partial", "fulfilled", "archived", "future_status"].map(mapPrintfulProviderState),
    ["draft", "submitted", "submitted", "failed", "canceled", "processing", "on_hold", "partial", "complete", "archived", "unknown"]);
  assert.equal(reducePrintfulProviderState({ providerState: "processing", lastProviderEvidenceAt: "2026-08-29T02:00:00Z" }, { providerState: "submitted", occurredAt: "2026-08-29T01:00:00Z" }).stale, true);
  assert.equal(reducePrintfulProviderState({ providerState: "complete", lastProviderEvidenceAt: "2026-08-29T02:00:00Z" }, { providerState: "processing", occurredAt: "2026-08-29T03:00:00Z" }).applied, false);
  assert.equal(reducePrintfulProviderState({ providerState: "failed", lastProviderEvidenceAt: "2026-08-29T02:00:00Z" }, { providerState: "processing", occurredAt: "2026-08-29T03:00:00Z" }).applied, true);
  assert.equal(reducePrintfulProviderState({ providerState: "canceled", lastProviderEvidenceAt: "2026-08-29T02:00:00Z" }, { providerState: "complete", occurredAt: "2026-08-29T03:00:00Z" }).applied, false);
});

test("draft, processing, split shipment, completion, reshipment, and return remain idempotent", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedOrder(harness.commerceDb);
  const env = commerceEnvironment(harness, { PRINTFUL_STORE_ID: "18668025" });
  const draft = normalizePrintfulOrderEvidence(order("draft", 1787961600), { expectedStoreId: "18668025" });
  const first = await reconcilePrintfulOrderEvidence(env, draft, { expectedStoreId: "18668025" });
  assert.equal(first.created, true); assert.equal(first.state, "unfulfilled");
  const duplicate = await reconcilePrintfulOrderEvidence(env, draft, { expectedStoreId: "18668025" });
  assert.equal(duplicate.created, false); assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_fulfillment_orders").first()).count, 1);
  await reconcilePrintfulOrderEvidence(env, normalizePrintfulOrderEvidence(order("inprocess", 1787965200), { expectedStoreId: "18668025" }), { expectedStoreId: "18668025" });

  const firstShipment = { id: 7001, carrier: "FEDEX", service: "Ground", tracking_number: "TRACK-ONE", tracking_url: "https://tracking.example/one", created: 1787968800, items: [{ item_id: 501, quantity: 1 }] };
  const partial = await reconcilePrintfulOrderEvidence(env, normalizePrintfulOrderEvidence(order("partial", 1787968800, [firstShipment]), { expectedStoreId: "18668025" }), { expectedStoreId: "18668025" });
  assert.equal(partial.state, "partial"); assert.equal(partial.covered, 1); assert.equal(partial.required, 3);
  const secondShipment = { id: 7002, carrier: "FEDEX", service: "Ground", tracking_number: "TRACK-TWO", tracking_url: "https://tracking.example/two", created: 1787972400, items: [{ item_id: 502, quantity: 2 }] };
  const complete = await reconcilePrintfulOrderEvidence(env, normalizePrintfulOrderEvidence(order("fulfilled", 1787972400, [firstShipment, secondShipment]), { expectedStoreId: "18668025" }), { expectedStoreId: "18668025" });
  assert.equal(complete.state, "shipped"); assert.equal(complete.covered, 3);

  const reshipment = normalizePrintfulShipmentEvidence({ id: 7003, reshipment: true, tracking_number: "RE-SHIP", created: 1787976000, items: [{ item_id: 501, quantity: 1 }] }, { eventType: "shipment_sent", occurredAt: "2026-08-29T04:00:00Z" });
  const reshipResult = await reconcilePrintfulOrderEvidence(env, { ...normalizePrintfulOrderEvidence(order("fulfilled", 1787976000), { expectedStoreId: "18668025" }), shipments: [reshipment] }, { expectedStoreId: "18668025" });
  assert.equal(reshipResult.state, "shipped"); assert.equal(reshipResult.covered, 3);
  const returned = normalizePrintfulShipmentEvidence({ ...firstShipment, status: "returned" }, { eventType: "shipment_returned", occurredAt: "2026-08-29T05:00:00Z", returnedReasonCategory: "package_returned" });
  const returnedResult = await reconcilePrintfulOrderEvidence(env, { ...normalizePrintfulOrderEvidence(order("fulfilled", 1787979600), { expectedStoreId: "18668025" }), shipments: [returned] }, { expectedStoreId: "18668025" });
  assert.equal(returnedResult.state, "returned");
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_fulfillment_shipments").first()).count, 3);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_email_deliveries").first()).count, 0);
});

test("coverage clamps duplicates and ignores reshipments", () => {
  const items = [{ id: "a", orderedQuantity: 1 }, { id: "b", orderedQuantity: 2 }];
  const shipments = [
    { shipmentState: "shipped", reshipment: false, items: [{ fulfillmentItemId: "a", quantity: 1 }] },
    { shipmentState: "shipped", reshipment: true, items: [{ fulfillmentItemId: "a", quantity: 1 }] },
  ];
  assert.deepEqual(deriveFulfillmentState(items, shipments, "partial"), { state: "partial", required: 3, covered: 1 });
  assert.deepEqual(deriveFulfillmentState(items, [{ shipmentState: "delivered", reshipment: false, items: [{ fulfillmentItemId: "a", quantity: 1 }, { fulfillmentItemId: "b", quantity: 2 }] }], "complete"), { state: "delivered", required: 3, covered: 3 });
  assert.equal(deriveFulfillmentState(items, [], "failed").state, "action_required");
  assert.equal(deriveFulfillmentState(items, [], "canceled").state, "canceled");
  assert.equal(deriveFulfillmentState(items, [], "unknown").state, "unknown");
});

test("wrong store, conflicting relationship, malformed tracking, and unsupported evidence fail closed", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedOrder(harness.commerceDb);
  const env = commerceEnvironment(harness, { PRINTFUL_STORE_ID: "18668025" });
  assert.throws(() => normalizePrintfulOrderEvidence(order("draft", 1787961600), { expectedStoreId: "999" }), (error) => error.code === "printful_store_mismatch");
  const badTracking = normalizePrintfulShipmentEvidence({ id: 1, tracking_number: "bad\nvalue", tracking_url: "javascript:alert(1)", created: 1787961600 }, { eventType: "shipment_sent", occurredAt: "2026-08-29T00:00:00Z" });
  assert.equal(badTracking.trackingAvailable, false);
  await reconcilePrintfulOrderEvidence(env, normalizePrintfulOrderEvidence(order("draft", 1787961600), { expectedStoreId: "18668025" }), { expectedStoreId: "18668025" });
  const conflict = order("draft", 1787965200); conflict.result.id = 9999;
  await assert.rejects(reconcilePrintfulOrderEvidence(env, normalizePrintfulOrderEvidence(conflict, { expectedStoreId: "18668025" }), { expectedStoreId: "18668025" }), (error) => error.code === "printful_order_relationship_conflict");
});

test("future V1 reconciliation uses only an injected GET boundary", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedOrder(harness.commerceDb);
  const env = commerceEnvironment(harness, { PRINTFUL_STORE_ID: "18668025", PRINTFUL_API_TOKEN: "synthetic-token" });
  let calls = 0;
  const result = await reconcileStoredPrintfulOrder(env, "ord-lifecycle", async (url, init) => {
    calls += 1; assert.equal(url, "https://api.printful.com/orders/@ord-lifecycle"); assert.equal(init.method, "GET");
    return new Response(JSON.stringify(order("draft", 1787961600)), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  assert.equal(result.created, true); assert.equal(calls, 1);
  await assert.rejects(reconcileStoredPrintfulOrder(env, "ord-lifecycle"), (error) => error.code === "printful_reconciliation_fetch_required");
});
