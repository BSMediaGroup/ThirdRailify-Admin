import assert from "node:assert/strict";
import test from "node:test";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { createStripeCheckoutSession, publicOrderStatusPayload } from "../functions/_shared/checkout-core.js";
import { onRequest as adminCommerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { onRequest as normalCheckoutRequest } from "../functions/api/commerce/checkout.js";
import { onRequestGet as publicStatusRequest } from "../functions/api/public/commerce/order-status.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases, enableControlledTestCheckout, insertTestProduct, insertTestShippingQuote, insertTestVariant, TEST_DELIVERY_RECIPIENT } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const PUBLIC_ORIGIN = "https://thirdrailify.pages.dev";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

async function configuredHarness() {
  const harness = await createCommerceDatabases();
  await insertTestProduct(harness.commerceDb, { title: "Controlled Mug", unitAmount: 9999, targetPrintfulProductId: "target-product-001", migrationStatus: "target_verified" });
  await insertTestVariant(harness.commerceDb, { unitAmount: 1500, migrationStatus: "target_verified" });
  await enableControlledTestCheckout(harness.commerceDb);
  await insertTestShippingQuote(harness.commerceDb);
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "sk_test_controlledOnly123", STRIPE_WEBHOOK_SECRET: "whsec_controlled_test_secret" });
  return { harness, env };
}

async function masterSession(env) {
  await ensureEnvironmentMasters(env);
  const master = await loadAccountByEmail(env, "master-one@example.test");
  const created = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  return { created, cookie: cookiePair(created.cookie) };
}

function stripeMock(calls, sessionId = "cs_test_controlled_001") {
  return async (url, init) => {
    calls.push({ url, init, params: new URLSearchParams(init.body) });
    const params = calls.at(-1).params;
    const orderId = params.get("metadata[order_id]");
    return Response.json({
      id: sessionId,
      object: "checkout.session",
      livemode: false,
      mode: "payment",
      currency: "cad",
      amount_total: 2000,
      client_reference_id: orderId,
      metadata: { order_id: orderId, checkout_request_id: params.get("metadata[checkout_request_id]") },
      url: `https://checkout.stripe.com/c/pay/${sessionId}`,
    });
  };
}

function controlledInput(overrides = {}) {
  return {
    checkoutRequestId: REQUEST_ID,
    items: [{ productId: "product-test-001", variantId: "variant-test-001", quantity: 1 }],
    recipient: TEST_DELIVERY_RECIPIENT,
    quoteId: "shq_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    shippingOptionId: "shr_bbbbbbbbbbbbbbbbbbbbbbbb",
    ...overrides,
  };
}

test("normal checkout stays disabled while the controlled route requires Master authority and CSRF", async (t) => {
  const { harness, env } = await configuredHarness(); t.after(harness.dispose);
  const normal = await normalCheckoutRequest({
    request: new Request(`${ADMIN_ORIGIN}/api/commerce/checkout`, { method: "POST", headers: { Origin: PUBLIC_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(controlledInput()) }),
    env, data: { checkoutFetch: async () => { throw new Error("Stripe must not be called"); } },
  });
  assert.equal(normal.status, 409); assert.equal((await normal.json()).error, "checkout_disabled");

  const url = `${ADMIN_ORIGIN}/api/admin/commerce/test-checkout`;
  const body = { checkoutRequestId: REQUEST_ID, productId: "product-test-001", variantId: "variant-test-001", quantity: 1, recipient: TEST_DELIVERY_RECIPIENT, quoteId: "shq_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", shippingOptionId: "shr_bbbbbbbbbbbbbbbbbbbbbbbb" };
  const anonymous = await adminCommerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, body }), env, data: { commerceFetch: stripeMock([]) } });
  assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).error, "unauthenticated");
  const { created, cookie } = await masterSession(env);
  const noCsrf = await adminCommerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, body }), env, data: { commerceFetch: stripeMock([]) } });
  assert.equal(noCsrf.status, 403);

  const calls = [];
  const response = await adminCommerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body }), env, data: { commerceFetch: stripeMock(calls) } });
  const payload = await response.json();
  assert.equal(response.status, 200); assert.equal(payload.ok, true); assert.equal(payload.sessionId, "cs_test_controlled_001"); assert.equal(calls.length, 1);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 1);
});

test("controlled core accepts only the configured fully verified sellable variant at quantity one", async (t) => {
  for (const [input, expected] of [
    [controlledInput({ items: [{ productId: "another-product", variantId: "variant-test-001", quantity: 1 }] }), "stripe_test_candidate_only"],
    [controlledInput({ items: [{ productId: "product-test-001", variantId: "another-variant", quantity: 1 }] }), "stripe_test_candidate_only"],
    [controlledInput({ items: [{ productId: "product-test-001", variantId: "variant-test-001", quantity: 2 }] }), "stripe_test_quantity_locked"],
  ]) {
    const { harness, env } = await configuredHarness();
    try {
      await assert.rejects(createStripeCheckoutSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), input, async () => { throw new Error("Stripe must not be called"); }, { gate: "controlled_test" }), (error) => error.code === expected);
      assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 0);
    } finally { await harness.dispose(); }
  }

  for (const [sql, expected] of [
    ["UPDATE commerce_product_variants SET is_sellable=0", "checkout_variant_unavailable"],
    ["UPDATE commerce_product_variants SET fulfillment_mapping_status='conflict'", "checkout_variant_fulfillment_unavailable"],
    ["UPDATE commerce_product_variants SET migration_status='blocked'", "checkout_variant_migration_unverified"],
    ["UPDATE commerce_product_variants SET migration_status='deferred'", "checkout_variant_migration_unverified"],
  ]) {
    const { harness, env } = await configuredHarness();
    try {
      await harness.commerceDb.prepare(sql).run();
      await assert.rejects(createStripeCheckoutSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), controlledInput(), async () => { throw new Error("Stripe must not be called"); }, { gate: "controlled_test" }), (error) => error.code === expected);
    } finally { await harness.dispose(); }
  }
});

test("controlled checkout requires a Stripe TEST credential and rejects browser price authority", async (t) => {
  const { harness, env } = await configuredHarness(); t.after(harness.dispose);
  for (const credential of ["", "sk_live_forbidden123"]) {
    await assert.rejects(createStripeCheckoutSession({ ...env, STRIPE_SECRET_KEY: credential }, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), controlledInput(), async () => { throw new Error("Stripe must not be called"); }, { gate: "controlled_test" }), (error) => error.code === "stripe_api_not_configured");
  }
  await assert.rejects(createStripeCheckoutSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), { ...controlledInput(), unitPrice: 1 }, async () => { throw new Error("Stripe must not be called"); }, { gate: "controlled_test" }), (error) => error.code === "checkout_request_fields_invalid");
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 0);
});

test("controlled checkout fails closed if either fulfillment gate is enabled", async () => {
  for (const sql of [
    "UPDATE commerce_settings SET value_json='true' WHERE setting_key='fulfillment_submission_enabled'",
    `UPDATE commerce_provider_connections SET safe_metadata_json='{"fulfillment_enabled":true}' WHERE provider='printful'`,
  ]) {
    const { harness, env } = await configuredHarness();
    try {
      await harness.commerceDb.prepare(sql).run();
      await assert.rejects(createStripeCheckoutSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), controlledInput(), async () => { throw new Error("Stripe must not be called"); }, { gate: "controlled_test" }), (error) => error.code === "fulfillment_must_remain_disabled");
    } finally { await harness.dispose(); }
  }
});

test("controlled core reuses authoritative pricing, immutable variant snapshot, and deterministic idempotency", async (t) => {
  const { harness, env } = await configuredHarness(); t.after(harness.dispose);
  const calls = []; const request = new Request(`${ADMIN_ORIGIN}/api/admin/commerce/test-checkout`, { method: "POST", headers: { Origin: ADMIN_ORIGIN } });
  const first = await createStripeCheckoutSession(env, request, controlledInput(), stripeMock(calls), { gate: "controlled_test" });
  const second = await createStripeCheckoutSession(env, request, controlledInput(), stripeMock(calls), { gate: "controlled_test" });
  assert.deepEqual(second, first); assert.equal(calls.length, 1);
  await assert.rejects(createStripeCheckoutSession(env, request, controlledInput({ checkoutRequestId: "66666666-6666-4666-8666-666666666666" }), stripeMock(calls, "cs_test_forbidden_second"), { gate: "controlled_test" }), (error) => error.code === "stripe_test_checkout_already_created");
  assert.equal(calls.length, 1);
  const params = calls[0].params;
  assert.equal(params.get("mode"), "payment"); assert.equal(params.get("line_items[0][price_data][currency]"), "cad"); assert.equal(params.get("line_items[0][price_data][unit_amount]"), "1500"); assert.equal(params.get("line_items[0][quantity]"), "1");
  assert.equal(Object.keys(calls[0].init.headers).some((name) => name.toLowerCase() === "stripe-account"), false);
  assert.match(calls[0].init.headers["Idempotency-Key"], /^thirdrailify-checkout-v1-[0-9a-f]{64}$/);
  const order = await harness.commerceDb.prepare("SELECT payment_status,fulfillment_status,customer_gross_amount,checkout_status,stripe_checkout_session_id,printful_order_id,safe_metadata_json FROM commerce_orders").first();
  assert.equal(order.payment_status, "pending"); assert.equal(order.fulfillment_status, "disabled"); assert.equal(order.customer_gross_amount, 2000); assert.equal(order.checkout_status, "checkout_created"); assert.equal(order.stripe_checkout_session_id, first.sessionId); assert.equal(order.printful_order_id, null); assert.deepEqual(JSON.parse(order.safe_metadata_json), { checkoutGate: "controlled_test", fulfillment: "disabled" });
  const line = await harness.commerceDb.prepare("SELECT product_id,variant_id,product_name,variant_name,unit_amount,quantity,line_total_amount,fulfillment_provider,fulfillment_variant_id FROM commerce_order_items").first();
  assert.deepEqual(line, { product_id: "product-test-001", variant_id: "variant-test-001", product_name: "Controlled Mug", variant_name: "M / Black", unit_amount: 1500, quantity: 1, line_total_amount: 1500, fulfillment_provider: "printful", fulfillment_variant_id: "target-variant-001" });
  const delivery = await harness.commerceDb.prepare("SELECT recipient_ciphertext,shipping_amount,display_shipping_method FROM commerce_order_delivery_snapshots").first();
  assert.equal(delivery.shipping_amount, 500); assert.equal(delivery.display_shipping_method, "Standard delivery"); assert.doesNotMatch(delivery.recipient_ciphertext, /Checkout Fixture|100 Test Street/);
});

test("a closed historical acceptance does not block one new configured candidate, but that candidate remains single-use", async (t) => {
  const { harness, env } = await configuredHarness(); t.after(harness.dispose);
  await insertTestVariant(harness.commerceDb, { id: "variant-historical", localVariantKey: "historical", targetPrintfulSyncVariantId: "target-variant-historical", targetCatalogueVariantId: "11547" });
  await harness.commerceDb.batch([
    harness.commerceDb.prepare(`INSERT INTO commerce_orders
      (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,environment,checkout_status,safe_metadata_json,created_at,updated_at)
      VALUES ('ord_historical','paid','disabled','CAD',1500,'test','checkout_created','{"checkoutGate":"controlled_test"}','2026-08-28T00:00:00Z','2026-08-28T00:00:00Z')`),
    harness.commerceDb.prepare(`INSERT INTO commerce_order_items
      (id,order_id,line_number,product_id,variant_id,product_name,variant_name,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,fulfillment_provider,fulfillment_variant_id,created_at)
      VALUES ('item-historical','ord_historical',1,'product-test-001','variant-historical','Historical','M / Black','CAD',1500,1,1500,1,'printful','target-variant-historical','2026-08-28T00:00:00Z')`),
  ]);
  const calls = [];
  const first = await createStripeCheckoutSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), controlledInput(), stripeMock(calls), { gate: "controlled_test" });
  assert.equal(first.sessionId, "cs_test_controlled_001"); assert.equal(calls.length, 1);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_orders").first()).count, 2);
  await assert.rejects(createStripeCheckoutSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), controlledInput({ checkoutRequestId: "99999999-9999-4999-8999-999999999999" }), stripeMock(calls), { gate: "controlled_test" }), (error) => error.code === "stripe_test_checkout_already_created");
  assert.equal(calls.length, 1);
});

test("public order status is exact-session-only and exposes a bounded local projection", async (t) => {
  const { harness, env } = await configuredHarness(); t.after(harness.dispose);
  const created = await createStripeCheckoutSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), controlledInput(), stripeMock([]), { gate: "controlled_test" });
  assert.deepEqual(await publicOrderStatusPayload(env, created.sessionId), { ok: true, order: { reference: created.orderId, paymentStatus: "pending", orderStatus: "checkout_created", fulfillmentStatus: "disabled", amount: 2000, currency: "CAD" } });
  const exact = await publicStatusRequest({ request: new Request(`${ADMIN_ORIGIN}/api/public/commerce/order-status?session_id=${created.sessionId}`), env });
  const payload = await exact.json(); assert.equal(exact.status, 200); assert.deepEqual(Object.keys(payload.order).sort(), ["amount", "currency", "fulfillmentStatus", "orderStatus", "paymentStatus", "reference"]);
  const missing = await publicStatusRequest({ request: new Request(`${ADMIN_ORIGIN}/api/public/commerce/order-status`), env }); assert.equal(missing.status, 400);
  const unknown = await publicStatusRequest({ request: new Request(`${ADMIN_ORIGIN}/api/public/commerce/order-status?session_id=cs_test_unknown_123`), env }); assert.equal(unknown.status, 404);
});
