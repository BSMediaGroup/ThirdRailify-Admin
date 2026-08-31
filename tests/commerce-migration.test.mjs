import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration } from "./auth-test-helpers.mjs";
import { createCommerceDatabases } from "./commerce-test-helpers.mjs";

test("commerce migrations apply in order, with the idempotent foundations repeat-safe", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  for (const migration of harness.commerceMigrations.slice(0, 2)) await applyMigration(harness.commerceDb, migration);
  const result = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
  assert.deepEqual(result.results.map((row) => row.name), [
    "account_inbox_messages", "account_inbox_states",
    "admin_inbox_messages", "admin_inbox_reads",
    "analytics_events",
    "bot_automation_config", "bot_runtime_heartbeat", "bot_service_nonces",
    "commerce_audit", "commerce_business_profiles", "commerce_catalogue_migrations", "commerce_catalogue_reconciliation_items", "commerce_catalogue_reconciliation_runs", "commerce_collections", "commerce_customers", "commerce_donations", "commerce_email_deliveries", "commerce_fulfillment_order_items", "commerce_fulfillment_orders", "commerce_fulfillment_shipment_items", "commerce_fulfillment_shipments", "commerce_launch_state", "commerce_operation_jobs", "commerce_order_delivery_snapshots", "commerce_order_documents", "commerce_order_items", "commerce_orders", "commerce_payment_attempts", "commerce_payment_provider_state", "commerce_paypal_webhook_events", "commerce_permission_grants", "commerce_printful_file_mappings", "commerce_product_collections", "commerce_product_variants", "commerce_products", "commerce_provider_connections", "commerce_provider_diagnostics", "commerce_provider_webhook_events", "commerce_saved_addresses", "commerce_settings", "commerce_shipping_markets", "commerce_shipping_quotes", "commerce_tax_registrations", "commerce_templates", "commerce_webhook_events",
    "community_comments", "community_email_outbox", "community_email_templates", "community_media", "community_moderation_events",
    "community_rate_limits", "community_reactions", "community_submissions",
    "poll_activity_events", "poll_creator_grants", "poll_options", "poll_rate_limits", "poll_rumble_event_fingerprints", "poll_rumble_leases", "poll_votes", "polls",
    "site_banner_settings",
    "wheel_access", "wheel_audit_events", "wheel_creator_grants", "wheel_entries", "wheel_media_assets", "wheel_official_spins", "wheel_rate_limits", "wheel_settings", "wheel_stage_items", "wheel_stages", "wheels",
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
  assert.equal(stripe.integration_mode, "direct_merchant"); assert.equal(stripe.credential_custody, "environment_secret"); assert.equal(stripe.status, "disabled"); assert.equal(stripe.environment, "test");
  assert.equal(stripe.country_code, "CA"); assert.equal(stripe.currency_code, "CAD");
  assert.deepEqual(JSON.parse(stripe.safe_metadata_json), { account_display_name: "Third Railify Official", account_created: true, api_configured: false, webhook_configured: false, checkout_enabled: false, live_payments_enabled: false, live_payout_readiness: "unverified", payment_methods: ["cards", "eligible_apple_pay", "eligible_google_pay"], preferred: false, enabled: false, retained_for_future_activation: true });
  assert.equal(providers.results.filter((row) => row.provider.startsWith("stripe")).length, 1);
  assert.equal(providers.results.find((row) => row.provider === "printful").credential_custody, "environment_secret");
  assert.equal(providers.results.find((row) => row.provider === "paypal").credential_custody, "environment_secret");
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
  await harness.commerceDb.prepare(`INSERT INTO commerce_products (
    id, source_provider, slug, title, currency_code, status, safe_metadata_json, created_at, updated_at
  ) VALUES ('product-one', 'manual', 'product-one', 'Product one', 'CAD', 'active', '{}', 'now', 'now')`).run();
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

test("0005 enforces stable variant identities while keeping SKU nullable and non-unique", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await harness.commerceDb.prepare(`INSERT INTO commerce_products (
    id, source_provider, slug, title, currency_code, status, safe_metadata_json, created_at, updated_at
  ) VALUES ('product-variant', 'printful', 'product-variant', 'Variant product', 'CAD', 'active', '{}', 'now', 'now')`).run();
  const insert = (id, localKey, targetVariant, legacyVariant) => harness.commerceDb.prepare(`INSERT INTO commerce_product_variants (
    id, product_id, local_variant_key, status, visibility, is_sellable, availability_status,
    unit_amount, currency_code, sku, target_printful_sync_variant_id, legacy_source_variant_id,
    option_values_json, migration_provenance_json, created_at, updated_at
  ) VALUES (?, 'product-variant', ?, 'active', 'public', 1, 'active', 2500, 'CAD',
    'DUPLICATE-SKU', ?, ?, '{}', '{}', 'now', 'now')`).bind(id, localKey, targetVariant, legacyVariant).run();
  await insert("variant-one", "one", "target-one", "legacy-one");
  await insert("variant-two", "two", "target-two", "legacy-two");
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_product_variants WHERE sku = 'DUPLICATE-SKU'").first()).count, 2);
  await assert.rejects(insert("variant-three", "three", "target-one", "legacy-three"));
  await assert.rejects(insert("variant-four", "four", "target-four", "legacy-one"));
  await assert.rejects(harness.commerceDb.prepare(`INSERT INTO commerce_product_variants (
    id, product_id, local_variant_key, unit_amount, currency_code, availability_status, created_at, updated_at
  ) VALUES ('bad-currency', 'product-variant', 'bad', 1, 'USD', 'active', 'now', 'now')`).run());
  const indexes = await harness.commerceDb.prepare("PRAGMA index_list('commerce_product_variants')").all();
  assert.equal(indexes.results.find((row) => row.name === "idx_commerce_product_variants_sku").unique, 0);
  const settings = await harness.commerceDb.prepare("SELECT setting_key, value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled', 'fulfillment_submission_enabled') ORDER BY setting_key").all();
  assert.deepEqual(settings.results, [{ setting_key: "checkout_enabled", value_json: "false" }, { setting_key: "fulfillment_submission_enabled", value_json: "false" }]);
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

test("0009 backfills every existing category into stable collection membership without changing products", async (t) => {
  const harness = await createCommerceDatabases({ commerceMigrationCount: 8 }); t.after(harness.dispose);
  await harness.commerceDb.prepare(`INSERT INTO commerce_products (id,source_provider,slug,title,currency_code,status,safe_metadata_json,created_at,updated_at,visibility) VALUES ('backfill-product','manual','backfill-product','Backfill product','CAD','active',?,'now','now','public')`).bind(JSON.stringify({ categories: ["Apparel", "Third Railify™ Branded"] })).run();
  const before = await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_products").first();
  await applyMigration(harness.commerceDb, harness.commerceMigrations[8]);
  const memberships = await harness.commerceDb.prepare(`SELECT c.slug FROM commerce_product_collections pc JOIN commerce_collections c ON c.id=pc.collection_id WHERE pc.product_id='backfill-product' ORDER BY c.slug`).all();
  assert.deepEqual(memberships.results.map((row) => row.slug), ["apparel", "third-railify-branded"]);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_products").first()).count, before.count);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_collections").first()).count, 7);
});
