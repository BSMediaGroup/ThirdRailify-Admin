import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertMigrationScopes,
  assertNoSourceFileIds,
  buildTargetCreatePayload,
  normalizeOAuthScopes,
  normalizeSourceFile,
  runPermanentPrintfulMigrationStep,
  validateSourceProduct,
  validateTargetProduct,
} from "../functions/_shared/printful-migration.js";
import { commerceEnvironment, createCommerceDatabases, importPermanentCatalogue } from "./commerce-test-helpers.mjs";

const importUrl = new URL("../commerce-import/permanent-catalogue-import.json", import.meta.url);
const sourceUrl = new URL("../commerce-import/live/printful-wix-source.snapshot.json", import.meta.url);

test("OAuth scope verification accepts documented write values and blocks missing product authority", () => {
  const scopes = normalizeOAuthScopes({ data: ["sync_products/write", "files/write", "orders/write", "webhooks/write"].map((value) => ({ value })) });
  assert.deepEqual(assertMigrationScopes(scopes), { products: true, files: true, orders: true, webhooks: true });
  assert.throws(() => assertMigrationScopes(["files/write", "orders/write", "webhooks/write"]), (error) => error.code === "printful_product_write_scope_missing");
  assert.throws(() => assertMigrationScopes(["sync_products/write", "files/write"]), (error) => error.code === "printful_expected_manage_scopes_missing");
});

test("source file resolution requires the original HTTPS URL and bounded acceptable metadata", () => {
  const file = normalizeSourceFile({ code: 200, result: { id: 10, status: "ok", url: "https://source.example.test/art.pdf", filename: "art.pdf", size: 1000, width: 100, height: 100, dpi: 300 } }, "10", "art.pdf");
  assert.equal(file.url, "https://source.example.test/art.pdf");
  assert.throws(() => normalizeSourceFile({ code: 200, result: { id: 10, status: "ok", url: null, preview_url: "https://source.example.test/preview.png", filename: "art.pdf" } }, "10", "art.pdf"), (error) => error.code === "printful_source_file_original_url_missing");
  assert.throws(() => normalizeSourceFile({ code: 200, result: { id: 10, status: "ok", url: "http://source.example.test/art.pdf", filename: "art.pdf" } }, "10", "art.pdf"), (error) => error.code === "printful_source_file_original_url_missing");
});

test("target payloads contain URL-based non-preview files, deterministic identities, and enforce the 100-variant gate", () => {
  const product = { title: "Selected", target_printful_external_id: "trf-source-product-1", safe_metadata_json: '{"targetThumbnail":"https://example.test/thumb.png"}' };
  const variant = { target_printful_external_id: "trf-source-variant-2", target_catalogue_variant_id: "11576", unit_amount: 1250, sku: null, files: [{ type: "front", url: "https://example.test/art.pdf", filename: "art.pdf", options: [] }], targetOptions: [] };
  const payload = buildTargetCreatePayload(product, [variant]);
  assert.equal(payload.sync_product.external_id, "trf-source-product-1");
  assert.equal(payload.sync_variants[0].external_id, "trf-source-variant-2");
  assert.equal(payload.sync_variants[0].retail_price, "12.50");
  assert.equal(Object.hasOwn(payload.sync_variants[0].files[0], "id"), false);
  assert.equal(assertNoSourceFileIds(payload), true);
  assert.throws(() => buildTargetCreatePayload(product, Array.from({ length: 101 }, () => variant)), (error) => error.code === "printful_target_payload_variant_count_invalid");
  assert.throws(() => assertNoSourceFileIds({ sync_variants: [{ files: [{ id: 9, type: "front", url: "https://example.test/art.pdf" }] }] }), (error) => error.code === "printful_cross_store_file_payload_invalid");
});

test("source validation blocks active fileless, price, catalogue, and artwork conflicts while ignoring unselected variants", () => {
  const product = { title: "Fixture", legacy_printful_source_product_id: "1" };
  const expected = [{ migration_status: "selected", legacy_source_variant_id: "2", target_catalogue_variant_id: "3", unit_amount: 1200, file_mapping_json: '[{"sourceFileId":"4","type":"front"}]' }];
  const valid = { syncProduct: { id: 1 }, syncVariants: [{ id: 2, variant_id: 3, retail_price: "12.00", files: [{ id: 4, type: "front" }] }, { id: 99, variant_id: 99, retail_price: "1.00", files: [] }] };
  assert.doesNotThrow(() => validateSourceProduct(valid, product, expected));
  assert.throws(() => validateSourceProduct({ ...valid, syncVariants: [{ ...valid.syncVariants[0], files: [] }] }, product, expected), (error) => error.code === "printful_source_variant_files_missing");
  assert.throws(() => validateSourceProduct({ ...valid, syncVariants: [{ ...valid.syncVariants[0], retail_price: "13.00" }] }, product, expected), (error) => error.code === "printful_source_variant_price_conflict");
  assert.throws(() => validateSourceProduct({ ...valid, syncVariants: [{ ...valid.syncVariants[0], variant_id: 8 }] }, product, expected), (error) => error.code === "printful_source_variant_identity_conflict");
});

test("target verification fails closed on external-ID, price, catalogue, deferred-variant, and file conflicts", () => {
  const product = { title: "Fixture", target_printful_external_id: "trf-product" };
  const expected = [{ target_printful_external_id: "trf-variant", target_catalogue_variant_id: "3", unit_amount: 1200, files: [{ type: "front", filename: "art.pdf" }] }];
  const valid = { syncProduct: { id: 10, external_id: "trf-product", name: "Fixture" }, syncVariants: [{ id: 20, external_id: "trf-variant", variant_id: 3, retail_price: "12.00", files: [{ id: 30, type: "front", filename: "art.pdf", status: "ok" }] }] };
  assert.deepEqual(validateTargetProduct(valid, product, expected), { processing: false });
  assert.deepEqual(validateTargetProduct({ ...valid, syncVariants: [{ ...valid.syncVariants[0], files: [{ ...valid.syncVariants[0].files[0], status: "waiting" }] }] }, product, expected), { processing: true });
  assert.throws(() => validateTargetProduct({ ...valid, syncProduct: { ...valid.syncProduct, name: "Conflict" } }, product, expected), (error) => error.code === "printful_target_external_id_conflict");
  assert.throws(() => validateTargetProduct({ ...valid, syncVariants: [{ ...valid.syncVariants[0], retail_price: "13.00" }] }, product, expected), (error) => error.code === "printful_target_price_conflict");
  assert.throws(() => validateTargetProduct({ ...valid, syncVariants: [{ ...valid.syncVariants[0], variant_id: 4 }] }, product, expected), (error) => error.code === "printful_target_catalogue_variant_conflict");
  assert.throws(() => validateTargetProduct({ ...valid, syncVariants: [...valid.syncVariants, { ...valid.syncVariants[0], external_id: "deferred" }] }, product, expected), (error) => error.code === "printful_target_variant_count_conflict");
  assert.throws(() => validateTargetProduct({ ...valid, syncVariants: [{ ...valid.syncVariants[0], files: [{ ...valid.syncVariants[0].files[0], filename: "wrong.pdf" }] }] }, product, expected), (error) => error.code === "printful_target_file_placement_conflict");
});

test("durable migration verifies stores/scopes, recovers 429 and 419, creates once, and maps by external ID", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await importPermanentCatalogue(harness.commerceDb, JSON.parse(await readFile(importUrl, "utf8")));
  const sourceSnapshot = JSON.parse(await readFile(sourceUrl, "utf8"));
  const env = commerceEnvironment(harness, {
    PRINTFUL_API_TOKEN: "target-token",
    PRINTFUL_WIX_SOURCE_TOKEN: "source-token",
    PRINTFUL_STORE_ID: "18668025",
    PRINTFUL_WIX_SOURCE_STORE_ID: "16847493",
  });
  const calls = [];
  let targetPayload = null;
  let scope429 = true;
  let file419 = true;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const authorization = new Headers(init.headers).get("Authorization");
    const method = init.method || "GET";
    calls.push({ url, method, authorization, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/stores")) {
      const target = authorization === "Bearer target-token";
      return json({ code: 200, result: [{ id: target ? 18668025 : 16847493, name: target ? "Third Railify API" : "Third Railify Official", type: target ? "native" : "wix" }], paging: { total: 1, offset: 0, limit: 20 } });
    }
    if (url.endsWith("/v2/oauth-scopes")) {
      if (scope429) { scope429 = false; return json({ code: 429 }, 429, { "Retry-After": "0" }); }
      return json({ data: ["sync_products/write", "files/write", "orders/write", "webhooks/write"].map((value) => ({ value })) });
    }
    const productMatch = /\/sync\/products\/(\d+)$/.exec(url);
    if (productMatch) {
      const product = sourceSnapshot.products.find((item) => item.id === productMatch[1]);
      return json(sourceProductResponse(product));
    }
    const fileMatch = /\/files\/(\d+)$/.exec(url);
    if (fileMatch) {
      if (file419) { file419 = false; return json({ code: 419 }, 419, { "Retry-After": "0" }); }
      return json({ code: 200, result: { id: Number(fileMatch[1]), status: "ok", url: `https://source.example.test/${fileMatch[1]}.pdf`, filename: `${fileMatch[1]}.pdf`, size: 1000, width: 100, height: 100, dpi: 300 } });
    }
    if (url.endsWith("/store/products") && method === "POST") {
      assert.equal(authorization, "Bearer target-token");
      targetPayload = JSON.parse(init.body);
      return json({ code: 200, result: { id: 900001, external_id: targetPayload.sync_product.external_id, name: targetPayload.sync_product.name, variants: targetPayload.sync_variants.length, synced: 0 } });
    }
    if (url.includes("/store/products/@")) {
      if (!targetPayload) return json({ code: 404, result: null }, 404);
      return json(targetProductResponse(targetPayload));
    }
    throw new Error(`Unexpected provider request ${method} ${url}`);
  };
  const session = { accountId: "master", account: { adminLevel: "master" } };
  let fakeNow = Date.parse("2026-08-28T00:00:00.000Z");
  let payload;
  for (let step = 0; step < 100; step += 1) {
    fakeNow += 10_000;
    payload = await runPermanentPrintfulMigrationStep(env, session, fetchImpl, { now: () => fakeNow });
    if (payload.migration.completedProducts === 1) break;
  }
  assert.equal(payload.migration.completedProducts, 1);
  assert.equal(payload.migration.productsCreated, 1);
  assert.equal(payload.migration.productsAdopted, 0);
  assert.equal(scope429, false); assert.equal(file419, false);
  const sourceCalls = calls.filter((call) => call.authorization === "Bearer source-token");
  assert.equal(sourceCalls.every((call) => call.method === "GET"), true, "the Wix source credential is GET-only");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.find((call) => call.method === "POST").url, "https://api.printful.com/store/products");
  assert.equal(targetPayload.sync_variants.every((variant) => variant.files.every((file) => !Object.hasOwn(file, "id") && file.type !== "preview" && file.url.startsWith("https://"))), true);
  const migratedProduct = await harness.commerceDb.prepare("SELECT id, target_printful_product_id, migration_status FROM commerce_products WHERE target_printful_product_id = '900001'").first();
  assert.equal(migratedProduct.migration_status, "target_verified");
  const mapped = await harness.commerceDb.prepare("SELECT target_printful_external_id, target_printful_sync_variant_id, fulfillment_mapping_status FROM commerce_product_variants WHERE product_id = ? ORDER BY id").bind(migratedProduct.id).all();
  assert.equal(mapped.results.length, targetPayload.sync_variants.length);
  assert.equal(mapped.results.every((row) => row.fulfillment_mapping_status === "mapped" && /^91\d+$/.test(row.target_printful_sync_variant_id)), true);
  const native = await harness.commerceDb.prepare("SELECT target_printful_product_id, migration_status FROM commerce_products WHERE id = 'product-target-native-459991347'").first();
  assert.deepEqual(native, { target_printful_product_id: "459991347", migration_status: "target_native" });
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS total FROM commerce_orders").first()).total, 0);
  assert.equal(calls.some((call) => /orders|webhooks/.test(new URL(call.url).pathname)), false);
});

test("permanent migration implementation has no Printful order, webhook, source write, or browser token path", async () => {
  const [migration, client, page] = await Promise.all([
    readFile(new URL("../functions/_shared/printful-migration.js", import.meta.url), "utf8"),
    readFile(new URL("../src/commerce/client.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/CommercePages.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(migration, /api\.printful\.com\/(?:orders|webhooks)/);
  assert.doesNotMatch(`${client}\n${page}`, /PRINTFUL_(?:API|WIX_SOURCE)_TOKEN|Authorization:\s*`?Bearer/);
  assert.match(page, /EXECUTE PERMANENT PRINTFUL CATALOGUE MIGRATION/);
});

function sourceProductResponse(product) {
  return { code: 200, result: {
    sync_product: { id: Number(product.id), external_id: product.externalId, name: product.name, variants: product.variants.length, synced: product.variants.length },
    sync_variants: product.variants.map((variant) => ({ id: Number(variant.id), external_id: variant.externalId, sync_product_id: Number(product.id), name: variant.name, synced: variant.synced, variant_id: Number(variant.catalogueVariantId), retail_price: variant.retailPrice, sku: variant.sku, files: variant.files.map((file) => ({ id: Number(file.id), type: file.type, filename: file.filename, status: file.status, options: file.options })) })),
  } };
}

function targetProductResponse(payload) {
  return { code: 200, result: {
    sync_product: { id: 900001, external_id: payload.sync_product.external_id, name: payload.sync_product.name, variants: payload.sync_variants.length, synced: payload.sync_variants.length },
    sync_variants: payload.sync_variants.map((variant, index) => ({ id: 910000 + index, external_id: variant.external_id, sync_product_id: 900001, variant_id: variant.variant_id, retail_price: variant.retail_price, sku: variant.sku, synced: true, files: variant.files.map((file, fileIndex) => ({ id: 920000 + index * 10 + fileIndex, ...file, status: "ok" })) })),
  } };
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}
