import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { onRequest as printfulWebhookRequest, PRINTFUL_WEBHOOK_MAX_BODY_BYTES } from "../functions/api/webhooks/printful.js";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const URL = "https://thirdrailify-admin.pages.dev/api/webhooks/printful";
const PUBLIC_KEY = "c3ludGhldGljLXByaW50ZnVsLXdlYmhvb2s=";
const SECRET_HEX = Buffer.from("synthetic-printful-v2-webhook-secret-32-bytes!!").toString("hex");

async function seedOrder(db) {
  await db.prepare("INSERT INTO commerce_products (id,source_provider,slug,title,currency_code,status,safe_metadata_json,created_at,updated_at) VALUES ('p-webhook','manual','p-webhook','Webhook product','CAD','active','{}','now','now')").run();
  await db.prepare(`INSERT INTO commerce_orders (id,payment_status,fulfillment_provider,fulfillment_status,currency_code,customer_gross_amount,environment,checkout_status,created_at,updated_at)
    VALUES ('ord-webhook','paid','printful','disabled','CAD',1500,'test','checkout_created','2026-08-29T00:00:00Z','2026-08-29T00:00:00Z')`).run();
  await db.prepare(`INSERT INTO commerce_order_items (id,order_id,line_number,product_id,product_name,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,fulfillment_provider,fulfillment_variant_id,created_at)
    VALUES ('item-webhook','ord-webhook',1,'p-webhook','Webhook item','CAD',1500,1,1500,1,'printful','variant-webhook','now')`).run();
}

function orderEvent(overrides = {}) {
  return {
    type: "order_created", occurred_at: "2026-08-29T01:00:00Z", retries: 0, store_id: 18668025,
    data: { order: { id: 9001, external_id: "ord-webhook", status: "draft", store_id: 18668025, created_at: "2026-08-29T00:59:00Z", updated_at: "2026-08-29T01:00:00Z" } },
    ...overrides,
  };
}

function requestFor(payload, options = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = new Headers({ "Content-Type": options.contentType || "application/json", "CF-Connecting-IP": options.ip || "203.0.113.10", ...(options.headers || {}) });
  if (options.signed !== false) {
    headers.set("x-pf-webhook-public-key", options.publicKey || PUBLIC_KEY);
    headers.set("x-pf-webhook-signature", options.signature || createHmac("sha256", Buffer.from(SECRET_HEX, "hex")).update(body).digest("hex"));
  }
  return new Request(URL, { method: options.method || "POST", headers, body: options.method === "GET" ? undefined : body });
}

function env(harness, overrides = {}) {
  return commerceEnvironment(harness, { PRINTFUL_STORE_ID: "18668025", PRINTFUL_WEBHOOK_V2_PUBLIC_KEY: PUBLIC_KEY, PRINTFUL_WEBHOOK_V2_SECRET_HEX: SECRET_HEX, ...overrides });
}

const invoke = (request, environment) => printfulWebhookRequest({ request, env: environment, data: {}, waitUntil() {} });

test("Printful V2 receiver is fail-closed until signed webhook configuration exists", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const response = await invoke(requestFor(orderEvent()), commerceEnvironment(harness, { PRINTFUL_STORE_ID: "18668025" }));
  assert.equal(response.status, 503); assert.equal((await response.json()).error, "printful_webhook_not_configured");
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_provider_webhook_events").first()).count, 0);
});

test("receiver validates method, content type, signature, store, type, JSON, and body size", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedOrder(harness.commerceDb); const environment = env(harness);
  const cases = [
    [requestFor("", { method: "GET" }), 405, "method_not_allowed"],
    [requestFor(orderEvent(), { contentType: "text/plain" }), 415, "content_type_unsupported"],
    [requestFor(orderEvent(), { signed: false }), 400, "printful_webhook_signature_required"],
    [requestFor(orderEvent(), { signature: "0".repeat(64) }), 403, "printful_webhook_signature_invalid"],
    [requestFor(orderEvent(), { publicKey: "d3Jvbmc=" }), 403, "printful_webhook_signature_invalid"],
    [requestFor("{"), 400, "printful_webhook_payload_invalid"],
    [requestFor(orderEvent({ store_id: 999 })), 403, "printful_webhook_store_mismatch"],
    [requestFor(orderEvent({ type: "made_up_event" })), 400, "printful_webhook_type_unsupported"],
    [requestFor("x", { headers: { "Content-Length": String(PRINTFUL_WEBHOOK_MAX_BODY_BYTES + 1) } }), 413, "request_too_large"],
    [requestFor("x".repeat(PRINTFUL_WEBHOOK_MAX_BODY_BYTES + 1)), 413, "request_too_large"],
  ];
  for (const [request, status, code] of cases) { const response = await invoke(request, environment); assert.equal(response.status, status); assert.equal((await response.json()).error, code); }
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_provider_webhook_events").first()).count, 0);
});

test("valid signed event is durable and a retry with changed retry count is idempotent", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedOrder(harness.commerceDb); const environment = env(harness);
  const payload = orderEvent();
  const first = await invoke(requestFor(payload), environment); assert.equal(first.status, 200);
  const firstBody = await first.json(); assert.equal(firstBody.duplicate, false); assert.equal(firstBody.result, "provider_order_reconciled");
  const retry = await invoke(requestFor({ ...payload, retries: 3 }), environment); assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_provider_webhook_events").first()).count, 1);
  assert.equal((await harness.commerceDb.prepare("SELECT retry_count FROM commerce_provider_webhook_events").first()).retry_count, 3);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_fulfillment_orders").first()).count, 1);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_email_deliveries").first()).count, 0);
});

test("signed shipment evidence stores encrypted tracking without PII, email, or outbound calls", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedOrder(harness.commerceDb); const environment = env(harness);
  await invoke(requestFor(orderEvent()), environment);
  const payload = {
    type: "shipment_sent", occurred_at: "2026-08-29T02:00:00Z", retries: 0, store_id: 18668025,
    data: {
      shipment: { id: 7001, status: "shipped", store_id: 18668025, tracking_number: "TRACK-WEBHOOK", tracking_url: "https://tracking.example/webhook", created_at: "2026-08-29T02:00:00Z", shipped_at: "2026-08-29T02:00:00Z", reshipment: false },
      order: { id: 9001, external_id: "ord-webhook", status: "partial", store_id: 18668025, created_at: "2026-08-29T00:59:00Z", updated_at: "2026-08-29T02:00:00Z" },
      recipient: { email: "must-not-persist@example.test", address1: "Hidden Street" },
    },
  };
  const response = await invoke(requestFor(payload), environment); assert.equal(response.status, 200); assert.equal((await response.json()).result, "shipment_reconciled");
  const shipment = await harness.commerceDb.prepare("SELECT tracking_available,tracking_number_ciphertext,tracking_url_ciphertext FROM commerce_fulfillment_shipments").first();
  assert.equal(shipment.tracking_available, 1); assert.notEqual(shipment.tracking_number_ciphertext, "TRACK-WEBHOOK"); assert.notEqual(shipment.tracking_url_ciphertext, "https://tracking.example/webhook");
  const stored = JSON.stringify({ events: await harness.commerceDb.prepare("SELECT * FROM commerce_provider_webhook_events").all(), shipments: await harness.commerceDb.prepare("SELECT * FROM commerce_fulfillment_shipments").all(), audit: await harness.commerceDb.prepare("SELECT * FROM commerce_audit").all() });
  assert.doesNotMatch(stored, /must-not-persist|Hidden Street|TRACK-WEBHOOK|tracking\.example\/webhook|PRINTFUL_WEBHOOK|synthetic-printful/i);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_email_deliveries").first()).count, 0);
});

test("unknown external ID is recorded as unresolved and never mutates another order", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedOrder(harness.commerceDb); const environment = env(harness);
  const payload = orderEvent({ data: { order: { ...orderEvent().data.order, id: 9999, external_id: "ord-unknown" } } });
  const response = await invoke(requestFor(payload), environment); assert.equal(response.status, 200); assert.equal((await response.json()).result, "printful_local_order_not_found");
  assert.equal((await harness.commerceDb.prepare("SELECT processing_status FROM commerce_provider_webhook_events").first()).processing_status, "unresolved");
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_fulfillment_orders").first()).count, 0);
});
