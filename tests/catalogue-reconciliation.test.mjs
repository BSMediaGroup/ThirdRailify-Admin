import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { reconcileCatalogues } from "../scripts/catalogue-reconciliation-core.mjs";
import { PUBLIC_WIX_CATALOGUE } from "../functions/_shared/public-wix-catalogue.js";

function variant(overrides = {}) {
  return { id: "sv-1", externalId: "wv-1", catalogueProductId: "71", catalogueVariantId: "4011", sku: "SKU-1", size: "M", color: "Black", retailPrice: "29.99", unitAmountCad: 2999, currency: "CAD", synced: true, isIgnored: false, availabilityStatus: "active", price: { status: "valid", value: "29.99", minorUnits: 2999 }, files: [{ id: "f-1", type: "front", url: "https://example.test/art.png", filename: "art.png", status: "ok", options: [] }], options: [], ...overrides };
}

function product(overrides = {}) {
  return { id: "sp-1", externalId: "wix-product-1", name: "Third Railify Tee", thumbnailUrl: "https://example.test/thumb.png", variants: [variant()], ...overrides };
}

function provider(sourceProducts = [product()], targetProducts = []) {
  return { source: { store: { id: "10", name: "Wix", type: "wix" }, products: sourceProducts }, target: { store: { id: "18668025", name: "Third Railify API", type: "native" }, products: targetProducts } };
}

function publicProduct(overrides = {}) {
  return { id: "wix-product-1", wixExternalProductId: "wix-product-1", title: "Third Railify Tee", slug: "third-railify-tee", publicUrl: "https://example.test/product", visibleUnitAmountCad: 2999, optionLabels: ["Color", "Size"], classification: "PRINTFUL_MERCH", ...overrides };
}

test("server Public projection stays byte-value equivalent to the canonical JSON artifact", async () => {
  const canonical = JSON.parse(await readFile(new URL("../commerce-import/public-wix-catalog.snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(PUBLIC_WIX_CATALOGUE, canonical);
});

test("stable external IDs outrank conflicting names", () => {
  const source = [product({ id: "strong", name: "Different Name" }), product({ id: "fuzzy", externalId: "other", name: "Third Railify Tee" })];
  const result = reconcileCatalogues(provider(source), { products: [publicProduct()] });
  assert.equal(result.matrix[0].sourceMatch.productId, "strong");
  assert.equal(result.matrix[0].matchEvidence[0], "external_id_exact");
});

test("ambiguous normalized names remain unresolved", () => {
  const source = [product({ id: "one", externalId: "one" }), product({ id: "two", externalId: "two" })];
  const result = reconcileCatalogues(provider(source), { products: [publicProduct({ id: "unknown", wixExternalProductId: null })] });
  assert.equal(result.matrix[0].classification, "AMBIGUOUS");
  assert.equal(result.matrix[0].sourceMatch, null);
});

test("variant prices remain variant-specific and public conflicts are not guessed", () => {
  const source = [product({ variants: [variant(), variant({ id: "sv-2", externalId: "wv-2", retailPrice: "34.99", unitAmountCad: 3499, price: { status: "valid", value: "34.99", minorUnits: 3499 } })] })];
  const exactBase = reconcileCatalogues(provider(source), { products: [publicProduct()] });
  assert.equal(exactBase.matrix[0].priceStatus, "price_variant_specific");
  const conflict = reconcileCatalogues(provider(source), { products: [publicProduct({ visibleUnitAmountCad: 4500 })] });
  assert.equal(conflict.matrix[0].priceStatus, "price_conflict");
  assert.equal(conflict.matrix[0].classification, "PRICE_CONFLICT");
});

test("duplicate SKU and IDs are surfaced and target payloads are plans only", () => {
  const source = [product({ variants: [variant(), variant({ id: "sv-2", externalId: "wv-2" })] })];
  const result = reconcileCatalogues(provider(source), { products: [publicProduct()] });
  assert.equal(result.duplicateEvidence.sourceSkus[0].value, "SKU-1");
  assert.equal(result.duplicateEvidence.sourceSkus[0].count, 2);
  assert.equal(result.duplicateEvidence.sourceSkus[0].records.length, 2);
  assert.equal(result.plannedTargetPayloads.length, 1);
  assert.equal(result.plannedTargetPayloads[0].endpoint, "POST /store/products");
  assert.equal(result.plannedTargetPayloads[0].send, false);
});

test("existing target products are preserved and never emitted as create payloads", () => {
  const target = product({ id: "tp-1", variants: [variant({ id: "tv-1" })] });
  const result = reconcileCatalogues(provider([product()], [target]), { products: [publicProduct()] });
  assert.equal(result.matrix[0].classification, "TARGET_ALREADY_PRESENT");
  assert.equal(result.plannedTargetPayloads.length, 0);
  assert.equal(result.targetDispositions[0].recommendation, "MAP");
});

test("non-Printful public products are excluded from provider migration", () => {
  const result = reconcileCatalogues(provider(), { products: [publicProduct({ classification: "GIFT_CARD" })] });
  assert.equal(result.matrix[0].classification, "NON_PRINTFUL");
  assert.equal(result.matrix[0].sourceMatch, null);
});

test("exact normalized name outranks price and variant coincidence", () => {
  const exact = product({ id: "393315779", externalId: "exact-wix", name: "Just Gina™ Icon | Short Sleeve T-shirt", variants: [variant({ id: "gina-v" })] });
  const leggings = product({ id: "399113926", externalId: "leggings-wix", name: "Third Railify™ | Leggings", variants: [variant({ id: "leggings-v" })] });
  const live = publicProduct({ id: "unknown", wixExternalProductId: null, title: "Just Gina™ Icon | Short Sleeve T-shirt", visibleUnitAmountCad: 2999 });
  const result = reconcileCatalogues(provider([leggings, exact]), { products: [live] });
  assert.equal(result.matrix[0].sourceMatch.productId, "393315779");
  assert.equal(result.matrix[0].matchPriority, 3);
  assert.equal(result.matrix[0].matchEvidence[0], "name_exact_normalized");
  assert.notEqual(result.matrix[0].sourceMatch.productId, "399113926");
});

test("discontinued fileless variants do not block, active fileless variants do, and temporary stock is explicit", () => {
  const discontinued = variant({ id: "gone", synced: false, availabilityStatus: "discontinued", files: [] });
  const temporary = variant({ id: "later", availabilityStatus: "temporary_out_of_stock" });
  const safe = reconcileCatalogues(provider([product({ variants: [variant(), discontinued, temporary] })]), { products: [publicProduct()] });
  assert.equal(safe.matrix[0].fileStatus, "files_ready");
  assert.equal(safe.matrix[0].availability.DISCONTINUED, 1);
  assert.equal(safe.matrix[0].availability.TEMPORARILY_OUT_OF_STOCK, 1);
  assert.deepEqual(safe.plannedTargetPayloads[0].sync_variants.map((item) => item.external_id), ["trf-source-variant-sv-1"]);
  assert.deepEqual(safe.plannedTargetPayloads[0].deferred_variants.map((item) => item.legacy_source_variant_id), ["later"]);

  const blocked = reconcileCatalogues(provider([product({ variants: [variant({ files: [] })] })]), { products: [publicProduct()] });
  assert.equal(blocked.matrix[0].classification, "FILE_CONFLICT");
  assert.equal(blocked.plannedTargetPayloads.length, 0);
});

test("same artwork alone never turns the real target-native product into a legacy identity match", () => {
  const source = product({ id: "439028668", name: "my balloon | Cotton Heritage", variants: [variant({ catalogueProductId: "960", files: [{ id: "source-art", type: "front", filename: "baLLOON2.pdf", status: "ok" }] })] });
  const target = product({ id: "459991347", externalId: "target-native", name: "My Balloon | classic tee", variants: [variant({ id: "5463409939", catalogueProductId: "438", sku: "TARGET", files: [{ id: "target-art", type: "front", filename: "baLLOON2.pdf", status: "ok" }] })] });
  const result = reconcileCatalogues(provider([source], [target]), { products: [] });
  assert.equal(result.targetDispositions[0].recommendation, "KEEP_TARGET_NATIVE");
  assert.equal(result.targetDispositions[0].sourceProductId, null);
  assert.equal(result.targetDispositions[0].relatedLegacyArtworkProductId, "439028668");
  assert.equal(result.targetDispositions[0].catalogueIdentityComparison.exact, false);
  assert.equal(result.writeSelection.products.at(-1).decision, "KEEP_EXISTING_TARGET_RELATED_LEGACY");
});

test("live publication drives payload selection while unpublished, ambiguous, and non-Printful products never enter payloads", () => {
  const published = product({ id: "published", externalId: "wix-published" });
  const unpublished = product({ id: "unpublished", externalId: "wix-unpublished", name: "Old Product" });
  const result = reconcileCatalogues(provider([published, unpublished]), { products: [publicProduct({ wixExternalProductId: "wix-published" }), publicProduct({ id: "gift", wixExternalProductId: null, title: "Gift Card", classification: "GIFT_CARD" })] });
  assert.equal(result.plannedTargetPayloads.length, 1);
  assert.equal(result.plannedTargetPayloads[0].migrationMetadata.legacySourceProductId, "published");
  assert.equal(result.writeSelection.products.find((item) => item.sourceProductId === "unpublished").decision, "EXCLUDE_NOT_CURRENTLY_PUBLISHED");
  assert.equal(result.writeSelection.products.find((item) => item.public?.id === "gift").decision, "NON_PRINTFUL");
});

test("immutable completed evidence produces the bounded final write set", async () => {
  const [source, target, live] = await Promise.all([
    readFile(new URL("../commerce-import/live/printful-wix-source.snapshot.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../commerce-import/live/printful-api-target.snapshot.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../commerce-import/live/live-wix-published.snapshot.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const result = reconcileCatalogues({ source, target }, live);
  assert.deepEqual(result.evidenceAggregates.source.availability, { ACTIVE: 2287, TEMPORARILY_OUT_OF_STOCK: 6, DISCONTINUED: 163, OTHER: 0 });
  assert.deepEqual(result.evidenceAggregates.source.filelessByAvailability, { ACTIVE: 0, TEMPORARILY_OUT_OF_STOCK: 0, DISCONTINUED: 163, OTHER: 0 });
  assert.equal(result.counts.publicProducts, 49);
  assert.equal(result.counts.printfulBackedMatches, 49);
  assert.equal(result.counts.plannedTargetCreates, 49);
  assert.equal(result.counts.migrationEligibleVariants, 1317);
  assert.equal(result.counts.fileConflicts, 0);
  assert.equal(result.duplicateEvidence.sourceSkus.length, 2);
  const gina = result.matrix.find((entry) => entry.public?.slug === "just-gina-icon-basic-short-sleeve-t-shirt");
  assert.equal(gina.sourceMatch.productId, "393315779");
  assert.notEqual(gina.sourceMatch.productId, "399113926");
  assert.equal(result.targetDispositions[0].targetProductId, "459991347");
  assert.equal(result.targetDispositions[0].recommendation, "KEEP_TARGET_NATIVE");
  assert.equal(result.plannedTargetPayloads.every((payload) => payload.send === false && payload.sync_variants.every((item) => item.migration_availability === "ACTIVE" && Number.isInteger(item.variant_id))), true);
});
