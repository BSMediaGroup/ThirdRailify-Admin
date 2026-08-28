import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPermanentCatalogueEvidence, validatePermanentCatalogueEvidence } from "./validate-permanent-catalogue.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_SQL = path.join(ROOT, "commerce-import", "permanent-catalogue-import.sql");
const OUTPUT_JSON = path.join(ROOT, "commerce-import", "permanent-catalogue-import.json");
const OUTPUT_REPORT = path.join(ROOT, "commerce-import", "permanent-catalogue-import.report.json");

export function buildPermanentCatalogueImport(evidence = readPermanentCatalogueEvidence()) {
  const validation = validatePermanentCatalogueEvidence(evidence);
  const { selection, live, source, target } = evidence;
  const timestamp = selection.generatedAt;
  const liveById = new Map(live.products.map((product) => [String(product.id), product]));
  const sourceById = new Map(source.products.map((product) => [String(product.id), product]));
  const selected = selection.products.filter((product) => product.decision === "MIGRATE_CREATE_TARGET")
    .sort((left, right) => String(left.sourceProductId).localeCompare(String(right.sourceProductId), "en", { numeric: true }));
  const statements = [
    "PRAGMA foreign_keys = ON;",
  ];
  const products = [];
  const variants = [];
  const addProduct = (value) => {
    products.push(value);
    statements.push(productUpsert(value));
  };
  const addVariant = (value) => {
    variants.push(value);
    statements.push(variantUpsert(value));
  };
  let activeVariants = 0;
  let deferredVariants = 0;

  for (const authority of selected) {
    const sourceProduct = sourceById.get(String(authority.sourceProductId));
    const liveProduct = liveById.get(String(authority.legacyWixExternalProductId));
    const payload = authority.targetPayload;
    const productId = authority.canonicalFutureLocalProductId;
    const productMetadata = {
      authority: "permanent_commerce_catalogue",
      publicImage: liveProduct.image,
      publicImages: liveProduct.images,
      canonicalUrl: liveProduct.canonicalUrl,
      publicUrl: liveProduct.publicUrl,
      categories: liveProduct.categories,
      wixProductType: liveProduct.wixProductType,
      physical: true,
      shippingRequired: true,
      targetThumbnail: payload.sync_product.thumbnail,
      targetExternalId: payload.sync_product.external_id,
    };
    const productProvenance = {
      authority: "catalogue-write-selection.json",
      publicationAuthority: authority.provenance.publicationAuthority,
      legacySourceStoreId: "16847493",
      targetStoreId: "18668025",
      legacySourceProductId: authority.sourceProductId,
      legacyWixExternalProductId: authority.legacyWixExternalProductId,
      eligibleVariantCount: payload.sync_variants.length,
      deferredVariantCount: payload.deferred_variants.length,
      excludedDiscontinuedVariantCount: authority.excludedDiscontinuedVariantIds.length,
      acceptedEvidenceGeneratedAt: timestamp,
    };
    addProduct({
      id: productId,
      sourceProvider: "wix_snapshot",
      externalProductId: authority.legacyWixExternalProductId,
      slug: liveProduct.slug,
      title: authority.publicTitle,
      unitAmount: liveProduct.visibleUnitAmountCad,
      targetExternalId: payload.sync_product.external_id,
      legacySourceProductId: authority.sourceProductId,
      legacyWixProductId: authority.legacyWixExternalProductId,
      migrationStatus: "selected",
      metadata: productMetadata,
      provenance: productProvenance,
      timestamp,
    });

    const sourceVariants = new Map(sourceProduct.variants.map((variant) => [String(variant.id), variant]));
    for (const plannedVariant of payload.sync_variants) {
      const sourceVariantId = plannedVariant.external_id.replace(/^trf-source-variant-/, "");
      const sourceVariant = sourceVariants.get(sourceVariantId);
      const wixVariantId = wixVariantFromExternalId(sourceVariant.externalId, authority.legacyWixExternalProductId);
      const optionValues = cleanOptionValues(sourceVariant);
      addVariant({
        id: `variant-${sourceVariantId}`,
        productId,
        localVariantKey: `legacy-printful-${sourceVariantId}`,
        status: "pending",
        availability: "active",
        migrationStatus: "selected",
        unitAmount: sourceVariant.unitAmountCad,
        sku: sourceVariant.sku,
        size: sourceVariant.size,
        color: sourceVariant.color,
        optionValues,
        targetExternalId: plannedVariant.external_id,
        targetCatalogueProductId: sourceVariant.catalogueProductId,
        targetCatalogueVariantId: sourceVariant.catalogueVariantId,
        legacySourceProductId: authority.sourceProductId,
        legacySourceVariantId: sourceVariantId,
        legacyWixProductId: authority.legacyWixExternalProductId,
        legacyWixVariantId: wixVariantId,
        mappingStatus: "planned",
        files: plannedVariant.files.map((file) => ({ sourceFileId: String(file.id), type: file.type, filename: file.filename, options: stripNullOptions(file.options) })),
        provenance: variantProvenance(plannedVariant, sourceVariant, timestamp),
        metadata: { sourceVariantName: sourceVariant.name, catalogueProductName: sourceVariant.catalogueProductName, catalogueImageUrl: sourceVariant.catalogueImageUrl, targetOptions: stripNullOptions(plannedVariant.options) },
        timestamp,
      });
      activeVariants += 1;
    }

    for (const deferred of payload.deferred_variants) {
      const sourceVariant = sourceVariants.get(String(deferred.legacy_source_variant_id));
      const sourceVariantId = String(sourceVariant.id);
      const wixVariantId = wixVariantFromExternalId(sourceVariant.externalId, authority.legacyWixExternalProductId);
      addVariant({
        id: `variant-${sourceVariantId}`,
        productId,
        localVariantKey: `legacy-printful-${sourceVariantId}`,
        status: "disabled",
        availability: "temporarily_out_of_stock",
        migrationStatus: "deferred",
        unitAmount: sourceVariant.unitAmountCad,
        sku: sourceVariant.sku,
        size: sourceVariant.size,
        color: sourceVariant.color,
        optionValues: cleanOptionValues(sourceVariant),
        targetExternalId: `trf-source-variant-${sourceVariantId}`,
        targetCatalogueProductId: sourceVariant.catalogueProductId,
        targetCatalogueVariantId: sourceVariant.catalogueVariantId,
        legacySourceProductId: authority.sourceProductId,
        legacySourceVariantId: sourceVariantId,
        legacyWixProductId: authority.legacyWixExternalProductId,
        legacyWixVariantId: wixVariantId,
        mappingStatus: "unmapped",
        files: sourceVariant.files.filter((file) => file.type !== "preview").map((file) => ({ sourceFileId: String(file.id), type: file.type, filename: file.filename, options: stripNullOptions(file.options) })),
        provenance: { ...variantProvenance(null, sourceVariant, timestamp), deferredPolicy: deferred.policy },
        metadata: { sourceVariantName: sourceVariant.name, catalogueProductName: sourceVariant.catalogueProductName, catalogueImageUrl: sourceVariant.catalogueImageUrl },
        timestamp,
      });
      deferredVariants += 1;
    }
  }

  const nativeProduct = target.products[0];
  const nativeVariant = nativeProduct.variants[0];
  addProduct({
    id: "product-target-native-459991347",
    sourceProvider: "printful",
    externalProductId: nativeProduct.externalId,
    slug: "target-native-my-balloon-classic-tee-459991347",
    title: nativeProduct.name,
    unitAmount: nativeVariant.unitAmountCad,
    targetExternalId: nativeProduct.externalId,
    targetProductId: nativeProduct.id,
    migrationStatus: "target_native",
    metadata: { authority: "permanent_commerce_catalogue", publicImage: nativeProduct.thumbnailUrl, physical: true, shippingRequired: true, targetNative: true, publicShopDisposition: "private" },
    provenance: { authority: "printful-api-target.snapshot.json", targetStoreId: "18668025", disposition: "USER_OWNED_REAL_TARGET_DATA", relatedLegacyArtworkProductId: "439028668", acceptedEvidenceGeneratedAt: timestamp },
    timestamp,
  });
  addVariant({
    id: "variant-target-native-5463409939",
    productId: "product-target-native-459991347",
    localVariantKey: "target-printful-5463409939",
    status: "restricted",
    availability: "active",
    migrationStatus: "target_native",
    unitAmount: nativeVariant.unitAmountCad,
    sku: nativeVariant.sku,
    size: nativeVariant.size,
    color: nativeVariant.color,
    optionValues: cleanOptionValues(nativeVariant),
    targetExternalId: nativeVariant.externalId,
    targetProductId: nativeProduct.id,
    targetSyncVariantId: nativeVariant.id,
    targetCatalogueProductId: nativeVariant.catalogueProductId,
    targetCatalogueVariantId: nativeVariant.catalogueVariantId,
    mappingStatus: "mapped",
    files: [],
    provenance: { authority: "printful-api-target.snapshot.json", targetStoreId: "18668025", disposition: "USER_OWNED_REAL_TARGET_DATA", acceptedEvidenceGeneratedAt: timestamp },
    metadata: { targetNative: true, sourceVariantName: nativeVariant.name, catalogueProductName: nativeVariant.catalogueProductName, catalogueImageUrl: nativeVariant.catalogueImageUrl },
    timestamp,
  });
  const migration = {
    id: "permanent-printful-2026-08",
    status: "ready",
    phase: "preflight",
    safeState: { evidenceGeneratedAt: timestamp, plannedProducts: 49, eligibleVariants: activeVariants, deferredVariants, targetNativeKeeps: 1 },
    updatedAt: timestamp,
  };
  statements.push(`INSERT INTO commerce_catalogue_migrations (id, status, phase, safe_state_json, updated_at)
VALUES (${sql(migration.id)}, ${sql(migration.status)}, ${sql(migration.phase)}, ${sqlJson(migration.safeState)}, ${sql(migration.updatedAt)})
ON CONFLICT(id) DO UPDATE SET
  safe_state_json = CASE WHEN commerce_catalogue_migrations.status = 'ready' THEN excluded.safe_state_json ELSE commerce_catalogue_migrations.safe_state_json END,
  updated_at = CASE WHEN commerce_catalogue_migrations.status = 'ready' THEN excluded.updated_at ELSE commerce_catalogue_migrations.updated_at END;`);
  statements.push("PRAGMA foreign_keys = ON;");

  const report = { ...validation, d1Products: selected.length + 1, d1Variants: activeVariants + deferredVariants + 1, activeVariants, deferredVariants, targetNativeProducts: 1, targetNativeVariants: 1, checkoutEnabled: false, fulfillmentEnabled: false, generatedFrom: selection.generatedFrom, acceptedEvidenceGeneratedAt: timestamp };
  const manifest = { format: "thirdrailify-permanent-catalogue-v1", acceptedEvidenceGeneratedAt: timestamp, products, variants, migration };
  return { sql: `${statements.join("\n\n")}\n`, manifest, report };
}

function productUpsert(value) {
  return `INSERT INTO commerce_products (
  id, source_provider, external_product_id, slug, title, currency_code, status, safe_metadata_json,
  created_at, updated_at, is_featured, featured_order, unit_amount, checkout_environment, visibility,
  max_checkout_quantity, requires_shipping, target_printful_product_id, target_printful_external_id,
  legacy_printful_source_product_id, legacy_wix_external_product_id, migration_status, migration_provenance_json
) VALUES (
  ${sql(value.id)}, ${sql(value.sourceProvider)}, ${sql(value.externalProductId)}, ${sql(value.slug)}, ${sql(value.title)}, 'CAD', 'pending', ${sqlJson(value.metadata)},
  ${sql(value.timestamp)}, ${sql(value.timestamp)}, 0, NULL, ${value.unitAmount}, 'test', 'private', 20, 1,
  ${sql(value.targetProductId)}, ${sql(value.targetExternalId)}, ${sql(value.legacySourceProductId)}, ${sql(value.legacyWixProductId)}, ${sql(value.migrationStatus)}, ${sqlJson(value.provenance)}
)
ON CONFLICT(id) DO UPDATE SET
  slug = excluded.slug, title = excluded.title, unit_amount = excluded.unit_amount,
  safe_metadata_json = excluded.safe_metadata_json, migration_provenance_json = excluded.migration_provenance_json,
  target_printful_external_id = excluded.target_printful_external_id,
  migration_status = CASE WHEN commerce_products.migration_status IN ('not_started', 'selected') THEN excluded.migration_status ELSE commerce_products.migration_status END,
  updated_at = excluded.updated_at;`;
}

function variantUpsert(value) {
  return `INSERT INTO commerce_product_variants (
  id, product_id, local_variant_key, status, visibility, is_sellable, availability_status, is_ignored,
  unit_amount, currency_code, sku, size_label, color_label, option_values_json,
  target_printful_product_id, target_printful_external_id, target_printful_sync_variant_id,
  target_catalogue_product_id, target_catalogue_variant_id, legacy_source_product_id, legacy_source_variant_id,
  legacy_wix_external_product_id, legacy_wix_external_variant_id, fulfillment_provider,
  fulfillment_mapping_status, migration_status, migration_provenance_json, file_mapping_json,
  safe_metadata_json, created_at, updated_at
) VALUES (
  ${sql(value.id)}, ${sql(value.productId)}, ${sql(value.localVariantKey)}, ${sql(value.status)}, 'private', 0, ${sql(value.availability)}, 0,
  ${value.unitAmount}, 'CAD', ${sql(value.sku)}, ${sql(value.size)}, ${sql(value.color)}, ${sqlJson(value.optionValues)},
  ${sql(value.targetProductId)}, ${sql(value.targetExternalId)}, ${sql(value.targetSyncVariantId)},
  ${sql(value.targetCatalogueProductId)}, ${sql(value.targetCatalogueVariantId)}, ${sql(value.legacySourceProductId)}, ${sql(value.legacySourceVariantId)},
  ${sql(value.legacyWixProductId)}, ${sql(value.legacyWixVariantId)}, 'printful', ${sql(value.mappingStatus)},
  ${sql(value.migrationStatus)}, ${sqlJson(value.provenance)}, ${sqlJson(value.files)}, ${sqlJson(value.metadata)}, ${sql(value.timestamp)}, ${sql(value.timestamp)}
)
ON CONFLICT(id) DO UPDATE SET
  unit_amount = excluded.unit_amount, sku = excluded.sku, size_label = excluded.size_label, color_label = excluded.color_label,
  option_values_json = excluded.option_values_json, target_catalogue_product_id = excluded.target_catalogue_product_id,
  target_catalogue_variant_id = excluded.target_catalogue_variant_id, file_mapping_json = excluded.file_mapping_json,
  safe_metadata_json = excluded.safe_metadata_json, migration_provenance_json = excluded.migration_provenance_json,
  migration_status = CASE WHEN commerce_product_variants.migration_status IN ('selected', 'deferred') THEN excluded.migration_status ELSE commerce_product_variants.migration_status END,
  updated_at = excluded.updated_at;`;
}

function variantProvenance(plannedVariant, sourceVariant, timestamp) {
  return { authority: "catalogue-write-selection.json", legacySourceStoreId: "16847493", targetStoreId: "18668025", sourceAvailability: sourceVariant.availabilityStatus, targetRetailPrice: plannedVariant?.retail_price || null, acceptedEvidenceGeneratedAt: timestamp };
}

function cleanOptionValues(variant) {
  return Object.fromEntries([["Size", variant.size], ["Color", variant.color]].filter(([, value]) => typeof value === "string" && value.trim()));
}

function stripNullOptions(options) {
  return Array.isArray(options) ? options.filter((option) => option && option.id && option.value !== null && option.value !== undefined) : [];
}

function wixVariantFromExternalId(externalId, wixProductId) {
  const prefix = `${wixProductId}:`;
  return typeof externalId === "string" && externalId.startsWith(prefix) ? externalId.slice(prefix.length) : null;
}

function sql(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return sql(JSON.stringify(value));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildPermanentCatalogueImport();
  fs.writeFileSync(OUTPUT_SQL, built.sql, "utf8");
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(built.manifest)}\n`, "utf8");
  fs.writeFileSync(OUTPUT_REPORT, `${JSON.stringify(built.report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ sql: path.relative(ROOT, OUTPUT_SQL), manifest: path.relative(ROOT, OUTPUT_JSON), report: path.relative(ROOT, OUTPUT_REPORT), ...built.report }, null, 2));
}
