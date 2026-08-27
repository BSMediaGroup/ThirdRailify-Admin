import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { cadMinorUnits, parsePublishedProductSitemap, parseSitemapIndex, projectLiveWixProduct } from "../functions/_shared/live-wix-census.js";

test("live Wix sitemap parsers discover and bound product pages", () => {
  const index = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.thirdrailify.com/store-products-sitemap.xml</loc></sitemap><sitemap><loc>https://www.thirdrailify.com/pages-sitemap.xml</loc></sitemap></sitemapindex>`;
  assert.deepEqual(parseSitemapIndex(index), ["https://www.thirdrailify.com/store-products-sitemap.xml", "https://www.thirdrailify.com/pages-sitemap.xml"]);
  const products = `<urlset><url><loc>https://www.thirdrailify.com/product-page/test-shirt</loc><lastmod>2026-08-28</lastmod><image:image><image:loc>https://static.wixstatic.com/test.png?a=1&amp;b=2</image:loc></image:image></url><url><loc>https://evil.example/product-page/nope</loc></url></urlset>`;
  assert.deepEqual(parsePublishedProductSitemap(products), [{ canonicalUrl: "https://www.thirdrailify.com/product-page/test-shirt", slug: "test-shirt", lastModified: "2026-08-28", sitemapImages: ["https://static.wixstatic.com/test.png?a=1&b=2"] }]);
});

test("public product projection keeps Wix identity and exact integer CAD cents", () => {
  const entry = { canonicalUrl: "https://www.thirdrailify.com/product-page/test-shirt", slug: "test-shirt", lastModified: "2026-08-28", sitemapImages: [] };
  const result = projectLiveWixProduct(entry, { id: "wix-id", name: "Test Shirt", urlPart: "test-shirt", price: 30.5, formattedPrice: "C$30.50", currency: "CAD", isVisible: true, isInStock: true, productType: "physical", options: [{ title: "Size", optionType: "DROP_DOWN", selections: [{ value: "M", description: "M" }] }], media: [{ fullUrl: "https://static.wixstatic.com/test.png" }], categories: [{ name: "Apparel" }], productItems: [{ id: "variant-id", sku: "SKU", price: 30.5, isVisible: true, inventory: { status: "in_stock" }, optionsSelections: [1] }] });
  assert.equal(result.wixExternalProductId, "wix-id");
  assert.equal(result.visibleUnitAmountCad, 3050);
  assert.equal(result.classification, "PHYSICAL_PRODUCT_REQUIRES_RECONCILIATION");
  assert.deepEqual(result.optionLabels, ["Size"]);
  assert.equal(cadMinorUnits(12.345), null);
});

test("captured live census is complete, public GET-only, and token-free", async () => {
  const text = await readFile(new URL("../commerce-import/live/live-wix-published.snapshot.json", import.meta.url), "utf8");
  const snapshot = JSON.parse(text);
  assert.equal(snapshot.counts.publishedProducts, 49);
  assert.equal(snapshot.products.length, 49);
  assert.equal(snapshot.source.evidenceMode, "PUBLIC_GET_ONLY");
  assert.equal(snapshot.source.requestMethod, "GET");
  assert.equal(snapshot.source.requestSummary.public_product_by_slug, 49);
  assert.equal(snapshot.source.anonymousTokenPersisted, false);
  assert.doesNotMatch(text, /accessToken|svSession|customer|authorization/i);
  assert.equal(new Set(snapshot.products.map((product) => product.id)).size, 49);
  assert.equal(new Set(snapshot.products.map((product) => product.canonicalUrl)).size, 49);
});
