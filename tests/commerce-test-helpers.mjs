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
  new URL("../commerce-migrations/0006_site_banner.sql", import.meta.url),
  new URL("../commerce-migrations/0007_goats_engagement_and_wix_import.sql", import.meta.url),
  new URL("../commerce-migrations/0008_goats_profile_gif.sql", import.meta.url),
  new URL("../commerce-migrations/0009_commerce_collections.sql", import.meta.url),
  new URL("../commerce-migrations/0010_commerce_production_control_plane.sql", import.meta.url),
  new URL("../commerce-migrations/0011_goats_geocoder.sql", import.meta.url),
  new URL("../commerce-migrations/0012_admin_inbox_and_reaction_reset.sql", import.meta.url),
  new URL("../commerce-migrations/0013_homepage_content_rail.sql", import.meta.url),
  new URL("../commerce-migrations/0014_wheels_v1.sql", import.meta.url),
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
    targetPrintfulProductId: null,
    migrationStatus: "not_started",
    ...overrides,
  };
  await db.prepare(
    `INSERT INTO commerce_products (
       id, source_provider, external_product_id, slug, title, currency_code, status,
       safe_metadata_json, created_at, updated_at, is_featured, featured_order, unit_amount,
       checkout_environment, visibility, max_checkout_quantity, requires_shipping,
       target_printful_product_id, migration_status
     ) VALUES (?, 'manual', NULL, ?, ?, ?, ?, '{}', 'now', 'now', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    product.id, product.slug, product.title, product.currencyCode, product.status,
    product.isFeatured, product.featuredOrder, product.unitAmount, product.checkoutEnvironment,
    product.visibility, product.maxCheckoutQuantity, product.requiresShipping,
    product.targetPrintfulProductId, product.migrationStatus,
  ).run();
  return product;
}

export async function applySqlBatches(db, sql, batchSize = 50) {
  const statements = sql.split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
  for (let offset = 0; offset < statements.length; offset += batchSize) {
    await db.batch(statements.slice(offset, offset + batchSize).map((statement) => db.prepare(statement)));
  }
}

export async function importPermanentCatalogue(db, manifest, batchSize = 50) {
  assertPermanentCatalogueManifest(manifest);
  const productSql = `INSERT INTO commerce_products (
    id, source_provider, external_product_id, slug, title, currency_code, status, safe_metadata_json,
    created_at, updated_at, is_featured, featured_order, unit_amount, checkout_environment, visibility,
    max_checkout_quantity, requires_shipping, target_printful_product_id, target_printful_external_id,
    legacy_printful_source_product_id, legacy_wix_external_product_id, migration_status, migration_provenance_json
  ) VALUES (?, ?, ?, ?, ?, 'CAD', 'pending', ?, ?, ?, 0, NULL, ?, 'test', 'private', 20, 1, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    slug = excluded.slug, title = excluded.title, unit_amount = excluded.unit_amount,
    safe_metadata_json = excluded.safe_metadata_json, migration_provenance_json = excluded.migration_provenance_json,
    target_printful_external_id = excluded.target_printful_external_id,
    migration_status = CASE WHEN commerce_products.migration_status IN ('not_started', 'selected') THEN excluded.migration_status ELSE commerce_products.migration_status END,
    updated_at = excluded.updated_at`;
  const variantSql = `INSERT INTO commerce_product_variants (
    id, product_id, local_variant_key, status, visibility, is_sellable, availability_status, is_ignored,
    unit_amount, currency_code, sku, size_label, color_label, option_values_json,
    target_printful_product_id, target_printful_external_id, target_printful_sync_variant_id,
    target_catalogue_product_id, target_catalogue_variant_id, legacy_source_product_id, legacy_source_variant_id,
    legacy_wix_external_product_id, legacy_wix_external_variant_id, fulfillment_provider,
    fulfillment_mapping_status, migration_status, migration_provenance_json, file_mapping_json,
    safe_metadata_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'private', 0, ?, 0, ?, 'CAD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'printful', ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    unit_amount = excluded.unit_amount, sku = excluded.sku, size_label = excluded.size_label, color_label = excluded.color_label,
    option_values_json = excluded.option_values_json, target_catalogue_product_id = excluded.target_catalogue_product_id,
    target_catalogue_variant_id = excluded.target_catalogue_variant_id, file_mapping_json = excluded.file_mapping_json,
    safe_metadata_json = excluded.safe_metadata_json, migration_provenance_json = excluded.migration_provenance_json,
    migration_status = CASE WHEN commerce_product_variants.migration_status IN ('selected', 'deferred') THEN excluded.migration_status ELSE commerce_product_variants.migration_status END,
    updated_at = excluded.updated_at`;

  await runPreparedBatches(db, manifest.products.map((value) => db.prepare(productSql).bind(
    value.id, value.sourceProvider, value.externalProductId, value.slug, value.title,
    JSON.stringify(value.metadata), value.timestamp, value.timestamp, value.unitAmount,
    value.targetProductId ?? null, value.targetExternalId ?? null, value.legacySourceProductId ?? null,
    value.legacyWixProductId ?? null, value.migrationStatus, JSON.stringify(value.provenance),
  )), batchSize);
  await runPreparedBatches(db, manifest.variants.map((value) => db.prepare(variantSql).bind(
    value.id, value.productId, value.localVariantKey, value.status, value.availability, value.unitAmount,
    value.sku ?? null, value.size ?? null, value.color ?? null, JSON.stringify(value.optionValues),
    value.targetProductId ?? null, value.targetExternalId ?? null, value.targetSyncVariantId ?? null,
    value.targetCatalogueProductId ?? null, value.targetCatalogueVariantId ?? null,
    value.legacySourceProductId ?? null, value.legacySourceVariantId ?? null,
    value.legacyWixProductId ?? null, value.legacyWixVariantId ?? null, value.mappingStatus,
    value.migrationStatus, JSON.stringify(value.provenance), JSON.stringify(value.files),
    JSON.stringify(value.metadata), value.timestamp, value.timestamp,
  )), batchSize);
  const migration = manifest.migration;
  await db.prepare(`INSERT INTO commerce_catalogue_migrations (id, status, phase, safe_state_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      safe_state_json = CASE WHEN commerce_catalogue_migrations.status = 'ready' THEN excluded.safe_state_json ELSE commerce_catalogue_migrations.safe_state_json END,
      updated_at = CASE WHEN commerce_catalogue_migrations.status = 'ready' THEN excluded.updated_at ELSE commerce_catalogue_migrations.updated_at END`)
    .bind(migration.id, migration.status, migration.phase, JSON.stringify(migration.safeState), migration.updatedAt).run();
}

function assertPermanentCatalogueManifest(manifest) {
  if (manifest?.format !== "thirdrailify-permanent-catalogue-v1" || !Array.isArray(manifest.products) || !Array.isArray(manifest.variants) || !manifest.migration) {
    throw new Error("Permanent catalogue manifest is invalid.");
  }
}

async function runPreparedBatches(db, statements, batchSize) {
  for (let offset = 0; offset < statements.length; offset += batchSize) {
    await db.batch(statements.slice(offset, offset + batchSize));
  }
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
    migrationStatus: "selected",
    ...overrides,
  };
  await db.prepare(
    `INSERT INTO commerce_product_variants (
       id, product_id, local_variant_key, status, visibility, is_sellable,
       availability_status, unit_amount, currency_code, sku, size_label, color_label,
       option_values_json, target_printful_product_id, target_printful_sync_variant_id,
       target_catalogue_product_id, target_catalogue_variant_id,
       fulfillment_provider, fulfillment_mapping_status, migration_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CAD', ?, ?, ?, ?, ?, ?, ?, ?, 'printful', ?, ?, 'now', 'now')`,
  ).bind(
    variant.id, variant.productId, variant.localVariantKey, variant.status, variant.visibility,
    variant.isSellable, variant.availabilityStatus, variant.unitAmount, variant.sku,
    variant.sizeLabel, variant.colorLabel, variant.optionValuesJson,
    variant.targetPrintfulProductId, variant.targetPrintfulSyncVariantId,
    variant.targetCatalogueProductId, variant.targetCatalogueVariantId,
    variant.fulfillmentMappingStatus, variant.migrationStatus,
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

export async function enableControlledTestCheckout(db, productId = "product-test-001", variantId = "variant-test-001") {
  const provider = await db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe'").first();
  const metadata = {
    ...JSON.parse(provider.safe_metadata_json),
    api_configured: true,
    webhook_configured: true,
    checkout_enabled: false,
    live_payments_enabled: false,
  };
  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare(
      `UPDATE commerce_provider_connections
       SET status = 'connected', environment = 'test', integration_mode = 'direct_merchant',
           country_code = 'CA', currency_code = 'cad', safe_metadata_json = ?
       WHERE provider = 'stripe'`,
    ).bind(JSON.stringify(metadata)),
    ...[
      ["checkout_enabled", false],
      ["stripe_api_configured", true],
      ["stripe_webhook_configured", true],
      ["live_payment_capture_enabled", false],
      ["fulfillment_submission_enabled", false],
      ["stripe_test_checkout_enabled", true],
      ["stripe_test_checkout_product_id", productId],
      ["stripe_test_checkout_variant_id", variantId],
    ].map(([key, value]) => db.prepare(
      `INSERT INTO commerce_settings (setting_key, value_json, classification, updated_at)
       VALUES (?, ?, 'safe', ?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
    ).bind(key, JSON.stringify(value), timestamp)),
  ]);
}
