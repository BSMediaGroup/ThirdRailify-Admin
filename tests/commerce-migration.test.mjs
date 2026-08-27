import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration } from "./auth-test-helpers.mjs";
import { createCommerceDatabases } from "./commerce-test-helpers.mjs";

test("commerce migrations apply in order, with the idempotent foundations repeat-safe", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  for (const migration of harness.commerceMigrations.slice(0, 2)) await applyMigration(harness.commerceDb, migration);
  const result = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
  assert.deepEqual(result.results.map((row) => row.name), [
    "commerce_audit", "commerce_business_profiles", "commerce_order_items", "commerce_orders", "commerce_permission_grants", "commerce_products",
    "commerce_provider_connections", "commerce_settings", "commerce_tax_registrations", "commerce_templates", "commerce_webhook_events",
    "community_comments", "community_email_outbox", "community_email_templates", "community_media", "community_moderation_events",
    "community_rate_limits", "community_reactions", "community_submissions",
  ]);
  const profile = await harness.commerceDb.prepare("SELECT trading_name, country_code, province_code, currency_code FROM commerce_business_profiles WHERE id = 'primary'").first();
  assert.deepEqual(profile, { trading_name: "Third Railify Official", country_code: "CA", province_code: "ON", currency_code: "CAD" });
  const indexes = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'commerce_webhook_events' ORDER BY name").all();
  assert.deepEqual(indexes.results.map((row) => row.name), [
    "idx_commerce_webhook_events_event_id", "idx_commerce_webhook_events_received", "idx_commerce_webhook_events_status",
    "idx_commerce_webhook_events_type_created", "sqlite_autoindex_commerce_webhook_events_1",
  ]);
  const products = await harness.commerceDb.prepare("SELECT id FROM commerce_products ORDER BY slug").all();
  assert.equal(products.results.length, 0);
});

test("provider uniqueness, status constraints, and credential custody fail closed", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await assert.rejects(harness.commerceDb.prepare("INSERT INTO commerce_provider_connections (id, provider, credential_custody, status, environment, created_at, updated_at) VALUES ('duplicate', 'paypal', 'admin_encrypted', 'deferred', 'deferred', 'now', 'now')").run());
  await assert.rejects(harness.commerceDb.prepare("INSERT INTO commerce_provider_connections (id, provider, credential_custody, status, environment, created_at, updated_at) VALUES ('bad-status', 'paypal', 'admin_encrypted', 'active', 'deferred', 'now', 'now')").run());
  await assert.rejects(harness.commerceDb.prepare("UPDATE commerce_provider_connections SET credential_ciphertext = 'plaintext' WHERE provider = 'stripe'").run());
  await assert.rejects(harness.commerceDb.prepare("UPDATE commerce_provider_connections SET integration_mode = 'legacy' WHERE provider = 'stripe'").run());
  await assert.rejects(harness.commerceDb.prepare("INSERT INTO commerce_provider_connections (id, provider, integration_mode, credential_custody, status, environment, created_at, updated_at) VALUES ('legacy-stripe', 'stripe_connected_account', 'direct_merchant', 'no_secret', 'setup_required', 'test', 'now', 'now')").run());
  const providers = await harness.commerceDb.prepare("SELECT provider, integration_mode, credential_custody, status, environment, country_code, currency_code, safe_metadata_json FROM commerce_provider_connections ORDER BY provider").all();
  const stripe = providers.results.find((row) => row.provider === "stripe");
  assert.equal(stripe.integration_mode, "direct_merchant"); assert.equal(stripe.credential_custody, "environment_secret"); assert.equal(stripe.status, "setup_required"); assert.equal(stripe.environment, "test");
  assert.equal(stripe.country_code, "CA"); assert.equal(stripe.currency_code, "CAD");
  assert.deepEqual(JSON.parse(stripe.safe_metadata_json), { account_display_name: "Third Railify Official", account_created: true, api_configured: false, webhook_configured: false, checkout_enabled: false, live_payments_enabled: false, live_payout_readiness: "unverified", payment_methods: ["cards", "eligible_apple_pay", "eligible_google_pay"] });
  assert.equal(providers.results.filter((row) => row.provider.startsWith("stripe")).length, 1);
  assert.equal(providers.results.find((row) => row.provider === "printful").credential_custody, "environment_secret");
  assert.equal(providers.results.find((row) => row.provider === "paypal").credential_custody, "admin_encrypted");
  const settings = await harness.commerceDb.prepare("SELECT setting_key, value_json FROM commerce_settings ORDER BY setting_key").all();
  assert.equal(settings.results.some((row) => row.setting_key.includes("onboarding")), false);
  assert.equal(settings.results.find((row) => row.setting_key === "checkout_enabled").value_json, "false");
});

test("order records keep customer payment and Printful costs separate", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await harness.commerceDb.prepare(`INSERT INTO commerce_orders (
    id, customer_payment_provider, payment_status, fulfillment_provider, fulfillment_status, currency_code,
    customer_gross_amount, stripe_fee_amount, refund_amount, printful_product_cost_amount,
    printful_shipping_cost_amount, printful_tax_amount, printful_refund_credit_amount, gross_margin_amount, created_at, updated_at
  ) VALUES ('order-test', 'stripe', 'paid', 'printful', 'draft', 'CAD', 6000, 204, 0, 2200, 900, 403, 100, 2193, 'now', 'now')`).run();
  const row = await harness.commerceDb.prepare("SELECT * FROM commerce_orders WHERE id = 'order-test'").first();
  assert.equal(row.customer_payment_provider, "stripe"); assert.equal(row.fulfillment_provider, "printful"); assert.equal(row.fulfillment_status, "draft");
  assert.equal(row.customer_gross_amount, 6000); assert.equal(row.printful_product_cost_amount, 2200); assert.equal(row.printful_shipping_cost_amount, 900); assert.equal(row.printful_refund_credit_amount, 100); assert.equal(row.gross_margin_amount, 2193);
});

test("checkout schema enforces request uniqueness, integer money, line snapshots, and foreign keys", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await harness.commerceDb.prepare(`INSERT INTO commerce_orders (
    id, customer_payment_provider, payment_status, fulfillment_status, currency_code, customer_gross_amount,
    checkout_request_id, checkout_request_digest, cart_digest, environment, checkout_status, created_at, updated_at
  ) VALUES ('ord_test_one', 'stripe', 'pending', 'disabled', 'CAD', 5000,
    '44444444-4444-4444-8444-444444444444', ?, ?, 'test', 'checkout_pending', 'now', 'now')`).bind("a".repeat(64), "b".repeat(64)).run();
  await assert.rejects(harness.commerceDb.prepare(`INSERT INTO commerce_orders (
    id, customer_payment_provider, payment_status, fulfillment_status, currency_code, customer_gross_amount,
    checkout_request_id, environment, checkout_status, created_at, updated_at
  ) VALUES ('ord_test_duplicate', 'stripe', 'pending', 'disabled', 'CAD', 1,
    '44444444-4444-4444-8444-444444444444', 'test', 'checkout_pending', 'now', 'now')`).run());
  await harness.commerceDb.prepare(`INSERT INTO commerce_order_items (
    id, order_id, line_number, product_id, product_name, currency_code, unit_amount, quantity,
    line_total_amount, requires_shipping, created_at
  ) VALUES ('item_one', 'ord_test_one', 1, 'product-one', 'Snapshot name', 'CAD', 2500, 2, 5000, 1, 'now')`).run();
  await assert.rejects(harness.commerceDb.prepare(`INSERT INTO commerce_order_items (
    id, order_id, line_number, product_id, product_name, currency_code, unit_amount, quantity,
    line_total_amount, requires_shipping, created_at
  ) VALUES ('item_bad_total', 'ord_test_one', 2, 'product-two', 'Bad total', 'CAD', 2500, 2, 1, 0, 'now')`).run());
  await assert.rejects(harness.commerceDb.prepare(`INSERT INTO commerce_order_items (
    id, order_id, line_number, product_id, product_name, currency_code, unit_amount, quantity,
    line_total_amount, requires_shipping, created_at
  ) VALUES ('item_missing_order', 'missing', 1, 'product-two', 'Missing order', 'CAD', 1, 1, 1, 0, 'now')`).run());
  await assert.rejects(harness.commerceDb.prepare("DELETE FROM commerce_orders WHERE id = 'ord_test_one'").run());
  await assert.rejects(harness.commerceDb.prepare(`INSERT INTO commerce_products (
    id, source_provider, slug, title, currency_code, status, safe_metadata_json, created_at, updated_at, unit_amount
  ) VALUES ('bad-price', 'manual', 'bad-price', 'Bad price', 'CAD', 'active', '{}', 'now', 'now', -1)`).run());
  const line = await harness.commerceDb.prepare("SELECT product_id, product_name, unit_amount, quantity, line_total_amount, requires_shipping FROM commerce_order_items WHERE id = 'item_one'").first();
  assert.deepEqual(line, { product_id: "product-one", product_name: "Snapshot name", unit_amount: 2500, quantity: 2, line_total_amount: 5000, requires_shipping: 1 });
});

test("pending 0003 preserves the historical accepted-noop webhook row exactly while adding processed status", async (t) => {
  const harness = await createCommerceDatabases({ commerceMigrationCount: 2 }); t.after(harness.dispose);
  await harness.commerceDb.prepare(`INSERT INTO commerce_webhook_events (
    provider, provider_event_id, event_type, event_created_at, received_at, livemode,
    api_version, related_object_id, related_object_type, processing_status, processed_at, result_code, payload_sha256
  ) VALUES ('stripe', 'evt_1U916SB2jGrq9Tn15Ouhe02E', 'checkout.session.completed', 1, 'now', 0,
    'test', 'cs_test_historical', 'checkout.session', 'accepted_noop', 'now', 'checkout_disabled', ?)`).bind("c".repeat(64)).run();
  await applyMigration(harness.commerceDb, harness.commerceMigrations[2]);
  const historical = await harness.commerceDb.prepare("SELECT provider_event_id, processing_status, result_code, payload_sha256 FROM commerce_webhook_events").first();
  assert.deepEqual(historical, { provider_event_id: "evt_1U916SB2jGrq9Tn15Ouhe02E", processing_status: "accepted_noop", result_code: "checkout_disabled", payload_sha256: "c".repeat(64) });
  await harness.commerceDb.prepare(`INSERT INTO commerce_webhook_events (
    provider, provider_event_id, event_type, received_at, livemode, processing_status, result_code
  ) VALUES ('stripe', 'evt_processed', 'checkout.session.completed', 'now', 0, 'processed', 'payment_confirmed')`).run();
});
