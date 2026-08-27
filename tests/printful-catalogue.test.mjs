import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handlePost as handleCommercePost, onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import {
  discoverLegacyPrintfulSource,
  parseCadMinorUnits,
  snapshotPrintfulCatalogues,
} from "../functions/_shared/printful-catalogue.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const SOURCE_TOKEN = "opaque-wix-reader-token";
const TARGET_TOKEN = "opaque-target-token";
const SOURCE_ID = "9876543";
const TARGET_ID = "18668025";

function env(overrides = {}) {
  return {
    PRINTFUL_WIX_SOURCE_TOKEN: SOURCE_TOKEN,
    PRINTFUL_API_TOKEN: TARGET_TOKEN,
    PRINTFUL_WIX_SOURCE_STORE_ID: SOURCE_ID,
    PRINTFUL_STORE_ID: TARGET_ID,
    ...overrides,
  };
}

function sourceSummary(id) {
  return { id, external_id: `wix-${id}`, name: `Source product ${id}`, variants: 1, synced: 1, thumbnail_url: `https://example.test/source-${id}.png`, is_ignored: false };
}

function sourceDetail(id, overrides = {}) {
  return {
    sync_product: sourceSummary(id),
    sync_variants: [{
      id: id * 10,
      external_id: `wix-variant-${id}`,
      sync_product_id: id,
      variant_id: 4010 + id,
      product_id: 71,
      name: `Black / ${id}`,
      sku: `TR-${id}`,
      retail_price: "29.99",
      size: "M",
      color: "Black",
      synced: true,
      availability_status: "active",
      files: [{ id: 9000 + id, type: "front", url: `https://example.test/art-${id}.png`, filename: `art-${id}.png`, status: "ok", options: [{ id: "template_type", value: "native" }] }],
      options: [{ id: "embroidery_type", value: "flat" }],
      ...overrides,
    }],
  };
}

function targetSummary(id = 700) {
  return { id, external_id: `thirdrailify-${id}`, name: "Existing target product", variants: 1, synced: 1, thumbnail_url: "https://example.test/target.png", is_ignored: false };
}

function targetDetail(id = 700) {
  return {
    sync_product: targetSummary(id),
    sync_variants: [{ id: 701, external_id: "target-variant", sync_product_id: id, variant_id: 4011, product_id: 71, name: "Black / M", sku: "TARGET-1", retail_price: "40.00", synced: true, availability_status: "active", files: [{ id: 9901, type: "front", url: "https://example.test/target-art.png", filename: "target-art.png" }], options: [] }],
  };
}

function providerFetch({ sourceCount = 1, sourceStore = { id: Number(SOURCE_ID), type: "wix", name: "Third Railify Wix" }, targetStore = { id: Number(TARGET_ID), type: "native", name: "Third Railify API" }, sourceVariantOverrides = {}, calls = [] } = {}) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const authorization = new Headers(init.headers).get("Authorization");
    const role = authorization === `Bearer ${SOURCE_TOKEN}` ? "source" : authorization === `Bearer ${TARGET_TOKEN}` ? "target" : "unknown";
    calls.push({ url: url.toString(), path: `${url.pathname}${url.search}`, method: init.method, role, headers: new Headers(init.headers) });
    if (role === "unknown") return Response.json({ code: 401 }, { status: 401 });
    if (url.pathname === "/stores") return Response.json({ code: 200, result: [role === "source" ? sourceStore : targetStore], paging: { total: 1, offset: 0, limit: 20 } });
    if (url.pathname === "/sync/products") {
      const offset = Number(url.searchParams.get("offset"));
      const result = Array.from({ length: Math.min(100, Math.max(0, sourceCount - offset)) }, (_, index) => sourceSummary(offset + index + 1));
      return Response.json({ code: 200, result, paging: { total: sourceCount, offset, limit: 100 } });
    }
    const sourceMatch = /^\/sync\/products\/(\d+)$/.exec(url.pathname);
    if (sourceMatch) return Response.json({ code: 200, result: sourceDetail(Number(sourceMatch[1]), sourceVariantOverrides) });
    if (url.pathname === "/store/products") return Response.json({ code: 200, result: [targetSummary()], paging: { total: 1, offset: 0, limit: 100 } });
    const targetMatch = /^\/store\/products\/(\d+)$/.exec(url.pathname);
    if (targetMatch) return Response.json({ code: 200, result: targetDetail(Number(targetMatch[1])) });
    return Response.json({ code: 404 }, { status: 404 });
  };
}

test("legacy source token is mandatory and never falls back to the target token", async () => {
  let calls = 0;
  await assert.rejects(discoverLegacyPrintfulSource(env({ PRINTFUL_WIX_SOURCE_TOKEN: undefined }), async () => { calls += 1; }), (error) => error.code === "printful_wix_source_token_unavailable");
  assert.equal(calls, 0);
});

test("legacy discovery requires exactly one non-native Wix store distinct from the target", async () => {
  const cases = [
    [{ code: 200, result: [] }, "printful_source_store_count_invalid"],
    [{ code: 200, result: [{ id: 1, type: "wix", name: "One" }, { id: 2, type: "wix", name: "Two" }] }, "printful_source_store_count_invalid"],
    [{ code: 200, result: [{ id: Number(TARGET_ID), type: "native", name: "Third Railify API" }] }, "printful_wix_source_is_target"],
    [{ code: 200, result: [{ id: 991, type: "native", name: "Other" }] }, "printful_wix_source_is_target"],
    [{ code: 200, result: [{ id: 992, type: "shopify", name: "Third Railify" }] }, "printful_wix_source_identity_ambiguous"],
  ];
  for (const [payload, code] of cases) {
    const fetchImpl = async () => Response.json(payload);
    await assert.rejects(discoverLegacyPrintfulSource(env(), fetchImpl), (error) => error.code === code);
  }
  const discovered = await discoverLegacyPrintfulSource(env(), providerFetch());
  assert.deepEqual(discovered, { store: { id: SOURCE_ID, name: "Third Railify Wix", type: "wix" }, configuredStoreId: SOURCE_ID, configurationMatches: true });
});

test("configured legacy Store ID must match the token-resolved source", async () => {
  const discovered = await discoverLegacyPrintfulSource(env({ PRINTFUL_WIX_SOURCE_STORE_ID: "123" }), providerFetch());
  assert.equal(discovered.configurationMatches, false);
  await assert.rejects(snapshotPrintfulCatalogues(env({ PRINTFUL_WIX_SOURCE_STORE_ID: "123" }), providerFetch()), (error) => error.code === "printful_wix_source_store_mismatch");
});

test("catalogue snapshot uses isolated endpoint families, paginates past 100, and fetches every detail", async () => {
  const calls = [];
  const result = await snapshotPrintfulCatalogues(env(), providerFetch({ sourceCount: 101, calls }));
  assert.equal(result.source.counts.products, 101);
  assert.equal(result.source.counts.variants, 101);
  assert.equal(result.target.counts.products, 1);
  assert.deepEqual(calls.filter((call) => call.path.startsWith("/sync/products?")).map((call) => call.path), ["/sync/products?offset=0&limit=100", "/sync/products?offset=100&limit=100"]);
  assert.equal(calls.filter((call) => /^\/sync\/products\/\d+$/.test(call.path)).length, 101);
  assert.equal(calls.filter((call) => /^\/store\/products\/\d+$/.test(call.path)).length, 1);
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.equal(calls.every((call) => !call.headers.has("X-PF-Store-Id")), true);
  assert.equal(calls.filter((call) => call.role === "source").every((call) => call.path === "/stores" || call.path.startsWith("/sync/products")), true);
  assert.equal(calls.filter((call) => call.role === "target").every((call) => call.path === "/stores" || call.path.startsWith("/store/products")), true);
});

test("money normalization is exact and malformed prices remain classified", () => {
  assert.deepEqual(parseCadMinorUnits("29.99"), { status: "valid", value: "29.99", minorUnits: 2999 });
  assert.deepEqual(parseCadMinorUnits("40.00"), { status: "valid", value: "40.00", minorUnits: 4000 });
  for (const value of ["29.9", "29", "1,000.00", "-1.00", "CAD 29.99", "NaN", ""]) {
    assert.equal(parseCadMinorUnits(value).status, "malformed");
    assert.equal(parseCadMinorUnits(value).minorUnits, null);
  }
});

test("variant-specific prices and safe file, placement, and option fields are preserved", async () => {
  const result = await snapshotPrintfulCatalogues(env(), providerFetch());
  const variant = result.source.products[0].variants[0];
  assert.equal(variant.unitAmountCad, 2999);
  assert.equal(variant.retailPrice, "29.99");
  assert.equal(variant.catalogueVariantId, "4011");
  assert.equal(variant.files[0].type, "front");
  assert.deepEqual(variant.files[0].options, [{ id: "template_type", value: "native" }]);
  assert.deepEqual(variant.options, [{ id: "embroidery_type", value: "flat" }]);
});

test("protected source verification enforces auth, exact origin, CSRF, capability, and rate conventions", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const runtime = commerceEnvironment(harness, env());
  await ensureEnvironmentMasters(runtime);
  const master = await loadAccountByEmail(runtime, "master-one@example.test");
  const created = await createSession(runtime, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  const cookie = cookiePair(created.cookie);
  const url = `${ADMIN_ORIGIN}/api/admin/commerce/printful/catalogue/source/verify`;
  assert.equal((await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, csrfToken: created.csrfToken }), env: runtime })).status, 401);
  assert.equal((await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie }), env: runtime })).status, 403);
  assert.equal((await commerceRequest({ request: jsonRequest(url, { origin: "https://example.test", cookie, csrfToken: created.csrfToken }), env: runtime })).status, 403);
  const response = await handleCommercePost(jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken }), runtime, "printful/catalogue/source/verify", providerFetch());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).store.id, SOURCE_ID);
});

test("full snapshot route does not touch commerce products, orders, checkout, or fulfillment", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const runtime = commerceEnvironment(harness, env());
  await ensureEnvironmentMasters(runtime);
  const master = await loadAccountByEmail(runtime, "master-one@example.test");
  const created = await createSession(runtime, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  const before = await harness.commerceDb.prepare("SELECT (SELECT COUNT(*) FROM commerce_products) AS products, (SELECT COUNT(*) FROM commerce_orders) AS orders, (SELECT value_json FROM commerce_settings WHERE setting_key='checkout_enabled') AS checkout, (SELECT value_json FROM commerce_settings WHERE setting_key='fulfillment_submission_enabled') AS fulfillment").first();
  const url = `${ADMIN_ORIGIN}/api/admin/commerce/printful/catalogue/snapshot`;
  const response = await handleCommercePost(jsonRequest(url, { origin: ADMIN_ORIGIN, cookie: cookiePair(created.cookie), csrfToken: created.csrfToken }), runtime, "printful/catalogue/snapshot", providerFetch());
  assert.equal(response.status, 200);
  const payload = await response.json();
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, new RegExp(SOURCE_TOKEN));
  assert.doesNotMatch(serialized, new RegExp(TARGET_TOKEN));
  assert.doesNotMatch(serialized, /customer_email|shipping_address|billing_address|payment_method|authorization/i);
  assert.deepEqual(await harness.commerceDb.prepare("SELECT (SELECT COUNT(*) FROM commerce_products) AS products, (SELECT COUNT(*) FROM commerce_orders) AS orders, (SELECT value_json FROM commerce_settings WHERE setting_key='checkout_enabled') AS checkout, (SELECT value_json FROM commerce_settings WHERE setting_key='fulfillment_submission_enabled') AS fulfillment").first(), before);
});

test("catalogue implementation contains no Printful provider write method or browser token path", async () => {
  const files = [
    new URL("../functions/_shared/printful-catalogue.js", import.meta.url),
    new URL("../functions/api/admin/commerce/[[path]].js", import.meta.url),
    new URL("../src/commerce/client.ts", import.meta.url),
    new URL("../src/pages/CommercePages.tsx", import.meta.url),
  ];
  const [helper, route, client, page] = await Promise.all(files.map((file) => readFile(file, "utf8")));
  assert.doesNotMatch(helper, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
  assert.doesNotMatch(`${client}\n${page}`, /PRINTFUL_(?:API|WIX_SOURCE)_TOKEN|Authorization:\s*`?Bearer/i);
  assert.match(route, /requireAdminOrigin/);
  assert.match(route, /requireCsrf/);
  assert.match(route, /enforceRateLimit/);
});
