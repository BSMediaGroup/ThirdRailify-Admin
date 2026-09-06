import test from "node:test";
import assert from "node:assert/strict";
import { createCommerceDatabases, commerceEnvironment, insertTestProduct, insertTestVariant } from "./commerce-test-helpers.mjs";
import { updateMerchandisingProduct } from "../functions/_shared/commerce-core.js";
import { publicCataloguePayload, publicProductPayload } from "../functions/_shared/public-catalogue.js";
import { authoritativeCartLines } from "../functions/_shared/shipping-core.js";

test("sale restrictions persist independently of visibility and block every new cart authority path", async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose);
  const db = h.commerceDb, env = commerceEnvironment(h), actor = { accountId: "fixture-admin" };
  await insertTestProduct(db, { targetPrintfulProductId: "9001", migrationStatus: "target_verified" });
  await insertTestVariant(db, { targetPrintfulProductId: "9001", targetPrintfulSyncVariantId: "7001", targetCatalogueVariantId: "11576", migrationStatus: "target_verified" });
  const input = { title: "Competition trophy", slug: "competition-trophy", description: "Prize fixture", primaryImageUrl: "https://example.test/trophy.png", additionalImages: [], categories: [], tags: [], featured: false, visibility: "public", status: "active", displayOrder: 10, maxQuantity: 5, unitAmount: 2500, currencyCode: "CAD" };
  const items = [{ productId: "product-test-001", variantId: "variant-test-001", quantity: 1 }];
  const before = await db.prepare("SELECT * FROM commerce_product_variants").all();
  for (const reason of ["competition_prize", "display_only"]) {
    const saved = await updateMerchandisingProduct(env, actor, "product-test-001", { ...input, saleRestriction: { enabled: true, reason } });
    assert.deepEqual(saved.product.saleRestriction, { enabled: true, reason });
    assert.equal(saved.product.readiness.checkout, false);
    const detail = (await publicProductPayload(env, input.slug)).product;
    assert.deepEqual(detail.saleRestriction, { enabled: true, reason });
    assert.equal(detail.available, true);
    assert.equal((await publicCataloguePayload(env)).products.length, 1);
    for (const gate of ["normal", "shipping_quote", "controlled_test"]) await assert.rejects(authoritativeCartLines(db, items, { gate }), error => error.code === "checkout_product_not_for_sale");
    await updateMerchandisingProduct(env, actor, "product-test-001", { ...input, visibility: "private" });
    assert.equal((await publicCataloguePayload(env)).products.length, 0);
    const republished = await updateMerchandisingProduct(env, actor, "product-test-001", input);
    assert.deepEqual(republished.product.saleRestriction, { enabled: true, reason });
  }
  await assert.rejects(updateMerchandisingProduct(env, actor, "product-test-001", { ...input, saleRestriction: { enabled: "true", reason: "competition_prize" } }), error => error.code === "commerce_sale_restriction_invalid");
  await updateMerchandisingProduct(env, actor, "product-test-001", { ...input, saleRestriction: { enabled: false, reason: "display_only" } });
  assert.equal((await authoritativeCartLines(db, items)).length, 1);
  assert.deepEqual((await db.prepare("SELECT * FROM commerce_product_variants").all()).results, before.results);
});
