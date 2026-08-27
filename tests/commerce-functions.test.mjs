import assert from "node:assert/strict";
import test from "node:test";
import { handlePost as handleCommercePost, onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { commerceAccessForSession, updateBusinessProfile, writeCommerceAudit } from "../functions/_shared/commerce-core.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";

async function masterSession(env) {
  await ensureEnvironmentMasters(env);
  const master = await loadAccountByEmail(env, "master-one@example.test");
  const created = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), master, ADMIN_ORIGIN);
  return { master, created, cookie: cookiePair(created.cookie) };
}

test("commerce overview is authenticated and missing DB leaves disabled truthful posture", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness); const { cookie } = await masterSession(env);
  const request = jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/overview`, { method: "GET", origin: ADMIN_ORIGIN, cookie });
  const response = await commerceRequest({ request, env, data: {} }); const payload = await response.json();
  assert.equal(response.status, 200); assert.equal(payload.databaseConfigured, true); assert.equal(payload.posture.checkout, "disabled");

  const noDbEnv = { ...env, THIRDRAILIFY_COMMERCE_DB: undefined };
  const noDbResponse = await commerceRequest({ request, env: noDbEnv, data: {} }); const noDbPayload = await noDbResponse.json();
  assert.equal(noDbResponse.status, 200); assert.equal(noDbPayload.databaseConfigured, false); assert.equal(noDbPayload.posture.livePaymentCapture, "disabled");
  const stripe = noDbPayload.providers.find((provider) => provider.provider === "stripe");
  assert.equal(stripe.integrationMode, "direct_merchant"); assert.equal(stripe.status, "setup_required"); assert.equal(stripe.accountCreated, true);
  assert.equal(stripe.apiConfigured, false); assert.equal(stripe.webhookConfigured, false); assert.equal(stripe.checkoutEnabled, false); assert.equal(stripe.livePaymentsEnabled, false);
  assert.equal(stripe.webhookEndpointReady, true); assert.equal(stripe.webhookSigningConfigured, false);
  assert.doesNotMatch(JSON.stringify(noDbPayload), /secret_key|webhook_secret|credential_ciphertext|acct_[A-Za-z0-9]+/i);
});

test("business mutations require CSRF and encryption, then persist ciphertext only", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness); const { master, created, cookie } = await masterSession(env);
  const body = { tradingName: "Third Railify Official", legalBusinessName: "Private legal name", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: "info@thirdrailify.com", supportEmail: "info@thirdrailify.com", websiteUrl: "https://thirdrailify.com", businessNumber: "123456789", publicAddress: {} };
  const noCsrf = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/business`, { origin: ADMIN_ORIGIN, cookie, body }), env, data: {} });
  assert.equal(noCsrf.status, 403);
  const noKeyEnv = { ...env, THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY: "" };
  const noKey = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/business`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body }), env: noKeyEnv, data: {} });
  assert.equal(noKey.status, 503);
  const response = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/business`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body }), env, data: {} });
  assert.equal(response.status, 200);
  const stored = await harness.commerceDb.prepare("SELECT legal_business_name_ciphertext FROM commerce_business_profiles WHERE id = 'primary'").first();
  const tax = await harness.commerceDb.prepare("SELECT identifier_ciphertext, masked_identifier FROM commerce_tax_registrations WHERE registration_type = 'business_number'").first();
  assert.doesNotMatch(stored.legal_business_name_ciphertext, /Private legal name/); assert.doesNotMatch(tax.identifier_ciphertext, /123456789/); assert.equal(tax.masked_identifier, "•••••6789");
  const audits = await harness.commerceDb.prepare("SELECT metadata_json FROM commerce_audit WHERE actor_account_id = ?").bind(master.id).all();
  assert.ok(audits.results.length >= 1); assert.doesNotMatch(JSON.stringify(audits.results), /123456789|Private legal name/);
});

test("Stripe verification route enforces auth, payments authority, CSRF, configuration, and a read-only provider request", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "rk_test_notARealRestrictedKey123" });
  const { created, cookie } = await masterSession(env);
  const url = `${ADMIN_ORIGIN}/api/admin/commerce/stripe/verify`;
  let providerCalls = 0;
  const commerceFetch = async (input, init) => {
    providerCalls += 1;
    assert.equal(input, "https://api.stripe.com/v1/account"); assert.equal(init.method, "GET");
    assert.equal(Object.keys(init.headers).some((name) => name.toLowerCase() === "stripe-account"), false);
    return Response.json({ id: "acct_RouteCanadian123", country: "CA", default_currency: "cad", business_profile: { name: "Third Railify Official" }, charges_enabled: false, payouts_enabled: false, details_submitted: false, type: "standard" });
  };

  const unauthenticated = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, csrfToken: created.csrfToken }), env, data: { commerceFetch } });
  assert.equal(unauthenticated.status, 401);
  const missingCsrf = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie }), env, data: { commerceFetch } });
  assert.equal(missingCsrf.status, 403); assert.equal((await missingCsrf.json()).error, "csrf_required");
  const invalidCsrf = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: "invalid" }), env, data: { commerceFetch } });
  assert.equal(invalidCsrf.status, 403); assert.equal((await invalidCsrf.json()).error, "csrf_invalid");

  const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts (id, email_normalized, display_name, role, admin_level, status, email_verified_at, created_at, updated_at, source) VALUES ('stripe-full-admin', 'stripe-full@example.test', 'Stripe Full Admin', 'admin', 'full', 'active', ?, ?, ?, 'test')").bind(now, now, now).run();
  const full = await loadAccountByEmail(env, "stripe-full@example.test");
  const fullCreated = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), full, ADMIN_ORIGIN);
  const unauthorized = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie: cookiePair(fullCreated.cookie), csrfToken: fullCreated.csrfToken }), env, data: { commerceFetch } });
  assert.equal(unauthorized.status, 403); assert.equal((await unauthorized.json()).error, "commerce_capability_required");

  const missingDb = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken }), env: { ...env, THIRDRAILIFY_COMMERCE_DB: undefined }, data: { commerceFetch } });
  assert.equal(missingDb.status, 503); assert.equal((await missingDb.json()).error, "commerce_database_unavailable");
  const missingKey = await commerceRequest({ request: jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken }), env: { ...env, STRIPE_SECRET_KEY: "" }, data: { commerceFetch } });
  assert.equal(missingKey.status, 503); assert.equal((await missingKey.json()).error, "stripe_credential_unavailable");
  assert.equal((await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'stripe_api_configured'").first()).value_json, "false");
  assert.equal(providerCalls, 0);

  const response = await handleCommercePost(jsonRequest(url, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken }), env, "stripe/verify", commerceFetch);
  const payload = await response.json();
  assert.equal(response.status, 200); assert.equal(providerCalls, 1); assert.equal(payload.stripeSecretConfigured, true);
  const stripe = payload.providers.find((provider) => provider.provider === "stripe");
  assert.equal(stripe.status, "connected"); assert.equal(stripe.externalAccountId, "acct_RouteCanadian123"); assert.equal(stripe.apiConfigured, true);
  assert.equal(stripe.webhookConfigured, false); assert.equal(stripe.checkoutEnabled, false); assert.equal(stripe.livePaymentsEnabled, false); assert.equal(stripe.livePayoutReadiness, "unverified");
  assert.equal(stripe.webhookEndpointReady, true); assert.equal(stripe.webhookSigningConfigured, false);
  assert.equal((await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'stripe_api_configured'").first()).value_json, "true");
});

test("only Master can grant commerce authority and ordinary users are rejected", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness); const { master, created, cookie } = await masterSession(env); const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts (id, email_normalized, display_name, role, admin_level, status, email_verified_at, created_at, updated_at, source) VALUES ('full-admin', 'full@example.test', 'Full Admin', 'admin', 'full', 'active', ?, ?, ?, 'test'), ('ordinary-user', 'user@example.test', 'User', 'user', 'none', 'active', ?, ?, ?, 'test')").bind(now, now, now, now, now, now).run();
  const grantResponse = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/permissions/grant`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { accountId: "full-admin", capability: "commerce.business.manage", reason: "Business owner support" } }), env, data: {} });
  assert.equal(grantResponse.status, 200);
  const access = await commerceAccessForSession(env, { accountId: "full-admin", account: { adminLevel: "full" } });
  assert.ok(access.capabilities.includes("commerce.view")); assert.ok(access.capabilities.includes("commerce.business.manage"));
  const full = await loadAccountByEmail(env, "full@example.test");
  const fullCreated = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), full, ADMIN_ORIGIN);
  const fullGrantResponse = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/permissions/grant`, { origin: ADMIN_ORIGIN, cookie: cookiePair(fullCreated.cookie), csrfToken: fullCreated.csrfToken, body: { accountId: "full-admin", capability: "commerce.templates.manage" } }), env, data: {} });
  assert.equal(fullGrantResponse.status, 403);
  const ordinaryGrantResponse = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/permissions/grant`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: { accountId: "ordinary-user", capability: "commerce.view" } }), env, data: {} });
  assert.equal(ordinaryGrantResponse.status, 409);
});

test("commerce mutations use the bounded D1 rate limit", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness); const { created, cookie } = await masterSession(env);
  let response;
  for (let attempt = 0; attempt < 31; attempt += 1) {
    response = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/not-an-action`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body: {} }), env, data: {} });
    if (attempt < 30) assert.equal(response.status, 404);
  }
  assert.equal(response.status, 429);
  const stored = await harness.authDb.prepare("SELECT key_hash, attempt_count FROM auth_rate_limits WHERE category = 'commerce'").first();
  assert.ok(stored.key_hash); assert.equal(stored.attempt_count, 31); assert.doesNotMatch(stored.key_hash, /master-one|127\.0\.0\.1/);
});

test("commerce audit stores redacted metadata and public payloads receive no private values", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness);
  await writeCommerceAudit(env, { actorAccountId: "master", action: "test", targetType: "test", result: "success", metadata: { clientSecret: "never-store", cardPan: "4242424242424242", safe: "ok" } });
  const row = await harness.commerceDb.prepare("SELECT metadata_json FROM commerce_audit WHERE action = 'test'").first();
  assert.doesNotMatch(row.metadata_json, /never-store|4242424242424242/); assert.match(row.metadata_json, /redacted/); assert.match(row.metadata_json, /ok/);
});

test("business helper rejects a missing commerce DB before any plaintext fallback", async () => {
  await assert.rejects(updateBusinessProfile({ THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY: "unused" }, { accountId: "master" }, {}), /not configured/i);
});
