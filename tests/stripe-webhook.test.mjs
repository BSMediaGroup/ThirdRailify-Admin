import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { onRequest as checkoutRequest } from "../functions/api/commerce/checkout.js";
import { onRequest as stripeWebhookRequest, STRIPE_WEBHOOK_MAX_BODY_BYTES } from "../functions/api/webhooks/stripe.js";
import { commerceEnvironment, createCommerceDatabases, enableTestCheckout, insertTestProduct } from "./commerce-test-helpers.mjs";

const WEBHOOK_URL = "https://thirdrailify-admin.pages.dev/api/webhooks/stripe";
const WEBHOOK_SECRET = "whsec_synthetic_test_secret_only";
const NOW = Date.now();
const NOW_SECONDS = Math.floor(NOW / 1000);

function eventPayload(overrides = {}) {
  return {
    id: "evt_synthetic_checkout_001",
    object: "event",
    api_version: "2025-08-27.basil",
    created: NOW_SECONDS,
    livemode: false,
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_safe_001", object: "checkout.session", customer_email: "not-persisted@example.test" } },
    ...overrides,
  };
}

function signature(body, timestamp = NOW_SECONDS, secret = WEBHOOK_SECRET) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

function webhookRequest(body, options = {}) {
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const headers = new Headers(options.headers || {});
  if (options.signed !== false) headers.set("Stripe-Signature", options.signatureHeader || `t=${timestamp},v1=${signature(body, timestamp, options.secret || WEBHOOK_SECRET)}`);
  return new Request(WEBHOOK_URL, { method: options.method || "POST", headers, body: options.method === "GET" ? undefined : body });
}

async function invoke(request, env) {
  return stripeWebhookRequest({ request, env, data: {}, waitUntil() {} });
}

async function createLinkedOrder(harness, env, checkoutRequestId = "33333333-3333-4333-8333-333333333333") {
  await enableTestCheckout(harness.commerceDb);
  await insertTestProduct(harness.commerceDb, { requiresShipping: 0 });
  const checkoutHttpRequest = new Request("https://thirdrailify-admin.pages.dev/api/commerce/checkout", {
    method: "POST",
    headers: { Origin: "https://thirdrailify.pages.dev", "Content-Type": "application/json" },
    body: JSON.stringify({ checkoutRequestId, items: [{ productId: "product-test-001", quantity: 2 }] }),
  });
  const response = await checkoutRequest({ request: checkoutHttpRequest, env, data: { checkoutFetch: async (url, init) => {
    assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
    const params = new URLSearchParams(init.body); const orderId = params.get("metadata[order_id]");
    return Response.json({ id: "cs_test_linked_001", object: "checkout.session", livemode: false, mode: "payment", currency: "cad", amount_total: 5000, client_reference_id: orderId, metadata: { order_id: orderId, checkout_request_id: checkoutRequestId }, url: "https://checkout.stripe.com/c/pay/cs_test_linked_001" });
  } } });
  assert.equal(response.status, 201);
  return response.json();
}

function completedSession(order, overrides = {}) {
  return {
    id: order.sessionId,
    object: "checkout.session",
    livemode: false,
    mode: "payment",
    currency: "cad",
    amount_total: 5000,
    payment_status: "paid",
    client_reference_id: order.orderId,
    metadata: { order_id: order.orderId, checkout_request_id: "33333333-3333-4333-8333-333333333333" },
    payment_intent: "pi_test_linked_001",
    customer_email: "not-persisted@example.test",
    customer_details: { address: { country: "CA" } },
    ...overrides,
  };
}

async function stripeConfiguration(db) {
  const settings = await db.prepare("SELECT setting_key, value_json FROM commerce_settings WHERE setting_key IN ('stripe_api_configured', 'stripe_webhook_configured', 'checkout_enabled', 'live_payment_capture_enabled', 'fulfillment_submission_enabled')").all();
  const provider = await db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe'").first();
  return {
    settings: Object.fromEntries(settings.results.map((row) => [row.setting_key, JSON.parse(row.value_json)])),
    provider: JSON.parse(provider.safe_metadata_json),
  };
}

test("webhook fails closed for method, configuration, storage, and body size", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const body = JSON.stringify(eventPayload());
  const baseEnv = commerceEnvironment(harness);

  const getResponse = await invoke(webhookRequest("", { method: "GET", signed: false }), baseEnv);
  assert.equal(getResponse.status, 405); assert.equal(getResponse.headers.get("allow"), "POST");
  const missingSecret = await invoke(webhookRequest(body, { signed: false }), baseEnv);
  assert.equal(missingSecret.status, 503); assert.equal((await missingSecret.json()).error, "stripe_webhook_not_configured");
  const env = { ...baseEnv, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const missingDb = await invoke(webhookRequest(body), { ...env, THIRDRAILIFY_COMMERCE_DB: undefined });
  assert.equal(missingDb.status, 503); assert.equal((await missingDb.json()).error, "commerce_database_unavailable");
  const oversized = await invoke(webhookRequest("x", { headers: { "Content-Length": String(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1) } }), env);
  assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error, "request_too_large");
  const streamedOversized = await invoke(webhookRequest("x".repeat(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1)), env);
  assert.equal(streamedOversized.status, 413); assert.equal((await streamedOversized.json()).error, "request_too_large");
  const configuration = await stripeConfiguration(harness.commerceDb);
  assert.equal(configuration.settings.stripe_webhook_configured, false); assert.equal(configuration.provider.webhook_configured, false);
});

test("webhook requires a current valid v1 signature over the exact raw body", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const body = `{\n  "id":"evt_synthetic_signature_001","object":"event","created":${NOW_SECONDS},"livemode":false,"type":"checkout.session.completed","data":{"object":{"id":"cs_test_safe_002","object":"checkout.session"}}\n}`;

  const missing = await invoke(webhookRequest(body, { signed: false }), env);
  assert.equal(missing.status, 400); assert.equal((await missing.json()).error, "stripe_signature_required");
  for (const signatureHeader of ["not-a-signature", `t=${NOW_SECONDS},v0=${"a".repeat(64)}`, `t=invalid,v1=${"a".repeat(64)}`]) {
    const response = await invoke(webhookRequest(body, { signatureHeader }), env);
    assert.equal(response.status, 400); assert.equal((await response.json()).error, "stripe_signature_invalid");
  }
  const invalid = await invoke(webhookRequest(body, { signatureHeader: `t=${NOW_SECONDS},v1=${"0".repeat(64)}` }), env);
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, "stripe_signature_invalid");
  const mutatedBody = `${body} `;
  const mutated = await invoke(webhookRequest(mutatedBody, { signatureHeader: `t=${NOW_SECONDS},v1=${signature(body)}` }), env);
  assert.equal(mutated.status, 400); assert.equal((await mutated.json()).error, "stripe_signature_invalid");
  for (const timestamp of [NOW_SECONDS - 601, NOW_SECONDS + 601]) {
    const response = await invoke(webhookRequest(body, { timestamp }), env);
    assert.equal(response.status, 400); assert.equal((await response.json()).error, "stripe_signature_timestamp_invalid");
  }

  const rejectedConfiguration = await stripeConfiguration(harness.commerceDb);
  assert.equal(rejectedConfiguration.settings.stripe_webhook_configured, false); assert.equal(rejectedConfiguration.provider.webhook_configured, false);

  const validSignature = signature(body);
  const multiple = await invoke(webhookRequest(body, { signatureHeader: `t=${NOW_SECONDS},v1=${"0".repeat(64)},v0=${"f".repeat(64)},v1=${validSignature}` }), env);
  assert.equal(multiple.status, 200); assert.equal((await multiple.json()).result, "checkout_disabled");
  const acceptedConfiguration = await stripeConfiguration(harness.commerceDb);
  assert.equal(acceptedConfiguration.settings.stripe_webhook_configured, true); assert.equal(acceptedConfiguration.provider.webhook_configured, true);
});

test("valid signatures still reject malformed JSON, non-Event envelopes, and live events", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const malformed = "{not-json";
  const malformedResponse = await invoke(webhookRequest(malformed), env);
  assert.equal(malformedResponse.status, 400); assert.equal((await malformedResponse.json()).error, "stripe_event_invalid");
  const notEvent = JSON.stringify(eventPayload({ object: "checkout.session" }));
  const notEventResponse = await invoke(webhookRequest(notEvent), env);
  assert.equal(notEventResponse.status, 400); assert.equal((await notEventResponse.json()).error, "stripe_event_invalid");
  const live = JSON.stringify(eventPayload({ id: "evt_synthetic_live_001", livemode: true }));
  const liveResponse = await invoke(webhookRequest(live), env);
  assert.equal(liveResponse.status, 400); assert.equal((await liveResponse.json()).error, "stripe_live_event_rejected");
  const count = await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_webhook_events").first();
  assert.equal(count.count, 0);
  const configuration = await stripeConfiguration(harness.commerceDb);
  assert.equal(configuration.settings.stripe_webhook_configured, false); assert.equal(configuration.provider.webhook_configured, false);
});

test("checkout completion is receipt-only, duplicate-safe, and persists no sensitive material", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const body = JSON.stringify(eventPayload());
  const rawSignature = signature(body);
  const first = await invoke(webhookRequest(body), env);
  assert.equal(first.status, 200); assert.deepEqual(await first.json(), { ok: true, received: true, duplicate: false, eventId: "evt_synthetic_checkout_001", result: "checkout_disabled" });
  const firstConfiguration = await stripeConfiguration(harness.commerceDb);
  assert.equal(firstConfiguration.settings.stripe_webhook_configured, true); assert.equal(firstConfiguration.provider.webhook_configured, true);
  assert.equal(firstConfiguration.settings.stripe_api_configured, false);
  assert.equal(firstConfiguration.settings.checkout_enabled, false); assert.equal(firstConfiguration.settings.live_payment_capture_enabled, false); assert.equal(firstConfiguration.settings.fulfillment_submission_enabled, false);

  const providerMetadata = { ...firstConfiguration.provider, webhook_configured: false };
  await harness.commerceDb.batch([
    harness.commerceDb.prepare("UPDATE commerce_settings SET value_json = 'false' WHERE setting_key = 'stripe_webhook_configured'"),
    harness.commerceDb.prepare("UPDATE commerce_provider_connections SET safe_metadata_json = ? WHERE provider = 'stripe'").bind(JSON.stringify(providerMetadata)),
  ]);
  const duplicate = await invoke(webhookRequest(body), env);
  assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), { ok: true, received: true, duplicate: true, eventId: "evt_synthetic_checkout_001", result: "duplicate" });
  const duplicateConfiguration = await stripeConfiguration(harness.commerceDb);
  assert.equal(duplicateConfiguration.settings.stripe_webhook_configured, true); assert.equal(duplicateConfiguration.provider.webhook_configured, true);

  const rows = await harness.commerceDb.prepare("SELECT * FROM commerce_webhook_events WHERE provider = 'stripe' AND provider_event_id = ?").bind("evt_synthetic_checkout_001").all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].event_type, "checkout.session.completed"); assert.equal(rows.results[0].livemode, 0);
  assert.equal(rows.results[0].related_object_id, "cs_test_safe_001"); assert.equal(rows.results[0].related_object_type, "checkout.session");
  assert.equal(rows.results[0].processing_status, "accepted_noop"); assert.equal(rows.results[0].result_code, "checkout_disabled");
  assert.match(rows.results[0].payload_sha256, /^[0-9a-f]{64}$/);

  const columns = await harness.commerceDb.prepare("PRAGMA table_info(commerce_webhook_events)").all();
  const columnNames = columns.results.map((column) => column.name);
  assert.equal(columnNames.some((name) => /payload(?!_sha256)|signature|secret|credential|customer|email|card/i.test(name)), false);
  const stored = JSON.stringify(rows.results);
  assert.doesNotMatch(stored, /not-persisted@example\.test|customer_email|whsec_|stripe-signature/i);
  assert.doesNotMatch(stored, new RegExp(rawSignature, "i")); assert.doesNotMatch(stored, new RegExp(WEBHOOK_SECRET, "i"));

  const orders = await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first();
  assert.equal(orders.count, 0);
  const fulfillmentTables = await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'commerce_fulfillment%'").first();
  assert.equal(fulfillmentTables.count, 0);
  const settings = await harness.commerceDb.prepare("SELECT setting_key, value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled', 'live_payment_capture_enabled', 'fulfillment_submission_enabled') ORDER BY setting_key").all();
  assert.deepEqual(settings.results.map((row) => row.value_json), ["false", "false", "false"]);
  const stripe = await harness.commerceDb.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe'").first();
  assert.equal(JSON.parse(stripe.safe_metadata_json).webhook_configured, true); assert.equal(JSON.parse(stripe.safe_metadata_json).checkout_enabled, false); assert.equal(JSON.parse(stripe.safe_metadata_json).live_payments_enabled, false);
});

test("unknown valid event types are acknowledged once and ignored", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const body = JSON.stringify(eventPayload({ id: "evt_synthetic_unknown_001", type: "customer.created", data: { object: { id: "cus_safe_001", object: "customer", email: "not-persisted@example.test" } } }));
  const response = await invoke(webhookRequest(body), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).result, "event_type_ignored");
  const row = await harness.commerceDb.prepare("SELECT processing_status, result_code, related_object_id, related_object_type FROM commerce_webhook_events WHERE provider_event_id = ?").bind("evt_synthetic_unknown_001").first();
  assert.deepEqual(row, { processing_status: "ignored", result_code: "event_type_ignored", related_object_id: "cus_safe_001", related_object_type: "customer" });
  const configuration = await stripeConfiguration(harness.commerceDb);
  assert.equal(configuration.settings.stripe_webhook_configured, true); assert.equal(configuration.provider.webhook_configured, true);
});

test("valid paid test completion links to an existing local order exactly once", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "sk_test_notARealCheckoutKey123", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const order = await createLinkedOrder(harness, env);
  const body = JSON.stringify(eventPayload({ id: "evt_synthetic_paid_001", data: { object: completedSession(order) } }));
  const first = await invoke(webhookRequest(body), env); const firstPayload = await first.json();
  assert.equal(first.status, 200); assert.deepEqual(firstPayload, { ok: true, received: true, duplicate: false, eventId: "evt_synthetic_paid_001", result: "payment_confirmed" });
  const paid = await harness.commerceDb.prepare("SELECT payment_status, payment_confirmed_at, stripe_payment_intent_id, fulfillment_status FROM commerce_orders WHERE id = ?").bind(order.orderId).first();
  assert.equal(paid.payment_status, "paid"); assert.ok(paid.payment_confirmed_at); assert.equal(paid.stripe_payment_intent_id, "pi_test_linked_001"); assert.equal(paid.fulfillment_status, "disabled");
  const paidAt = paid.payment_confirmed_at;
  const duplicate = await invoke(webhookRequest(body), env); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).result, "duplicate");
  const after = await harness.commerceDb.prepare("SELECT payment_status, payment_confirmed_at FROM commerce_orders WHERE id = ?").bind(order.orderId).first();
  assert.deepEqual(after, { payment_status: "paid", payment_confirmed_at: paidAt });
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 1);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_webhook_events WHERE provider_event_id = 'evt_synthetic_paid_001'").first()).count, 1);
  const ledger = await harness.commerceDb.prepare("SELECT processing_status, result_code FROM commerce_webhook_events WHERE provider_event_id = 'evt_synthetic_paid_001'").first();
  assert.deepEqual(ledger, { processing_status: "processed", result_code: "payment_confirmed" });
  assert.doesNotMatch(JSON.stringify(await harness.commerceDb.prepare("SELECT * FROM commerce_orders").all()), /not-persisted@example|customer_details|address/i);
});

test("unknown, mismatched, wrong-amount, wrong-currency, and unpaid Sessions never mark an order paid", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "sk_test_notARealCheckoutKey123", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const order = await createLinkedOrder(harness, env);
  const cases = [
    ["evt_synthetic_unknown_session", completedSession(order, { id: "cs_test_unknown_999" }), "checkout_order_unlinked"],
    ["evt_synthetic_reference_mismatch", completedSession(order, { client_reference_id: "ord_other", metadata: { order_id: order.orderId } }), "checkout_order_reference_mismatch"],
    ["evt_synthetic_metadata_order_missing", completedSession(order, { metadata: { checkout_request_id: "33333333-3333-4333-8333-333333333333" } }), "checkout_order_reference_missing"],
    ["evt_synthetic_metadata_request_missing", completedSession(order, { metadata: { order_id: order.orderId } }), "checkout_request_mismatch"],
    ["evt_synthetic_amount_mismatch", completedSession(order, { amount_total: 4999 }), "checkout_amount_mismatch"],
    ["evt_synthetic_currency_mismatch", completedSession(order, { currency: "usd" }), "checkout_currency_mismatch"],
    ["evt_synthetic_unpaid", completedSession(order, { payment_status: "unpaid" }), "checkout_payment_incomplete"],
    ["evt_synthetic_live_session", completedSession(order, { livemode: true }), "checkout_environment_mismatch"],
  ];
  for (const [eventId, session, resultCode] of cases) {
    const body = JSON.stringify(eventPayload({ id: eventId, data: { object: session } }));
    const response = await invoke(webhookRequest(body), env); assert.equal(response.status, 200); assert.equal((await response.json()).result, resultCode);
    const ledger = await harness.commerceDb.prepare("SELECT processing_status, result_code FROM commerce_webhook_events WHERE provider_event_id = ?").bind(eventId).first();
    assert.deepEqual(ledger, { processing_status: "accepted_noop", result_code: resultCode });
    assert.equal((await harness.commerceDb.prepare("SELECT payment_status FROM commerce_orders WHERE id = ?").bind(order.orderId).first()).payment_status, "pending");
  }
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 1);
  assert.equal((await harness.commerceDb.prepare("SELECT fulfillment_status FROM commerce_orders").first()).fulfillment_status, "disabled");
});
