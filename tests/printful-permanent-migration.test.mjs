import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertMigrationScopes,
  assertPermanentCatalogueAuthority,
  assertNoSourceFileIds,
  buildTargetCreatePayload,
  derivativeFilename,
  inspectSourceVariantFile,
  normalizeOAuthScopes,
  normalizeSourceFile,
  normalizeSourceVariantFile,
  permanentMigrationPayload,
  resumeManuallyPausedPermanentPrintfulMigration,
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

test("target payloads accept one validated URL or target File ID, deterministic identities, and enforce the 100-variant gate", () => {
  const product = { title: "Selected", target_printful_external_id: "trf-source-product-1", safe_metadata_json: '{"targetThumbnail":"https://example.test/thumb.png"}' };
  const variant = { target_printful_external_id: "trf-source-variant-2", target_catalogue_variant_id: "11576", unit_amount: 1250, sku: null, files: [{ type: "front", url: "https://example.test/art.pdf", filename: "art.pdf", options: [] }], targetOptions: [] };
  const payload = buildTargetCreatePayload(product, [variant]);
  assert.equal(payload.sync_product.external_id, "trf-source-product-1");
  assert.equal(payload.sync_variants[0].external_id, "trf-source-variant-2");
  assert.equal(payload.sync_variants[0].retail_price, "12.50");
  assert.equal(Object.hasOwn(payload.sync_variants[0].files[0], "id"), false);
  assert.equal(assertNoSourceFileIds(payload), true);
  const idPayload = buildTargetCreatePayload(product, [{ ...variant, files: [{ type: "front", targetFileId: "876425703", filename: "art.pdf", options: [] }] }]);
  assert.deepEqual(idPayload.sync_variants[0].files[0], { type: "front", id: 876425703 });
  assert.equal(assertNoSourceFileIds(idPayload), true);
  assert.throws(() => buildTargetCreatePayload(product, Array.from({ length: 101 }, () => variant)), (error) => error.code === "printful_target_payload_variant_count_invalid");
  assert.throws(() => assertNoSourceFileIds({ sync_variants: [{ files: [{ id: 9, type: "front", url: "https://example.test/art.pdf" }] }] }), (error) => error.code === "printful_cross_store_file_payload_invalid");
});

test("Printful preview derivatives use their actual image type and mockup preview entries are never artwork", () => {
  assert.equal(derivativeFilename("892781392", "https://files.cdn.printful.com/files/abc/abc_preview.png", "application/pdf"), "trf-migrated-892781392.png");
  const expected = { sourceFileId: "876425703", expectedFilename: "WMCOL.png", legacySyncVariantId: "4974393098", legacySyncProductId: "393219932", catalogueVariantId: "7854" };
  const inspected = inspectSourceVariantFile({ code: 200, result: { sync_variant: {
    id: 4974393098, sync_product_id: 393219932, variant_id: 7854,
    files: [{ id: 876425703, type: "preview", filename: "WMCOL.png", status: "ok", preview_url: "https://files.cdn.printful.com/files/abc/abc_preview.png" }],
  } } }, expected);
  assert.deepEqual(inspected, { file: null, candidate: null });
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
  const rehydrated = [{ ...expected[0], files: [
    { type: "embroidery_front_large", filename: "trf-migrated-10.png", targetFileId: "101" },
    { type: "embroidery_back", filename: "trf-migrated-10.png", targetFileId: "101" },
  ] }];
  const canonicalized = { ...valid, syncVariants: [{ ...valid.syncVariants[0], files: [
    { id: 101, type: "embroidery_front_large", filename: "trf-migrated-10.png", status: "ok" },
    { id: 101, type: "back", filename: "trf-migrated-10.png", status: "ok" },
  ] }] };
  assert.deepEqual(validateTargetProduct(canonicalized, product, rehydrated), { processing: false }, "Printful's returned embroidery placement aliases retain exact target File IDs");
  assert.throws(() => validateTargetProduct({ ...canonicalized, syncVariants: [{ ...canonicalized.syncVariants[0], files: canonicalized.syncVariants[0].files.map((file) => ({ ...file, id: 102 })) }] }, product, rehydrated), (error) => error.code === "printful_target_file_placement_conflict");
});

test("an explicit continuation clears only the durable manual pause gate and preserves migration counters", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await importPermanentCatalogue(harness.commerceDb, JSON.parse(await readFile(importUrl, "utf8")));
  await harness.commerceDb.prepare(`UPDATE commerce_catalogue_migrations SET status='waiting', phase='source_files',
    products_created=7, products_verified=7, variants_mapped=174, provider_failures=14,
    next_provider_request_at=4102444800000, throttle_until=4102444800000,
    safe_state_json=json_set(safe_state_json,'$.manualPause',json('true'),'$.manualPauseReason','fixture')
    WHERE id='permanent-printful-2026-08'`).run();
  const env = commerceEnvironment(harness);
  const paused = await permanentMigrationPayload(env);
  assert.equal(paused.migration.manuallyPaused, true);
  assert.equal(paused.migration.providerState, "paused");
  assert.equal(paused.migration.retryAt, null);
  assert.equal(await resumeManuallyPausedPermanentPrintfulMigration(env), true);
  const job = await harness.commerceDb.prepare("SELECT status,products_created,products_verified,variants_mapped,provider_failures,next_provider_request_at,throttle_until,safe_state_json FROM commerce_catalogue_migrations WHERE id='permanent-printful-2026-08'").first();
  assert.deepEqual({ status: job.status, productsCreated: job.products_created, productsVerified: job.products_verified, variantsMapped: job.variants_mapped, providerFailures: job.provider_failures, next: job.next_provider_request_at, throttle: job.throttle_until }, { status: "running", productsCreated: 7, productsVerified: 7, variantsMapped: 174, providerFailures: 14, next: null, throttle: null });
  assert.equal(JSON.parse(job.safe_state_json).manualPause, undefined);
  assert.equal(await resumeManuallyPausedPermanentPrintfulMigration(env), false);
});

test("permanent product migration admits only the exact sandbox acceptance evidence and fails closed on every live-commerce authority", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  await importPermanentCatalogue(harness.commerceDb, JSON.parse(await readFile(importUrl, "utf8")));
  const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: "target-token", PRINTFUL_WIX_SOURCE_TOKEN: "source-token", PRINTFUL_STORE_ID: "18668025", PRINTFUL_WIX_SOURCE_STORE_ID: "16847493" });
  const assertSafe = () => assertPermanentCatalogueAuthority(harness.commerceDb, env);
  await harness.commerceDb.prepare(`INSERT INTO commerce_orders
    (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,stripe_checkout_session_id,
     environment,checkout_status,created_at,updated_at)
    VALUES ('ord_e47b94a4-4252-438b-8ca7-c47470029940','paid','disabled','CAD',1500,
      'cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC','test','checkout_created','now','now')`).run();
  await assert.doesNotReject(assertSafe, "the exact non-fulfillable Stripe TEST acceptance row is evidence, not order-write authority");

  for (const setting of ["checkout_enabled", "live_payment_capture_enabled", "fulfillment_submission_enabled"]) {
    await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key=?").bind(setting).run();
    await assert.rejects(assertSafe, (error) => error.code === "commerce_migration_safety_gate_open", `${setting}=true must reject`);
    await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='false' WHERE setting_key=?").bind(setting).run();
  }
  await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='null' WHERE setting_key='checkout_enabled'").run();
  await assert.rejects(assertSafe, (error) => error.code === "commerce_migration_safety_gate_open", "an ambiguous checkout value must reject");
  await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='false' WHERE setting_key='checkout_enabled'").run();
  await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='\"live\"' WHERE setting_key='printful_order_mode'").run();
  await assert.rejects(assertSafe, (error) => error.code === "commerce_migration_safety_gate_open", "live Printful order mode must reject");
  await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='\"draft_only\"' WHERE setting_key='printful_order_mode'").run();

  const providers = await harness.commerceDb.prepare("SELECT provider,safe_metadata_json FROM commerce_provider_connections WHERE provider IN ('stripe','printful','wix')").all();
  const original = Object.fromEntries(providers.results.map((row) => [row.provider, row.safe_metadata_json]));
  for (const [provider, mutation] of [
    ["stripe", (value) => ({ ...value, checkout_enabled: true })],
    ["stripe", (value) => { const next = { ...value }; delete next.live_payments_enabled; return next; }],
    ["printful", (value) => ({ ...value, fulfillment_enabled: true })],
    ["printful", (value) => ({ ...value, mode: "live" })],
    ["wix", (value) => ({ ...value, must_remain_untouched: false })],
  ]) {
    await harness.commerceDb.prepare("UPDATE commerce_provider_connections SET safe_metadata_json=? WHERE provider=?").bind(JSON.stringify(mutation(JSON.parse(original[provider]))), provider).run();
    await assert.rejects(assertSafe, (error) => error.code === "commerce_migration_safety_gate_open", `${provider} unsafe or ambiguous metadata must reject`);
    await harness.commerceDb.prepare("UPDATE commerce_provider_connections SET safe_metadata_json=? WHERE provider=?").bind(original[provider], provider).run();
  }

  await harness.commerceDb.prepare(`INSERT INTO commerce_orders (id,environment,created_at,updated_at)
    VALUES ('ord_live_must_block','live','now','now')`).run();
  await assert.rejects(assertSafe, (error) => error.code === "commerce_migration_safety_gate_open", "any non-acceptance order row must reject");
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
      return json({ code: 404, result: null }, 404);
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
  assert.equal(payload.migration.completedProducts, 1, JSON.stringify(payload));
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
  assert.deepEqual(dadHat.sync_variants[0].files.filter((file) => file.url.endsWith("/876425703.png")).map((file) => file.type), ["embroidery_back", "embroidery_front_large"]);
  assert.equal(dadHat.sync_variants.every((variant) => variant.files.filter((file) => file.url.endsWith("/876425703.png")).length === 2), true);
  assert.equal(dadHat.sync_variants.every((variant) => variant.files.every((file) => file.options?.some((option) => option.id === "auto_thread_color" && option.value === true))), true, "embroidery files use Printful's documented automatic thread-color option");
  assert.equal(calls.filter((call) => /\/sync\/variant\/4974393098$/.test(call.url) && call.authorization === "Bearer source-token" && call.method === "GET").length, 4, "one paced retry plus one successful representative lookup per unique file");
  assert.equal(calls.some((call) => /\/v2\/files\//.test(call.url)), true, "both authorization contexts are probed before Sync Variant fallback");
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

test("target V2 accessibility probe reuses the exact target-accessible File ID", async (t) => {
  const fixture = await resolverFixture(t);
  const calls = [];
  await runUntil(fixture.env, sourceResolverFetch(fixture.sourceSnapshot, calls, { targetExistingV2: true }), async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_file_id FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first()));
  const mapping = await fixture.harness.commerceDb.prepare("SELECT source_url,filename,safe_metadata_json FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first();
  const metadata = JSON.parse(mapping.safe_metadata_json);
  assert.equal(metadata.resolutionMethod, "target_existing_file");
  assert.equal(metadata.targetFileId, "876425703");
  assert.equal(metadata.targetStoreId, "18668025");
  assert.equal(mapping.filename, "WMCOL.png");
  assert.equal(calls.filter((call) => /\/v2\/files\/876425703$/.test(call.url) && call.authorization === "Bearer target-token").length, 1);
  assert.equal(calls.some((call) => /\/sync\/variant\//.test(call.url)), false);
});

test("source V2 original URL resolves after target accessibility probes", async (t) => {
  const fixture = await resolverFixture(t);
  const calls = [];
  await runUntil(fixture.env, sourceResolverFetch(fixture.sourceSnapshot, calls, { sourceV2Url: (id) => `https://source.example.test/v2-${id}.png` }), async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_file_id FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first()));
  const mapping = await fixture.harness.commerceDb.prepare("SELECT source_url,safe_metadata_json FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first();
  assert.equal(mapping.source_url, "https://source.example.test/v2-876425703.png");
  assert.equal(JSON.parse(mapping.safe_metadata_json).resolutionMethod, "source_v2_url");
  assert.equal(calls.some((call) => /\/sync\/variant\//.test(call.url)), false);
});

test("Printful preview rehydration creates one hidden target file and persists an idempotent target mapping", async (t) => {
  const fixture = await resolverFixture(t);
  const calls = [];
  const fetchImpl = sourceResolverFetch(fixture.sourceSnapshot, calls, { variantUrl: () => null, fileUrl: () => null, rehydrateTarget: true });
  await runUntil(fixture.env, fetchImpl, async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_file_id FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first()));
  const mapping = await fixture.harness.commerceDb.prepare("SELECT filename,safe_metadata_json FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first();
  const metadata = JSON.parse(mapping.safe_metadata_json);
  assert.equal(mapping.filename, "trf-migrated-876425703.png");
  assert.equal(metadata.resolutionMethod, "printful_preview_rehydrated");
  assert.match(metadata.targetFileId, /^99000\d$/);
  const posts = calls.filter((call) => call.method === "POST" && call.url.endsWith("/files"));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { url: "https://files.cdn.printful.com/files/9ee/9ee850419ca592df54859d99a395e3d7_preview.png", filename: "trf-migrated-876425703.png", visible: false });
  await runPermanentPrintfulMigrationStep(fixture.env, { accountId: "master" }, fetchImpl, { now: () => Date.parse("2026-08-29T00:00:00.000Z") });
  assert.equal(calls.filter((call) => call.method === "POST" && call.url.endsWith("/files")).length, 1);
});

test("target-readable legacy IDs that fail Sync Product creation automatically rehydrate and retry the same product", async (t) => {
  const fixture = await resolverFixture(t);
  const calls = [];
  const fetchImpl = sourceResolverFetch(fixture.sourceSnapshot, calls, {
    targetExistingV2: true,
    rejectTargetIdsOnce: true,
    rehydrateTarget: true,
    variantUrl: () => null,
    fileUrl: () => null,
  });
  const payload = await runUntil(fixture.env, fetchImpl, async (current) => current?.migration.completedProducts === 1, 120);
  assert.equal(payload.migration.productsCreated, 1);
  assert.equal(payload.catalogue.blockedProducts, 0);
  assert.equal(payload.catalogue.fileMappings.targetExisting, 0);
  assert.equal(payload.catalogue.fileMappings.printfulPreviewRehydrated, 3);
  assert.equal(calls.filter((call) => call.method === "POST" && call.url.endsWith("/store/products")).length, 2);
  assert.equal(calls.filter((call) => call.method === "POST" && call.url.endsWith("/files")).length, 3);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT migration_status FROM commerce_products WHERE id='product-393219932'").first()).migration_status, "target_verified");
});

test("exact hosted local artwork is used only with exact filename provenance after provider strategies fail", async (t) => {
  const fixture = await resolverFixture(t);
  fixture.env.PRINTFUL_LOCAL_EXACT_ARTWORK_URLS = JSON.stringify({
    "876425703": { sourceFilename: "WMCOL.png", targetFilename: "WMCOL.png", url: "https://thirdrailify-admin.pages.dev/commerce-migration-artwork/WMCOL.png", sha256: "a".repeat(64) },
  });
  const calls = [];
  await runUntil(fixture.env, sourceResolverFetch(fixture.sourceSnapshot, calls, { variantUrl: () => null, fileUrl: () => null, previewUrl: false }), async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_file_id FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first()));
  const mapping = await fixture.harness.commerceDb.prepare("SELECT source_url,safe_metadata_json FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first();
  assert.equal(mapping.source_url, "https://thirdrailify-admin.pages.dev/commerce-migration-artwork/WMCOL.png");
  assert.equal(JSON.parse(mapping.safe_metadata_json).resolutionMethod, "local_exact_artwork");
});

test("artwork resolver uses a bounded alternate representative before the File Library fallback", async (t) => {
  const fixture = await resolverFixture(t);
  const calls = [];
  const fetchImpl = sourceResolverFetch(fixture.sourceSnapshot, calls, {
    variantUrl: (variant, file) => variant.id === "4974393098" && file.id === "876425703" ? null : `https://source.example.test/${file.id}.png`,
  });
  await runUntil(fixture.env, fetchImpl, async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_url FROM commerce_printful_file_mappings WHERE source_file_id = '876425703'").first()));
  assert.deepEqual(calls.filter((call) => /\/sync\/variant\//.test(call.url)).map((call) => new URL(call.url).pathname), ["/sync/variant/4974393098", "/sync/variant/4974393099"]);
  assert.equal(calls.filter((call) => /\/files\/876425703$/.test(call.url)).length, 4, "target/source v2 and v1 probes precede bounded Sync Variant resolution");
  assert.equal(calls.filter((call) => /\/sync\/variant\//.test(call.url)).every((call) => call.authorization === "Bearer source-token" && call.method === "GET"), true);
});

test("source V1 File Library original URL resolves after target and source V2 probes", async (t) => {
  const fixture = await resolverFixture(t);
  const calls = [];
  const fetchImpl = sourceResolverFetch(fixture.sourceSnapshot, calls, {
    variantUrl: (_variant, file) => file.id === "876425703" ? null : `https://source.example.test/${file.id}.png`,
    fileUrl: (fileId) => `https://source.example.test/fallback-${fileId}.png`,
  });
  await runUntil(fixture.env, fetchImpl, async () => Boolean(await fixture.harness.commerceDb.prepare("SELECT source_url FROM commerce_printful_file_mappings WHERE source_file_id = '876425703'").first()));
  assert.deepEqual(calls.filter((call) => /\/sync\/variant\//.test(call.url)).map((call) => new URL(call.url).pathname), []);
  assert.equal(calls.filter((call) => /\/files\/876425703$/.test(call.url)).length, 4);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT source_url FROM commerce_printful_file_mappings WHERE source_file_id = '876425703'").first()).source_url, "https://source.example.test/fallback-876425703.png");
});

test("impossible artwork blocks only its product and the migration continues to the next product", async (t) => {
  const fixture = await resolverFixture(t);
  const failedCalls = [];
  const unavailable = sourceResolverFetch(fixture.sourceSnapshot, failedCalls, {
    variantUrl: () => null,
    fileUrl: () => null,
    previewUrl: false,
  });
  const blocked = await runUntil(fixture.env, unavailable, async (payload) => payload?.catalogue.blockedProducts === 1);
  assert.equal(blocked.migration.id, "permanent-printful-2026-08");
  assert.equal(blocked.migration.status, "running");
  assert.equal(blocked.migration.currentProduct, null);
  assert.equal(blocked.migration.lastError, null);
  assert.equal(blocked.migration.blockedProducts[0].code, "printful_source_file_url_unavailable");
  assert.equal(blocked.migration.blockedProducts[0].sourceFileId, "876425703");
  assert.equal(blocked.migration.productsCreated, 0);
  assert.equal(blocked.migration.productsAdopted, 0);
  assert.equal(blocked.migration.completedProducts, 0);
  assert.equal(blocked.migration.variantsMapped, 0);
  assert.equal(failedCalls.some((call) => call.method === "POST"), false);
  assert.deepEqual(failedCalls.filter((call) => /\/sync\/variant\//.test(call.url)).map((call) => new URL(call.url).pathname), ["/sync/variant/4974393098", "/sync/variant/4974393099", "/sync/variant/4974393100"]);
  assert.equal(failedCalls.filter((call) => /\/files\/876425703$/.test(call.url)).length, 4);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT COUNT(*) AS total FROM commerce_catalogue_migrations").first()).total, 1);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT COUNT(*) AS total FROM commerce_printful_file_mappings WHERE source_file_id = '876425703'").first()).total, 0);
  const continued = await runUntil(fixture.env, sourceResolverFetch(fixture.sourceSnapshot, []), async (payload) => payload?.migration.currentProduct?.id === "product-393220449");
  assert.equal(continued.catalogue.blockedProducts, 1);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT migration_status FROM commerce_products WHERE id='product-393219932'").first()).migration_status, "blocked");
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

test("a deployed product block caused by readable legacy target IDs is restored for preview rehydration", async (t) => {
  const fixture = await resolverFixture(t);
  const sourceFiles = fixture.sourceSnapshot.products.find((product) => product.id === "393219932").variants[0].files.filter((file) => file.type !== "preview");
  const unique = [...new Map(sourceFiles.map((file) => [file.id, file])).values()];
  const timestamp = "2026-08-28T00:00:00.000Z";
  await fixture.harness.commerceDb.batch([
    ...unique.map((file) => fixture.harness.commerceDb.prepare(`INSERT INTO commerce_printful_file_mappings
      (source_store_id,source_file_id,source_url,filename,file_status,safe_metadata_json,resolved_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind("16847493", file.id, file.previewUrl, file.filename, "ok", JSON.stringify({ resolutionMethod: "target_existing_file", targetStoreId: "18668025", targetFileId: file.id, targetFilename: file.filename }), timestamp, timestamp)),
    fixture.harness.commerceDb.prepare("UPDATE commerce_products SET migration_status='blocked',status='error' WHERE id='product-393219932'"),
    fixture.harness.commerceDb.prepare("UPDATE commerce_product_variants SET migration_status='blocked',fulfillment_mapping_status='conflict',status='error' WHERE product_id='product-393219932' AND migration_status='selected'"),
    fixture.harness.commerceDb.prepare("UPDATE commerce_products SET migration_status='resolving_files' WHERE id='product-393220449'"),
    fixture.harness.commerceDb.prepare("UPDATE commerce_catalogue_migrations SET status='running',phase='target_lookup',current_product_id='product-393220449',provider_failures=3,safe_state_json=? WHERE id='permanent-printful-2026-08'")
      .bind(JSON.stringify({ blockedProducts: [{ productId: "product-393219932", code: "printful_target_create_rejected" }] })),
  ]);
  const calls = [];
  const payload = await runPermanentPrintfulMigrationStep(fixture.env, { accountId: "master" }, sourceResolverFetch(fixture.sourceSnapshot, calls, { variantUrl: () => null, fileUrl: () => null, rehydrateTarget: true }), { now: () => Date.parse("2026-08-29T00:00:00.000Z") });
  assert.equal(payload.migration.currentProduct.id, "product-393219932");
  assert.equal(payload.catalogue.blockedProducts, 0);
  assert.equal(payload.migration.providerFailures, 3);
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT migration_status FROM commerce_products WHERE id='product-393219932'").first()).migration_status, "resolving_files");
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT migration_status FROM commerce_products WHERE id='product-393220449'").first()).migration_status, "selected");
  assert.equal((await fixture.harness.commerceDb.prepare("SELECT COUNT(*) AS total FROM commerce_printful_file_mappings WHERE source_file_id='876425703'").first()).total, 0);
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

async function runUntil(env, fetchImpl, predicate, maxSteps = 40) {
  let fakeNow = Date.parse("2026-08-28T00:00:00.000Z");
  let payload = null;
  for (let step = 0; step < maxSteps; step += 1) {
    fakeNow += 10_000;
    payload = await runPermanentPrintfulMigrationStep(env, { accountId: "master" }, fetchImpl, { now: () => fakeNow });
    if (await predicate(payload)) return payload;
  }
  throw new Error("Migration fixture did not reach the expected state.");
}

function sourceResolverFetch(sourceSnapshot, calls, options = {}) {
  let targetPayload = null;
  let targetIdPayloadRejected = false;
  const targetFiles = new Map();
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
    if (fileMatch) {
      const sourceFile = sourceSnapshot.products.flatMap((product) => product.variants).flatMap((variant) => variant.files).find((file) => file.id === fileMatch[1]);
      if (authorization === "Bearer target-token") {
        if (options.targetExistingV2 && url.includes("/v2/files/")) return json({ data: { id: Number(fileMatch[1]), status: "ok", url: null, filename: sourceFile.filename, preview_url: sourceFile.previewUrl, mime_type: "image/png", hash: "provider-hash" } });
        return json({ code: 404, result: null }, 404);
      }
      if (url.includes("/v2/files/")) {
        if (!options.sourceV2Url) return json({ code: 404, data: null }, 404);
        return json({ data: { id: Number(fileMatch[1]), status: "ok", url: options.sourceV2Url(fileMatch[1]), filename: sourceFile.filename } });
      }
      return json({ code: 200, result: { id: Number(fileMatch[1]), status: "ok", url: options.fileUrl ? options.fileUrl(fileMatch[1]) : null, filename: sourceFile.filename, preview_url: options.previewUrl === false ? null : sourceFile.previewUrl, mime_type: "image/png" } });
    }
    if (url.endsWith("/files") && method === "POST") {
      if (!options.rehydrateTarget) return json({ code: 422, result: null }, 422);
      const body = JSON.parse(init.body);
      const id = 990000 + calls.filter((call) => call.method === "POST").length;
      targetFiles.set(String(id), body.filename);
      return json({ code: 200, result: { id, status: "ok", filename: body.filename, hash: "rehydrated-hash" } });
    }
    if (url.endsWith("/store/products") && method === "POST") {
      const body = JSON.parse(init.body);
      if (options.rejectTargetIdsOnce && !targetIdPayloadRejected && body.sync_variants.some((variant) => variant.files.some((file) => file.id))) {
        targetIdPayloadRejected = true;
        return json({ code: 400, result: "Legacy file IDs are not usable for this store." }, 400);
      }
      targetPayload = body;
      return json({ code: 200, result: { id: 900001, external_id: body.sync_product.external_id, name: body.sync_product.name, variants: body.sync_variants.length } });
    }
    if (url.includes("/store/products/@")) return targetPayload ? json(targetProductResponse(targetPayload, targetFiles)) : json({ code: 404, result: null }, 404);
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

function targetProductResponse(payload, targetFiles = new Map()) {
  return { code: 200, result: {
    sync_product: { id: 900001, external_id: payload.sync_product.external_id, name: payload.sync_product.name, variants: payload.sync_variants.length, synced: payload.sync_variants.length },
    sync_variants: payload.sync_variants.map((variant, index) => ({ id: 910000 + index, external_id: variant.external_id, sync_product_id: 900001, variant_id: variant.variant_id, retail_price: variant.retail_price, sku: variant.sku, synced: true, files: variant.files.map((file, fileIndex) => ({ id: 920000 + index * 10 + fileIndex, ...file, ...(file.id && targetFiles.has(String(file.id)) ? { filename: targetFiles.get(String(file.id)) } : {}), status: "ok" })) })),
  } };
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}
