import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration } from "./auth-test-helpers.mjs";
import { createCommerceDatabases } from "./commerce-test-helpers.mjs";

test("commerce migration creates the separate control-plane schema and is repeat-safe", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await applyMigration(harness.commerceDb, harness.commerceMigration);
  const result = await harness.commerceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
  assert.deepEqual(result.results.map((row) => row.name), [
    "commerce_audit", "commerce_business_profiles", "commerce_orders", "commerce_permission_grants", "commerce_products",
    "commerce_provider_connections", "commerce_settings", "commerce_tax_registrations", "commerce_templates",
  ]);
  const profile = await harness.commerceDb.prepare("SELECT trading_name, country_code, province_code, currency_code FROM commerce_business_profiles WHERE id = 'primary'").first();
  assert.deepEqual(profile, { trading_name: "Third Railify Official", country_code: "CA", province_code: "ON", currency_code: "CAD" });
});

test("provider uniqueness, status constraints, and credential custody fail closed", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await assert.rejects(harness.commerceDb.prepare("INSERT INTO commerce_provider_connections (id, provider, credential_custody, status, environment, created_at, updated_at) VALUES ('duplicate', 'paypal', 'admin_encrypted', 'deferred', 'deferred', 'now', 'now')").run());
  await assert.rejects(harness.commerceDb.prepare("INSERT INTO commerce_provider_connections (id, provider, credential_custody, status, environment, created_at, updated_at) VALUES ('bad-status', 'paypal', 'admin_encrypted', 'active', 'deferred', 'now', 'now')").run());
  await assert.rejects(harness.commerceDb.prepare("UPDATE commerce_provider_connections SET credential_ciphertext = 'plaintext' WHERE provider = 'stripe_platform'").run());
  const custody = await harness.commerceDb.prepare("SELECT provider, credential_custody FROM commerce_provider_connections ORDER BY provider").all();
  assert.equal(custody.results.find((row) => row.provider === "stripe_platform").credential_custody, "environment_secret");
  assert.equal(custody.results.find((row) => row.provider === "stripe_connected_account").credential_custody, "no_secret");
  assert.equal(custody.results.find((row) => row.provider === "printful").credential_custody, "environment_secret");
  assert.equal(custody.results.find((row) => row.provider === "paypal").credential_custody, "admin_encrypted");
});

test("order records keep customer payment and Printful costs separate", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await harness.commerceDb.prepare(`INSERT INTO commerce_orders (
    id, customer_payment_provider, payment_status, fulfillment_provider, fulfillment_status, currency_code,
    customer_gross_amount, stripe_fee_amount, refund_amount, printful_product_cost_amount,
    printful_shipping_cost_amount, printful_tax_amount, gross_margin_amount, created_at, updated_at
  ) VALUES ('order-test', 'stripe', 'paid', 'printful', 'draft', 'CAD', 6000, 204, 0, 2200, 900, 403, 2293, 'now', 'now')`).run();
  const row = await harness.commerceDb.prepare("SELECT * FROM commerce_orders WHERE id = 'order-test'").first();
  assert.equal(row.customer_payment_provider, "stripe"); assert.equal(row.fulfillment_provider, "printful"); assert.equal(row.fulfillment_status, "draft");
  assert.equal(row.customer_gross_amount, 6000); assert.equal(row.printful_product_cost_amount, 2200); assert.equal(row.printful_shipping_cost_amount, 900);
});
