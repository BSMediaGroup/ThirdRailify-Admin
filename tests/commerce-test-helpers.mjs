import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { applyMigration, authEnvironment } from "./auth-test-helpers.mjs";

const authMigrationUrl = new URL("../migrations/0001_auth_foundation.sql", import.meta.url);
const commerceMigrationUrls = [
  new URL("../commerce-migrations/0001_commerce_control_plane.sql", import.meta.url),
  new URL("../commerce-migrations/0002_stripe_webhook_events.sql", import.meta.url),
  new URL("../commerce-migrations/0003_product_merchandising.sql", import.meta.url),
  new URL("../commerce-migrations/0004_goats_community.sql", import.meta.url),
  new URL("../commerce-migrations/0005_commerce_product_variants.sql", import.meta.url),
];

export const TEST_COMMERCE_KEY = "ERERERERERERERERERERERERERERERERERERERERERE";

export async function createCommerceDatabases({ commerceMigrationCount = commerceMigrationUrls.length } = {}) {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-08-11",
    d1Databases: ["THIRDRAILIFY_AUTH_DB", "THIRDRAILIFY_COMMERCE_DB"],
    modules: true,
    script: "export default { fetch() { return new Response('test'); } };",
  });
  const authDb = await miniflare.getD1Database("THIRDRAILIFY_AUTH_DB");
  const commerceDb = await miniflare.getD1Database("THIRDRAILIFY_COMMERCE_DB");
  const [authMigration, ...commerceMigrations] = await Promise.all([readFile(authMigrationUrl, "utf8"), ...commerceMigrationUrls.map((url) => readFile(url, "utf8"))]);
  await applyMigration(authDb, authMigration);
  for (const migration of commerceMigrations.slice(0, commerceMigrationCount)) await applyMigration(commerceDb, migration);
  return { authDb, commerceDb, commerceMigrations, dispose: () => miniflare.dispose() };
}

export function commerceEnvironment(harness, overrides = {}) {
  return authEnvironment(harness.authDb, {
    THIRDRAILIFY_COMMERCE_DB: harness.commerceDb,
    THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY: TEST_COMMERCE_KEY,
    ...overrides,
  });
}

export async function insertTestProduct(db, overrides = {}) {
  const product = {
    id: "product-test-001",
    slug: "product-test-001",
    title: "Authoritative Test Product",
    currencyCode: "CAD",
    status: "active",
    unitAmount: 2500,
    checkoutEnvironment: "test",
    visibility: "public",
    maxCheckoutQuantity: 5,
    requiresShipping: 1,
    isFeatured: 0,
    featuredOrder: null,
    ...overrides,
  };
  await db.prepare(
    `INSERT INTO commerce_products (
       id, source_provider, external_product_id, slug, title, currency_code, status,
       safe_metadata_json, created_at, updated_at, is_featured, featured_order, unit_amount,
       checkout_environment, visibility, max_checkout_quantity, requires_shipping
     ) VALUES (?, 'manual', NULL, ?, ?, ?, ?, '{}', 'now', 'now', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    product.id, product.slug, product.title, product.currencyCode, product.status,
    product.isFeatured, product.featuredOrder, product.unitAmount, product.checkoutEnvironment,
    product.visibility, product.maxCheckoutQuantity, product.requiresShipping,
  ).run();
  return product;
}

export async function insertTestVariant(db, overrides = {}) {
  const variant = {
    id: "variant-test-001",
    productId: "product-test-001",
    localVariantKey: "black-m",
    status: "active",
    visibility: "public",
    isSellable: 1,
    availabilityStatus: "active",
    unitAmount: 2750,
    sku: "TEST-SKU-001",
    sizeLabel: "M",
    colorLabel: "Black",
    optionValuesJson: '{"Size":"M","Color":"Black"}',
    targetPrintfulProductId: "target-product-001",
    targetPrintfulSyncVariantId: "target-variant-001",
    targetCatalogueProductId: "438",
    targetCatalogueVariantId: "11576",
    fulfillmentMappingStatus: "mapped",
    ...overrides,
  };
  await db.prepare(
    `INSERT INTO commerce_product_variants (
       id, product_id, local_variant_key, status, visibility, is_sellable,
       availability_status, unit_amount, currency_code, sku, size_label, color_label,
       option_values_json, target_printful_product_id, target_printful_sync_variant_id,
       target_catalogue_product_id, target_catalogue_variant_id,
       fulfillment_provider, fulfillment_mapping_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CAD', ?, ?, ?, ?, ?, ?, ?, ?, 'printful', ?, 'now', 'now')`,
  ).bind(
    variant.id, variant.productId, variant.localVariantKey, variant.status, variant.visibility,
    variant.isSellable, variant.availabilityStatus, variant.unitAmount, variant.sku,
    variant.sizeLabel, variant.colorLabel, variant.optionValuesJson,
    variant.targetPrintfulProductId, variant.targetPrintfulSyncVariantId,
    variant.targetCatalogueProductId, variant.targetCatalogueVariantId,
    variant.fulfillmentMappingStatus,
  ).run();
  return variant;
}

export async function enableTestCheckout(db) {
  const provider = await db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe'").first();
  const metadata = {
    ...JSON.parse(provider.safe_metadata_json),
    api_configured: true,
    webhook_configured: true,
    checkout_enabled: true,
    live_payments_enabled: false,
  };
  await db.batch([
    db.prepare(
      `UPDATE commerce_provider_connections
       SET status = 'connected', environment = 'test', integration_mode = 'direct_merchant',
           country_code = 'CA', currency_code = 'cad', safe_metadata_json = ?
       WHERE provider = 'stripe'`,
    ).bind(JSON.stringify(metadata)),
    db.prepare("UPDATE commerce_settings SET value_json = 'true' WHERE setting_key IN ('checkout_enabled', 'stripe_api_configured', 'stripe_webhook_configured')"),
    db.prepare("UPDATE commerce_settings SET value_json = 'false' WHERE setting_key IN ('live_payment_capture_enabled', 'fulfillment_submission_enabled')"),
  ]);
}
