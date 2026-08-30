import assert from "node:assert/strict";
import test from "node:test";
import { activateCommerceLaunch, activatePayPalDonations, applyEligibleVariantSellability, commerceLaunchPlan, paypalDonationLaunchPlan, pauseCommerceLaunch } from "../functions/_shared/commerce-launch.js";
import { PAYPAL_WEBHOOK_EVENTS } from "../functions/_shared/paypal-client.js";
import { commerceEnvironment, createCommerceDatabases, insertTestProduct, insertTestVariant } from "./commerce-test-helpers.mjs";

test("launch planning and sellability use one exact eligibility predicate", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await insertTestProduct(harness.commerceDb, { targetPrintfulProductId: "9001", migrationStatus: "target_verified", requiresShipping: 1 });
  await insertTestVariant(harness.commerceDb, { isSellable: 0, targetPrintfulProductId: "9001", targetPrintfulSyncVariantId: "7001", targetCatalogueVariantId: "11576", migrationStatus: "target_verified" });
  const env = commerceEnvironment(harness);
  const before = await commerceLaunchPlan(env);
  assert.equal(before.catalogue.eligibleVariants, 1); assert.equal(before.catalogue.eligibleSellableVariants, 0); assert.equal(before.ready, false);
  const [first, second] = await Promise.all([applyEligibleVariantSellability(env, "master"), applyEligibleVariantSellability(env, "master")]);
  assert.equal(first.after.eligible, 1); assert.equal(second.after.eligible, 1);
  const after = await commerceLaunchPlan(env);
  assert.equal(after.catalogue.eligibleSellableVariants, 1); assert.equal(after.catalogue.ineligibleSellableVariants, 0);
  assert.equal((await harness.commerceDb.prepare("SELECT is_sellable FROM commerce_product_variants WHERE id='variant-test-001'").first()).is_sellable, 1);
});

test("activation fails atomically when any hard gate is blocked and pause is revision guarded", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const plan = await commerceLaunchPlan(env);
  await assert.rejects(activateCommerceLaunch(env, { confirmation: "ACTIVATE LIVE COMMERCE", expectedRevision: plan.revision }, "master"), (error) => error.code === "commerce_launch_blocked");
  assert.deepEqual(await harness.commerceDb.prepare("SELECT state,revision FROM commerce_launch_state WHERE id='production'").first(), { state: "preflight", revision: 1 });
  await assert.rejects(pauseCommerceLaunch(env, { confirmation: "PAUSE LIVE COMMERCE", expectedRevision: 99, reason: "test" }, "master"), (error) => error.code === "commerce_launch_revision_conflict");
  const paused = await pauseCommerceLaunch(env, { confirmation: "PAUSE LIVE COMMERCE", expectedRevision: 1, reason: "test emergency pause" }, "master");
  assert.equal(paused.state, "paused"); assert.equal(paused.revision, 2); assert.equal(paused.settings.emergencyPaused, true);
});

test("donation launch excludes store, shipping, Printful, fulfilment, and email gates and activates independently", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const timestamp = "2026-08-30T04:00:00.000Z";
  const metadata = { preferred: true, live: { oauth_verified: true, webhook_configured: true, webhook_readback_verified: true, webhook_events: PAYPAL_WEBHOOK_EVENTS } };
  await harness.commerceDb.batch([
    harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='true',updated_at=? WHERE setting_key IN ('paypal_live_configured','paypal_live_webhook_configured')").bind(timestamp),
    harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='false',updated_at=? WHERE setting_key='stripe_enabled'").bind(timestamp),
    harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='\"paypal\"',updated_at=? WHERE setting_key='preferred_payment_provider'").bind(timestamp),
    harness.commerceDb.prepare("UPDATE commerce_provider_connections SET status='connected',environment='live',integration_mode='direct_merchant',country_code='CA',currency_code='CAD',safe_metadata_json=?,updated_at=? WHERE provider='paypal'").bind(JSON.stringify(metadata),timestamp),
  ]);
  const env = { ...commerceEnvironment(harness), PAYPAL_LIVE_CLIENT_ID: "live-client-test", PAYPAL_LIVE_CLIENT_SECRET: "live-secret-test", PAYPAL_LIVE_WEBHOOK_ID: "WHLIVE001" };
  const plan = await paypalDonationLaunchPlan(env);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.excludedDependencies, ["catalogue","shipping","printful","fulfillment","transactional_email"]);
  const activated = await activatePayPalDonations(env, { confirmation: "ACTIVATE LIVE PAYPAL DONATIONS", expectedRevision: plan.revision }, "master");
  assert.equal(activated.settings.donationsEnabled, true);
  assert.equal(activated.settings.storeCheckoutEnabled, false);
  const settings = Object.fromEntries((await harness.commerceDb.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled','fulfillment_submission_enabled','paypal_store_checkout_enabled','paypal_donations_enabled','paypal_live_capture_enabled','stripe_enabled')").all()).results.map((row) => [row.setting_key, JSON.parse(row.value_json)]));
  assert.deepEqual(settings, { checkout_enabled: false, fulfillment_submission_enabled: false, paypal_store_checkout_enabled: false, paypal_live_capture_enabled: true, paypal_donations_enabled: true, stripe_enabled: false });
});
