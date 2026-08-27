import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { onRequest as stripeWebhookRequest, STRIPE_WEBHOOK_MAX_BODY_BYTES } from "../functions/api/webhooks/stripe.js";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

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

  const validSignature = signature(body);
  const multiple = await invoke(webhookRequest(body, { signatureHeader: `t=${NOW_SECONDS},v1=${"0".repeat(64)},v0=${"f".repeat(64)},v1=${validSignature}` }), env);
  assert.equal(multiple.status, 200); assert.equal((await multiple.json()).result, "checkout_disabled");
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
});

test("checkout completion is receipt-only, duplicate-safe, and persists no sensitive material", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const body = JSON.stringify(eventPayload());
  const rawSignature = signature(body);
  const first = await invoke(webhookRequest(body), env);
  assert.equal(first.status, 200); assert.deepEqual(await first.json(), { ok: true, received: true, duplicate: false, eventId: "evt_synthetic_checkout_001", result: "checkout_disabled" });
  const duplicate = await invoke(webhookRequest(body), env);
  assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), { ok: true, received: true, duplicate: true, eventId: "evt_synthetic_checkout_001", result: "duplicate" });

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
  assert.equal(JSON.parse(stripe.safe_metadata_json).webhook_configured, false); assert.equal(JSON.parse(stripe.safe_metadata_json).checkout_enabled, false);
});

test("unknown valid event types are acknowledged once and ignored", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const body = JSON.stringify(eventPayload({ id: "evt_synthetic_unknown_001", type: "customer.created", data: { object: { id: "cus_safe_001", object: "customer", email: "not-persisted@example.test" } } }));
  const response = await invoke(webhookRequest(body), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).result, "event_type_ignored");
  const row = await harness.commerceDb.prepare("SELECT processing_status, result_code, related_object_id, related_object_type FROM commerce_webhook_events WHERE provider_event_id = ?").bind("evt_synthetic_unknown_001").first();
  assert.deepEqual(row, { processing_status: "ignored", result_code: "event_type_ignored", related_object_id: "cus_safe_001", related_object_type: "customer" });
});
