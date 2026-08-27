import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DIR = path.join(ROOT, "commerce-import", "live");

export function readPermanentCatalogueEvidence() {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(LIVE_DIR, name), "utf8"));
  return {
    selection: read("catalogue-write-selection.json"),
    live: read("live-wix-published.snapshot.json"),
    source: read("printful-wix-source.snapshot.json"),
    target: read("printful-api-target.snapshot.json"),
    corrected: read("catalogue-reconciliation.corrected.json"),
    payloads: read("printful-target-create-payloads.json"),
    report: read("migration-evidence-report.json"),
  };
}

export function validatePermanentCatalogueEvidence(evidence = readPermanentCatalogueEvidence()) {
  const { selection, live, source, target, corrected, payloads, report } = evidence;
  const failures = [];
  const require = (condition, message) => { if (!condition) failures.push(message); };
  const decisions = Object.groupBy(selection.products, (product) => product.decision);
  const sourceById = new Map(source.products.map((product) => [String(product.id), product]));
  const liveById = new Map(live.products.map((product) => [String(product.id), product]));
  const payloadBySourceId = new Map(payloads.payloads.map((payload) => [String(payload.migrationMetadata?.legacySourceProductId), payload]));
  const productExternalIds = new Set();
  const variantExternalIds = new Set();
  let eligibleVariants = 0;
  let deferredVariants = 0;
  let selectedDiscontinuedVariants = 0;
  let maximumVariantsPerProduct = 0;
  let sourceFileReferences = 0;

  require(source.store?.id === "16847493" && source.store?.name === "Third Railify Official" && source.store?.type === "wix", "Legacy source identity is not authoritative.");
  require(target.store?.id === "18668025" && target.store?.name === "Third Railify API" && target.store?.type === "native", "Permanent target identity is not authoritative.");
  require(source.store?.id !== target.store?.id, "Legacy source and permanent target Store IDs collide.");
  require(source.products.length === 119 && sum(source.products, (product) => product.variants.length) === 2456, "Legacy source product or variant counts changed.");
  require(live.products.length === 49 && new Set(live.products.map((product) => product.id)).size === 49, "The live Wix publication authority is not exactly 49 unique products.");
  require(decisions.MIGRATE_CREATE_TARGET?.length === 49, "MIGRATE_CREATE_TARGET is not exactly 49.");
  require(decisions.KEEP_EXISTING_TARGET_RELATED_LEGACY?.length === 1, "KEEP_EXISTING_TARGET is not exactly one.");
  require(decisions.EXCLUDE_NOT_CURRENTLY_PUBLISHED?.length === 69, "The not-currently-published exclusion set is not exactly 69.");
  require(decisions.MANUAL_REVIEW?.length === 1 && decisions.MANUAL_REVIEW[0].sourceProductId === "454885552", "Raider's Goblet is not the sole manual-review record.");
  require(Object.entries(selection.acceptanceGates).every(([key, value]) => ["checkoutEnabled", "fulfillmentEnabled"].includes(key) ? value === false : value === true), "A final selection acceptance gate is not satisfied.");
  require(sha256("live-wix-published.snapshot.json") === selection.generatedFrom?.liveWixSnapshotSha256, "The selection live-Wix evidence hash changed.");
  require(sha256("live-wix-published.snapshot.json") === report.liveWixSnapshotSha256, "The evidence-report live-Wix hash changed.");
  require(JSON.stringify(selection.counts) === JSON.stringify(report.selection), "Selection and evidence-report counts disagree.");
  require(payloads.send === false && payloads.endpoint === "POST /store/products", "The payload artifact lost its explicit not-sent guard.");
  require(payloads.payloads.length === 49 && payloads.counts?.products === 49, "The target payload product count is not exactly 49.");

  for (const selected of decisions.MIGRATE_CREATE_TARGET || []) {
    const sourceProduct = sourceById.get(String(selected.sourceProductId));
    const liveProduct = liveById.get(String(selected.legacyWixExternalProductId));
    const payload = payloadBySourceId.get(String(selected.sourceProductId));
    require(selected.strongIdentity === true && !selected.blocker && selected.targetPayloadReadiness === "READY_NOT_SENT", `Selected product ${selected.sourceProductId} is not unambiguously write-ready.`);
    require(Boolean(sourceProduct && liveProduct && payload), `Selected product ${selected.sourceProductId} is missing source, live, or payload evidence.`);
    if (!sourceProduct || !liveProduct || !payload) continue;
    require(JSON.stringify(payload) === JSON.stringify(selected.targetPayload), `Selected product ${selected.sourceProductId} disagrees with the final target payload artifact.`);
    require(payload.send === false && payload.endpoint === "POST /store/products", `Selected product ${selected.sourceProductId} lost its not-sent guard.`);
    require(payload.sync_product?.external_id === `trf-source-product-${selected.sourceProductId}`, `Selected product ${selected.sourceProductId} has a non-deterministic external ID.`);
    require(!productExternalIds.has(payload.sync_product.external_id), `Duplicate target product external ID ${payload.sync_product.external_id}.`);
    productExternalIds.add(payload.sync_product.external_id);
    maximumVariantsPerProduct = Math.max(maximumVariantsPerProduct, payload.sync_variants.length);
    eligibleVariants += payload.sync_variants.length;
    deferredVariants += payload.deferred_variants.length;
    selectedDiscontinuedVariants += selected.excludedDiscontinuedVariantIds.length;
    require(payload.sync_variants.length <= 100, `Selected product ${selected.sourceProductId} exceeds Printful's 100-variant limit (${payload.sync_variants.length}).`);
    const eligibleIds = new Set(selected.eligibleVariantIds.map(String));
    const sourceVariants = new Map(sourceProduct.variants.map((variant) => [String(variant.id), variant]));
    require(eligibleIds.size === payload.sync_variants.length, `Selected product ${selected.sourceProductId} has an eligible-variant count mismatch.`);
    for (const variant of payload.sync_variants) {
      const sourceVariantId = String(variant.external_id).replace(/^trf-source-variant-/, "");
      const sourceVariant = sourceVariants.get(sourceVariantId);
      require(eligibleIds.has(sourceVariantId) && Boolean(sourceVariant), `Target variant ${variant.external_id} is outside the selected source set.`);
      require(sourceVariant?.availabilityStatus === "active" && sourceVariant?.isIgnored === false && sourceVariant?.synced === true, `Target variant ${variant.external_id} is not an active synchronized source variant.`);
      require(variant.migration_availability === "ACTIVE", `Target variant ${variant.external_id} is not marked ACTIVE.`);
      require(/^\d+\.\d{2}$/.test(variant.retail_price) && Number.isSafeInteger(Number(variant.variant_id)), `Target variant ${variant.external_id} has invalid price or catalogue identity.`);
      require(!variantExternalIds.has(variant.external_id), `Duplicate target variant external ID ${variant.external_id}.`);
      variantExternalIds.add(variant.external_id);
      require(variant.files.length > 0 && variant.files.every((file) => file.type !== "preview" && /^\d+$/.test(String(file.id))), `Target variant ${variant.external_id} has missing, preview, or invalid source files.`);
      sourceFileReferences += variant.files.length;
    }
    for (const deferred of payload.deferred_variants) {
      require(/^\d+$/.test(String(deferred.legacy_source_variant_id)) && deferred.policy === "VERIFY_TARGET_SUPPORT_BEFORE_ANY_FUTURE_CREATE", `Selected product ${selected.sourceProductId} has invalid deferred-variant evidence.`);
    }
  }

  for (const row of corrected.matrix.filter((item) => item.recommendedAction === "MIGRATE_CREATE_TARGET")) {
    require(!["AMBIGUOUS", "PRICE_CONFLICT", "VARIANT_CONFLICT", "FILE_CONFLICT"].includes(row.classification), "The selected reconciliation matrix contains a forbidden write classification.");
    require(!row.blocker && !row.manualReview && !/conflict/i.test(row.priceStatus) && !/conflict/i.test(row.variantStatus) && !/conflict/i.test(row.fileStatus), "The selected reconciliation matrix contains an unresolved write-authority conflict.");
  }

  const targetProduct = target.products?.[0];
  const targetVariant = targetProduct?.variants?.[0];
  require(target.products?.length === 1 && targetProduct?.id === "459991347" && targetProduct?.name === "My Balloon | classic tee", "The preserved target-native product changed.");
  require(targetProduct?.variants?.length === 1 && targetVariant?.id === "5463409939" && targetVariant?.catalogueProductId === "438" && targetVariant?.catalogueVariantId === "11576" && targetVariant?.unitAmountCad === 1250, "The preserved target-native variant changed.");
  require(eligibleVariants === 1317 && payloads.counts?.variants === 1317, "The selected active target-create variant set is not exactly 1,317.");
  require(deferredVariants === 5, "The selected deferred variant set is not exactly five.");
  require(selectedDiscontinuedVariants === 90, "The selected discontinued exclusion set is not exactly 90.");

  if (failures.length) throw new Error(`Permanent catalogue evidence failed validation:\n- ${failures.join("\n- ")}`);
  return Object.freeze({
    legacyProducts: source.products.length,
    legacyVariants: sum(source.products, (product) => product.variants.length),
    publishedWixProducts: live.products.length,
    migrateProducts: decisions.MIGRATE_CREATE_TARGET.length,
    targetNativeKeeps: decisions.KEEP_EXISTING_TARGET_RELATED_LEGACY.length,
    excludedNotPublished: decisions.EXCLUDE_NOT_CURRENTLY_PUBLISHED.length,
    manualReview: decisions.MANUAL_REVIEW.length,
    eligibleVariants,
    deferredVariants,
    selectedDiscontinuedVariants,
    maximumVariantsPerProduct,
    sourceFileReferences,
    liveWixSha256: sha256("live-wix-published.snapshot.json"),
  });
}

function sha256(name) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(LIVE_DIR, name))).digest("hex");
}

function sum(values, value) {
  return values.reduce((total, item) => total + value(item), 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(validatePermanentCatalogueEvidence(), null, 2));
}
