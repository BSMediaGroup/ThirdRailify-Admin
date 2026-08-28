import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { onRequestGet as catalogueRequest } from "../functions/api/public/commerce/catalogue.js";
import { onRequestGet as productRequest } from "../functions/api/public/commerce/products/[slug].js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { applySqlBatches, commerceEnvironment, createCommerceDatabases, importPermanentCatalogue, insertTestProduct, insertTestVariant } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
async function masterSession(env) { await ensureEnvironmentMasters(env); const master = await loadAccountByEmail(env, "master-one@example.test"); const created = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN); return { master, created, cookie: cookiePair(created.cookie) }; }
function productBody(overrides = {}) { return { title: "Authoritative Tee", slug: "authoritative-tee", description: "A real product description.", primaryImageUrl: "https://images.example.test/tee.png", additionalImages: ["https://images.example.test/tee-back.png"], categories: ["Apparel"], tags: ["tee"], featured: true, visibility: "public", status: "active", displayOrder: 12, maxQuantity: 5, unitAmount: 2500, currencyCode: "CAD", ...overrides }; }
function variantBody(overrides = {}) { return { displayLabel: "Medium / Black", size: "M", color: "Black", options: { Size: "M", Color: "Black" }, unitAmount: 3050, currencyCode: "CAD", status: "active", visibility: "public", sellable: false, availability: "active", ...overrides }; }

test("Admin product and variant merchandising requires auth, exact origin, CSRF, capability, validation, and audit", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness); const { master, created, cookie } = await masterSession(env);
  await insertTestProduct(harness.commerceDb); await insertTestVariant(harness.commerceDb);
  const url = `${ADMIN_ORIGIN}/api/admin/commerce/products/product-test-001`;
  const unauthenticated = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, csrfToken: created.csrfToken, body: productBody() }), env, data: {} }); assert.equal(unauthenticated.status, 401);
  const noCsrf = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, body: productBody() }), env, data: {} }); assert.equal(noCsrf.status, 403);
  const wrongOrigin = await commerceRequest({ request: jsonRequest(url, { origin: "https://evil.example", cookie, csrfToken: created.csrfToken, body: productBody() }), env, data: {} }); assert.equal(wrongOrigin.status, 403);
  const savedResponse = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: productBody() }), env, data: {} }); assert.equal(savedResponse.status, 200); const saved = await savedResponse.json(); assert.equal(saved.product.title, "Authoritative Tee"); assert.equal(saved.product.variants.length, 1);
  const variantUrl = `${url}/variants/variant-test-001`; const variantResponse = await commerceRequest({ request: jsonRequest(variantUrl, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: variantBody() }), env, data: {} }); assert.equal(variantResponse.status, 200); assert.equal((await variantResponse.json()).product.variants[0].unitAmount, 3050);
  const stored = await harness.commerceDb.prepare("SELECT target_printful_product_id,target_printful_sync_variant_id,sku,unit_amount FROM commerce_product_variants WHERE id='variant-test-001'").first(); assert.deepEqual(stored, { target_printful_product_id: "target-product-001", target_printful_sync_variant_id: "target-variant-001", sku: "TEST-SKU-001", unit_amount: 3050 });
  for (const [body, code] of [[productBody({ slug: "Bad Slug" }), "commerce_product_slug_invalid"], [productBody({ currencyCode: "USD" }), "commerce_product_currency_invalid"], [{ ...productBody(), targetPrintfulProductId: "overwrite" }, "commerce_product_fields_invalid"]]) { const response = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body }), env, data: {} }); assert.equal(response.status, 400); assert.equal((await response.json()).error, code); }
  for (const [body, code] of [[variantBody({ unitAmount: -1 }), "commerce_variant_price_invalid"], [variantBody({ currencyCode: "USD" }), "commerce_variant_currency_invalid"], [{ ...variantBody(), targetPrintfulVariantId: "overwrite" }, "commerce_variant_fields_invalid"]]) { const response = await commerceRequest({ request: jsonRequest(variantUrl, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body }), env, data: {} }); assert.equal(response.status, 400); assert.equal((await response.json()).error, code); }
  await insertTestProduct(harness.commerceDb, { id: "product-test-002", slug: "other-product" }); const duplicate = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/products/product-test-002`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: productBody() }), env, data: {} }); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error, "commerce_product_slug_duplicate");
  const audits = await harness.commerceDb.prepare("SELECT action,actor_account_id FROM commerce_audit WHERE action IN ('commerce.product_updated','commerce.variant_updated') ORDER BY action").all(); assert.deepEqual(audits.results.map((row) => row.action), ["commerce.product_updated", "commerce.variant_updated"]); assert.ok(audits.results.every((row) => row.actor_account_id === master.id));
});

test("authorized commerce role can edit while ungranted Admin is rejected", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness); await insertTestProduct(harness.commerceDb); const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES ('merch-admin','merch@example.test','Merch Admin','admin','full','active',?,?,?,'test')").bind(now, now, now).run();
  const account = await loadAccountByEmail(env, "merch@example.test"); const session = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), account, ADMIN_ORIGIN); const cookie = cookiePair(session.cookie); const url = `${ADMIN_ORIGIN}/api/admin/commerce/products/product-test-001`;
  const rejected = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: session.csrfToken, body: productBody() }), env, data: {} }); assert.equal(rejected.status, 403);
  await harness.commerceDb.prepare("INSERT INTO commerce_permission_grants (id,account_id,capability,granted_by_account_id,granted_at) VALUES ('grant-merch','merch-admin','commerce.business.manage','master',?)").bind(now).run();
  const accepted = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: session.csrfToken, body: productBody() }), env, data: {} }); assert.equal(accepted.status, 200);
});

test("public catalogue exposes only safe public D1 fields with exact variant prices and cache behavior", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness);
  await insertTestProduct(harness.commerceDb); await insertTestVariant(harness.commerceDb, { unitAmount: 2750 });
  await harness.commerceDb.prepare("UPDATE commerce_products SET safe_metadata_json=? WHERE id='product-test-001'").bind(JSON.stringify({ description: "Safe description", publicImage: "https://images.example.test/front.png", categories: ["Apparel"], tags: ["tee"], displayOrder: 10 })).run();
  await harness.commerceDb.prepare("UPDATE commerce_product_variants SET safe_metadata_json=? WHERE id='variant-test-001'").bind(JSON.stringify({ displayLabel: "M / Black" })).run();
  await insertTestProduct(harness.commerceDb, { id: "product-private", slug: "private-product", title: "My Balloon | classic tee", visibility: "private" });
  const response = await catalogueRequest({ env }); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /s-maxage/); const payload = await response.json(); assert.equal(payload.products.length, 1); assert.equal(payload.products[0].variants[0].unitAmount, 2750); assert.equal(payload.products[0].price.minUnitAmount, 2750); assert.equal(payload.products[0].price.maxUnitAmount, 2750); assert.doesNotMatch(JSON.stringify(payload), /printful|legacy|migration|sku|safe_metadata|source_provider/i);
  const detail = await productRequest({ env, params: { slug: "product-test-001" } }); assert.equal(detail.status, 200); assert.equal((await detail.json()).product.slug, "product-test-001");
  const missing = await productRequest({ env, params: { slug: "missing-product" } }); assert.equal(missing.status, 404); assert.equal(missing.headers.get("cache-control"), "no-store");
});

test("deterministic reconciliation publishes only the 49 accepted products and leaves the paused Printful checkpoint untouched", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const manifest = JSON.parse(await readFile(new URL("../commerce-import/permanent-catalogue-import.json", import.meta.url), "utf8")); await importPermanentCatalogue(harness.commerceDb, manifest);
  const pausedState = JSON.stringify({ plannedProducts: 49, blockedProducts: Array.from({ length: 28 }, (_, index) => ({ productId: `blocked-${index}` })), manualPause: true, manualPauseReason: "operator_requested_later_continuation" });
  await harness.commerceDb.prepare("UPDATE commerce_catalogue_migrations SET status='waiting',phase='source_files',products_created=12,products_verified=12,variants_mapped=238,provider_failures=36,next_provider_request_at=4102444800000,throttle_until=4102444800000,safe_state_json=? WHERE id='permanent-printful-2026-08'").bind(pausedState).run();
  const before = await harness.commerceDb.prepare("SELECT status,phase,products_created,products_verified,variants_mapped,provider_failures,next_provider_request_at,throttle_until,safe_state_json FROM commerce_catalogue_migrations").first();
  const sql = await readFile(new URL("../commerce-import/live/commerce-merchandising-reconciliation.sql", import.meta.url), "utf8"); await applySqlBatches(harness.commerceDb, sql);
  const publicCount = await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_products WHERE status='active' AND visibility='public'").first(); assert.equal(publicCount.count, 49);
  const targetNative = await harness.commerceDb.prepare("SELECT visibility,status FROM commerce_products WHERE id='product-target-native-459991347'").first(); assert.deepEqual(targetNative, { visibility: "private", status: "pending" });
  const raider = await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_products WHERE legacy_printful_source_product_id='454885552'").first(); assert.equal(raider.count, 0);
  const publicVariants = await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_product_variants WHERE status='active' AND visibility='public'").first(); assert.equal(publicVariants.count, 1322);
  const sellable = await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_product_variants WHERE is_sellable=1").first(); assert.equal(sellable.count, 0);
  const after = await harness.commerceDb.prepare("SELECT status,phase,products_created,products_verified,variants_mapped,provider_failures,next_provider_request_at,throttle_until,safe_state_json FROM commerce_catalogue_migrations").first(); assert.deepEqual(after, before); assert.equal(JSON.parse(after.safe_state_json).manualPause, true);
});
