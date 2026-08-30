import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { businessInformationPayload, createTaxRegistration } from "../functions/_shared/commerce-control-plane.js";
import { updateBusinessProfile } from "../functions/_shared/commerce-core.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const masterSession = { accountId: "master-admin", account: { adminLevel: "master" } };

test("business control plane masks sensitive identity and derives grouped readiness from canonical authority", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { RESEND_API_KEY: "configured-not-called", MAIL_FROM: "Third Railify <alerts@example.test>" });
  await updateBusinessProfile(env, masterSession, { revision: 1, tradingName: "  Third   Railify Official  ", countryCode: "CA", provinceCode: "ON", currencyCode: "cad", publicContactEmail: "INFO@ThirdRailify.com", supportEmail: "support@thirdrailify.com", publicPhone: "+1 416 555 0199", websiteUrl: "https://thirdrailify.com", publicAddress: {}, legalBusinessName: "Sensitive Legal Entity", businessRegistrationNumber: "CORP-PRIVATE-9876", privateAddress: { line1: "1 Private Way", line2: "Suite 2", city: "Toronto", province: "ON", postalCode: "M5V1A1", country: "CA" } });
  const payload = await businessInformationPayload(env, masterSession); const serialized = JSON.stringify(payload);
  assert.equal(payload.profile.tradingName, "Third Railify Official");
  assert.equal(payload.profile.publicContactEmail, "info@thirdrailify.com");
  assert.equal(payload.profile.currencyCode, "CAD");
  assert.match(payload.profile.private.businessRegistrationNumberMasked, /9876$/);
  assert.equal(payload.profile.private.legalBusinessNameMasked, "Encrypted value configured");
  assert.equal(payload.readiness.profile.legalIdentity, "complete");
  assert.equal(payload.readiness.profile.tax, "not_configured");
  assert.equal(payload.readiness.dependencies.paypalRequired, false);
  assert.equal(payload.canonicalReadiness.domains.communications.details.sendEnabled, false);
  assert.doesNotMatch(serialized, /Sensitive Legal Entity|Private Way|CORP-PRIVATE-9876|A256GCM|ciphertext|configured-not-called/);
  await createTaxRegistration(env, masterSession, { registrationType: "gst_hst", jurisdiction: "CA", countryCode: "CA", provinceCode: "", identifier: "123456789RT0001", status: "active", effectiveDate: "", expiresAt: "", notes: "", documentDisclosureEnabled: false });
  const withTax = await businessInformationPayload(env, masterSession);
  assert.equal(withTax.readiness.profile.tax, "complete"); assert.equal(withTax.profile.taxProviderState, "unavailable"); assert.equal(withTax.canonicalReadiness.domains.tax.ready, false);
});

test("commerce.view can read business state while mutations require commerce.business.manage", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness);
  await ensureEnvironmentMasters(env); const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES ('business-viewer','business-viewer@example.test','Business Viewer','admin','full','active',?,?,?,'test')").bind(now, now, now).run();
  await harness.commerceDb.prepare("INSERT INTO commerce_permission_grants (id,account_id,capability,granted_by_account_id,granted_at) VALUES ('business-view-grant','business-viewer','commerce.view','master-admin',?)").bind(now).run();
  const account = await loadAccountByEmail(env, "business-viewer@example.test"); const created = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), account, ADMIN_ORIGIN); const cookie = cookiePair(created.cookie);
  const read = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/business`, { method: "GET", origin: ADMIN_ORIGIN, cookie }), env, data: {} });
  assert.equal(read.status, 200); assert.equal((await read.json()).access.capabilities.includes("commerce.view"), true);
  const policyMaster = await harness.authDb.prepare("SELECT id FROM accounts WHERE source='env_master' ORDER BY created_at LIMIT 1").first();
  await harness.authDb.prepare("INSERT INTO admin_role_capability_denials (role,capability,denied_by_account_id,created_at,updated_at) VALUES ('full','commerce.business.manage',?,?,?)").bind(policyMaster.id, now, now).run();
  const body = { revision: 1, tradingName: "Third Railify Official", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: "info@thirdrailify.com", supportEmail: "", publicPhone: "", websiteUrl: "", publicAddress: {} };
  const forbidden = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/business`, { origin: ADMIN_ORIGIN, cookie, csrfToken: created.csrfToken, body }), env, data: {} });
  assert.equal(forbidden.status, 403); assert.equal((await forbidden.json()).error, "admin_capability_restricted");
  const unauthenticated = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/business`, { method: "GET", origin: ADMIN_ORIGIN }), env, data: {} }); assert.equal(unauthenticated.status, 401);
});

test("business mutation rejects unsafe fields, invalid Canadian addresses, stale revisions, and locale changes", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness);
  await assert.rejects(updateBusinessProfile(env, masterSession, { revision: 1, tradingName: "<script>alert(1)</script>" }), (error) => error.code === "trading_name_invalid");
  await assert.rejects(updateBusinessProfile(env, masterSession, { revision: 1, tradingName: "Third Railify Official", countryCode: "US", provinceCode: "NY", currencyCode: "USD" }), (error) => error.code === "commerce_locale_locked");
  await assert.rejects(updateBusinessProfile(env, masterSession, { revision: 1, tradingName: "Third Railify Official", publicAddress: { line1: "1 Rail Way", city: "Toronto", province: "ON", postalCode: "INVALID", country: "CA" } }), (error) => error.code === "public_address_postal_invalid");
  await updateBusinessProfile(env, masterSession, { revision: 1, tradingName: "Third Railify Official", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: "info@thirdrailify.com", supportEmail: "support@thirdrailify.com", publicPhone: "", websiteUrl: "", publicAddress: {} });
  await assert.rejects(updateBusinessProfile(env, masterSession, { revision: 1, tradingName: "Stale edit" }), (error) => error.code === "business_profile_revision_conflict");
});

test("business audit records changed categories without plaintext and profile save performs no provider work", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "provider-secret-must-not-appear", RESEND_API_KEY: "resend-secret-must-not-appear" });
  await updateBusinessProfile(env, masterSession, { revision: 1, tradingName: "Third Railify Store", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: "hello@thirdrailify.com", supportEmail: "", publicPhone: "", websiteUrl: "", publicAddress: {}, legalBusinessName: "Never Log Legal", privateAddress: { line1: "9 Secret Street", line2: "", city: "Toronto", province: "ON", postalCode: "M5V 1A1", country: "CA" } });
  const audit = await harness.commerceDb.prepare("SELECT metadata_json FROM commerce_audit WHERE action='business_profile_updated'").first(); const metadata = JSON.parse(audit.metadata_json);
  assert.deepEqual(metadata.changedFields.sort(), ["business_address", "contact_information", "legal_name", "storefront_identity"].sort());
  assert.doesNotMatch(audit.metadata_json, /Never Log Legal|Secret Street|hello@thirdrailify|provider-secret|resend-secret/);
});
