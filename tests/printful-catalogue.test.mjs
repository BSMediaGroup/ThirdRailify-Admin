import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handlePost as handleCommercePost, onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import {
  beginPrintfulCatalogueSnapshot,
  discoverLegacyPrintfulSource,
  parseCadMinorUnits,
  readPrintfulCatalogueFileChunk,
  readPrintfulCatalogueProductChunk,
  snapshotPrintfulCatalogues,
} from "../functions/_shared/printful-catalogue.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";
import { commerceOverview } from "../functions/_shared/commerce-core.js";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const SOURCE_TOKEN = "opaque-wix-reader-token";
const TARGET_TOKEN = "opaque-target-token";
const SOURCE_ID = "16847493";
const TARGET_ID = "18668025";

function env(overrides = {}) {
  return {
    PRINTFUL_WIX_SOURCE_TOKEN: SOURCE_TOKEN,
    PRINTFUL_API_TOKEN: TARGET_TOKEN,
    PRINTFUL_WIX_SOURCE_STORE_ID: SOURCE_ID,
    PRINTFUL_STORE_ID: TARGET_ID,
    THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: "test-rate-limit-secret-that-is-not-deployed",
    ...overrides,
  };
}

function fakeSchedulerClock(start = Date.now()) {
  let current = start;
  return {
    runtime: { now: () => current, sleep: async (milliseconds) => { current += Math.max(0, milliseconds); }, random: () => 0 },
    now: () => current,
    advance: (milliseconds) => { current += milliseconds; },
  };
}

async function beginManifest(fetchImpl, clock, sourceCount = 12, targetCount = 0) {
  let input = { phase: "begin" };
  for (;;) {
    const result = await beginPrintfulCatalogueSnapshot(env(), input, fetchImpl || providerFetch({ sourceCount, targetCount }), clock.runtime);
    if (result.status === "complete") return result;
    assert.equal(result.status, "continuing");
    input = { phase: "begin", checkpoint: result.checkpoint, checkpointSignature: result.checkpointSignature };
  }
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

function providerFetch({ sourceCount = 1, targetCount = 1, sourceStore = { id: Number(SOURCE_ID), type: "wix", name: "Third Railify Official" }, targetStore = { id: Number(TARGET_ID), type: "native", name: "Third Railify API" }, sourceVariantOverrides = {}, calls = [] } = {}) {
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
    if (url.pathname === "/store/products") {
      const offset = Number(url.searchParams.get("offset"));
      const result = Array.from({ length: Math.min(100, Math.max(0, targetCount - offset)) }, (_, index) => targetSummary(offset + index + 700));
      return Response.json({ code: 200, result, paging: { total: targetCount, offset, limit: 100 } });
    }
    const targetMatch = /^\/store\/products\/(\d+)$/.exec(url.pathname);
    if (targetMatch) return Response.json({ code: 200, result: targetDetail(Number(targetMatch[1])) });
    const fileMatch = /^\/files\/(\d+)$/.exec(url.pathname);
    if (fileMatch) return Response.json({ code: 200, result: { id: Number(fileMatch[1]), type: "front", url: `https://example.test/file-${fileMatch[1]}.png`, filename: `file-${fileMatch[1]}.png`, preview_url: `https://example.test/file-${fileMatch[1]}-preview.png` } });
    return Response.json({ code: 404 }, { status: 404 });
  };
}

async function runSnapshotRoute(runtime, cookie, csrfToken, fetchImpl, invocationProviderCounts = [], schedulerClock = fakeSchedulerClock()) {
  const url = `${ADMIN_ORIGIN}/api/admin/commerce/printful/catalogue/snapshot`;
  const step = async (body) => {
    let calls = 0;
    const countedFetch = (...args) => { calls += 1; return fetchImpl(...args); };
    const response = await handleCommercePost(jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken, body }), runtime, "printful/catalogue/snapshot", countedFetch, schedulerClock.runtime);
    invocationProviderCounts.push(calls);
    return response;
  };
  const completePhase = async (initial, continuationBase) => {
    let body = initial;
    for (;;) {
      const response = await step(body);
      assert.equal(response.status, 200);
      const result = await response.json();
      if (result.status === "complete") return result;
      assert.equal(result.status, "continuing");
      body = { ...continuationBase, checkpoint: result.checkpoint, checkpointSignature: result.checkpointSignature };
    }
  };
  const started = await completePhase({ phase: "begin" }, { phase: "begin" });
  let rateCheckpoint = started.rateCheckpoint;
  let rateCheckpointSignature = started.rateCheckpointSignature;
  const productEvidence = [];
  for (const role of ["source", "target"]) {
    const ids = started.manifest[role].summaries.map((summary) => summary.id);
    for (let offset = 0; offset < ids.length; offset += started.chunkSizes.products) {
      const base = { phase: "products", manifest: started.manifest, manifestSignature: started.signature };
      const result = await completePhase({ ...base, role, productIds: ids.slice(offset, offset + started.chunkSizes.products), rateCheckpoint, rateCheckpointSignature }, base);
      productEvidence.push({ chunk: result.chunk, signature: result.signature });
      rateCheckpoint = result.rateCheckpoint;
      rateCheckpointSignature = result.rateCheckpointSignature;
    }
  }
  const fileEvidence = [];
  for (const evidence of productEvidence) {
    const ids = evidence.chunk.incompleteFileIds;
    for (let offset = 0; offset < ids.length; offset += started.chunkSizes.files) {
      const base = { phase: "files", manifest: started.manifest, manifestSignature: started.signature, productChunk: evidence.chunk, productChunkSignature: evidence.signature };
      const result = await completePhase({ ...base, role: evidence.chunk.role, fileIds: ids.slice(offset, offset + started.chunkSizes.files), rateCheckpoint, rateCheckpointSignature }, base);
      fileEvidence.push({ chunk: result.chunk, signature: result.signature });
      rateCheckpoint = result.rateCheckpoint;
      rateCheckpointSignature = result.rateCheckpointSignature;
    }
  }
  return step({ phase: "assemble", manifest: started.manifest, manifestSignature: started.signature, productEvidence, fileEvidence });
}

test("legacy source token is mandatory and never falls back to the target token", async () => {
  let calls = 0;
  await assert.rejects(discoverLegacyPrintfulSource(env({ PRINTFUL_WIX_SOURCE_TOKEN: undefined }), async () => { calls += 1; }), (error) => error.code === "printful_wix_source_token_unavailable");
  assert.equal(calls, 0);
});

test("legacy discovery pins the exact verified Wix source identity", async () => {
  const cases = [
    [{ code: 200, result: [] }, "printful_source_store_count_invalid"],
    [{ code: 200, result: [{ id: 1, type: "wix", name: "One" }, { id: 2, type: "wix", name: "Two" }] }, "printful_source_store_count_invalid"],
    [{ code: 200, result: [{ id: Number(TARGET_ID), type: "native", name: "Third Railify API" }] }, "printful_source_store_mismatch"],
    [{ code: 200, result: [{ id: Number(SOURCE_ID), type: "native", name: "Third Railify Official" }] }, "printful_source_store_identity_invalid"],
    [{ code: 200, result: [{ id: Number(SOURCE_ID), type: "wix", name: "Wrong Wix store" }] }, "printful_source_store_identity_invalid"],
  ];
  for (const [payload, code] of cases) {
    const fetchImpl = async () => Response.json(payload);
    await assert.rejects(discoverLegacyPrintfulSource(env(), fetchImpl), (error) => error.code === code);
  }
  const discovered = await discoverLegacyPrintfulSource(env(), providerFetch());
  assert.deepEqual(discovered, { store: { id: SOURCE_ID, name: "Third Railify Official", type: "wix" }, configuredStoreId: SOURCE_ID, configurationMatches: true });
});

test("configured legacy Store ID must match the token-resolved source", async () => {
  const discovered = await discoverLegacyPrintfulSource(env({ PRINTFUL_WIX_SOURCE_STORE_ID: "123" }), providerFetch());
  assert.equal(discovered.configurationMatches, false);
  await assert.rejects(snapshotPrintfulCatalogues(env({ PRINTFUL_WIX_SOURCE_STORE_ID: "123" }), providerFetch()), (error) => error.code === "printful_source_store_mismatch");
});

test("source and target configuration cannot collide and the permanent target stays pinned", async () => {
  await assert.rejects(snapshotPrintfulCatalogues(env({ PRINTFUL_WIX_SOURCE_STORE_ID: TARGET_ID }), providerFetch()), (error) => error.code === "printful_source_store_mismatch");
  await assert.rejects(snapshotPrintfulCatalogues(env({ PRINTFUL_STORE_ID: "123" }), providerFetch()), (error) => error.code === "printful_target_store_mismatch");
  await assert.rejects(snapshotPrintfulCatalogues(env(), providerFetch({ targetStore: { id: Number(TARGET_ID), type: "wix", name: "Third Railify API" } }), fakeSchedulerClock().runtime), (error) => error.code === "printful_target_store_identity_invalid");
});

test("catalogue snapshot uses isolated endpoint families, paginates past 100, and fetches every detail", async () => {
  const calls = [];
  const clock = fakeSchedulerClock();
  const result = await snapshotPrintfulCatalogues(env(), providerFetch({ sourceCount: 101, targetCount: 101, calls }), clock.runtime);
  assert.equal(result.source.counts.products, 101);
  assert.equal(result.source.counts.variants, 101);
  assert.equal(result.target.counts.products, 101);
  assert.deepEqual(calls.filter((call) => call.path.startsWith("/sync/products?")).map((call) => call.path), ["/sync/products?offset=0&limit=100", "/sync/products?offset=100&limit=100"]);
  assert.deepEqual(calls.filter((call) => call.path.startsWith("/store/products?")).map((call) => call.path), ["/store/products?offset=0&limit=100", "/store/products?offset=100&limit=100"]);
  assert.equal(calls.filter((call) => /^\/sync\/products\/\d+$/.test(call.path)).length, 101);
  assert.equal(calls.filter((call) => /^\/store\/products\/\d+$/.test(call.path)).length, 101);
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.equal(calls.every((call) => !call.headers.has("X-PF-Store-Id")), true);
  assert.equal(calls.filter((call) => call.role === "source").every((call) => call.path === "/stores" || call.path.startsWith("/sync/products")), true);
  assert.equal(calls.filter((call) => call.role === "target").every((call) => call.path === "/stores" || call.path.startsWith("/store/products")), true);
  assert.equal(calls.filter((call) => call.path.startsWith("/sync/products")).every((call) => call.role === "source"), true);
  assert.equal(calls.filter((call) => call.path.startsWith("/store/products")).every((call) => call.role === "target"), true);
});

test("product detail reads use one globally paced stream and preserve deterministic ordering", async () => {
  const calls = [];
  const baseFetch = providerFetch({ sourceCount: 12, targetCount: 9, calls });
  let activeDetails = 0;
  let maximumDetails = 0;
  const delayedFetch = async (input, init) => {
    const pathname = new URL(input).pathname;
    const isDetail = /^\/(?:sync|store)\/products\/\d+$/.test(pathname);
    if (!isDetail) return baseFetch(input, init);
    activeDetails += 1;
    maximumDetails = Math.max(maximumDetails, activeDetails);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try { return await baseFetch(input, init); }
    finally { activeDetails -= 1; }
  };
  const clock = fakeSchedulerClock();
  const result = await snapshotPrintfulCatalogues(env(), delayedFetch, clock.runtime);
  assert.equal(maximumDetails, 1);
  assert.deepEqual(result.source.products.map((product) => product.id), Array.from({ length: 12 }, (_, index) => String(index + 1)));
  assert.deepEqual(result.target.products.map((product) => product.id), Array.from({ length: 9 }, (_, index) => String(index + 700)));
});

test("provider transport failures identify the safe role and operation after a bounded retry", async () => {
  const baseFetch = providerFetch();
  let attempts = 0;
  const failingFetch = async (input, init) => {
    if (new URL(input).pathname === "/sync/products") {
      attempts += 1;
      throw new Error("unsafe transport detail");
    }
    return baseFetch(input, init);
  };
  const clock = fakeSchedulerClock();
  await assert.rejects(snapshotPrintfulCatalogues(env(), failingFetch, clock.runtime), (error) => {
    assert.equal(error.code, "printful_source_products_unavailable");
    assert.match(error.message, /legacy source product enumeration could not be reached after 3 attempts/i);
    assert.doesNotMatch(error.message, /unsafe transport detail|Bearer|token/i);
    return true;
  });
  assert.equal(attempts, 3);
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
  const result = await snapshotPrintfulCatalogues(env(), providerFetch(), fakeSchedulerClock().runtime);
  const variant = result.source.products[0].variants[0];
  assert.equal(variant.unitAmountCad, 2999);
  assert.equal(variant.retailPrice, "29.99");
  assert.equal(variant.catalogueVariantId, "4011");
  assert.equal(variant.files[0].type, "front");
  assert.deepEqual(variant.files[0].options, [{ id: "template_type", value: "native" }]);
  assert.deepEqual(variant.options, [{ id: "embroidery_type", value: "flat" }]);
});

test("missing recreation metadata is completed through a GET-only file detail", async () => {
  const calls = [];
  const result = await snapshotPrintfulCatalogues(env(), providerFetch({ calls, sourceVariantOverrides: { files: [{ id: 9001 }] } }), fakeSchedulerClock().runtime);
  const file = result.source.products[0].variants[0].files[0];
  assert.equal(file.type, "front");
  assert.equal(file.filename, "file-9001.png");
  assert.equal(file.previewUrl, "https://example.test/file-9001-preview.png");
  assert.deepEqual(calls.filter((call) => call.path === "/files/9001").map((call) => [call.method, call.role]), [["GET", "source"]]);
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

  await harness.authDb.prepare("INSERT INTO accounts (id, email_normalized, display_name, role, admin_level, status, email_verified_at, created_at, updated_at, source) VALUES ('full-no-capability', 'full-no-capability@example.test', 'Full Admin', 'admin', 'full', 'active', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', 'test')").run();
  await harness.authDb.prepare("INSERT INTO admin_role_capability_denials (role,capability,denied_by_account_id,created_at,updated_at) VALUES ('full','commerce.integrations.manage',?,'2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z')").bind(master.id).run();
  const fullAdmin = await loadAccountByEmail(runtime, "full-no-capability@example.test");
  const fullSession = await createSession(runtime, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), fullAdmin, ADMIN_ORIGIN);
  const snapshotRequest = jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/printful/catalogue/snapshot`, { origin: ADMIN_ORIGIN, cookie: cookiePair(fullSession.cookie), csrfToken: fullSession.csrfToken, body: { phase: "begin" } });
  await assert.rejects(handleCommercePost(snapshotRequest, runtime, "printful/catalogue/snapshot", providerFetch()), (error) => error.code === "admin_capability_restricted");
});

test("verified Store-ID configuration exposes the operator capability without prior snapshot or commerce activation", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const runtime = commerceEnvironment(harness, env({ PRINTFUL_WIX_SOURCE_TOKEN: undefined }));
  const masterSession = { accountId: "master", account: { adminLevel: "master" } };
  const master = await commerceOverview(runtime, masterSession);
  assert.equal(master.printfulCatalogueSnapshot.available, true);
  assert.equal(master.printfulCatalogueSnapshot.configurationReady, true);
  assert.equal(master.printfulCatalogueSnapshot.sourceTargetDistinct, true);
  assert.deepEqual(master.printfulCatalogueSnapshot.source, { id: SOURCE_ID, name: "Third Railify Official", type: "wix" });
  assert.deepEqual(master.printfulCatalogueSnapshot.target, { id: TARGET_ID, name: "Third Railify API", type: "native" });
  assert.equal(master.printfulCatalogueSnapshot.actionPath, "/api/admin/commerce/printful/catalogue/snapshot");
  assert.ok(master.access.capabilities.includes("commerce.integrations.manage"));
  assert.equal(master.counts.products, 0);
  assert.equal(master.counts.orders, 0);
  assert.equal(master.posture.checkout, "disabled");
  assert.equal(master.posture.fulfillmentSubmission, "disabled");

  const delegatedId = "full-admin";
  const delegated = await commerceOverview(runtime, { accountId: delegatedId, account: { role: "admin", adminLevel: "full", status: "active" } });
  assert.equal(delegated.printfulCatalogueSnapshot.available, true);
  assert.ok(delegated.access.capabilities.includes("commerce.integrations.manage"));

  const unauthorized = await commerceOverview(runtime, { accountId: "regular-user", account: { role: "user", adminLevel: "none", status: "active" } });
  assert.equal(unauthorized.access.capabilities.includes("commerce.integrations.manage"), false);
  assert.equal(unauthorized.printfulCatalogueSnapshot.available, true);

  const collision = await commerceOverview({ ...runtime, PRINTFUL_WIX_SOURCE_STORE_ID: TARGET_ID }, masterSession);
  assert.equal(collision.printfulCatalogueSnapshot.available, false);
  assert.equal(collision.printfulCatalogueSnapshot.configurationReady, false);
  assert.equal(collision.printfulCatalogueSnapshot.sourceTargetDistinct, false);
});

test("a missing source secret fails closed only when the protected snapshot action runs", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const runtime = commerceEnvironment(harness, env({ PRINTFUL_WIX_SOURCE_TOKEN: undefined }));
  await ensureEnvironmentMasters(runtime);
  const master = await loadAccountByEmail(runtime, "master-one@example.test");
  const created = await createSession(runtime, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  const request = jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/printful/catalogue/snapshot`, { origin: ADMIN_ORIGIN, cookie: cookiePair(created.cookie), csrfToken: created.csrfToken });
  await assert.rejects(handleCommercePost(request, runtime, "printful/catalogue/snapshot", providerFetch()), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "printful_wix_source_token_unavailable");
    assert.doesNotMatch(JSON.stringify({ code: error.code, message: error.message }), /opaque-|Bearer|Authorization/i);
    return true;
  });
});

test("full snapshot route does not touch commerce products, orders, checkout, or fulfillment", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const runtime = commerceEnvironment(harness, env());
  await ensureEnvironmentMasters(runtime);
  const master = await loadAccountByEmail(runtime, "master-one@example.test");
  const created = await createSession(runtime, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  const before = await harness.commerceDb.prepare("SELECT (SELECT COUNT(*) FROM commerce_products) AS products, (SELECT COUNT(*) FROM commerce_orders) AS orders, (SELECT value_json FROM commerce_settings WHERE setting_key='checkout_enabled') AS checkout, (SELECT value_json FROM commerce_settings WHERE setting_key='fulfillment_submission_enabled') AS fulfillment").first();
  const response = await runSnapshotRoute(runtime, cookiePair(created.cookie), created.csrfToken, providerFetch());
  assert.equal(response.status, 200);
  const payload = await response.json();
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, new RegExp(SOURCE_TOKEN));
  assert.doesNotMatch(serialized, new RegExp(TARGET_TOKEN));
  assert.doesNotMatch(serialized, /customer_email|shipping_address|billing_address|payment_method|authorization/i);
  assert.equal(payload.publicCatalogue.source.repository, "ThirdRailify");
  assert.equal(payload.reconciliation.counts.publicProducts, 8);
  assert.deepEqual(payload.downloadFilenames, {
    source: "printful-wix-source.snapshot.json",
    target: "printful-api-target.snapshot.json",
    publicCatalogue: "public-wix-catalog.snapshot.json",
    reconciliation: "catalogue-reconciliation.json",
  });
  assert.deepEqual(await harness.commerceDb.prepare("SELECT (SELECT COUNT(*) FROM commerce_products) AS products, (SELECT COUNT(*) FROM commerce_orders) AS orders, (SELECT value_json FROM commerce_settings WHERE setting_key='checkout_enabled') AS checkout, (SELECT value_json FROM commerce_settings WHERE setting_key='fulfillment_submission_enabled') AS fulfillment").first(), before);
});

test("one operator click is split into protected phases below the 50-subrequest Pages limit", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const runtime = commerceEnvironment(harness, env());
  await ensureEnvironmentMasters(runtime);
  const master = await loadAccountByEmail(runtime, "master-one@example.test");
  const created = await createSession(runtime, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  const invocationProviderCounts = [];
  const response = await runSnapshotRoute(runtime, cookiePair(created.cookie), created.csrfToken, providerFetch({ sourceCount: 49, targetCount: 1 }), invocationProviderCounts);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source.counts.products, 49);
  assert.equal(payload.target.counts.products, 1);
  assert.ok(invocationProviderCounts.length > 4);
  assert.ok(Math.max(...invocationProviderCounts) < 50);
  assert.equal(invocationProviderCounts.at(-1), 0);
  const rateRows = await harness.authDb.prepare("SELECT category, attempt_count FROM auth_rate_limits WHERE category IN ('commerce','commerce_snapshot') ORDER BY category").all();
  assert.deepEqual(rateRows.results.map((row) => row.category), ["commerce", "commerce_snapshot"]);
  assert.equal(rateRows.results.find((row) => row.category === "commerce").attempt_count, 1);
  assert.ok(rateRows.results.find((row) => row.category === "commerce_snapshot").attempt_count > 1);
});

test("a V1-style 120 request rolling-minute provider completes more than 120 reads without loss or duplication", async () => {
  const clock = fakeSchedulerClock();
  const calls = [];
  const rollingStarts = [];
  const allStarts = [];
  let provider429s = 0;
  const baseFetch = providerFetch({ sourceCount: 130, targetCount: 0, calls });
  const limitedFetch = async (input, init) => {
    const now = clock.now();
    while (rollingStarts.length && rollingStarts[0] <= now - 60_000) rollingStarts.shift();
    if (rollingStarts.length >= 120) {
      provider429s += 1;
      return Response.json({ code: 429 }, { status: 429, headers: { "Retry-After": "61", "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "0" } });
    }
    rollingStarts.push(now);
    allStarts.push(now);
    return baseFetch(input, init);
  };
  const result = await snapshotPrintfulCatalogues(env(), limitedFetch, clock.runtime);
  const detailIds = result.source.products.map((product) => product.id);
  assert.equal(result.source.counts.products, 130);
  assert.equal(provider429s, 0);
  assert.equal(new Set(detailIds).size, 130);
  assert.deepEqual(detailIds, Array.from({ length: 130 }, (_, index) => String(index + 1)));
  assert.ok(calls.length > 120);
  assert.ok(allStarts.slice(1).every((startedAt, index) => startedAt - allStarts[index] >= 675));
});

test("forced 429 retains partial products and resumes the exact failed cursor only after Retry-After", async () => {
  const clock = fakeSchedulerClock();
  const baseFetch = providerFetch({ sourceCount: 12, targetCount: 0 });
  let detailAttempts = 0;
  let forced = false;
  const fetchedIds = [];
  const fetchImpl = async (input, init) => {
    const match = /^\/sync\/products\/(\d+)$/.exec(new URL(input).pathname);
    if (match) {
      detailAttempts += 1;
      fetchedIds.push(match[1]);
      if (!forced && detailAttempts === 5) {
        forced = true;
        return Response.json({ code: 429 }, { status: 429, headers: { "Retry-After": "2", "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "5", "X-RateLimit-Policy": "120;w=60" } });
      }
    }
    return baseFetch(input, init);
  };
  const started = await beginManifest(fetchImpl, clock);
  const initial = { phase: "products", role: "source", productIds: started.manifest.source.summaries.map((summary) => summary.id), manifest: started.manifest, manifestSignature: started.signature, rateCheckpoint: started.rateCheckpoint, rateCheckpointSignature: started.rateCheckpointSignature };
  const paused = await readPrintfulCatalogueProductChunk(env(), initial, fetchImpl, clock.runtime);
  assert.equal(paused.status, "throttled");
  assert.equal(paused.reason, "printful_rate_limited");
  assert.equal(paused.providerStatus, 429);
  assert.deepEqual(paused.cursor, { index: 4, id: "5" });
  assert.deepEqual(paused.partialResults.map((product) => product.id), ["1", "2", "3", "4"]);
  assert.ok(paused.retryAfterMs >= 6_000);
  assert.deepEqual(paused.rateControl, { retryAfter: "2", retryAt: paused.rateControl.retryAt, limit: 120, remaining: 0, reset: paused.rateControl.reset, resetAt: paused.rateControl.resetAt, policy: "120;w=60" });
  const attemptsBeforeEarlyContinuation = detailAttempts;
  const continuation = { phase: "products", manifest: started.manifest, manifestSignature: started.signature, checkpoint: paused.checkpoint, checkpointSignature: paused.checkpointSignature };
  const stillPaused = await readPrintfulCatalogueProductChunk(env(), continuation, fetchImpl, clock.runtime);
  assert.equal(stillPaused.status, "throttled");
  assert.equal(detailAttempts, attemptsBeforeEarlyContinuation);
  clock.advance(stillPaused.retryAfterMs);
  const completed = await readPrintfulCatalogueProductChunk(env(), { ...continuation, checkpoint: stillPaused.checkpoint, checkpointSignature: stillPaused.checkpointSignature }, fetchImpl, clock.runtime);
  assert.equal(completed.status, "complete");
  assert.deepEqual(completed.chunk.products.map((product) => product.id), Array.from({ length: 12 }, (_, index) => String(index + 1)));
  assert.deepEqual(fetchedIds.filter((id) => Number(id) < 5), ["1", "2", "3", "4"]);
  assert.equal(fetchedIds.filter((id) => id === "5").length, 2);
});

test("429 without provider timing uses the safe fallback and preserves the first uncompleted item", async () => {
  const clock = fakeSchedulerClock();
  const baseFetch = providerFetch({ sourceCount: 1, targetCount: 0 });
  let force429 = true;
  const fetchImpl = async (input, init) => {
    if (force429 && /^\/sync\/products\/1$/.test(new URL(input).pathname)) {
      force429 = false;
      return Response.json({ code: 429 }, { status: 429 });
    }
    return baseFetch(input, init);
  };
  const started = await beginManifest(fetchImpl, clock, 1, 0);
  const paused = await readPrintfulCatalogueProductChunk(env(), { phase: "products", role: "source", productIds: ["1"], manifest: started.manifest, manifestSignature: started.signature, rateCheckpoint: started.rateCheckpoint, rateCheckpointSignature: started.rateCheckpointSignature }, fetchImpl, clock.runtime);
  assert.equal(paused.status, "throttled");
  assert.equal(paused.retryAfterMs, 62_000);
  assert.deepEqual(paused.cursor, { index: 0, id: "1" });
  assert.deepEqual(paused.partialResults, []);
});

test("provider throttle cycles are bounded and terminal failure retains the signed cursor", async () => {
  const clock = fakeSchedulerClock();
  const baseFetch = providerFetch({ sourceCount: 1, targetCount: 0 });
  const fetchImpl = async (input, init) => /^\/sync\/products\/1$/.test(new URL(input).pathname)
    ? Response.json({ code: 429 }, { status: 429, headers: { "Retry-After": "1" } })
    : baseFetch(input, init);
  const started = await beginManifest(fetchImpl, clock, 1, 0);
  let input = { phase: "products", role: "source", productIds: ["1"], manifest: started.manifest, manifestSignature: started.signature, rateCheckpoint: started.rateCheckpoint, rateCheckpointSignature: started.rateCheckpointSignature };
  let result;
  for (let cycle = 0; cycle < 13; cycle += 1) {
    result = await readPrintfulCatalogueProductChunk(env(), input, fetchImpl, clock.runtime);
    if (result.status === "failed") break;
    assert.equal(result.status, "throttled");
    clock.advance(result.retryAfterMs);
    input = { phase: "products", manifest: started.manifest, manifestSignature: started.signature, checkpoint: result.checkpoint, checkpointSignature: result.checkpointSignature };
  }
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "printful_rate_limit_recovery_exhausted");
  assert.deepEqual(result.cursor, { index: 0, id: "1" });
  assert.deepEqual(result.partialResults, []);
  assert.match(result.message, /retained safely/i);
});

test("419 warning pauses safely, retains progress, and resumes without parsing warning content", async () => {
  const clock = fakeSchedulerClock();
  const baseFetch = providerFetch({ sourceCount: 3, targetCount: 0 });
  let warningSent = false;
  const fetchedIds = [];
  const fetchImpl = async (input, init) => {
    const match = /^\/sync\/products\/(\d+)$/.exec(new URL(input).pathname);
    if (match) {
      fetchedIds.push(match[1]);
      if (match[1] === "2" && !warningSent) {
        warningSent = true;
        return Response.json({ result: { unsafe: "not catalogue data" } }, { status: 419, headers: { "Retry-After": "1" } });
      }
    }
    return baseFetch(input, init);
  };
  const started = await beginManifest(fetchImpl, clock, 3, 0);
  const initial = { phase: "products", role: "source", productIds: ["1", "2", "3"], manifest: started.manifest, manifestSignature: started.signature, rateCheckpoint: started.rateCheckpoint, rateCheckpointSignature: started.rateCheckpointSignature };
  const paused = await readPrintfulCatalogueProductChunk(env(), initial, fetchImpl, clock.runtime);
  assert.equal(paused.status, "throttled");
  assert.equal(paused.providerStatus, 419);
  assert.deepEqual(paused.partialResults.map((product) => product.id), ["1"]);
  assert.deepEqual(paused.cursor, { index: 1, id: "2" });
  clock.advance(paused.retryAfterMs);
  const completed = await readPrintfulCatalogueProductChunk(env(), { phase: "products", manifest: started.manifest, manifestSignature: started.signature, checkpoint: paused.checkpoint, checkpointSignature: paused.checkpointSignature }, fetchImpl, clock.runtime);
  assert.deepEqual(completed.chunk.products.map((product) => product.id), ["1", "2", "3"]);
  assert.deepEqual(fetchedIds, ["1", "2", "2", "3"]);
});

test("successful response with zero remaining pauses proactively at the provider reset", async () => {
  const clock = fakeSchedulerClock();
  const baseFetch = providerFetch({ sourceCount: 2, targetCount: 0 });
  const fetchedIds = [];
  const fetchImpl = async (input, init) => {
    const match = /^\/sync\/products\/(\d+)$/.exec(new URL(input).pathname);
    if (match) {
      fetchedIds.push(match[1]);
      const response = await baseFetch(input, init);
      if (match[1] === "1") return Response.json(await response.json(), { headers: { "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "2" } });
      return response;
    }
    return baseFetch(input, init);
  };
  const started = await beginManifest(fetchImpl, clock, 2, 0);
  const paused = await readPrintfulCatalogueProductChunk(env(), { phase: "products", role: "source", productIds: ["1", "2"], manifest: started.manifest, manifestSignature: started.signature, rateCheckpoint: started.rateCheckpoint, rateCheckpointSignature: started.rateCheckpointSignature }, fetchImpl, clock.runtime);
  assert.equal(paused.status, "throttled");
  assert.deepEqual(paused.partialResults.map((product) => product.id), ["1"]);
  assert.deepEqual(paused.cursor, { index: 1, id: "2" });
  assert.deepEqual(fetchedIds, ["1"]);
  assert.ok(paused.retryAfterMs >= 3_000);
});

test("pagination checkpoint retains completed pages when the next page is throttled", async () => {
  const clock = fakeSchedulerClock();
  const baseFetch = providerFetch({ sourceCount: 130, targetCount: 0 });
  let pageThrottle = true;
  let page100Calls = 0;
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/sync/products" && url.searchParams.get("offset") === "100") {
      page100Calls += 1;
      if (pageThrottle) {
        pageThrottle = false;
        return Response.json({ code: 429 }, { status: 429, headers: { "Retry-After": "1" } });
      }
    }
    return baseFetch(input, init);
  };
  const paused = await beginPrintfulCatalogueSnapshot(env(), { phase: "begin" }, fetchImpl, clock.runtime);
  assert.equal(paused.status, "throttled");
  assert.equal(paused.cursor.step, "source_pages");
  assert.equal(paused.cursor.sourceOffset, 100);
  assert.equal(paused.partialResults.sourceSummaries.length, 100);
  const pageCallsBeforeEarlyContinuation = page100Calls;
  const early = await beginPrintfulCatalogueSnapshot(env(), { phase: "begin", checkpoint: paused.checkpoint, checkpointSignature: paused.checkpointSignature }, fetchImpl, clock.runtime);
  assert.equal(early.status, "throttled");
  assert.equal(page100Calls, pageCallsBeforeEarlyContinuation);
  clock.advance(early.retryAfterMs);
  const complete = await beginPrintfulCatalogueSnapshot(env(), { phase: "begin", checkpoint: early.checkpoint, checkpointSignature: early.checkpointSignature }, fetchImpl, clock.runtime);
  assert.equal(complete.status, "complete");
  assert.equal(complete.manifest.source.summaries.length, 130);
  assert.equal(new Set(complete.manifest.source.summaries.map((summary) => summary.id)).size, 130);
  assert.equal(page100Calls, 2);
});

test("file-detail throttle retains completed files and resumes the exact missing file", async () => {
  const clock = fakeSchedulerClock();
  const baseFetch = providerFetch({ sourceCount: 3, targetCount: 0 });
  let fileThrottle = true;
  const fetchedFiles = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    const productMatch = /^\/sync\/products\/(\d+)$/.exec(url.pathname);
    if (productMatch) {
      const id = Number(productMatch[1]);
      return Response.json({ code: 200, result: sourceDetail(id, { files: [{ id: 9000 + id }] }) });
    }
    const fileMatch = /^\/files\/(\d+)$/.exec(url.pathname);
    if (fileMatch) {
      fetchedFiles.push(fileMatch[1]);
      if (fileMatch[1] === "9002" && fileThrottle) {
        fileThrottle = false;
        return Response.json({ code: 429 }, { status: 429, headers: { "Retry-After": "1" } });
      }
    }
    return baseFetch(input, init);
  };
  const started = await beginManifest(fetchImpl, clock, 3, 0);
  const products = await readPrintfulCatalogueProductChunk(env(), { phase: "products", role: "source", productIds: ["1", "2", "3"], manifest: started.manifest, manifestSignature: started.signature, rateCheckpoint: started.rateCheckpoint, rateCheckpointSignature: started.rateCheckpointSignature }, fetchImpl, clock.runtime);
  const fileInput = { phase: "files", role: "source", fileIds: products.chunk.incompleteFileIds, manifest: started.manifest, manifestSignature: started.signature, productChunk: products.chunk, productChunkSignature: products.signature, rateCheckpoint: products.rateCheckpoint, rateCheckpointSignature: products.rateCheckpointSignature };
  const paused = await readPrintfulCatalogueFileChunk(env(), fileInput, fetchImpl, clock.runtime);
  assert.equal(paused.status, "throttled");
  assert.deepEqual(paused.cursor, { index: 1, id: "9002" });
  assert.deepEqual(paused.partialResults.map((file) => file.id), ["9001"]);
  clock.advance(paused.retryAfterMs);
  const completed = await readPrintfulCatalogueFileChunk(env(), { phase: "files", manifest: started.manifest, manifestSignature: started.signature, productChunk: products.chunk, productChunkSignature: products.signature, checkpoint: paused.checkpoint, checkpointSignature: paused.checkpointSignature }, fetchImpl, clock.runtime);
  assert.deepEqual(completed.chunk.files.map((file) => file.id), ["9001", "9002", "9003"]);
  assert.deepEqual(fetchedFiles, ["9001", "9002", "9002", "9003"]);
});

test("signed pacing evidence carries the request-start envelope across Pages invocations", async () => {
  const clock = fakeSchedulerClock();
  const starts = [];
  const baseFetch = providerFetch({ sourceCount: 2, targetCount: 0 });
  const fetchImpl = async (input, init) => {
    if (/^\/sync\/products\/\d+$/.test(new URL(input).pathname)) starts.push(clock.now());
    return baseFetch(input, init);
  };
  const started = await beginManifest(fetchImpl, clock, 2, 0);
  const common = { phase: "products", role: "source", manifest: started.manifest, manifestSignature: started.signature };
  const invocationA = await readPrintfulCatalogueProductChunk(env(), { ...common, productIds: ["1"], rateCheckpoint: started.rateCheckpoint, rateCheckpointSignature: started.rateCheckpointSignature }, fetchImpl, clock.runtime);
  const invocationB = await readPrintfulCatalogueProductChunk(env(), { ...common, productIds: ["2"], rateCheckpoint: invocationA.rateCheckpoint, rateCheckpointSignature: invocationA.rateCheckpointSignature }, fetchImpl, clock.runtime);
  assert.equal(invocationA.status, "complete");
  assert.equal(invocationB.status, "complete");
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 675);
  assert.equal(invocationB.rateCheckpoint.rate.providerRequestCount, invocationA.rateCheckpoint.rate.providerRequestCount + 1);
});

test("caller-modified pacing or cursor evidence is rejected before a provider call", async () => {
  const clock = fakeSchedulerClock();
  const baseFetch = providerFetch({ sourceCount: 1, targetCount: 0 });
  const started = await beginManifest(baseFetch, clock, 1, 0);
  const tamperedRate = structuredClone(started.rateCheckpoint);
  tamperedRate.rate.nextProviderRequestAt = 0;
  let providerCalls = 0;
  const countedFetch = (...args) => { providerCalls += 1; return baseFetch(...args); };
  await assert.rejects(readPrintfulCatalogueProductChunk(env(), { phase: "products", role: "source", productIds: ["1"], manifest: started.manifest, manifestSignature: started.signature, rateCheckpoint: tamperedRate, rateCheckpointSignature: started.rateCheckpointSignature }, countedFetch, clock.runtime), (error) => error.code === "printful_snapshot_evidence_invalid");
  assert.equal(providerCalls, 0);
});

test("read-only catalogue helper remains GET-only while the browser exposes only the protected permanent migration", async () => {
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
  assert.doesNotMatch(helper, /node:fs|writeFile|readFile|commerce-import/i);
  assert.match(page, /EXECUTE PERMANENT PRINTFUL CATALOGUE MIGRATION/);
  assert.match(page, /CONTINUE PERMANENT PRINTFUL MIGRATION FROM CHECKPOINT/);
  assert.doesNotMatch(page, /if \(migrationStatus.*void continueMigration\(\)/);
  assert.match(client, /action:\s*"continue_permanent_printful_migration"/);
  assert.match(route, /printful_migration_action_invalid/);
  assert.doesNotMatch(page, /Retry read-only snapshot|Download Wix source snapshot|Download API target snapshot|Download Public catalogue snapshot|Download reconciliation snapshot/);
  assert.doesNotMatch(`${client}\n${page}`, /downloadJson\(/);
});
