import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { reconcileCatalogues } from "../scripts/catalogue-reconciliation-core.mjs";
import { PUBLIC_WIX_CATALOGUE } from "../functions/_shared/public-wix-catalogue.js";

function variant(overrides = {}) {
  return { id: "sv-1", externalId: "wv-1", catalogueVariantId: "4011", sku: "SKU-1", size: "M", color: "Black", retailPrice: "29.99", unitAmountCad: 2999, price: { status: "valid", value: "29.99", minorUnits: 2999 }, files: [{ id: "f-1", type: "front", url: "https://example.test/art.png", filename: "art.png", options: [] }], options: [], ...overrides };
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
  assert.deepEqual(result.duplicateEvidence.sourceSkus, [{ value: "SKU-1", count: 2 }]);
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
