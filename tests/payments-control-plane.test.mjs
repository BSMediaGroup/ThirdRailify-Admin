import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { paymentsControlPlanePayload } from "../functions/_shared/commerce-control-plane.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases, insertTestProduct, insertTestVariant } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const ORDER_ID = "ord_e47b94a4-4252-438b-8ca7-c47470029940";
const SESSION_ID = "cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC";
const EVENT_ID = "evt_1U9OysB2jGrq9Tn1apdsFgi2";

async function masterSession(env) {
  await ensureEnvironmentMasters(env);
  const account = await loadAccountByEmail(env, "master-one@example.test");
  const created = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), account, ADMIN_ORIGIN);
  return { account, created, cookie: cookiePair(created.cookie) };
}

async function seedVerifiedPayments(harness) {
  await insertTestProduct(harness.commerceDb, { id: "product-397267935", slug: "third-rail-farm-black-glossy-mug", title: "Third Rail Farm | Black Glossy Mug", unitAmount: 1500 });
  await insertTestVariant(harness.commerceDb, { id: "variant-5019554081", productId: "product-397267935", unitAmount: 1500, sizeLabel: "11 oz", colorLabel: "Black" });
  const provider = await harness.commerceDb.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider='stripe'").first();
  const metadata = { ...JSON.parse(provider.safe_metadata_json), api_configured: true, webhook_configured: true, charges_enabled: true, payouts_enabled: false, details_submitted: true };
  await harness.commerceDb.batch([
    harness.commerceDb.prepare("UPDATE commerce_provider_connections SET status='connected',environment='test',external_account_id='acct_TestMerchantSafe123',country_code='CA',currency_code='CAD',safe_metadata_json=?,last_synchronized_at='2026-08-28T12:00:00.000Z' WHERE provider='stripe'").bind(JSON.stringify(metadata)),
    harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key IN ('stripe_api_configured','stripe_webhook_configured')"),
    harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='false' WHERE setting_key IN ('checkout_enabled','live_payment_capture_enabled','fulfillment_submission_enabled')"),
    harness.commerceDb.prepare(`INSERT INTO commerce_orders (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,refund_amount,stripe_checkout_session_id,stripe_payment_intent_id,environment,checkout_status,created_at,updated_at,checkout_created_at,payment_confirmed_at)
      VALUES (?,'paid','disabled','CAD',1500,0,?,'pi_test_accepted','test','checkout_created','2026-08-28T12:17:12.217Z','2026-08-28T12:34:03.094Z','2026-08-28T12:17:13.196Z','2026-08-28T12:34:03.094Z')`).bind(ORDER_ID, SESSION_ID),
    harness.commerceDb.prepare(`INSERT INTO commerce_order_items (id,order_id,line_number,product_id,variant_id,product_name,variant_name,option_values_json,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,fulfillment_provider,created_at)
      VALUES ('line-accepted',?,1,'product-397267935','variant-5019554081','Third Rail Farm | Black Glossy Mug','11 oz / Black','{}','CAD',1500,1,1500,1,'printful','2026-08-28T12:17:12.217Z')`).bind(ORDER_ID),
    harness.commerceDb.prepare(`INSERT INTO commerce_webhook_events (provider,provider_event_id,event_type,event_created_at,received_at,livemode,related_object_id,related_object_type,processing_status,processed_at,result_code,payload_sha256)
      VALUES ('stripe',?,'checkout.session.completed',1787920442,'2026-08-28T12:34:03.000Z',0,?,'checkout.session','processed','2026-08-28T12:34:03.094Z','payment_confirmed',?)`).bind(EVENT_ID, SESSION_ID, "a".repeat(64)),
    harness.commerceDb.prepare(`INSERT INTO commerce_webhook_events (provider,provider_event_id,event_type,event_created_at,received_at,livemode,processing_status,processed_at,result_code,payload_sha256)
      VALUES ('stripe','evt_test_failed_projection','checkout.session.completed',1787920500,'2026-08-28T12:35:00.000Z',0,'error','2026-08-28T12:35:00.100Z','processing_error',?)`).bind("b".repeat(64)),
    harness.commerceDb.prepare("INSERT INTO commerce_orders (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,refund_amount,environment,checkout_status,created_at,updated_at) VALUES ('ord-test-extra','paid','disabled','CAD',700,0,'test','checkout_created','2026-08-28T13:00:00Z','2026-08-28T13:00:00Z')"),
    harness.commerceDb.prepare("INSERT INTO commerce_orders (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,refund_amount,environment,checkout_status,created_at,updated_at) VALUES ('ord-live-paid','paid','disabled','CAD',2000,0,'live','checkout_created','2026-08-28T14:00:00Z','2026-08-28T14:00:00Z')"),
    harness.commerceDb.prepare("INSERT INTO commerce_orders (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,refund_amount,environment,checkout_status,created_at,updated_at) VALUES ('ord-live-refunded','partially_refunded','disabled','CAD',3000,500,'live','checkout_created','2026-08-28T15:00:00Z','2026-08-28T15:00:00Z')"),
  ]);
}

test("payments projection distinguishes configured secrets from verified evidence and stays fail-closed", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "rk_test_notARealRestrictedKey123", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_payments_only" });
  const payload = await paymentsControlPlanePayload(env, { accountId: "master", account: { adminLevel: "master" } });
  assert.equal(payload.stripe.integrationMode, "direct_merchant");
  assert.equal(payload.stripe.apiCredentialConfigured, true); assert.equal(payload.stripe.apiVerified, false);
  assert.equal(payload.stripe.webhookSigningSecretConfigured, true); assert.equal(payload.stripe.webhookAcceptanceVerified, false);
  assert.equal(payload.overall.stripeState, "configured"); assert.equal(payload.overall.testAcceptance, "unverified");
  assert.equal(payload.productionActivation.checkout.enabled, false); assert.equal(payload.productionActivation.livePayments.enabled, false); assert.equal(payload.productionActivation.fulfillment.enabled, false);
  assert.equal(payload.testEvidence, null); assert.equal(payload.payoutState.state, "unverified");
  assert.deepEqual(payload.paypal, { provider: "paypal", state: "deferred", integrationMode: "direct_merchant", environment: "deferred", countryCode: "CA", currencyCode: "CAD", credentialConfigured: false, donationsEnabled: false, membershipEnabled: false, shopCheckoutEnabled: false, providerMutationAvailable: false, lastVerifiedAt: null });
  assert.equal(payload.payoutState.availableBalance, null); assert.equal(payload.payoutState.nextPayout, null); assert.equal(payload.payoutState.schedule, null);
  assert.equal(payload.paymentSummary.live.grossAmount, 0); assert.equal(payload.paymentSummary.test.grossAmount, 0);
  assert.equal(payload.paymentSummary.processingFees.available, false);
  assert.doesNotMatch(JSON.stringify(payload), /rk_test_notAReal|whsec_synthetic|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|credential_ciphertext|bank_account_number/i);
});

test("verified TEST evidence is canonical and excluded from exact LIVE minor-unit totals", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedVerifiedPayments(harness);
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "rk_test_notARealRestrictedKey123", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_payments_only" });
  const payload = await paymentsControlPlanePayload(env, { accountId: "master", account: { adminLevel: "master" } });
  assert.equal(payload.overall.stripeState, "verified"); assert.equal(payload.overall.testAcceptance, "verified"); assert.equal(payload.overall.productionPayments, "disabled");
  assert.equal(payload.testEvidence.orderId, ORDER_ID); assert.equal(payload.testEvidence.amount, 1500); assert.equal(payload.testEvidence.currencyCode, "CAD"); assert.equal(payload.testEvidence.paymentStatus, "paid");
  assert.equal(payload.testEvidence.stripeSessionId, SESSION_ID); assert.equal(payload.testEvidence.webhookEventId, EVENT_ID); assert.equal(payload.testEvidence.webhookResult, "payment_confirmed");
  assert.deepEqual(payload.paymentSummary.test, { available: true, successfulPayments: 2, grossAmount: 2200, refundedPayments: 0, refundAmount: 0, netAfterRefunds: 2200 });
  assert.deepEqual(payload.paymentSummary.live, { available: true, successfulPayments: 2, grossAmount: 5000, refundedPayments: 1, refundAmount: 500, netAfterRefunds: 4500 });
  assert.equal(payload.webhookHealth.counts.processed, 1); assert.equal(payload.webhookHealth.counts.failed, 1); assert.equal(payload.webhookHealth.latestProcessed.eventId, EVENT_ID); assert.equal(payload.webhookHealth.latestFailed.eventId, "evt_test_failed_projection");
  assert.equal(payload.webhookHealth.externallyVerified, false); assert.equal(payload.webhookHealth.counts.duplicates, null);
  assert.equal(payload.stripe.payoutsEnabledInTest, false); assert.equal(payload.payoutState.testCapabilityObserved, false); assert.equal(payload.payoutState.state, "unverified");
  assert.equal(payload.technical.stripeConnect, false); assert.equal(payload.technical.stripeAccountHeader, false); assert.equal(payload.technical.providerMutationAvailable, false);
  assert.equal(payload.paypal.state, "deferred"); assert.equal(payload.paypal.integrationMode, "direct_merchant"); assert.equal(payload.paypal.credentialConfigured, false); assert.equal(payload.paypal.donationsEnabled, false); assert.equal(payload.paypal.shopCheckoutEnabled, false); assert.equal(payload.paypal.providerMutationAvailable, false);
  await harness.commerceDb.prepare("UPDATE commerce_webhook_events SET payload_sha256=NULL WHERE provider_event_id=?").bind(EVENT_ID).run();
  const invalidated = await paymentsControlPlanePayload(env, { accountId: "master", account: { adminLevel: "master" } });
  assert.equal(invalidated.stripe.webhookAcceptanceVerified, true); assert.equal(invalidated.testEvidence, null); assert.equal(invalidated.overall.testAcceptance, "unverified");
});

test("payments read route requires Admin auth and commerce view, exposes no secrets, and performs no provider request", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); await seedVerifiedPayments(harness);
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "rk_test_notARealRestrictedKey123", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_payments_only" });
  const { cookie } = await masterSession(env); const url = `${ADMIN_ORIGIN}/api/admin/commerce/payments`;
  let providerCalls = 0; const commerceFetch = async () => { providerCalls += 1; throw new Error("status route must not contact Stripe"); };
  const unauthenticated = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: ADMIN_ORIGIN }), env, data: { commerceFetch } });
  assert.equal(unauthenticated.status, 401);
  const response = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: ADMIN_ORIGIN, cookie }), env, data: { commerceFetch } });
  assert.equal(response.status, 200); assert.equal(providerCalls, 0);
  const payload = await response.json(); assert.equal(payload.access.isMasterAdmin, true); assert.equal(payload.stripe.accountId, "acct_TestMerchantSafe123");
  assert.doesNotMatch(JSON.stringify(payload), /rk_test_notAReal|whsec_synthetic|credential_ciphertext|safe_metadata_json|payload_sha256/i);

  const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES ('payments-view-admin','payments-view@example.test','Payments View Admin','admin','full','active',?,?,?,'test'),('payments-user','payments-user@example.test','Payments User','user','none','active',?,?,?,'test')").bind(now, now, now, now, now, now).run();
  const viewAdmin = await loadAccountByEmail(env, "payments-view@example.test"); const viewAdminSession = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), viewAdmin, ADMIN_ORIGIN);
  const delegated = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: ADMIN_ORIGIN, cookie: cookiePair(viewAdminSession.cookie) }), env, data: { commerceFetch } }); const delegatedPayload = await delegated.json();
  assert.equal(delegated.status, 200); assert.equal(delegatedPayload.access.capabilities.includes("commerce.view"), true); assert.equal(delegatedPayload.access.capabilities.includes("commerce.payments.manage"), false); assert.equal(delegatedPayload.stripe.accountId, null); assert.equal(delegatedPayload.stripe.accountIdRestricted, true);
  const user = await loadAccountByEmail(env, "payments-user@example.test"); const userSession = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), user, ADMIN_ORIGIN);
  const nonAdmin = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: ADMIN_ORIGIN, cookie: cookiePair(userSession.cookie) }), env, data: { commerceFetch } }); assert.equal(nonAdmin.status, 403);

  const noDb = await commerceRequest({ request: jsonRequest(url, { method: "GET", origin: ADMIN_ORIGIN, cookie }), env: { ...env, THIRDRAILIFY_COMMERCE_DB: undefined }, data: { commerceFetch } });
  assert.equal(noDb.status, 200); const noDbPayload = await noDb.json(); assert.equal(noDbPayload.databaseConfigured, false); assert.equal(noDbPayload.testEvidence, null); assert.equal(noDbPayload.productionActivation.checkout.enabled, false);
});
