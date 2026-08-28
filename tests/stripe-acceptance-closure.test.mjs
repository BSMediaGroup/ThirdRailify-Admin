import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { commerceOrdersPayload, createStripeCheckoutSession, publicOrderStatusPayload } from "../functions/_shared/checkout-core.js";
import {
  applySqlBatches,
  commerceEnvironment,
  createCommerceDatabases,
  enableControlledTestCheckout,
  insertTestProduct,
  insertTestVariant,
} from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const OPERATION_URL = new URL("../commerce-operations/close-stripe-test-acceptance-2026-08.sql", import.meta.url);
const ACTUAL_ORDER_ID = "ord_e47b94a4-4252-438b-8ca7-c47470029940";
const ACTUAL_SESSION_ID = "cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC";

test("acceptance closure preserves paid evidence and paused migration while both checkout paths fail before Stripe", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await insertTestProduct(harness.commerceDb, { title: "Third Rail Farm | Black Glossy Mug", unitAmount: 1500, targetPrintfulProductId: "target-product-001", migrationStatus: "target_verified" });
  await insertTestVariant(harness.commerceDb, { unitAmount: 1500, migrationStatus: "target_verified" });
  await enableControlledTestCheckout(harness.commerceDb);
  await harness.commerceDb.prepare(`UPDATE commerce_product_variants
    SET safe_metadata_json = '{"displayLabel":"M / Black","legitimatePermanentField":"preserved","testSellable":true,"acceptanceCandidate":true,"acceptancePurpose":"stripe_test_pre_cutover"}'
    WHERE id = 'variant-test-001'`).run();
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "sk_test_closureOnly123", STRIPE_WEBHOOK_SECRET: "whsec_closure_only" });
  let stripeCalls = 0;
  const created = await createStripeCheckoutSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), {
    checkoutRequestId: "77777777-7777-4777-8777-777777777777",
    items: [{ productId: "product-test-001", variantId: "variant-test-001", quantity: 1 }],
  }, async (_url, init) => {
    stripeCalls += 1;
    const params = new URLSearchParams(init.body);
    return Response.json({
      id: "cs_test_controlled_001", object: "checkout.session", livemode: false, mode: "payment", currency: "cad", amount_total: 1500,
      client_reference_id: params.get("metadata[order_id]"),
      metadata: { order_id: params.get("metadata[order_id]"), checkout_request_id: params.get("metadata[checkout_request_id]") },
      url: "https://checkout.stripe.com/c/pay/cs_test_controlled_001",
    });
  }, { gate: "controlled_test" });
  assert.equal(stripeCalls, 1);
  await harness.commerceDb.batch([
    harness.commerceDb.prepare("UPDATE commerce_orders SET payment_status='paid', payment_confirmed_at='2026-08-28T12:34:03.094Z', stripe_payment_intent_id='pi_test_accepted', updated_at='2026-08-28T12:34:03.094Z' WHERE id=?").bind(created.orderId),
    harness.commerceDb.prepare(`INSERT INTO commerce_webhook_events (
      provider, provider_event_id, event_type, event_created_at, received_at, livemode, api_version,
      related_object_id, related_object_type, processing_status, processed_at, result_code, payload_sha256
    ) VALUES ('stripe','evt_1U9OysB2jGrq9Tn1apdsFgi2','checkout.session.completed',1787920442,'2026-08-28T12:34:03.094Z',0,
      '2026-07-29.dahlia',?,'checkout.session','processed','2026-08-28T12:34:03.094Z','payment_confirmed',?)`).bind(created.sessionId, "a".repeat(64)),
  ]);

  const before = {
    order: await harness.commerceDb.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(created.orderId).first(),
    items: await harness.commerceDb.prepare("SELECT * FROM commerce_order_items WHERE order_id=? ORDER BY line_number").bind(created.orderId).all(),
    webhook: await harness.commerceDb.prepare("SELECT * FROM commerce_webhook_events WHERE provider_event_id='evt_1U9OysB2jGrq9Tn1apdsFgi2'").first(),
    migration: await harness.commerceDb.prepare("SELECT * FROM commerce_catalogue_migrations WHERE id='permanent-printful-2026-08'").first(),
  };
  let operation = await readFile(OPERATION_URL, "utf8");
  operation = operation
    .replaceAll(ACTUAL_ORDER_ID, created.orderId)
    .replaceAll(ACTUAL_SESSION_ID, created.sessionId)
    .replaceAll("product-397267935", "product-test-001")
    .replaceAll("variant-5019554081", "variant-test-001");
  await applySqlBatches(harness.commerceDb, operation);

  const settings = await harness.commerceDb.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key LIKE 'stripe_test_checkout_%' ORDER BY setting_key").all();
  assert.deepEqual(settings.results, [{ setting_key: "stripe_test_checkout_enabled", value_json: "false" }]);
  const variant = await harness.commerceDb.prepare("SELECT is_sellable,unit_amount,fulfillment_mapping_status,migration_status,safe_metadata_json FROM commerce_product_variants WHERE id='variant-test-001'").first();
  assert.equal(variant.is_sellable, 0); assert.equal(variant.unit_amount, 1500); assert.equal(variant.fulfillment_mapping_status, "mapped"); assert.equal(variant.migration_status, "target_verified");
  assert.deepEqual(JSON.parse(variant.safe_metadata_json), { displayLabel: "M / Black", legitimatePermanentField: "preserved" });
  assert.deepEqual(await harness.commerceDb.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(created.orderId).first(), before.order);
  assert.deepEqual((await harness.commerceDb.prepare("SELECT * FROM commerce_order_items WHERE order_id=? ORDER BY line_number").bind(created.orderId).all()).results, before.items.results);
  assert.deepEqual(await harness.commerceDb.prepare("SELECT * FROM commerce_webhook_events WHERE provider_event_id='evt_1U9OysB2jGrq9Tn1apdsFgi2'").first(), before.webhook);
  assert.deepEqual(await harness.commerceDb.prepare("SELECT * FROM commerce_catalogue_migrations WHERE id='permanent-printful-2026-08'").first(), before.migration);

  const status = await publicOrderStatusPayload(env, created.sessionId);
  assert.equal(status.order.paymentStatus, "paid"); assert.equal(status.order.amount, 1500); assert.equal(status.order.currency, "CAD"); assert.equal(status.order.fulfillmentStatus, "disabled");
  const admin = await commerceOrdersPayload(env, { account: { adminLevel: "master" } });
  assert.equal(admin.orders.length, 1); assert.equal(admin.orders[0].test, true); assert.equal(admin.orders[0].webhookReceiptCount, 1); assert.equal(admin.orders[0].webhookVerified, true); assert.equal(admin.controlledTest.enabled, false); assert.equal(admin.controlledTest.candidate, null);

  const mustNotCallStripe = async () => { stripeCalls += 1; throw new Error("Stripe must not be called"); };
  await assert.rejects(createStripeCheckoutSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), {
    checkoutRequestId: "88888888-8888-4888-8888-888888888888",
    items: [{ productId: "product-test-001", variantId: "variant-test-001", quantity: 1 }],
  }, mustNotCallStripe, { gate: "controlled_test" }), (error) => error.code === "stripe_test_checkout_disabled");
  await assert.rejects(createStripeCheckoutSession(env, new Request("https://thirdrailify.pages.dev/", { headers: { Origin: "https://thirdrailify.pages.dev" } }), {
    checkoutRequestId: "99999999-9999-4999-8999-999999999999",
    items: [{ productId: "product-test-001", variantId: "variant-test-001", quantity: 1 }],
  }, mustNotCallStripe), (error) => error.code === "checkout_disabled");
  assert.equal(stripeCalls, 1); assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 1);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_webhook_events WHERE provider_event_id='evt_1U9OysB2jGrq9Tn1apdsFgi2'").first()).count, 1);
  assert.deepEqual((await harness.commerceDb.prepare("SELECT action FROM commerce_audit WHERE action IN ('stripe.acceptance_completed','stripe.test_gate_closed','commerce.acceptance_variant_restored') ORDER BY action").all()).results.map((row) => row.action), ["commerce.acceptance_variant_restored", "stripe.acceptance_completed", "stripe.test_gate_closed"]);
  await applySqlBatches(harness.commerceDb, operation);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_audit WHERE id LIKE 'stripe-test-acceptance-2026-08-%'").first()).count, 3);
});
