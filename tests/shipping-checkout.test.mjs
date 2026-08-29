import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as quoteRequest } from "../functions/api/commerce/shipping-quotes.js";
import { onRequest as checkoutRequest } from "../functions/api/commerce/checkout.js";
import { decryptCommerceSecret } from "../functions/_shared/commerce-core.js";
import { prepareStoredPrintfulDraftOrder } from "../functions/_shared/commerce-control-plane.js";
import {
  normalizeDeliveryRecipient,
  normalizePrintfulShippingRates,
  printfulShippingRateRequest,
} from "../functions/_shared/shipping-core.js";
import {
  commerceEnvironment,
  createCommerceDatabases,
  enableTestCheckout,
  insertTestProduct,
  insertTestVariant,
} from "./commerce-test-helpers.mjs";

const PUBLIC_ORIGIN = "https://thirdrailify.pages.dev";
const QUOTE_URL = "https://thirdrailify-admin.pages.dev/api/commerce/shipping-quotes";
const CHECKOUT_URL = "https://thirdrailify-admin.pages.dev/api/commerce/checkout";
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const ITEMS = [{ productId: "product-test-001", variantId: "variant-test-001", quantity: 2 }];
const RECIPIENT = { name: "  Ada   Rail  ", address1: "  100   King Street  ", address2: " Unit  4 ", city: " London ", region: "on", postalCode: "n6a 1a1", countryCode: "ca" };
const CUSTOMER = { mode: "guest", name: "Ada Rail", email: "ada@example.test" };

function post(url, body) {
  return new Request(url, { method: "POST", headers: { Origin: PUBLIC_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function env(harness) {
  return commerceEnvironment(harness, {
    PRINTFUL_API_TOKEN: "mock-printful-token",
    STRIPE_SECRET_KEY: "sk_test_notARealCheckoutKey123",
    STRIPE_WEBHOOK_SECRET: "whsec_synthetic_checkout_secret",
  });
}

async function enableShipping(db) {
  const row = await db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider='printful'").first();
  const metadata = { ...JSON.parse(row.safe_metadata_json), api_configured: true, mode: "draft_only", fulfillment_enabled: false };
  await db.batch([
    db.prepare("UPDATE commerce_settings SET value_json='\"printful_dynamic\"' WHERE setting_key='shipping_strategy'"),
    db.prepare("UPDATE commerce_provider_connections SET status='connected',integration_mode='fulfillment',currency_code='CAD',safe_metadata_json=? WHERE provider='printful'").bind(JSON.stringify(metadata)),
  ]);
}

async function seedPhysicalCart(harness) {
  await insertTestProduct(harness.commerceDb, { requiresShipping: 1, targetPrintfulProductId: "target-product-001", migrationStatus: "target_verified" });
  await insertTestVariant(harness.commerceDb, { targetCatalogueVariantId: "11576", migrationStatus: "target_verified" });
}

function printfulRates(calls, overrides = {}) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({ code: 200, result: [{ id: "STANDARD", name: "Flat Rate", rate: "13.50", currency: "CAD", minDeliveryDays: 4, maxDeliveryDays: 7, ...overrides }] });
  };
}

async function createQuote(harness, overrides = {}) {
  const calls = [];
  const response = await quoteRequest({ request: post(QUOTE_URL, { items: ITEMS, recipient: RECIPIENT, ...overrides }), env: env(harness), data: { shippingFetch: printfulRates(calls) } });
  return { response, payload: await response.json(), calls };
}

test("delivery normalization is bounded, canonical, country-aware, and does not claim verification", () => {
  assert.deepEqual(normalizeDeliveryRecipient(RECIPIENT), {
    name: "Ada Rail", address1: "100 King Street", address2: "Unit 4", city: "London",
    region: "ON", postalCode: "N6A 1A1", countryCode: "CA", phone: null,
  });
  assert.throws(() => normalizeDeliveryRecipient({ ...RECIPIENT, region: "" }), (error) => error.code === "delivery_region_required");
  assert.throws(() => normalizeDeliveryRecipient({ ...RECIPIENT, postalCode: "not canadian" }), (error) => error.code === "delivery_postal_code_invalid");
  assert.throws(() => normalizeDeliveryRecipient({ ...RECIPIENT, name: "Ada\nInjected" }), (error) => error.code === "delivery_field_unsafe");
  assert.throws(() => normalizeDeliveryRecipient({ ...RECIPIENT, address1: "<script>" }), (error) => error.code === "delivery_field_unsafe");
  assert.throws(() => normalizeDeliveryRecipient({ ...RECIPIENT, countryCode: "ZZ" }), (error) => error.code === "delivery_country_invalid");
  assert.throws(() => normalizeDeliveryRecipient({ ...RECIPIENT, address1: "A".repeat(181) }), (error) => error.code === "delivery_field_too_long");
  assert.throws(() => normalizeDeliveryRecipient({ ...RECIPIENT, phone: "javascript:alert(1)" }), (error) => error.code === "delivery_phone_invalid");
});

test("shipping quote fails before provider fetch while strategy is unconfigured", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedPhysicalCart(harness);
  let fetches = 0;
  const response = await quoteRequest({ request: post(QUOTE_URL, { items: ITEMS, recipient: RECIPIENT }), env: env(harness), data: { shippingFetch: async () => { fetches += 1; throw new Error("must not fetch"); } } });
  assert.equal(response.status, 409); assert.equal((await response.json()).error, "shipping_unavailable"); assert.equal(fetches, 0);
  const forged = await quoteRequest({ request: post(QUOTE_URL, { items: ITEMS, recipient: RECIPIENT, printfulVariantId: "11576", providerRateAmount: 1 }), env: env(harness), data: { shippingFetch: async () => { fetches += 1; } } });
  assert.equal(forged.status, 400); assert.equal((await forged.json()).error, "shipping_quote_request_invalid"); assert.equal(fetches, 0);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_shipping_quotes").first()).count, 0);
});

test("stable Printful v1 shipping adapter uses Catalog variant IDs and normalizes integer CAD", () => {
  const request = printfulShippingRateRequest(normalizeDeliveryRecipient(RECIPIENT), [{ requiresShipping: true, catalogueVariantId: "11576", quantity: 2 }]);
  assert.deepEqual(request.items, [{ variant_id: "11576", quantity: 2 }]);
  assert.equal("sync_variant_id" in request.items[0], false); assert.equal(request.currency, "CAD"); assert.equal(request.recipient.state_code, "ON");
  const rates = normalizePrintfulShippingRates({ code: 200, result: [{ id: "STANDARD", name: "Flat Rate", rate: "13.50", currency: "CAD", minDeliveryDays: 4, maxDeliveryDays: 7 }] });
  assert.equal(rates[0].amount, 1350); assert.equal(rates[0].providerRateId, "STANDARD");
  assert.throws(() => normalizePrintfulShippingRates({ code: 200, result: [{ id: "STANDARD", name: "Flat Rate", rate: "13.50", currency: "USD" }] }), (error) => error.code === "shipping_provider_currency_mismatch");
  assert.throws(() => normalizePrintfulShippingRates({ code: 200, result: [] }), (error) => error.code === "shipping_rates_unavailable");
  assert.throws(() => normalizePrintfulShippingRates({ code: 200, result: [{ id: "STANDARD", name: "Flat Rate", rate: "13.999", currency: "CAD" }] }), (error) => error.code === "shipping_provider_response_invalid");
});

test("quote binds authoritative cart and recipient, then checkout snapshots encrypted delivery and Stripe-ready total", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await seedPhysicalCart(harness); await enableShipping(harness.commerceDb); await enableTestCheckout(harness.commerceDb);
  const { response, payload, calls } = await createQuote(harness);
  assert.equal(response.status, 201); assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://api.printful.com/shipping/rates");
  assert.deepEqual(calls[0].body.items, [{ variant_id: "11576", quantity: 2 }]);
  assert.equal(payload.quote.subtotalAmount, 5500); assert.equal(payload.quote.options[0].amount, 1350); assert.equal(payload.quote.options[0].totalAmount, 6850);
  assert.equal("providerRateId" in payload.quote.options[0], false); assert.doesNotMatch(JSON.stringify(payload), /11576|target-variant|STANDARD/);

  const stripeCalls = [];
  const checkoutBody = { checkoutRequestId: REQUEST_ID, customer: CUSTOMER, items: ITEMS, recipient: RECIPIENT, quoteId: payload.quote.id, shippingOptionId: payload.quote.options[0].id };
  const stripe = async (url, init) => {
    const params = new URLSearchParams(init.body); stripeCalls.push({ url, init, params }); const orderId = params.get("metadata[order_id]");
    return Response.json({ id: "cs_test_shipping_001", object: "checkout.session", livemode: false, mode: "payment", currency: "cad", amount_total: 6850, client_reference_id: orderId, metadata: { order_id: orderId, checkout_request_id: REQUEST_ID }, url: "https://checkout.stripe.com/c/pay/cs_test_shipping_001" });
  };
  const checkout = await checkoutRequest({ request: post(CHECKOUT_URL, checkoutBody), env: env(harness), data: { checkoutFetch: stripe } });
  const checkoutPayload = await checkout.json(); assert.equal(checkout.status, 201, JSON.stringify(checkoutPayload)); assert.equal(stripeCalls.length, 1);
  const params = stripeCalls[0].params;
  assert.equal(params.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"), "1350");
  assert.equal(params.get("shipping_options[0][shipping_rate_data][fixed_amount][currency]"), "cad");
  assert.equal(params.get("shipping_options[0][shipping_rate_data][display_name]"), "Flat Rate");
  assert.equal([...params.keys()].some((key) => /recipient|address|postal|phone/i.test(key)), false);
  assert.doesNotMatch(params.toString(), /Ada\+Rail|100\+King|N6A\+1A1/i);

  const order = await harness.commerceDb.prepare("SELECT customer_gross_amount,fulfillment_provider FROM commerce_orders WHERE id=?").bind(checkoutPayload.orderId).first();
  const delivery = await harness.commerceDb.prepare("SELECT * FROM commerce_order_delivery_snapshots WHERE order_id=?").bind(checkoutPayload.orderId).first();
  assert.equal(order.customer_gross_amount, 6850); assert.equal(order.fulfillment_provider, "printful"); assert.equal(delivery.shipping_amount, 1350); assert.equal(delivery.currency_code, "CAD");
  assert.doesNotMatch(delivery.recipient_ciphertext, /Ada|King|N6A/i);
  assert.deepEqual(JSON.parse(await decryptCommerceSecret(env(harness), delivery.recipient_ciphertext, `order-delivery:${checkoutPayload.orderId}`)), { ...normalizeDeliveryRecipient(RECIPIENT), customerContact: { name: CUSTOMER.name, email: CUSTOMER.email } });
  const serializedDb = JSON.stringify(await harness.commerceDb.prepare("SELECT * FROM commerce_shipping_quotes").all());
  assert.doesNotMatch(serializedDb, /Ada|King|N6A/i);

  const duplicate = await checkoutRequest({ request: post(CHECKOUT_URL, checkoutBody), env: env(harness), data: { checkoutFetch: stripe } });
  assert.equal(duplicate.status, 201); assert.deepEqual(await duplicate.json(), checkoutPayload); assert.equal(stripeCalls.length, 1);

  await harness.commerceDb.prepare("UPDATE commerce_orders SET payment_status='paid' WHERE id=?").bind(checkoutPayload.orderId).run();
  const draft = await prepareStoredPrintfulDraftOrder(env(harness), checkoutPayload.orderId);
  assert.equal(draft.eligible, false); assert.ok(draft.blockers.some((item) => item.code === "fulfillment_disabled"));
  assert.equal(draft.internalDraftPayload.shipping, "STANDARD");
  assert.deepEqual(draft.internalDraftPayload.items, [{ sync_variant_id: "target-variant-001", quantity: 2 }]);
  assert.equal(draft.internalDraftPayload.recipient.address1, "100 King Street");
  assert.equal(draft.submission.networkRequestMade, false); assert.equal(draft.submission.providerOrderCreated, false);
});

test("checkout rejects changed cart, recipient, expired quote, selected option, forged fields, and environment mismatch", async (t) => {
  const cases = [
    [async (body) => ({ ...body, items: [{ ...ITEMS[0], quantity: 1 }] }), "shipping_quote_cart_mismatch"],
    [async (body) => ({ ...body, recipient: { ...RECIPIENT, address1: "200 King Street" } }), "shipping_quote_recipient_mismatch"],
    [async (body) => ({ ...body, shippingOptionId: "shr_aaaaaaaaaaaaaaaaaaaaaaaa" }), "shipping_option_invalid"],
  ];
  for (const [mutate, expected] of cases) {
    const harness = await createCommerceDatabases();
    try {
      await seedPhysicalCart(harness); await enableShipping(harness.commerceDb); await enableTestCheckout(harness.commerceDb);
      const { payload } = await createQuote(harness);
      const body = await mutate({ checkoutRequestId: REQUEST_ID, customer: CUSTOMER, items: ITEMS, recipient: RECIPIENT, quoteId: payload.quote.id, shippingOptionId: payload.quote.options[0].id });
      const response = await checkoutRequest({ request: post(CHECKOUT_URL, body), env: env(harness), data: { checkoutFetch: async () => { throw new Error("must not call Stripe"); } } });
      const error = await response.json(); assert.equal(response.status, 409, JSON.stringify(error)); assert.equal(error.error, expected);
      assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_orders").first()).count, 0);
    } finally { await harness.dispose(); }
  }

  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await seedPhysicalCart(harness); await enableShipping(harness.commerceDb); await enableTestCheckout(harness.commerceDb);
  const { payload } = await createQuote(harness);
  await harness.commerceDb.prepare("UPDATE commerce_shipping_quotes SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").bind(payload.quote.id).run();
  const base = { checkoutRequestId: REQUEST_ID, customer: CUSTOMER, items: ITEMS, recipient: RECIPIENT, quoteId: payload.quote.id, shippingOptionId: payload.quote.options[0].id };
  const expired = await checkoutRequest({ request: post(CHECKOUT_URL, base), env: env(harness), data: { checkoutFetch: async () => { throw new Error("must not call Stripe"); } } });
  assert.equal(expired.status, 409); assert.equal((await expired.json()).error, "shipping_quote_expired");
  const forged = await checkoutRequest({ request: post(CHECKOUT_URL, { ...base, shippingAmount: 1 }), env: env(harness), data: {} });
  assert.equal(forged.status, 400); assert.equal((await forged.json()).error, "checkout_request_fields_invalid");
  await harness.commerceDb.prepare("UPDATE commerce_shipping_quotes SET expires_at='2099-01-01T00:00:00Z',environment='live' WHERE id=?").bind(payload.quote.id).run();
  const mismatch = await checkoutRequest({ request: post(CHECKOUT_URL, base), env: env(harness), data: { checkoutFetch: async () => { throw new Error("must not call Stripe"); } } });
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error, "shipping_quote_environment_mismatch");
});
