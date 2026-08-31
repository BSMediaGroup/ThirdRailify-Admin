import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCurrentCatalogueReconciliation,
  buildCurrentCataloguePlan,
  previewCurrentCatalogueReconciliation,
  readCurrentPrintfulSnapshot,
} from "../functions/_shared/current-catalogue-reconciliation.js";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { publicCataloguePayload } from "../functions/_shared/public-catalogue.js";
import { authoritativeCartLines } from "../functions/_shared/shipping-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases, insertTestProduct } from "./commerce-test-helpers.mjs";

const STORE_ID = "18668025";
const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";

test("the bounded reader selects the explicit store and reads all 17 Sync Products with details", async () => {
  const provider = providerFixture(17);
  const calls = [];
  const snapshot = await readCurrentPrintfulSnapshot(environment(), async (url, init) => {
    calls.push({ url, init });
    return provider.response(url);
  }, { intervalMs: 0 });

  assert.equal(snapshot.store.id, STORE_ID);
  assert.equal(snapshot.counts.products, 17);
  assert.equal(snapshot.counts.variants, 17);
  assert.equal(calls.filter((call) => call.url.includes("/store/products?")).length, 2);
  assert.equal(calls.filter((call) => /\/store\/products\/\d+$/.test(call.url)).length, 17);
  assert.equal(calls.every((call) => call.init.method === "GET"), true);
  assert.equal(calls.filter((call) => call.url.includes("/store/products")).every((call) => call.init.headers["X-PF-Store-Id"] === STORE_ID), true);
  assert.equal(calls.find((call) => call.url.endsWith("/stores")).init.headers["X-PF-Store-Id"], undefined);
  assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/);
});

test("zero, partial, and identity-mismatched provider reads fail closed", async () => {
  const zero = providerFixture(0);
  await assert.rejects(readCurrentPrintfulSnapshot(environment(), zero.response, { intervalMs: 0 }), (error) => error.code === "printful_catalogue_empty_or_incomplete");

  const partial = providerFixture(2, { advertisedTotal: 3 });
  await assert.rejects(readCurrentPrintfulSnapshot(environment(), partial.response, { intervalMs: 0 }), (error) => error.code === "printful_pagination_incomplete");

  const wrong = providerFixture(1, { storeName: "Wrong store" });
  await assert.rejects(readCurrentPrintfulSnapshot(environment(), wrong.response, { intervalMs: 0 }), (error) => error.code === "printful_store_identity_invalid");
});

test("matching is deterministic, never title-only, and preserves historical rows for archival", () => {
  const snapshot = normalizedSnapshot(2);
  snapshot.products[1].name = "Same title";
  const plan = buildCurrentCataloguePlan(snapshot, { products: [
    localProduct({ id: "exact", title: "Curated exact title", targetPrintfulProductId: "1", orderReferences: 3 }),
    localProduct({ id: "same-title-only", title: "Same title" }),
  ] });

  assert.equal(plan.items.find((item) => item.localProductId === "exact").classification, "current_incomplete_local_data");
  assert.equal(plan.items.find((item) => item.localProductId === "same-title-only").classification, "ambiguous_replacement_candidate");
  assert.equal(plan.items.find((item) => item.providerProductId === "2" && item.kind === "provider").action, "insert");
  assert.equal(plan.counts.historically_referenced, 1);
  assert.equal(plan.items.find((item) => item.localProductId === "exact").desired.title, "Curated exact title");
});

test("the realistic 50-local / 17-provider plan separates current, wrong-store, ambiguous, historical, and safe legacy rows", () => {
  const snapshot = normalizedSnapshot(17);
  const products = Array.from({ length: 10 }, (_, index) => localProduct({
    id: `exact-${index + 1}`, slug: `exact-${index + 1}`, title: `Curated ${index + 1}`,
    targetPrintfulProductId: String(index + 1), isFeatured: index === 0, collectionCount: index === 0 ? 2 : 0,
  }));
  products.push(
    localProduct({ id: "wrong-store", slug: "wrong-store", title: "Old store row", targetPrintfulProductId: "11", providerStoreId: "16847493", isFeatured: true, collectionCount: 1 }),
    localProduct({ id: "same-title", slug: "same-title", title: "Provider product 12", isFeatured: true }),
    localProduct({ id: "provider-missing", slug: "provider-missing", targetPrintfulProductId: "999", isFeatured: true }),
    localProduct({ id: "historical", slug: "historical", targetPrintfulProductId: "998", orderReferences: 1, collectionCount: 1 }),
  );
  for (let index = products.length; index < 50; index += 1) products.push(localProduct({ id: `legacy-${index}`, slug: `legacy-${index}`, title: `Legacy ${index}` }));

  const plan = buildCurrentCataloguePlan(snapshot, { products });
  assert.equal(products.length, 50);
  assert.equal(plan.snapshot.counts.products, 17);
  assert.equal(plan.counts.current_incomplete_local_data, 10);
  assert.equal(plan.counts.current_provider_not_imported, 7);
  assert.equal(plan.counts.wrong_store, 1);
  assert.equal(plan.counts.ambiguous_replacement_candidate, 1);
  assert.equal(plan.counts.provider_missing, 2);
  assert.equal(plan.counts.legacy_unidentified, 36);
  assert.equal(plan.counts.historically_referenced, 1);
  assert.equal(plan.changes.productsArchived, 40);
  assert.equal(plan.changes.featuredStatesRemoved, 3);
  assert.equal(plan.changes.collectionMembershipsRemoved, 2);
  assert.equal(plan.unusualReduction, true);
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.items.find((item) => item.localProductId === "same-title").action, "archive");
  assert.equal(plan.items.find((item) => item.providerProductId === "12" && item.kind === "provider").action, "insert");
});

test("preview/apply archives stale rows, imports current rows, records audit, and is idempotent", async (t) => {
  const harness = await createCommerceDatabases();
  t.after(() => harness.dispose());
  const env = commerceEnvironment(harness, environment());
  await insertTestProduct(harness.commerceDb, { id: "local-current", slug: "local-current", title: "Curated local title", targetPrintfulProductId: "1", visibility: "public", isFeatured: 1, featuredOrder: 1 });
  await insertTestProduct(harness.commerceDb, { id: "local-stale", slug: "local-stale", title: "Legacy product", targetPrintfulProductId: "999", visibility: "public", isFeatured: 1, featuredOrder: 2 });
  const provider = providerFixture(2);
  const session = { accountId: "env-master-1", access: { isMasterAdmin: true } };

  const preview = await previewCurrentCatalogueReconciliation(env, session, provider.response, { intervalMs: 0 });
  assert.equal(preview.snapshot.products, 2);
  assert.equal(preview.changes.productsArchived, 1);
  assert.equal(preview.changes.productsInserted, 1);
  assert.equal(preview.unusualReduction, false);
  const result = await applyCurrentCatalogueReconciliation(env, session, { runId: preview.runId, confirmation: preview.confirmationText }, provider.response, { intervalMs: 0 });
  assert.equal(result.state, "applied");
  await assert.rejects(
    applyCurrentCatalogueReconciliation(env, session, { runId: preview.runId, confirmation: preview.confirmationText }, provider.response, { intervalMs: 0 }),
    (error) => error.code === "catalogue_reconciliation_preview_not_applicable",
  );

  const rows = await harness.commerceDb.prepare("SELECT id,title,status,visibility,is_featured,provider_presence,archived_at FROM commerce_products ORDER BY id").all();
  assert.deepEqual(rows.results.map((row) => [row.id, row.provider_presence]), [["local-current", "current"], ["local-stale", "provider_missing"], [`printful-${STORE_ID}-2`, "current"]]);
  assert.equal(rows.results.find((row) => row.id === "local-current").title, "Curated local title");
  assert.equal(rows.results.find((row) => row.id === "local-stale").status, "disabled");
  assert.equal(rows.results.find((row) => row.id === "local-stale").visibility, "private");
  assert.equal(rows.results.find((row) => row.id === "local-stale").is_featured, 0);
  assert.ok(rows.results.find((row) => row.id === "local-stale").archived_at);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_audit WHERE action='commerce.catalogue_reconciliation_applied'").first()).count, 1);
  await harness.commerceDb.prepare("UPDATE commerce_product_variants SET is_sellable=1 WHERE product_id='local-current'").run();
  const publicCatalogue = await publicCataloguePayload(env);
  assert.equal(publicCatalogue.authority.reconciled, true);
  assert.equal(publicCatalogue.authority.currentProducts, 2);
  assert.deepEqual(publicCatalogue.products.map((product) => product.id), ["local-current"]);
  await assert.rejects(authoritativeCartLines(harness.commerceDb, [{ productId: "local-stale", variantId: null, quantity: 1 }]), (error) => error.code === "checkout_product_provider_inactive");

  const second = await previewCurrentCatalogueReconciliation(env, session, provider.response, { intervalMs: 0 });
  assert.deepEqual(second.changes, { productsInserted: 0, productsUpdated: 0, productsArchived: 0, productsUnchanged: 3, variantsInserted: 0, variantsUpdated: 0, variantsArchived: 0, imagesReconciled: 0, collectionMembershipsRemoved: 0, featuredStatesRemoved: 0 });
  assert.equal(second.blockers.length, 0);
});

test("reconciliation reads require commerce access and preview remains Master-only with CSRF", async (t) => {
  const harness = await createCommerceDatabases(); t.after(() => harness.dispose());
  const env = commerceEnvironment(harness, environment());
  await ensureEnvironmentMasters(env);
  const master = await loadAccountByEmail(env, "master-one@example.test");
  const masterSession = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES ('catalogue-full','catalogue-full@example.test','Catalogue Full','admin','full','active',?,?,?,'test')").bind(now, now, now).run();
  const full = await loadAccountByEmail(env, "catalogue-full@example.test");
  const fullSession = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), full, ADMIN_ORIGIN);
  const statusUrl = `${ADMIN_ORIGIN}/api/admin/commerce/products/reconciliation`;
  const previewUrl = `${statusUrl}/preview`;

  assert.equal((await commerceRequest({ request: jsonRequest(statusUrl, { method: "GET", origin: ADMIN_ORIGIN }), env, data: {} })).status, 401);
  assert.equal((await commerceRequest({ request: jsonRequest(statusUrl, { method: "GET", origin: ADMIN_ORIGIN, cookie: cookiePair(fullSession.cookie) }), env, data: {} })).status, 200);
  assert.equal((await commerceRequest({ request: jsonRequest(previewUrl, { origin: ADMIN_ORIGIN, cookie: cookiePair(masterSession.cookie), body: {} }), env, data: {} })).status, 403);
  const forbidden = await commerceRequest({ request: jsonRequest(previewUrl, { origin: ADMIN_ORIGIN, cookie: cookiePair(fullSession.cookie), csrfToken: fullSession.csrfToken, body: {} }), env, data: { commerceFetch: async () => { throw new Error("provider must not be called"); } } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, "admin_capability_restricted");
});

test("Apply fails closed when the provider snapshot changes after Preview", async (t) => {
  const harness = await createCommerceDatabases(); t.after(() => harness.dispose());
  const env = commerceEnvironment(harness, environment());
  const provider = providerFixture(2);
  const session = { accountId: "env-master-1", access: { isMasterAdmin: true } };
  const preview = await previewCurrentCatalogueReconciliation(env, session, provider.response, { intervalMs: 0 });
  const changed = providerFixture(2);
  changed.products[0].sync_product.name = "Changed after Preview";
  await assert.rejects(
    applyCurrentCatalogueReconciliation(env, session, { runId: preview.runId, confirmation: preview.confirmationText }, changed.response, { intervalMs: 0 }),
    (error) => error.code === "catalogue_reconciliation_snapshot_changed",
  );
  assert.equal((await harness.commerceDb.prepare("SELECT state FROM commerce_catalogue_reconciliation_runs WHERE id=?").bind(preview.runId).first()).state, "failed");
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_products WHERE archived_at IS NOT NULL").first()).count, 0);
});

function environment() { return { PRINTFUL_STORE_ID: STORE_ID, PRINTFUL_API_TOKEN: "test-token" }; }

function providerFixture(count, options = {}) {
  const products = Array.from({ length: count }, (_, index) => rawProduct(index + 1));
  const response = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/stores") return json({ result: [{ id: 16847493, name: "Third Railify Official", type: "wix" }, { id: Number(STORE_ID), name: options.storeName || "Third Railify API", type: "native" }] });
    if (url.pathname === "/store/products") {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const page = products.slice(offset, offset + limit).map((item) => item.sync_product);
      return json({ result: page, paging: { total: options.advertisedTotal ?? products.length, offset, limit } });
    }
    const id = url.pathname.split("/").pop();
    const product = products.find((item) => String(item.sync_product.id) === id);
    return product ? json({ result: product }) : json({ error: { message: "missing" } }, 404);
  };
  return { products, response };
}

function rawProduct(id) { return {
  sync_product: { id, external_id: `external-${id}`, name: `Provider product ${id}`, thumbnail_url: `https://cdn.example.com/product-${id}.jpg`, is_ignored: false, status: "synced" },
  sync_variants: [{ id: id * 100, external_id: `variant-external-${id}`, sync_product_id: id, product_id: id + 1000, variant_id: id + 2000, name: "M / Black", sku: `SKU-${id}`, size: "M", color: "Black", options: [{ id: "Size", value: "M" }], synced: true, is_ignored: false, availability_status: "active", retail_price: "25.00", currency: "CAD", product: { image: `https://cdn.example.com/variant-${id}.jpg` } }],
}; }

function normalizedSnapshot(count) { return {
  contract: "printful-v1-sync-products", store: { id: STORE_ID, name: "Third Railify API", type: "native" }, fingerprint: "a".repeat(64), retrievedAt: "2026-09-01T00:00:00.000Z",
  counts: { products: count, variants: count, ignoredProducts: 0, ignoredVariants: 0, incompleteProducts: 0, productsWithoutImages: 0, productsWithoutValidVariants: 0 },
  products: Array.from({ length: count }, (_, index) => ({ id: String(index + 1), externalId: `external-${index + 1}`, name: `Provider product ${index + 1}`, isIgnored: false, status: "synced", images: [`https://cdn.example.com/${index + 1}.jpg`], reviewReasons: [], variants: [{ id: String((index + 1) * 100), externalId: `variant-${index + 1}`, syncProductId: String(index + 1), catalogueProductId: String(index + 1001), catalogueVariantId: String(index + 2001), name: "M", sku: null, size: "M", color: null, options: { Size: "M" }, synced: true, isIgnored: false, availabilityStatus: "active", unitAmount: 2500, currency: "CAD", catalogueImageUrl: `https://cdn.example.com/${index + 1}.jpg` }] })),
}; }

function localProduct(overrides = {}) { return { id: "local", slug: "local", title: "Local", status: "active", visibility: "public", isFeatured: false, unitAmount: 2500, externalProductId: null, targetPrintfulProductId: null, targetPrintfulExternalId: null, providerStoreId: null, providerPresence: "legacy", providerReconciliationStatus: "legacy", providerSnapshotHash: null, archivedAt: null, metadata: {}, variants: [], collectionCount: 0, orderReferences: 0, communityReferences: 0, ...overrides }; }
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
