import assert from "node:assert/strict";
import test from "node:test";
import { errorResponse } from "../functions/_shared/auth-core.js";
import {
  assertCanonicalPrintfulOrderExternalId,
  assertPrintfulTargetStore,
  buildPrintfulDraftCreateRequest,
  buildPrintfulOrderExternalId,
  normalizePrintfulApiError,
  PRINTFUL_SAFE_MESSAGE_MAX,
} from "../functions/_shared/printful-api.js";

const LOCAL_ORDER_ID = "ord_51d7da1b-0c22-44eb-8dad-8aef29333086";
const RECIPIENT = { name: "Recipient Fixture", address1: "100 Test Street", address2: "Unit 4", city: "London", state_code: "ON", country_code: "CA", zip: "N6A 1A1", phone: "+1 555 555 1212", email: "must-not-pass@example.test", internal: "never" };

test("canonical Printful external IDs are deterministic, valid, and never raw local IDs", async () => {
  const first = await buildPrintfulOrderExternalId(LOCAL_ORDER_ID);
  const second = await buildPrintfulOrderExternalId(LOCAL_ORDER_ID);
  assert.equal(first, "tr_5409478810d24536e83c97214b837");
  assert.equal(first, second);
  assert.equal(first.length, 32);
  assert.match(first, /^tr_[0-9a-f]{29}$/);
  assert.throws(() => assertCanonicalPrintfulOrderExternalId(LOCAL_ORDER_ID), (error) => error.code === "printful_external_id_invalid");
});

test("draft create request is a target-store minimal V1 contract with draft confirmation structurally omitted", async () => {
  const request = await buildPrintfulDraftCreateRequest({ localOrderId: LOCAL_ORDER_ID, targetStoreId: "18668025", shippingCode: "STANDARD", recipient: RECIPIENT, syncVariantId: "5464856039", quantity: 1 });
  assert.equal(request.url, "https://api.printful.com/orders");
  assert.deepEqual(request.queryParameters, {});
  assert.equal(request.targetStoreId, "18668025");
  assert.deepEqual(Object.keys(request.body).sort(), ["external_id", "items", "recipient", "shipping"]);
  assert.deepEqual(request.body.items, [{ sync_variant_id: 5464856039, quantity: 1 }]);
  for (const forbidden of ["external_id", "variant_id", "product_template_id", "external_variant_id", "warehouse_variant_id", "files"]) assert.equal(forbidden in request.body.items[0], false);
  assert.equal("confirm" in request.body, false); assert.equal("update_existing" in request.body, false);
  assert.equal(request.body.shipping, "STANDARD"); assert.notEqual(request.body.shipping, "Flat Rate (Estimated delivery: Sep 2–5)");
  assert.deepEqual(Object.keys(request.body.recipient), ["name", "address1", "address2", "city", "state_code", "country_code", "zip", "phone"]);
  assert.equal("email" in request.body.recipient, false); assert.equal("internal" in request.body.recipient, false);
  assert.match(request.payloadDigest, /^[0-9a-f]{64}$/);
  assert.equal(request.diagnostic.confirmBehavior, "query_parameter_omitted_draft_default");
  assert.doesNotMatch(JSON.stringify(request.diagnostic), /Recipient Fixture|100 Test Street|N6A 1A1|example\.test/);
  assert.throws(() => assertPrintfulTargetStore("16847493"), (error) => error.code === "printful_source_store_rejected");
  assert.throws(() => assertPrintfulTargetStore("999"), (error) => error.code === "printful_target_store_mismatch");
});

test("shipping labels cannot substitute for persisted provider method codes", async () => {
  await assert.rejects(buildPrintfulDraftCreateRequest({ localOrderId: LOCAL_ORDER_ID, targetStoreId: "18668025", shippingCode: "Flat Rate (Estimated delivery: Sep 2–5)", recipient: RECIPIENT, syncVariantId: "5464856039", quantity: 1 }), (error) => error.code === "printful_shipping_code_invalid");
});

test("structured Printful errors retain safe diagnostics and redact recipient, contact, address, and secrets", async () => {
  const response = new Response(JSON.stringify({ code: 400, error: { code: "VALIDATION_FAILED", reason: "external_id too long for Jane Example at jane@example.test, +1 555 555 1212, 100 Test Street, N6A 1A1; Authorization: Bearer secret-value; pi_test_hidden" } }), { status: 400, headers: { "Content-Type": "application/json", "X-Request-Id": "pf-request-123" } });
  const error = await normalizePrintfulApiError(response, { operation: "printful_order_draft_create", payloadDigest: "a".repeat(64) });
  assert.equal(error.httpStatus, 400); assert.equal(error.providerCode, "400"); assert.equal(error.providerErrorCode, "VALIDATION_FAILED"); assert.equal(error.requestId, "pf-request-123"); assert.equal(error.responseJsonParsed, true); assert.equal(error.payloadDigest, "a".repeat(64));
  assert.match(error.safeMessage, /external_id too long/);
  assert.doesNotMatch(JSON.stringify(error.toSafeJSON()), /jane@example|555 555|100 Test|N6A 1A1|secret-value|pi_test_hidden/);
});

test("plain-text and malformed Printful errors remain bounded, safe, and generic in normal API projections", async () => {
  const plain = await normalizePrintfulApiError(new Response(`Rejected for email victim@example.test at 999 Example Road ${"x".repeat(800)}`, { status: 503, headers: { "Content-Type": "text/plain" } }), { operation: "printful_order_draft_create" });
  assert.equal(plain.httpStatus, 503); assert.equal(plain.retryable, true); assert.ok(plain.safeMessage.length <= PRINTFUL_SAFE_MESSAGE_MAX); assert.doesNotMatch(plain.safeMessage, /victim@example|999 Example/);
  const malformed = await normalizePrintfulApiError(new Response("{not-json", { status: 502, headers: { "Content-Type": "application/json" } }), { operation: "printful_order_reconcile" });
  assert.equal(malformed.httpStatus, 502); assert.equal(malformed.responseJsonParsed, false); assert.ok(malformed.safeMessage.length <= PRINTFUL_SAFE_MESSAGE_MAX);
  const projected = await errorResponse(plain, new Request("https://thirdrailify-admin.pages.dev/api/admin/commerce/orders/x/printful-draft"), {} ).json();
  assert.deepEqual(projected, { ok: false, error: "printful_provider_rejected", message: "Printful could not complete the draft request." });
  assert.doesNotMatch(JSON.stringify(projected), /victim|Example|503/);
});
