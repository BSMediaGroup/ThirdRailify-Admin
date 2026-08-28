import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertMigrationScopes,
  assertNoSourceFileIds,
  buildTargetCreatePayload,
  normalizeOAuthScopes,
  normalizeSourceFile,
  normalizeSourceVariantFile,
  permanentMigrationPayload,
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

test("Sync Variant file resolution matches the exact legacy file ID and accepts only its original HTTPS url", () => {
  const expected = { sourceFileId: "876425703", expectedFilename: "WMCOL.png", legacySyncVariantId: "4974393098", legacySyncProductId: "393219932", catalogueVariantId: "7854" };
  const payload = { code: 200, result: { sync_variant: { id: 4974393098, sync_product_id: 393219932, variant_id: 7854, files: [
    { id: 111, type: "preview", url: "https://source.example.test/preview.png", filename: "preview.png" },
    { id: 876425703, type: "back", url: "https://source.example.test/WMCOL.png", filename: "WMCOL.png", preview_url: "https://source.example.test/not-used-preview.png", thumbnail_url: "https://source.example.test/not-used-thumb.png" },
  ] } } };
  assert.deepEqual(normalizeSourceVariantFile(payload, expected), {
    id: "876425703", url: "https://source.example.test/WMCOL.png", filename: "WMCOL.png", status: "ok",
    metadata: { resolvedVia: "sync_variant", legacySyncVariantId: "4974393098", fileType: "back" },
  });
  assert.equal(normalizeSourceVariantFile({ code: 200, result: { sync_variant: { ...payload.result.sync_variant, files: [{ id: 876425703, type: "back", url: "http://source.example.test/WMCOL.png", preview_url: "https://source.example.test/preview.png", thumbnail_url: "https://source.example.test/thumb.png" }] } } }, expected), null);
  assert.equal(normalizeSourceVariantFile({ code: 200, result: { sync_variant: { ...payload.result.sync_variant, files: [{ id: 999, type: "back", url: "https://source.example.test/WMCOL.png" }] } } }, expected), null);
  assert.throws(() => normalizeSourceVariantFile({ code: 200, result: { sync_variant: { ...payload.result.sync_variant, sync_product_id: 1 } } }, expected), (error) => error.code === "printful_source_variant_file_product_conflict");
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
  let variant419 = true;
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
    const variantMatch = /\/sync\/variant\/(\d+)$/.exec(url);
    if (variantMatch) {
      if (variant419) { variant419 = false; return json({ code: 419 }, 419, { "Retry-After": "0" }); }
      const variant = sourceSnapshot.products.flatMap((product) => product.variants).find((item) => item.id === variantMatch[1]);
      return json(sourceVariantResponse(variant));
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
  assert.equal(scope429, false); assert.equal(variant419, false);
  const sourceCalls = calls.filter((call) => call.authorization === "Bearer source-token");
  assert.equal(sourceCalls.every((call) => call.method === "GET"), true, "the Wix source credential is GET-only");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.find((call) => call.method === "POST").url, "https://api.printful.com/store/products");
  assert.equal(targetPayload.sync_variants.every((variant) => variant.files.every((file) => !Object.hasOwn(file, "id") && file.type !== "preview" && file.url.startsWith("https://"))), true);
  const dadHat = targetPayload.sync_product.external_id === "trf-source-product-393219932" ? targetPayload : null;
  assert.ok(dadHat, "the deterministic first product is the blocked Dad hat checkpoint product");
  assert.deepEqual(dadHat.sync_variants[0].files.filter((file) => file.url.endsWith("/876425703.png")).map((file) => file.type), ["back", "embroidery_front_large"]);
  assert.equal(dadHat.sync_variants.every((variant) => variant.files.filter((file) => file.url.endsWith("/876425703.png")).length === 2), true);
  assert.equal(calls.filter((call) => /\/sync\/variant\/4974393098$/.test(call.url) && call.authorization === "Bearer source-token" && call.method === "GET").length, 4, "one paced retry plus one successful representative lookup per unique file");
  assert.equal(calls.some((call) => /\/files\//.test(call.url)), false, "File Library is not used when Sync Variant detail resolves artwork");
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

test("artwork resolver uses a bounded alternate representative before the File Library fallback", async (t) => {
  const fixture = await resolverFixture(t);
  const calls = [];
  const fetchImpl = sourceResolverFetch(fixture.sourceSnapshot, calls, {
    variantUrl: (variant, file) => variant.id === "4974393098" && file.id === "876425703" ? null : `https://source.example.test/${file.id}.png`,
  });
  await runUntil(fixture.env, fetchImpl, async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_url FROM commerce_printful_file_mappings WHERE source_file_id = '876425703'").first()));
  assert.deepEqual(calls.filter((call) => /\/sync\/variant\//.test(call.url)).map((call) => new URL(call.url).pathname), ["/sync/variant/4974393098", "/sync/variant/4974393099"]);
  assert.equal(calls.some((call) => /\/files\/876425703$/.test(call.url)), false);
  assert.equal(calls.filter((call) => /\/sync\/variant\//.test(call.url)).every((call) => call.authorization === "Bearer source-token" && call.method === "GET"), true);
});

test("File Library is a secondary fallback only when all bounded Sync Variant representatives lack the original URL", async (t) => {
  const fixture = await resolverFixture(t);
  const calls = [];
  const fetchImpl = sourceResolverFetch(fixture.sourceSnapshot, calls, {
    variantUrl: (_variant, file) => file.id === "876425703" ? null : `https://source.example.test/${file.id}.png`,
    fileUrl: (fileId) => `https://source.example.test/fallback-${fileId}.png`,
  });
  await runUntil(fixture.env, fetchImpl, async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_url FROM commerce_printful_file_mappings WHERE source_file_id = '876425703'").first()));
  assert.deepEqual(calls.filter((call) => /\/sync\/variant\//.test(call.url)).map((call) => new URL(call.url).pathname), ["/sync/variant/4974393098", "/sync/variant/4974393099", "/sync/variant/4974393100"]);
  assert.equal(calls.filter((call) => /\/files\/876425703$/.test(call.url)).length, 1);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT source_url FROM commerce_printful_file_mappings WHERE source_file_id = '876425703'").first()).source_url, "https://source.example.test/fallback-876425703.png");
});

test("true missing artwork blocks before target POST and the same checkpoint resumes without resetting counts", async (t) => {
  const fixture = await resolverFixture(t);
  const failedCalls = [];
  const unavailable = sourceResolverFetch(fixture.sourceSnapshot, failedCalls, {
    variantUrl: () => null,
    fileUrl: () => null,
  });
  const blocked = await runUntil(fixture.env, unavailable, async (payload) => payload?.migration.status === "blocked");
  assert.equal(blocked.migration.id, "permanent-printful-2026-08");
  assert.equal(blocked.migration.currentProduct.id, "product-393219932");
  assert.equal(blocked.migration.lastError.code, "printful_source_file_url_unavailable");
  assert.equal(blocked.migration.canResume, true);
  assert.equal(blocked.migration.checkpointState, "checkpointed_resumable");
  assert.equal(blocked.migration.productsCreated, 0);
  assert.equal(blocked.migration.productsAdopted, 0);
  assert.equal(blocked.migration.completedProducts, 0);
  assert.equal(blocked.migration.variantsMapped, 0);
  assert.equal(failedCalls.some((call) => call.method === "POST"), false);
  assert.deepEqual(failedCalls.filter((call) => /\/sync\/variant\//.test(call.url)).map((call) => new URL(call.url).pathname), ["/sync/variant/4974393098", "/sync/variant/4974393099", "/sync/variant/4974393100"]);
  assert.equal(failedCalls.filter((call) => /\/files\/876425703$/.test(call.url)).length, 1);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT COUNT(*) AS total FROM commerce_catalogue_migrations").first()).total, 1);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT COUNT(*) AS total FROM commerce_printful_file_mappings WHERE source_file_id = '876425703'").first()).total, 0);

  const resumedCalls = [];
  const recovered = sourceResolverFetch(fixture.sourceSnapshot, resumedCalls);
  const resumed = await runUntil(fixture.env, recovered, async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_url FROM commerce_printful_file_mappings WHERE source_file_id = '876425703'").first()));
  assert.equal(resumed.migration.id, blocked.migration.id);
  assert.equal(resumed.migration.currentProduct.id, blocked.migration.currentProduct.id);
  assert.equal(resumed.migration.productsCreated, blocked.migration.productsCreated);
  assert.equal(resumed.migration.productsAdopted, blocked.migration.productsAdopted);
  assert.equal(resumed.migration.completedProducts, blocked.migration.completedProducts);
  assert.equal(resumed.migration.variantsMapped, blocked.migration.variantsMapped);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT COUNT(*) AS total FROM commerce_catalogue_migrations").first()).total, 1);
  assert.equal(resumedCalls.filter((call) => /\/sync\/variant\/4974393098$/.test(call.url)).length, 1);
  assert.equal(resumedCalls.some((call) => call.method === "POST"), false);
  const settings = await fixture.harness.commerceDb.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled','live_payment_capture_enabled','fulfillment_submission_enabled') ORDER BY setting_key").all();
  assert.equal(settings.results.every((row) => row.value_json === "false"), true);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT COUNT(*) AS total FROM commerce_orders").first()).total, 0);
});

test("the deployed legacy blocked error code resumes in place and preserves nonzero checkpoint counters", async (t) => {
  const fixture = await resolverFixture(t);
  const state = { preflightStep: "complete", sourceVerified: true, targetVerified: true, lastError: { code: "printful_source_file_original_url_missing", message: "Source file 876425703 does not expose a usable original HTTPS URL.", at: "2026-08-28T00:00:00.000Z" } };
  await fixture.harness.commerceDb.batch([
    fixture.harness.commerceDb.prepare("UPDATE commerce_catalogue_migrations SET status='blocked',phase='blocked',current_product_id='product-393219932',products_created=20,products_adopted=16,products_verified=36,variants_mapped=900,provider_failures=1,safe_state_json=? WHERE id='permanent-printful-2026-08'").bind(JSON.stringify(state)),
    fixture.harness.commerceDb.prepare("UPDATE commerce_products SET migration_status='blocked',status='error' WHERE id='product-393219932'"),
  ]);
  const before = await permanentMigrationPayload(fixture.env);
  assert.equal(before.migration.canResume, true);
  const calls = [];
  const resumed = await runUntil(fixture.env, sourceResolverFetch(fixture.sourceSnapshot, calls), async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_url FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first()));
  assert.equal(resumed.migration.id, before.migration.id);
  assert.equal(resumed.migration.completedProducts, 36);
  assert.equal(resumed.migration.productsCreated, 20);
  assert.equal(resumed.migration.productsAdopted, 16);
  assert.equal(resumed.migration.variantsMapped, 900);
  assert.equal(resumed.migration.providerFailures, 1);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT COUNT(*) AS total FROM commerce_catalogue_migrations").first()).total, 1);
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
  assert.match(page, /RESUME PERMANENT PRINTFUL CATALOGUE MIGRATION/);
});

async function resolverFixture(t) {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await importPermanentCatalogue(harness.commerceDb, JSON.parse(await readFile(importUrl, "utf8")));
  return {
    harness,
    sourceSnapshot: JSON.parse(await readFile(sourceUrl, "utf8")),
    env: commerceEnvironment(harness, { PRINTFUL_API_TOKEN: "target-token", PRINTFUL_WIX_SOURCE_TOKEN: "source-token", PRINTFUL_STORE_ID: "18668025", PRINTFUL_WIX_SOURCE_STORE_ID: "16847493" }),
  };
}

async function runUntil(env, fetchImpl, predicate) {
  let fakeNow = Date.parse("2026-08-28T00:00:00.000Z");
  let payload = null;
  for (let step = 0; step < 40; step += 1) {
    fakeNow += 10_000;
    payload = await runPermanentPrintfulMigrationStep(env, { accountId: "master" }, fetchImpl, { now: () => fakeNow });
    if (await predicate(payload)) return payload;
  }
  throw new Error("Migration fixture did not reach the expected state.");
}

function sourceResolverFetch(sourceSnapshot, calls, options = {}) {
  return async (input, init = {}) => {
    const url = String(input); const method = init.method || "GET"; const authorization = new Headers(init.headers).get("Authorization");
    calls.push({ url, method, authorization, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/stores")) {
      const target = authorization === "Bearer target-token";
      return json({ code: 200, result: [{ id: target ? 18668025 : 16847493, name: target ? "Third Railify API" : "Third Railify Official", type: target ? "native" : "wix" }], paging: { total: 1 } });
    }
    if (url.endsWith("/v2/oauth-scopes")) return json({ data: ["sync_products/write", "files/write", "orders/write", "webhooks/write"].map((value) => ({ value })) });
    const productMatch = /\/sync\/products\/(\d+)$/.exec(url);
    if (productMatch) return json(sourceProductResponse(sourceSnapshot.products.find((product) => product.id === productMatch[1])));
    const variantMatch = /\/sync\/variant\/(\d+)$/.exec(url);
    if (variantMatch) {
      const variant = sourceSnapshot.products.flatMap((product) => product.variants).find((item) => item.id === variantMatch[1]);
      return json(sourceVariantResponse(variant, (file) => options.variantUrl ? options.variantUrl(variant, file) : `https://source.example.test/${file.id}.png`));
    }
    const fileMatch = /\/files\/(\d+)$/.exec(url);
    if (fileMatch) return json({ code: 200, result: { id: Number(fileMatch[1]), status: "ok", url: options.fileUrl ? options.fileUrl(fileMatch[1]) : null, filename: `${fileMatch[1]}.png` } });
    if (url.includes("/store/products/@")) return json({ code: 404, result: null }, 404);
    throw new Error(`Unexpected provider request ${method} ${url}`);
  };
}

function sourceProductResponse(product) {
  return { code: 200, result: {
    sync_product: { id: Number(product.id), external_id: product.externalId, name: product.name, variants: product.variants.length, synced: product.variants.length },
    sync_variants: product.variants.map((variant) => ({ id: Number(variant.id), external_id: variant.externalId, sync_product_id: Number(product.id), name: variant.name, synced: variant.synced, variant_id: Number(variant.catalogueVariantId), retail_price: variant.retailPrice, sku: variant.sku, files: variant.files.map((file) => ({ id: Number(file.id), type: file.type, filename: file.filename, status: file.status, options: file.options })) })),
  } };
}

function sourceVariantResponse(variant, urlForFile = (file) => `https://source.example.test/${file.id}.png`) {
  return { code: 200, result: { sync_variant: {
    id: Number(variant.id), sync_product_id: Number(variant.syncProductId), variant_id: Number(variant.catalogueVariantId),
    files: variant.files.map((file) => ({ id: Number(file.id), type: file.type, url: file.type === "preview" ? null : urlForFile(file), filename: file.filename, options: file.options })),
  } } };
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
