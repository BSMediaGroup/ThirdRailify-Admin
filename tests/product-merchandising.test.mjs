import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { onRequestGet as catalogueRequest } from "../functions/api/public/commerce/catalogue.js";
import { onRequestGet as productRequest } from "../functions/api/public/commerce/products/[slug].js";
import { commerceMediaResponse, MAX_COMMERCE_IMAGE_BYTES } from "../functions/_shared/commerce-media.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { applySqlBatches, commerceEnvironment, createCommerceDatabases, importPermanentCatalogue, insertTestProduct, insertTestVariant } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
async function masterSession(env) { await ensureEnvironmentMasters(env); const master = await loadAccountByEmail(env, "master-one@example.test"); const created = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN); return { master, created, cookie: cookiePair(created.cookie) }; }
function productBody(overrides = {}) { return { title: "Authoritative Tee", slug: "authoritative-tee", description: "A real product description.", primaryImageUrl: "https://images.example.test/tee.png", additionalImages: ["https://images.example.test/tee-back.png"], categories: ["Apparel"], tags: ["tee"], featured: true, visibility: "public", status: "active", displayOrder: 12, maxQuantity: 5, unitAmount: 2500, currencyCode: "CAD", ...overrides }; }
function variantBody(overrides = {}) { return { displayLabel: "Medium / Black", size: "M", color: "Black", options: { Size: "M", Color: "Black" }, unitAmount: 3050, currencyCode: "CAD", status: "active", visibility: "public", sellable: false, availability: "active", ...overrides }; }
function collectionBody(overrides = {}) { return { title: "Signal Collection", slug: "signal-collection", description: "A stable collection.", visibility: "public", displayOrder: 80, ...overrides }; }
function mediaUploadRequest(url, { bytes, type = "image/png", name = "product.png", origin = ADMIN_ORIGIN, cookie, csrfToken } = {}) { const body = new FormData(); body.set("image", new Blob([bytes || new Uint8Array()], { type }), name); const headers = { Origin: origin }; if (cookie) headers.Cookie = cookie; if (csrfToken) headers["X-CSRF-Token"] = csrfToken; return new Request(url, { method: "POST", headers, body }); }

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

test("product media ingestion copies validated bytes into first-party R2 and serves immutable cross-origin images", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const objects = new Map();
  const bucket = { async head(key) { return objects.get(key) || null; }, async put(key, body, options) { const bytes = new Uint8Array(body); objects.set(key, { body: bytes, size: bytes.byteLength, httpEtag: '"fixture"', httpMetadata: options.httpMetadata }); }, async get(key) { return objects.get(key) || null; } };
  const env = commerceEnvironment(harness, { THIRDRAILIFY_PROFILE_MEDIA: bucket, THIRDRAILIFY_PROFILE_MEDIA_ORIGIN: ADMIN_ORIGIN, THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN: "https://cdn.thirdrailify.com" }); const { created, cookie } = await masterSession(env); await insertTestProduct(harness.commerceDb);
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const fetchImage = async () => new Response(png, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(png.byteLength) } });
  const url = `${ADMIN_ORIGIN}/api/admin/commerce/products/product-test-001/media/ingest`;
  const response = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { imageUrls: ["https://static.wixstatic.com/media/source.png"] } }), env, data: { commerceFetch: fetchImage } });
  assert.equal(response.status, 200); const payload = await response.json(); assert.match(payload.primaryImageUrl, /^https:\/\/cdn\.thirdrailify\.com\/commerce-media\/[a-f0-9]{64}\.png$/); assert.equal(payload.assets[0].contentType, "image/png"); assert.equal(objects.size, 1);
  const delivered = await commerceMediaResponse(new Request(payload.primaryImageUrl), env); assert.equal(delivered.status, 200); assert.equal(delivered.headers.get("content-type"), "image/png"); assert.equal(delivered.headers.get("cross-origin-resource-policy"), "cross-origin"); assert.match(delivered.headers.get("cache-control"), /immutable/); assert.deepEqual(new Uint8Array(await delivered.arrayBuffer()), png);
  const repeated = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { imageUrls: [payload.primaryImageUrl] } }), env, data: { commerceFetch: () => { throw new Error("first-party media must not be refetched"); } } }); assert.equal(repeated.status, 200); assert.equal(objects.size, 1);
  const audit = await harness.commerceDb.prepare("SELECT action FROM commerce_audit WHERE action='commerce.product_media_ingested'").first(); assert.equal(audit.action, "commerce.product_media_ingested");
});

test("direct product media uploads enforce Admin security and byte validation while ignoring caller filenames", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const objects = new Map();
  const bucket = { async head(key) { return objects.get(key) || null; }, async put(key, body, options) { const bytes = new Uint8Array(body); objects.set(key, { body: bytes, size: bytes.byteLength, httpEtag: '"fixture"', httpMetadata: options.httpMetadata }); }, async get(key) { return objects.get(key) || null; } };
  const env = commerceEnvironment(harness, { THIRDRAILIFY_PROFILE_MEDIA: bucket, THIRDRAILIFY_PROFILE_MEDIA_ORIGIN: ADMIN_ORIGIN, THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN: "https://cdn.thirdrailify.com" }); const { created, cookie } = await masterSession(env); await insertTestProduct(harness.commerceDb);
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const url = `${ADMIN_ORIGIN}/api/admin/commerce/products/product-test-001/media/ingest`;
  const unauthenticated = await commerceRequest({ request: mediaUploadRequest(url, { bytes: png, csrfToken: created.csrfToken }), env, data: {} }); assert.equal(unauthenticated.status, 401);
  const noCsrf = await commerceRequest({ request: mediaUploadRequest(url, { bytes: png, cookie }), env, data: {} }); assert.equal(noCsrf.status, 403);
  const wrongOrigin = await commerceRequest({ request: mediaUploadRequest(url, { bytes: png, cookie, csrfToken: created.csrfToken, origin: "https://evil.example" }), env, data: {} }); assert.equal(wrongOrigin.status, 403);
  const unsupported = await commerceRequest({ request: mediaUploadRequest(url, { bytes: png, type: "image/gif", name: "fake.gif", cookie, csrfToken: created.csrfToken }), env, data: {} }); assert.equal(unsupported.status, 415); assert.equal((await unsupported.json()).error, "commerce_media_format_invalid");
  const malformed = await commerceRequest({ request: mediaUploadRequest(url, { bytes: new TextEncoder().encode("not really a png"), name: "fake.png", cookie, csrfToken: created.csrfToken }), env, data: {} }); assert.equal(malformed.status, 415); assert.equal((await malformed.json()).error, "commerce_media_format_invalid");
  const oversized = await commerceRequest({ request: mediaUploadRequest(url, { bytes: new Uint8Array(MAX_COMMERCE_IMAGE_BYTES + 1), name: "huge.png", cookie, csrfToken: created.csrfToken }), env, data: {} }); assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error, "commerce_media_too_large");
  const uploaded = await commerceRequest({ request: mediaUploadRequest(url, { bytes: png, name: "../../caller-path.exe.png", cookie, csrfToken: created.csrfToken }), env, data: {} }); assert.equal(uploaded.status, 200); const payload = await uploaded.json();
  assert.deepEqual(payload.limits, { maxBytes: 10 * 1024 * 1024, maxProductImages: 25, maxAdditionalImages: 24, acceptedTypes: ["image/jpeg", "image/png", "image/webp"] });
  assert.match(payload.asset.url, /^https:\/\/cdn\.thirdrailify\.com\/commerce-media\/[a-f0-9]{64}\.png$/); assert.equal(payload.asset.contentType, "image/png"); assert.equal(payload.asset.bytes, png.byteLength);
  assert.equal(objects.size, 1); const [objectKey] = objects.keys(); assert.match(objectKey, /^commerce\/catalogue\/[a-f0-9]{64}\.png$/); assert.doesNotMatch(objectKey, /caller|path|exe|\.\./);
  const audit = await harness.commerceDb.prepare("SELECT action,metadata_json FROM commerce_audit WHERE action='commerce.product_media_uploaded'").first(); assert.equal(audit.action, "commerce.product_media_uploaded"); assert.match(audit.metadata_json, /direct_upload/);
});

test("Admin product listing paginates after search and filters with bounded page sizes and correct totals", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness); const { cookie } = await masterSession(env);
  for (let index = 1; index <= 105; index += 1) {
    const suffix = String(index).padStart(3, "0");
    await insertTestProduct(harness.commerceDb, {
      id: "page-product-" + suffix,
      slug: "page-product-" + suffix,
      title: (index % 2 ? "Odd" : "Even") + " Product " + suffix,
      visibility: index % 3 ? "public" : "private",
      migrationStatus: index % 5 ? "target_verified" : "blocked",
    });
  }
  const request = async (search = "") => {
    const response = await commerceRequest({ request: new Request(ADMIN_ORIGIN + "/api/admin/commerce/products/list" + search, { headers: { Origin: ADMIN_ORIGIN, Cookie: cookie } }), env, data: {} });
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await request(); assert.equal(initial.page, 1); assert.equal(initial.pageSize, 20); assert.equal(initial.items.length, 20); assert.equal(initial.totalItems, 105); assert.equal(initial.totalPages, 6); assert.equal(initial.totals.products, 105);
  for (const size of [20, 50, 75, 100]) { const payload = await request("?pageSize=" + String(size)); assert.equal(payload.pageSize, size); assert.equal(payload.items.length, Math.min(size, 105)); }
  for (const size of [101, 500, 37, "anything"]) { const payload = await request("?pageSize=" + String(size)); assert.equal(payload.pageSize, 20); assert.equal(payload.items.length, 20); }
  const filtered = await request("?query=even&visibility=public&page=2&pageSize=20&sort=name"); assert.equal(filtered.totalItems, 35); assert.equal(filtered.page, 2); assert.equal(filtered.items.length, 15); assert.ok(filtered.items.every((product) => product.title.startsWith("Even") && product.visibility === "public"));
  const next = await request("?page=2&pageSize=20"); assert.equal(next.page, 2); assert.equal(next.items.length, 20); assert.notEqual(next.items[0].id, initial.items[0].id);
  const normalizedHigh = await request("?page=999&pageSize=20"); assert.equal(normalizedHigh.page, 6); assert.equal(normalizedHigh.items.length, 5);
  const normalizedLow = await request("?page=-4&pageSize=20"); assert.equal(normalizedLow.page, 1);
});

test("bulk product state operations are authenticated, controlled, audited, synchronized, and preserve unrelated commerce fields", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness); const { created, cookie } = await masterSession(env);
  await insertTestProduct(harness.commerceDb, { id: "bulk-one", slug: "bulk-one", title: "Bulk Match One", targetPrintfulProductId: "target-one", migrationStatus: "target_verified" });
  await insertTestProduct(harness.commerceDb, { id: "bulk-two", slug: "bulk-two", title: "Bulk Match Two", targetPrintfulProductId: "target-two", migrationStatus: "blocked" });
  await insertTestProduct(harness.commerceDb, { id: "bulk-three", slug: "bulk-three", title: "Different Product", isFeatured: 1, featuredOrder: 10 });
  await insertTestVariant(harness.commerceDb, { id: "bulk-variant", productId: "bulk-one", targetPrintfulProductId: "target-one", migrationStatus: "target_verified" });
  const url = ADMIN_ORIGIN + "/api/admin/commerce/products/bulk";
  const post = (body, options = {}) => commerceRequest({ request: jsonRequest(url, { origin: options.origin || ADMIN_ORIGIN, cookie: options.cookie, csrfToken: options.csrfToken, body }), env, data: {} });
  const unauthenticated = await post({ operation: "hide", productIds: ["bulk-one"] }, { csrfToken: created.csrfToken }); assert.equal(unauthenticated.status, 401);
  const noCsrf = await post({ operation: "hide", productIds: ["bulk-one"] }, { cookie }); assert.equal(noCsrf.status, 403);
  const unknown = await post({ operation: "hide", productIds: ["missing"] }, { cookie, csrfToken: created.csrfToken }); assert.equal(unknown.status, 400); assert.equal((await unknown.json()).error, "commerce_product_unknown");
  const invalidMatching = await post({ operation: "hide", matching: { query: "bulk", pageSize: 100 }, confirmMatching: true, expectedCount: 2 }, { cookie, csrfToken: created.csrfToken }); assert.equal(invalidMatching.status, 400);
  const hidden = await post({ operation: "hide", productIds: ["bulk-one", "bulk-two"] }, { cookie, csrfToken: created.csrfToken }); const hiddenPayload = await hidden.json(); assert.equal(hidden.status, 200); assert.deepEqual({ matched: hiddenPayload.matched, updated: hiddenPayload.updated, unchanged: hiddenPayload.unchanged, rejected: hiddenPayload.rejected }, { matched: 2, updated: 2, unchanged: 0, rejected: 0 });
  const unchanged = await post({ operation: "hide", productIds: ["bulk-one", "bulk-two"] }, { cookie, csrfToken: created.csrfToken }); assert.equal((await unchanged.json()).unchanged, 2);
  const shown = await post({ operation: "show", productIds: ["bulk-one"] }, { cookie, csrfToken: created.csrfToken }); assert.equal((await shown.json()).updated, 1);
  const featured = await post({ operation: "feature", productIds: ["bulk-one", "bulk-two"] }, { cookie, csrfToken: created.csrfToken }); assert.equal((await featured.json()).updated, 2);
  const featuredRows = await harness.commerceDb.prepare("SELECT id,is_featured,featured_order FROM commerce_products WHERE id LIKE 'bulk-%' ORDER BY featured_order").all(); assert.deepEqual(featuredRows.results.map((row) => [row.id, row.is_featured, row.featured_order]), [["bulk-three", 1, 10], ["bulk-one", 1, 20], ["bulk-two", 1, 30]]);
  const unfeatured = await post({ operation: "unfeature", productIds: ["bulk-one"] }, { cookie, csrfToken: created.csrfToken }); assert.equal((await unfeatured.json()).updated, 1); assert.equal((await harness.commerceDb.prepare("SELECT featured_order FROM commerce_products WHERE id='bulk-two'").first()).featured_order, 20);
  const matching = await post({ operation: "hide", matching: { query: "bulk match", sort: "name" }, confirmMatching: true, expectedCount: 2 }, { cookie, csrfToken: created.csrfToken }); const matchingPayload = await matching.json(); assert.equal(matching.status, 200); assert.equal(matchingPayload.selection, "matching"); assert.equal(matchingPayload.matched, 2);
  const changedMatch = await post({ operation: "show", matching: { query: "bulk match" }, confirmMatching: true, expectedCount: 99 }, { cookie, csrfToken: created.csrfToken }); assert.equal(changedMatch.status, 409);
  const product = await harness.commerceDb.prepare("SELECT visibility,is_featured,featured_order,target_printful_product_id,migration_status FROM commerce_products WHERE id='bulk-one'").first(); assert.deepEqual(product, { visibility: "private", is_featured: 0, featured_order: null, target_printful_product_id: "target-one", migration_status: "target_verified" });
  const variant = await harness.commerceDb.prepare("SELECT visibility,target_printful_product_id,migration_status FROM commerce_product_variants WHERE id='bulk-variant'").first(); assert.deepEqual(variant, { visibility: "public", target_printful_product_id: "target-one", migration_status: "target_verified" });
  const audit = await harness.commerceDb.prepare("SELECT metadata_json FROM commerce_audit WHERE action='commerce.products_bulk_updated' ORDER BY id DESC LIMIT 1").first(); assert.match(audit.metadata_json, /operation|selection|matched|updated/);
});

test("individual featured toggle appends deterministically and unfeature removes ordering", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness); const { created, cookie } = await masterSession(env);
  await insertTestProduct(harness.commerceDb, { id: "featured-existing", slug: "featured-existing", title: "Existing", isFeatured: 1, featuredOrder: 10 });
  await insertTestProduct(harness.commerceDb, { id: "featured-editor", slug: "featured-editor", title: "Editor Toggle" });
  const url = ADMIN_ORIGIN + "/api/admin/commerce/products/featured-editor";
  const enabled = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: productBody({ title: "Editor Toggle", slug: "featured-editor", categories: [], featured: true }) }), env, data: {} }); assert.equal(enabled.status, 200); assert.equal((await enabled.json()).product.featuredOrder, 20);
  await insertTestProduct(harness.commerceDb, { id: "featured-later", slug: "featured-later", title: "Later", isFeatured: 1, featuredOrder: 30 });
  const disabled = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: productBody({ title: "Editor Toggle", slug: "featured-editor", categories: [], featured: false }) }), env, data: {} }); const disabledProduct = (await disabled.json()).product; assert.equal(disabled.status, 200); assert.equal(disabledProduct.featured, false); assert.equal(disabledProduct.featuredOrder, null); assert.equal((await harness.commerceDb.prepare("SELECT featured_order FROM commerce_products WHERE id='featured-later'").first()).featured_order, 20);
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
  await harness.commerceDb.batch([
    harness.commerceDb.prepare("INSERT INTO commerce_product_collections (product_id,collection_id,assigned_at) VALUES ('product-test-001','collection-apparel','now')"),
    harness.commerceDb.prepare("INSERT INTO commerce_product_collections (product_id,collection_id,assigned_at) VALUES ('product-test-001','collection-third-rail-lore','now')"),
    harness.commerceDb.prepare("UPDATE commerce_collections SET visibility='hidden' WHERE id='collection-third-rail-lore'"),
  ]);
  await insertTestProduct(harness.commerceDb, { id: "product-private", slug: "private-product", title: "My Balloon | classic tee", visibility: "private" });
  const response = await catalogueRequest({ env }); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /s-maxage/); const payload = await response.json(); assert.equal(payload.products.length, 1); assert.equal(payload.products[0].variants[0].unitAmount, 2750); assert.equal(payload.products[0].price.minUnitAmount, 2750); assert.equal(payload.products[0].price.maxUnitAmount, 2750); assert.deepEqual(payload.products[0].categories, ["Apparel"]); assert.deepEqual(payload.products[0].collectionSlugs, ["apparel"]); assert.equal(payload.collections.some((collection) => collection.slug === "third-rail-lore"), false); assert.equal(payload.collections.find((collection) => collection.slug === "apparel").productCount, 1); assert.deepEqual(payload.collections.map((collection) => collection.displayOrder), [...payload.collections.map((collection) => collection.displayOrder)].sort((a, b) => a - b)); assert.doesNotMatch(JSON.stringify(payload), /printful|legacy|migration|sku|safe_metadata|source_provider|archived/i);
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

test("collection authority validates security, stable slugs, revisions, ordering, assignment, archive, delete safety, and audit", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness); const { master, created, cookie } = await masterSession(env);
  await insertTestProduct(harness.commerceDb); await insertTestVariant(harness.commerceDb); await insertTestProduct(harness.commerceDb, { id: "product-test-002", slug: "product-test-002", title: "Second Product" });
  await harness.commerceDb.prepare("UPDATE commerce_products SET safe_metadata_json=? WHERE id='product-test-001'").bind(JSON.stringify({ publicImage: "https://images.example.test/front.png" })).run();
  const base = `${ADMIN_ORIGIN}/api/admin/commerce/collections`;
  const unauth = await commerceRequest({ request: jsonRequest(base, { origin: ADMIN_ORIGIN, csrfToken: created.csrfToken, body: collectionBody() }), env, data: {} }); assert.equal(unauth.status, 401);
  const noCsrf = await commerceRequest({ request: jsonRequest(base, { origin: ADMIN_ORIGIN, cookie, body: collectionBody() }), env, data: {} }); assert.equal(noCsrf.status, 403);
  const wrongOrigin = await commerceRequest({ request: jsonRequest(base, { origin: "https://evil.example", cookie, csrfToken: created.csrfToken, body: collectionBody() }), env, data: {} }); assert.equal(wrongOrigin.status, 403);
  const createdResponse = await commerceRequest({ request: jsonRequest(base, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: collectionBody() }), env, data: {} }); assert.equal(createdResponse.status, 200); let payload = await createdResponse.json(); const collection = payload.collection; assert.equal(collection.slug, "signal-collection"); assert.equal(collection.revision, 1);
  const duplicate = await commerceRequest({ request: jsonRequest(base, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: collectionBody({ title: "Different title" }) }), env, data: {} }); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error, "commerce_collection_slug_or_title_duplicate");
  const updateUrl = `${base}/${collection.id}`;
  const updatedResponse = await commerceRequest({ request: jsonRequest(updateUrl, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { title: "Renamed Signal Collection", description: "Hidden safely.", visibility: "hidden", displayOrder: 85, revision: 1 } }), env, data: {} }); assert.equal(updatedResponse.status, 200); payload = await updatedResponse.json(); const updated = payload.collection; assert.equal(updated.slug, "signal-collection"); assert.equal(updated.visibility, "hidden"); assert.equal(updated.revision, 2);
  const conflict = await commerceRequest({ request: jsonRequest(updateUrl, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { title: "Stale", description: "", visibility: "public", displayOrder: 1, revision: 1 } }), env, data: {} }); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error, "commerce_collection_revision_conflict");
  const assignmentsUrl = `${updateUrl}/products`;
  const unknownProduct = await commerceRequest({ request: jsonRequest(assignmentsUrl, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { revision: 2, productIds: ["missing-product"] } }), env, data: {} }); assert.equal(unknownProduct.status, 400); assert.equal((await unknownProduct.json()).error, "commerce_product_unknown");
  const duplicateProduct = await commerceRequest({ request: jsonRequest(assignmentsUrl, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { revision: 2, productIds: ["product-test-001", "product-test-001"] } }), env, data: {} }); assert.equal(duplicateProduct.status, 400);
  const assignedResponse = await commerceRequest({ request: jsonRequest(assignmentsUrl, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { revision: 2, productIds: ["product-test-001"] } }), env, data: {} }); assert.equal(assignedResponse.status, 200); payload = await assignedResponse.json(); const assigned = payload.collection; assert.equal(assigned.assignedProductCount, 1); assert.equal(assigned.publicProductCount, 1); assert.equal(assigned.revision, 3);
  const productCollections = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/products/product-test-002/collections`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { collectionIds: [collection.id] } }), env, data: {} }); assert.equal(productCollections.status, 200); assert.deepEqual((await productCollections.json()).product.collectionIds, [collection.id]);
  const unknownCollection = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/products/product-test-002/collections`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { collectionIds: ["collection-missing"] } }), env, data: {} }); assert.equal(unknownCollection.status, 400); assert.equal((await unknownCollection.json()).error, "commerce_collection_unknown");
  const currentPayload = await (await commerceRequest({ request: new Request(base, { headers: { Origin: ADMIN_ORIGIN, Cookie: cookie } }), env, data: {} })).json(); const reversed = currentPayload.collections.map((item) => item.id).reverse(); const orderResponse = await commerceRequest({ request: jsonRequest(`${base}/order`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { collectionIds: reversed } }), env, data: {} }); assert.equal(orderResponse.status, 200); assert.deepEqual((await orderResponse.json()).collections.map((item) => item.id), reversed);
  const beforeArchive = await harness.commerceDb.prepare("SELECT revision FROM commerce_collections WHERE id=?").bind(collection.id).first(); const archivedResponse = await commerceRequest({ request: jsonRequest(`${updateUrl}/archive`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { revision: beforeArchive.revision, confirmArchive: true } }), env, data: {} }); assert.equal(archivedResponse.status, 200); assert.equal((await archivedResponse.json()).archived, true); assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) count FROM commerce_product_collections WHERE collection_id=?").bind(collection.id).first()).count, 2);
  const unsafeDelete = await commerceRequest({ request: jsonRequest(`${updateUrl}/delete`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { confirmDelete: true } }), env, data: {} }); assert.equal(unsafeDelete.status, 409); assert.equal((await unsafeDelete.json()).error, "commerce_collection_not_empty");
  const emptyCreated = await (await commerceRequest({ request: jsonRequest(base, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: collectionBody({ title: "Empty Collection", slug: "empty-collection" }) }), env, data: {} })).json(); const empty = emptyCreated.collection; const deleted = await commerceRequest({ request: jsonRequest(`${base}/${empty.id}/delete`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { confirmDelete: true } }), env, data: {} }); assert.equal(deleted.status, 200); assert.equal((await deleted.json()).productsDeleted, 0); assert.equal(await harness.commerceDb.prepare("SELECT id FROM commerce_collections WHERE id=?").bind(empty.id).first(), null);
  const audits = await harness.commerceDb.prepare("SELECT action,actor_account_id FROM commerce_audit WHERE action LIKE 'commerce.collection%' OR action='commerce.product_collections_updated' ORDER BY created_at").all(); assert.ok(audits.results.length >= 6); assert.ok(audits.results.every((row) => row.actor_account_id === master.id));
});
