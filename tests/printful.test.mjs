import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handlePost as handleCommercePost, onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { isPrintfulCredentialConfigured, verifyPrintfulStore } from "../functions/_shared/commerce-core.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const PRINTFUL_TOKEN = "opaque-private-token-for-tests";
const STORE_ID = "16384729";

function storeResponse(overrides = {}) {
  return {
    code: 200,
    result: [{ id: Number(STORE_ID), type: "native", name: "Third Railify API" }],
    paging: { total: 1, offset: 0, limit: 20 },
    ...overrides,
  };
}

function productResponse(total = 0, result = []) {
  return { code: 200, result, paging: { total, offset: 0, limit: 1 } };
}

function printfulFetch({ stores = storeResponse(), products = productResponse(), status = 200, calls = [] } = {}) {
  return async (input, init) => {
    calls.push({ input, method: init?.method, headers: new Headers(init?.headers) });
    const body = input === "https://api.printful.com/stores" ? stores : products;
    return Response.json(body, { status });
  };
}

async function masterSession(env) {
  await ensureEnvironmentMasters(env);
  const master = await loadAccountByEmail(env, "master-one@example.test");
  const created = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  return { master, created, cookie: cookiePair(created.cookie) };
}

test("Printful credential validation is opaque, bounded, and fails closed before fetch", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const session = { accountId: "master", account: { adminLevel: "master" } };
  let calls = 0;
  const noFetch = async () => { calls += 1; throw new Error("unexpected fetch"); };
  for (const token of [undefined, "", "   ", "opaque\nvalue", "x".repeat(4097)]) {
    const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: token });
    assert.equal(isPrintfulCredentialConfigured(env), false);
    await assert.rejects(verifyPrintfulStore(env, session, noFetch), (error) => error.code === "printful_credential_unavailable");
  }
  assert.equal(calls, 0);
  assert.equal(isPrintfulCredentialConfigured(commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN })), true);
});

test("Printful store discovery fails closed for malformed scope, Wix, and ambiguous identity", async (t) => {
  const session = { accountId: "master", account: { adminLevel: "master" } };
  const cases = [
    ["empty", storeResponse({ result: [], paging: { total: 0, offset: 0, limit: 20 } }), "printful_store_unavailable"],
    ["multiple", storeResponse({ result: [{ id: 1, type: "native", name: "Third Railify API" }, { id: 2, type: "wix", name: "Wix" }], paging: { total: 2, offset: 0, limit: 20 } }), "printful_store_scope_invalid"],
    ["malformed", { code: 200, result: "not-an-array", paging: { total: 1 } }, "printful_stores_response_invalid"],
    ["Wix type", storeResponse({ result: [{ id: Number(STORE_ID), type: "wix", name: "Third Railify API" }] }), "printful_wix_store_rejected"],
    ["Wix name", storeResponse({ result: [{ id: Number(STORE_ID), type: "native", name: "Third Railify Wix" }] }), "printful_wix_store_rejected"],
    ["wrong native name", storeResponse({ result: [{ id: Number(STORE_ID), type: "native", name: "Another API Store" }] }), "printful_store_identity_ambiguous"],
    ["unknown type", storeResponse({ result: [{ id: Number(STORE_ID), type: "shopify", name: "Third Railify API" }] }), "printful_store_identity_ambiguous"],
  ];
  for (const [label, stores, expectedCode] of cases) {
    const harness = await createCommerceDatabases();
    try {
      const calls = [];
      const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN });
      await assert.rejects(verifyPrintfulStore(env, session, printfulFetch({ stores, calls })), (error) => error.code === expectedCode, label);
      assert.equal(calls.length, 1, `${label} must stop before the product probe`);
      const row = await harness.commerceDb.prepare("SELECT status, external_account_id, safe_metadata_json FROM commerce_provider_connections WHERE provider = 'printful'").first();
      assert.equal(row.status, "setup_required"); assert.equal(row.external_account_id, null); assert.equal(JSON.parse(row.safe_metadata_json).api_active, false);
    } finally { await harness.dispose(); }
  }
});

test("Printful verification performs exactly two server-only GETs and persists safe existing-row metadata", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN });
  const session = { accountId: "master", account: { adminLevel: "master" } };
  const beforeProducts = await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_products").first();
  const beforeOrders = await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first();
  const beforeCheckout = await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'checkout_enabled'").first();
  const beforeLive = await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'live_payment_capture_enabled'").first();
  const calls = [];
  const overview = await verifyPrintfulStore(env, session, printfulFetch({ calls }));

  assert.deepEqual(calls.map((call) => [call.input, call.method]), [
    ["https://api.printful.com/stores", "GET"],
    ["https://api.printful.com/store/products?limit=1", "GET"],
  ]);
  for (const call of calls) {
    assert.equal(call.headers.get("Authorization"), `Bearer ${PRINTFUL_TOKEN}`);
    assert.equal(call.headers.has("X-PF-Store-Id"), false);
  }
  const row = await harness.commerceDb.prepare("SELECT * FROM commerce_provider_connections WHERE provider = 'printful'").first();
  const metadata = JSON.parse(row.safe_metadata_json);
  assert.equal(row.id, "provider-printful"); assert.equal(row.status, "connected"); assert.equal(row.environment, "staging"); assert.equal(row.external_account_id, STORE_ID);
  assert.equal(row.credential_custody, "environment_secret"); assert.equal(row.credential_ciphertext, null);
  assert.deepEqual({ storeName: metadata.store_name, storeType: metadata.store_type, productCount: metadata.product_count }, { storeName: "Third Railify API", storeType: "native", productCount: 0 });
  assert.equal(metadata.api_configured, true); assert.equal(metadata.credential_configured, true); assert.equal(metadata.access_level, "single_store");
  assert.equal(metadata.order_mode, "draft_only"); assert.equal(metadata.fulfillment_enabled, false); assert.equal(metadata.webhook_configured, false); assert.equal(metadata.existing_wix_store_untouched, true);
  assert.doesNotMatch(row.safe_metadata_json, new RegExp(PRINTFUL_TOKEN)); assert.doesNotMatch(row.safe_metadata_json, /authorization|raw_response/i);
  const printful = overview.providers.find((provider) => provider.provider === "printful");
  assert.equal(printful.apiConfigured, true); assert.equal(printful.webhookConfigured, false); assert.equal(printful.externalAccountId, STORE_ID);
  assert.equal(printful.metadata.storeName, "Third Railify API"); assert.equal(printful.metadata.storeType, "native"); assert.equal(printful.metadata.productCount, 0); assert.equal(printful.metadata.fulfillmentEnabled, false);
  assert.doesNotMatch(JSON.stringify(overview), new RegExp(PRINTFUL_TOKEN)); assert.doesNotMatch(JSON.stringify(overview), /authorization/i);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_provider_connections WHERE provider = 'printful'").first()).count, 1);
  assert.deepEqual(await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_products").first(), beforeProducts);
  assert.deepEqual(await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first(), beforeOrders);
  assert.deepEqual(await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'checkout_enabled'").first(), beforeCheckout);
  assert.deepEqual(await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'live_payment_capture_enabled'").first(), beforeLive);
  assert.equal((await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'fulfillment_submission_enabled'").first()).value_json, "false");
  assert.equal((await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'printful_order_mode'").first()).value_json, '"draft_only"');
  assert.equal((await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'printful_api_configured'").first()).value_json, "true");
  const audit = await harness.commerceDb.prepare("SELECT action, result, metadata_json FROM commerce_audit WHERE action = 'printful.store_verified'").first();
  assert.equal(audit.result, "success"); assert.match(audit.metadata_json, /Third Railify API|native|productCount|16384729/); assert.doesNotMatch(audit.metadata_json, new RegExp(PRINTFUL_TOKEN));
});

test("Printful product probe reports existing products without creating, deleting, or importing them", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN });
  const calls = [];
  const result = [{ id: 91, external_id: "safe-id", name: "Existing item", variants: 1, synced: 1 }];
  const overview = await verifyPrintfulStore(env, { accountId: "master" }, printfulFetch({ products: productResponse(3, result), calls }));
  assert.equal(overview.providers.find((provider) => provider.provider === "printful").metadata.productCount, 3);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_products").first()).count, 0);
  assert.equal((await harness.commerceDb.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first()).count, 0);
  assert.equal(calls.every((call) => call.method === "GET"), true);
});

test("Printful product probe failure does not persist connected state", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN });
  await assert.rejects(verifyPrintfulStore(env, { accountId: "master" }, printfulFetch({ products: { code: 200, result: [], paging: {} } })), (error) => error.code === "printful_products_response_invalid");
  const row = await harness.commerceDb.prepare("SELECT status, external_account_id, safe_metadata_json FROM commerce_provider_connections WHERE provider = 'printful'").first();
  assert.equal(row.status, "setup_required"); assert.equal(row.external_account_id, null); assert.equal(JSON.parse(row.safe_metadata_json).api_active, false);
  assert.equal(await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'printful_api_configured'").first(), null);
});

test("configured, token-resolved, and persisted Printful Store IDs must agree permanently", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const session = { accountId: "master" };
  await verifyPrintfulStore(commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN }), session, printfulFetch());
  const matching = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN, PRINTFUL_STORE_ID: STORE_ID });
  assert.equal((await verifyPrintfulStore(matching, session, printfulFetch())).providers.find((provider) => provider.provider === "printful").externalAccountId, STORE_ID);

  const configuredMismatchCalls = [];
  await assert.rejects(verifyPrintfulStore(commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN, PRINTFUL_STORE_ID: "999999" }), session, printfulFetch({ calls: configuredMismatchCalls })), (error) => error.code === "printful_store_mismatch");
  assert.equal(configuredMismatchCalls.length, 1);

  await harness.commerceDb.prepare("UPDATE commerce_provider_connections SET external_account_id = '888888' WHERE provider = 'printful'").run();
  const persistedMismatchCalls = [];
  await assert.rejects(verifyPrintfulStore(matching, session, printfulFetch({ calls: persistedMismatchCalls })), (error) => error.code === "printful_store_mismatch");
  assert.equal(persistedMismatchCalls.length, 1);

  await harness.commerceDb.prepare("UPDATE commerce_provider_connections SET external_account_id = NULL WHERE provider = 'printful'").run();
  await assert.rejects(verifyPrintfulStore(matching, session, printfulFetch()), (error) => error.code === "printful_store_mismatch");
  await assert.rejects(verifyPrintfulStore(commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN, PRINTFUL_STORE_ID: "not-numeric" }), session, printfulFetch()), (error) => error.code === "printful_store_configuration_invalid");
});

test("Printful route requires Admin auth, exact origin, CSRF, and integrations authority", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { PRINTFUL_API_TOKEN: PRINTFUL_TOKEN });
  const { created, cookie } = await masterSession(env);
  const url = `${ADMIN_ORIGIN}/api/admin/commerce/printful/verify`;
  const unauthenticated = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, csrfToken: created.csrfToken }), env, data: {} });
  assert.equal(unauthenticated.status, 401);
  const missingCsrf = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie }), env, data: {} });
  assert.equal(missingCsrf.status, 403); assert.equal((await missingCsrf.json()).error, "csrf_required");
  const invalidCsrf = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: "invalid" }), env, data: {} });
  assert.equal(invalidCsrf.status, 403); assert.equal((await invalidCsrf.json()).error, "csrf_invalid");
  const wrongOrigin = await commerceRequest({ request: jsonRequest(url, { origin: "https://example.test", cookie, csrfToken: created.csrfToken }), env, data: {} });
  assert.equal(wrongOrigin.status, 403); assert.equal((await wrongOrigin.json()).error, "origin_not_allowed");

  const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts (id, email_normalized, display_name, role, admin_level, status, email_verified_at, created_at, updated_at, source) VALUES ('printful-full', 'printful-full@example.test', 'Printful Full Admin', 'admin', 'full', 'active', ?, ?, ?, 'test')").bind(now, now, now).run();
  const full = await loadAccountByEmail(env, "printful-full@example.test");
  const fullCreated = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), full, ADMIN_ORIGIN);
  const unauthorized = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie: cookiePair(fullCreated.cookie), csrfToken: fullCreated.csrfToken }), env, data: {} });
  assert.equal(unauthorized.status, 403); assert.equal((await unauthorized.json()).error, "commerce_capability_required");

  const response = await handleCommercePost(jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken }), env, "printful/verify", printfulFetch());
  assert.equal(response.status, 200); assert.equal((await response.json()).providers.find((provider) => provider.provider === "printful").apiConfigured, true);
});

test("Printful implementation contains no provider write method or browser credential path", async () => {
  const files = [
    new URL("../functions/_shared/commerce-core.js", import.meta.url),
    new URL("../functions/api/admin/commerce/[[path]].js", import.meta.url),
    new URL("../src/commerce/client.ts", import.meta.url),
    new URL("../src/pages/CommercePages.tsx", import.meta.url),
  ];
  const [core, route, client, page] = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const providerUrls = [...core.matchAll(/https:\/\/api\.printful\.com[^"\s]*/g)].map((match) => match[0]).sort();
  assert.deepEqual(providerUrls, ["https://api.printful.com/store/products?limit=1", "https://api.printful.com/stores"]);
  assert.doesNotMatch(`${core}\n${route}`, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["'][\s\S]{0,120}printful/i);
  assert.doesNotMatch(`${client}\n${page}`, /PRINTFUL_API_TOKEN|Authorization:\s*`?Bearer/i);
});
