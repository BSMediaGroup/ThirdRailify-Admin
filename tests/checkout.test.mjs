import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as checkoutRequest } from "../functions/api/commerce/checkout.js";
import { commerceEnvironment, createCommerceDatabases, enableTestCheckout, insertTestProduct } from "./commerce-test-helpers.mjs";

const PUBLIC_ORIGIN = "https://thirdrailify.pages.dev";
const CHECKOUT_URL = "https://thirdrailify-admin.pages.dev/api/commerce/checkout";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function request(body = { checkoutRequestId: REQUEST_ID, items: [{ productId: "product-test-001", quantity: 2 }] }, overrides = {}) {
  return new Request(CHECKOUT_URL, {
    method: overrides.method || "POST",
    headers: { Origin: overrides.origin || PUBLIC_ORIGIN, "Content-Type": "application/json", ...(overrides.headers || {}) },
    body: overrides.method === "OPTIONS" ? undefined : JSON.stringify(body),
  });
}

async function invoke(requestValue, env, checkoutFetch) {
  return checkoutRequest({ request: requestValue, env, data: { checkoutFetch }, waitUntil() {} });
}

function testEnv(harness, overrides = {}) {
  return commerceEnvironment(harness, {
    STRIPE_SECRET_KEY: "sk_test_notARealCheckoutKey123",
    STRIPE_WEBHOOK_SECRET: "whsec_synthetic_checkout_secret",
    ...overrides,
  });
}

function successfulStripe(calls, overrides = {}) {
  return async (url, init) => {
    calls.push({ url, init, params: new URLSearchParams(init.body) });
    const params = calls.at(-1).params;
    const orderId = params.get("metadata[order_id]");
    return Response.json({
      id: "cs_test_authoritative_001",
      object: "checkout.session",
      livemode: false,
      mode: "payment",
      currency: "cad",
      amount_total: 5000,
      client_reference_id: orderId,
      metadata: { order_id: orderId, checkout_request_id: REQUEST_ID },
      url: "https://checkout.stripe.com/c/pay/cs_test_authoritative_001",
      ...overrides,
    });
  };
}

test("checkout is Public-origin POST/OPTIONS only and fails closed for disabled or missing D1 before Stripe", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = testEnv(harness); let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("unexpected Stripe request"); };

  const options = await invoke(request({}, { method: "OPTIONS" }), env, fetchImpl);
  assert.equal(options.status, 204); assert.equal(options.headers.get("access-control-allow-origin"), PUBLIC_ORIGIN); assert.equal(options.headers.get("access-control-allow-methods"), "POST,OPTIONS"); assert.equal(options.headers.has("access-control-allow-credentials"), false);
  const invalidOrigin = await invoke(request(undefined, { origin: "https://evil.example" }), env, fetchImpl);
  assert.equal(invalidOrigin.status, 403); assert.equal((await invalidOrigin.json()).error, "origin_not_allowed");
  const disabled = await invoke(request(), env, fetchImpl);
  assert.equal(disabled.status, 409); assert.equal(disabled.headers.get("access-control-allow-origin"), PUBLIC_ORIGIN); assert.equal(disabled.headers.has("access-control-allow-credentials"), false); assert.equal((await disabled.json()).error, "checkout_disabled");
  const missingDb = await invoke(request(), { ...env, THIRDRAILIFY_COMMERCE_DB: undefined }, fetchImpl);
  assert.equal(missingDb.status, 503); assert.equal((await missingDb.json()).error, "commerce_database_unavailable");
  const get = await invoke(new Request(CHECKOUT_URL, { method: "GET", headers: { Origin: PUBLIC_ORIGIN } }), env, fetchImpl);
  assert.equal(get.status, 405); assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  assert.equal(calls, 0);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 0);
});

test("checkout rejects malformed, empty, excessive, duplicate, unsupported, and invalid-quantity carts", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await enableTestCheckout(harness.commerceDb);
  const env = testEnv(harness); const shouldNotFetch = async () => { throw new Error("unexpected Stripe request"); };
  const cases = [
    [{}, "checkout_request_id_invalid"],
    [{ checkoutRequestId: REQUEST_ID, items: [] }, "checkout_cart_empty"],
    [{ checkoutRequestId: REQUEST_ID, items: Array.from({ length: 21 }, (_, index) => ({ productId: `product-${index}`, quantity: 1 })) }, "checkout_cart_too_large"],
    [{ checkoutRequestId: REQUEST_ID, items: [{ productId: "product-test-001", quantity: 1.5 }] }, "checkout_quantity_invalid"],
    [{ checkoutRequestId: REQUEST_ID, items: [{ productId: "product-test-001", quantity: 0 }] }, "checkout_quantity_invalid"],
    [{ checkoutRequestId: REQUEST_ID, items: [{ productId: "product-test-001", quantity: 1 }, { productId: "product-test-001", quantity: 2 }] }, "checkout_line_duplicate"],
    [{ checkoutRequestId: REQUEST_ID, items: [{ productId: "product-test-001", variantId: "invented", quantity: 1 }] }, "checkout_line_invalid"],
    [{ checkoutRequestId: REQUEST_ID, subtotal: 1, items: [{ productId: "product-test-001", quantity: 1 }] }, "checkout_request_fields_invalid"],
    [{ checkoutRequestId: REQUEST_ID, items: [{ productId: "product-test-001", quantity: 1, unitPrice: 1 }] }, "checkout_line_invalid"],
  ];
  for (const [body, code] of cases) {
    const response = await invoke(request(body), env, shouldNotFetch);
    assert.equal(response.status, 400); assert.equal((await response.json()).error, code);
  }
  const raw = new Request(CHECKOUT_URL, { method: "POST", headers: { Origin: PUBLIC_ORIGIN, "Content-Type": "application/json" }, body: "{" });
  const malformed = await invoke(raw, env, shouldNotFetch);
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error, "invalid_json");
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 0);
});

test("checkout validates product existence, active visibility, test environment, CAD price, and quantity authority", async (t) => {
  const cases = [
    [null, "checkout_product_unknown"],
    [{ status: "disabled" }, "checkout_product_unavailable"],
    [{ visibility: "private" }, "checkout_product_unavailable"],
    [{ checkoutEnvironment: "live" }, "checkout_product_unavailable"],
    [{ currencyCode: "USD" }, "checkout_product_currency_invalid"],
    [{ unitAmount: null }, "checkout_product_price_invalid"],
    [{ maxCheckoutQuantity: 1 }, "checkout_quantity_unavailable"],
  ];
  for (const [product, code] of cases) {
    const harness = await createCommerceDatabases();
    try {
      await enableTestCheckout(harness.commerceDb);
      if (product) await insertTestProduct(harness.commerceDb, product);
      const response = await invoke(request(), testEnv(harness), async () => { throw new Error("unexpected Stripe request"); });
      assert.equal(response.status, code === "checkout_product_unknown" ? 400 : 409); assert.equal((await response.json()).error, code);
      assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 0);
    } finally { await harness.dispose(); }
  }
});

test("checkout creates one authoritative local order and inline Stripe test Session request", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await enableTestCheckout(harness.commerceDb);
  await insertTestProduct(harness.commerceDb, { title: "Canonical Rail Shirt", unitAmount: 2500, requiresShipping: 1 });
  const calls = [];
  const response = await invoke(request({ checkoutRequestId: REQUEST_ID, items: [{ productId: "product-test-001", quantity: 2 }] }), testEnv(harness), successfulStripe(calls));
  const payload = await response.json();
  assert.equal(response.status, 201); assert.deepEqual(Object.keys(payload).sort(), ["checkoutUrl", "ok", "orderId", "sessionId"]); assert.equal(payload.sessionId, "cs_test_authoritative_001");
  assert.equal(calls.length, 1); const call = calls[0]; const params = call.params;
  assert.equal(call.url, "https://api.stripe.com/v1/checkout/sessions"); assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["Stripe-Account"], undefined); assert.equal(Object.keys(call.init.headers).some((key) => key.toLowerCase() === "stripe-account"), false);
  assert.match(call.init.headers.Authorization, /^Bearer sk_test_/); assert.doesNotMatch(call.init.headers["Idempotency-Key"], /Canonical|2500/); assert.match(call.init.headers["Idempotency-Key"], /^thirdrailify-checkout-v1-[0-9a-f]{64}$/);
  assert.equal(params.get("mode"), "payment"); assert.equal(params.get("payment_method_types[0]"), "card");
  assert.equal(params.get("line_items[0][price_data][currency]"), "cad"); assert.equal(params.get("line_items[0][price_data][unit_amount]"), "2500");
  assert.equal(params.get("line_items[0][price_data][product_data][name]"), "Canonical Rail Shirt"); assert.equal(params.get("line_items[0][quantity]"), "2");
  assert.equal(params.get("metadata[order_id]"), payload.orderId); assert.equal(params.get("client_reference_id"), payload.orderId); assert.equal(params.get("metadata[checkout_request_id]"), REQUEST_ID); assert.match(params.get("metadata[cart_digest]"), /^[0-9a-f]{64}$/);
  assert.equal(params.get("success_url"), `${PUBLIC_ORIGIN}/shop?checkout=success&session_id={CHECKOUT_SESSION_ID}`); assert.equal(params.get("cancel_url"), `${PUBLIC_ORIGIN}/shop?checkout=canceled`);
  assert.equal(params.has("automatic_tax[enabled]"), false); assert.equal([...params.keys()].some((key) => /shipping|discount/i.test(key)), false);
  const order = await harness.commerceDb.prepare("SELECT * FROM commerce_orders WHERE id = ?").bind(payload.orderId).first();
  assert.equal(order.customer_gross_amount, 5000); assert.equal(order.currency_code, "CAD"); assert.equal(order.environment, "test"); assert.equal(order.checkout_status, "checkout_created"); assert.equal(order.payment_status, "pending"); assert.equal(order.fulfillment_status, "disabled"); assert.equal(order.stripe_checkout_session_id, payload.sessionId); assert.ok(order.checkout_created_at);
  const lines = await harness.commerceDb.prepare("SELECT * FROM commerce_order_items WHERE order_id = ?").bind(payload.orderId).all();
  assert.equal(lines.results.length, 1); assert.equal(lines.results[0].product_name, "Canonical Rail Shirt"); assert.equal(lines.results[0].unit_amount, 2500); assert.equal(lines.results[0].quantity, 2); assert.equal(lines.results[0].line_total_amount, 5000); assert.equal(lines.results[0].requires_shipping, 1);
});

test("duplicate and retry checkout requests reuse one order and one deterministic Stripe idempotency key", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await enableTestCheckout(harness.commerceDb); await insertTestProduct(harness.commerceDb);
  const calls = []; const stripe = successfulStripe(calls);
  const first = await invoke(request(), testEnv(harness), stripe); assert.equal(first.status, 201); const firstPayload = await first.json();
  const duplicate = await invoke(request(), testEnv(harness), stripe); assert.equal(duplicate.status, 201); assert.deepEqual(await duplicate.json(), firstPayload); assert.equal(calls.length, 1);
  const conflict = await invoke(request({ checkoutRequestId: REQUEST_ID, items: [{ productId: "product-test-001", quantity: 1 }] }), testEnv(harness), stripe);
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error, "checkout_request_conflict");
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 1);

  const retryId = "22222222-2222-4222-8222-222222222222"; const retryCalls = [];
  const retryRequest = request({ checkoutRequestId: retryId, items: [{ productId: "product-test-001", quantity: 2 }] });
  const rejected = await invoke(retryRequest, testEnv(harness), async (url, init) => { retryCalls.push({ url, init }); return Response.json({ error: { type: "api_error" } }, { status: 500 }); });
  assert.equal(rejected.status, 502);
  const recovered = await invoke(request({ checkoutRequestId: retryId, items: [{ productId: "product-test-001", quantity: 2 }] }), testEnv(harness), async (url, init) => {
    retryCalls.push({ url, init }); const params = new URLSearchParams(init.body); const orderId = params.get("metadata[order_id]");
    return Response.json({ id: "cs_test_retry_001", object: "checkout.session", livemode: false, mode: "payment", currency: "cad", amount_total: 5000, client_reference_id: orderId, metadata: { order_id: orderId, checkout_request_id: retryId }, url: "https://checkout.stripe.com/c/pay/cs_test_retry_001" });
  });
  assert.equal(recovered.status, 201); assert.equal(retryCalls.length, 2); assert.equal(retryCalls[0].init.headers["Idempotency-Key"], retryCalls[1].init.headers["Idempotency-Key"]);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 2);
});

test("live-mode, unexpected-currency, or mismatched Stripe Sessions fail closed without linking", async (t) => {
  for (const override of [{ livemode: true }, { currency: "usd" }, { amount_total: 1 }, { id: "cs_live_forbidden" }]) {
    const harness = await createCommerceDatabases();
    try {
      await enableTestCheckout(harness.commerceDb); await insertTestProduct(harness.commerceDb);
      const response = await invoke(request(), testEnv(harness), successfulStripe([], override));
      assert.equal(response.status, 502); assert.equal((await response.json()).error, "stripe_checkout_response_invalid");
      const order = await harness.commerceDb.prepare("SELECT checkout_status, stripe_checkout_session_id, payment_status FROM commerce_orders").first();
      assert.equal(order.checkout_status, "checkout_failed"); assert.equal(order.stripe_checkout_session_id, null); assert.equal(order.payment_status, "pending");
    } finally { await harness.dispose(); }
  }
});

test("checkout persistence contains no customer/card/address data and never invokes Printful", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await enableTestCheckout(harness.commerceDb); await insertTestProduct(harness.commerceDb);
  const calls = []; await invoke(request(), testEnv(harness), successfulStripe(calls));
  assert.deepEqual(calls.map((call) => call.url), ["https://api.stripe.com/v1/checkout/sessions"]);
  const schema = await harness.commerceDb.prepare("SELECT sql FROM sqlite_master WHERE name IN ('commerce_orders', 'commerce_order_items') ORDER BY name").all();
  const stored = await harness.commerceDb.prepare("SELECT * FROM commerce_orders JOIN commerce_order_items ON commerce_order_items.order_id = commerce_orders.id").all();
  const serialized = JSON.stringify({ schema: schema.results, stored: stored.results });
  assert.doesNotMatch(serialized, /customer_email|billing|shipping_address|card|cvc|full_stripe/i);
  assert.equal((await harness.commerceDb.prepare("SELECT fulfillment_status FROM commerce_orders").first()).fulfillment_status, "disabled");
  assert.equal((await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'fulfillment_submission_enabled'").first()).value_json, "false");
});
