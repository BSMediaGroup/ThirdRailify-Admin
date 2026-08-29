import assert from "node:assert/strict";
import test from "node:test";
import { createStoredPrintfulDraftOrder } from "../functions/_shared/commerce-control-plane.js";
import { createStripeCheckoutSession } from "../functions/_shared/checkout-core.js";
import {
  commerceEnvironment,
  createCommerceDatabases,
  enableControlledTestCheckout,
  insertTestProduct,
  insertTestShippingQuote,
  insertTestVariant,
  TEST_DELIVERY_RECIPIENT,
} from "./commerce-test-helpers.mjs";

const REQUEST_ID = "88888888-8888-4888-8888-888888888888";

function runtime(harness) {
  return commerceEnvironment(harness, {
    PRINTFUL_API_TOKEN: "mock-printful-token",
    PRINTFUL_STORE_ID: "18668025",
    STRIPE_SECRET_KEY: "sk_test_controlledDraft123",
    STRIPE_WEBHOOK_SECRET: "whsec_controlled_draft_secret",
  });
}

async function seedPaidAcceptance(harness) {
  const db = harness.commerceDb;
  await insertTestProduct(db, { title: "Controlled Tee", unitAmount: 3050, targetPrintfulProductId: "target-product-001", migrationStatus: "target_verified" });
  await insertTestVariant(db, { unitAmount: 3050, migrationStatus: "target_verified" });
  await enableControlledTestCheckout(db);
  const quote = await insertTestShippingQuote(db);
  const provider = await db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider='printful'").first();
  const metadata = { ...JSON.parse(provider.safe_metadata_json), api_configured: true, order_manage_authority: true, mode: "draft_only", order_mode: "draft_only", fulfillment_enabled: false };
  await db.batch([
    db.prepare("UPDATE commerce_settings SET value_json='\"printful_dynamic\"' WHERE setting_key='shipping_strategy'"),
    db.prepare("UPDATE commerce_provider_connections SET status='connected',environment='staging',integration_mode='fulfillment',currency_code='CAD',external_account_id='18668025',safe_metadata_json=? WHERE provider='printful'").bind(JSON.stringify(metadata)),
    db.prepare(`INSERT INTO commerce_catalogue_migrations (id,status,phase,safe_state_json,updated_at)
      VALUES ('permanent-printful-2026-08','completed','completed','{}','2026-08-29T00:00:00Z')
      ON CONFLICT(id) DO UPDATE SET status='completed',phase='completed',step_lease_token=NULL`),
  ]);
  const input = {
    checkoutRequestId: REQUEST_ID,
    items: [{ productId: "product-test-001", variantId: "variant-test-001", quantity: 1 }],
    recipient: TEST_DELIVERY_RECIPIENT,
    quoteId: quote.quoteId,
    shippingOptionId: quote.shippingOptionId,
    customer: { mode: "guest", name: "Controlled Draft Guest", email: "controlled-draft@example.test" },
  };
  const stripe = async (_url, init) => {
    const params = new URLSearchParams(init.body);
    const orderId = params.get("metadata[order_id]");
    return Response.json({
      id: "cs_test_controlled_draft_001", object: "checkout.session", livemode: false, mode: "payment", currency: "cad",
      amount_total: quote.totalAmount, client_reference_id: orderId,
      metadata: { order_id: orderId, checkout_request_id: REQUEST_ID },
      url: "https://checkout.stripe.com/c/pay/cs_test_controlled_draft_001",
    });
  };
  const created = await createStripeCheckoutSession(runtime(harness), new Request("https://thirdrailify-admin.pages.dev/", { headers: { Origin: "https://thirdrailify-admin.pages.dev" } }), input, stripe, { gate: "controlled_test" });
  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE commerce_orders SET payment_status='paid',payment_confirmed_at=?,stripe_payment_intent_id='pi_test_controlled_draft_001',updated_at=? WHERE id=?").bind(timestamp, timestamp, created.orderId),
    db.prepare(`INSERT INTO commerce_webhook_events
      (provider,provider_event_id,event_type,event_created_at,received_at,livemode,related_object_id,related_object_type,processing_status,processed_at,result_code,payload_sha256)
      VALUES ('stripe','evt_controlled_draft_001','checkout.session.completed',1,?,0,?,'checkout.session','processed',?,'payment_confirmed',?)`)
      .bind(timestamp, created.sessionId, timestamp, "a".repeat(64)),
  ]);
  return created;
}

test("controlled paid TEST order creates at most one unconfirmed Printful draft and reconciles locally", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const created = await seedPaidAcceptance(harness);
  const calls = [];
  const printful = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "GET") return Response.json({ code: 404, result: [] }, { status: 404 });
    assert.equal(url, "https://api.printful.com/orders?confirm=false&update_existing=false");
    assert.equal("confirm" in calls.at(-1).body, false);
    assert.equal(calls.at(-1).body.external_id, created.orderId);
    assert.equal(calls.at(-1).body.shipping, "STANDARD");
    assert.deepEqual(calls.at(-1).body.items, [{ sync_variant_id: "target-variant-001", quantity: 1 }]);
    assert.equal(calls.at(-1).body.recipient.address1, "100 Test Street");
    return Response.json({ code: 200, result: { id: 700001, external_id: created.orderId, store: 18668025, status: "draft" } });
  };

  const result = await createStoredPrintfulDraftOrder(runtime(harness), { accountId: "master-test" }, created.orderId, printful);
  assert.deepEqual(result, { ok: true, orderId: created.orderId, providerOrderId: "700001", externalId: created.orderId, status: "draft", confirmed: false, created: true, reconciled: false });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.some((call) => /\/confirm(?:ation)?(?:\?|$)/.test(call.url)), false);

  const order = await harness.commerceDb.prepare("SELECT payment_status,fulfillment_status,printful_order_id,safe_metadata_json FROM commerce_orders WHERE id=?").bind(created.orderId).first();
  const safe = JSON.parse(order.safe_metadata_json);
  assert.equal(order.payment_status, "paid"); assert.equal(order.fulfillment_status, "disabled"); assert.equal(order.printful_order_id, "700001");
  assert.equal(safe.printfulOrderStatus, "draft"); assert.equal(safe.printfulConfirmationStatus, "unconfirmed");
  assert.doesNotMatch(JSON.stringify(safe), /Checkout Fixture|100 Test Street|N6A 1A1/);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_audit WHERE action='printful.order_draft_created'").first()).count, 1);

  const repeatedCalls = [];
  const repeated = await createStoredPrintfulDraftOrder(runtime(harness), { accountId: "master-test" }, created.orderId, async (...args) => { repeatedCalls.push(args); throw new Error("provider must not be called"); });
  assert.equal(repeated.created, false); assert.equal(repeated.reconciled, true); assert.deepEqual(repeatedCalls, []);
});

test("Printful draft acceptance fails before provider access when payment or safety authority is incomplete", async () => {
  for (const mutation of [
    "UPDATE commerce_orders SET payment_status='pending',payment_confirmed_at=NULL",
    "UPDATE commerce_orders SET customer_id=NULL",
    "DELETE FROM commerce_webhook_events",
    "UPDATE commerce_settings SET value_json='true' WHERE setting_key='fulfillment_submission_enabled'",
    "UPDATE commerce_settings SET value_json='\"live\"' WHERE setting_key='printful_order_mode'",
    "UPDATE commerce_product_variants SET is_sellable=0",
  ]) {
    const harness = await createCommerceDatabases();
    try {
      const created = await seedPaidAcceptance(harness);
      await harness.commerceDb.prepare(mutation).run();
      let calls = 0;
      await assert.rejects(createStoredPrintfulDraftOrder(runtime(harness), { accountId: "master-test" }, created.orderId, async () => { calls += 1; throw new Error("must not fetch"); }), AuthFailureLike);
      assert.equal(calls, 0);
      assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_orders WHERE printful_order_id IS NOT NULL").first()).count, 0);
    } finally { await harness.dispose(); }
  }
});

function AuthFailureLike(error) {
  return Boolean(error && Number(error.status) >= 400 && String(error.code || ""));
}
