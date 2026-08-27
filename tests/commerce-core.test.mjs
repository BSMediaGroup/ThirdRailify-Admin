import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PROVIDER_BLUEPRINTS,
  PRINTFUL_TWO_TRANSACTION_MODEL,
  assertNoCommerceSecretsInPublicPayload,
  businessProjection,
  commerceOverview,
  decryptCommerceSecret,
  encryptCommerceSecret,
  maskTaxIdentifier,
  publicBusinessProjection,
  redactCommerceAuditMetadata,
  requireCommerceDb,
  stripeTestCredentialKind,
  validateTemplate,
  verifyStripeAccount,
} from "../functions/_shared/commerce-core.js";
import { commerceEnvironment, createCommerceDatabases, TEST_COMMERCE_KEY } from "./commerce-test-helpers.mjs";

test("AES-256-GCM round trips and rejects wrong keys, tampering, and missing configuration", async () => {
  const env = { THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY: TEST_COMMERCE_KEY };
  const encrypted = await encryptCommerceSecret(env, "sensitive-value", "test:field");
  assert.doesNotMatch(encrypted, /sensitive-value/);
  assert.equal(await decryptCommerceSecret(env, encrypted, "test:field"), "sensitive-value");
  await assert.rejects(decryptCommerceSecret({ THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI" }, encrypted, "test:field"), /authenticated/i);
  const envelope = JSON.parse(encrypted); envelope.ct = `${envelope.ct.slice(0, -2)}AA`;
  await assert.rejects(decryptCommerceSecret(env, JSON.stringify(envelope), "test:field"), /authenticated/i);
  await assert.rejects(encryptCommerceSecret({}, "plaintext", "test:field"), /not configured/i);
});

test("commerce DB and private projections fail closed without plaintext fallback", () => {
  assert.throws(() => requireCommerceDb({}), /not configured/i);
  const row = {
    trading_name: "Third Railify Official", legal_business_name_ciphertext: "cipher", country_code: "CA", province_code: "ON", currency_code: "CAD",
    public_address_json: '{"city":"Toronto"}', private_address_ciphertext: "cipher", public_contact_email: "info@thirdrailify.com",
    support_email: "info@thirdrailify.com", public_phone: "", website_url: "https://thirdrailify.com", invoice_prefix: "TR", document_footer: "Safe footer",
  };
  const publicValue = publicBusinessProjection(row); const adminValue = businessProjection(row, [{ registration_type: "gst_hst", jurisdiction: "CA", masked_identifier: "••••1234", status: "unverified" }]);
  assert.equal(publicValue.tradingName, "Third Railify Official"); assert.equal(Object.hasOwn(publicValue, "private"), false);
  assert.equal(adminValue.private.legalBusinessNameStored, true); assert.equal(adminValue.private.registrations[0].maskedIdentifier, "••••1234");
  assertNoCommerceSecretsInPublicPayload(publicValue);
  assert.equal(maskTaxIdentifier("123456789"), "•••••6789");
});

test("template validation accepts bounded structured text and rejects scripts or executable HTML", () => {
  const valid = validateTemplate({ templateKey: "order_confirmation", subject: "Order received", heading: "Thanks", bodyBlocks: ["Plain text"], ctaLabel: "View", ctaUrl: "/account", accentColor: "#F3C928", status: "draft" });
  assert.equal(valid.accentColor, "#f3c928"); assert.deepEqual(valid.bodyBlocks, ["Plain text"]);
  assert.throws(() => validateTemplate({ templateKey: "order_confirmation", subject: "<script>alert(1)</script>", heading: "Unsafe" }), /structured plain text/i);
  assert.throws(() => validateTemplate({ templateKey: "order_confirmation", subject: "Order", heading: "Unsafe", introduction: '<img src=x onerror="alert(1)">' }), /structured plain text/i);
});

test("audit redaction removes credential, tax, bank, and card material", () => {
  const redacted = redactCommerceAuditMetadata({ clientSecret: "secret-value", businessNumber: "123456789", note: "sk_live_not-a-real-key", nested: { bankAccount: "99887766" } });
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /secret-value|123456789|99887766|sk_live/); assert.match(serialized, /redacted/);
});

test("staging Stripe credential validation accepts test restricted and secret keys only", () => {
  assert.equal(stripeTestCredentialKind("rk_test_notARealRestrictedKey123"), "restricted_test");
  assert.equal(stripeTestCredentialKind("sk_test_notARealSecretKey123"), "secret_test");
  assert.equal(stripeTestCredentialKind("rk_live_notARealRestrictedKey123"), null);
  assert.equal(stripeTestCredentialKind("sk_live_notARealSecretKey123"), null);
  assert.equal(stripeTestCredentialKind("pk_test_notARealPublishableKey123"), null);
});

test("Stripe account verification uses one direct read and persists only the existing safe provider row", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const credential = "rk_test_notARealRestrictedKey123";
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: credential });
  const session = { accountId: "master", account: { adminLevel: "master" } };
  const calls = [];
  const overview = await verifyStripeAccount(env, session, async (url, init) => {
    calls.push({ url, init });
    return Response.json({
      id: "acct_TestCanadian123",
      country: "ca",
      default_currency: "CAD",
      business_profile: { name: "Third Railify Official", support_email: "private@example.test" },
      type: "standard",
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      external_accounts: { data: [{ last4: "1234" }] },
      individual: { email: "private@example.test" },
    });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.stripe.com/v1/account");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${credential}`);
  assert.equal(Object.keys(calls[0].init.headers).some((name) => name.toLowerCase() === "stripe-account"), false);
  const rows = await harness.commerceDb.prepare("SELECT * FROM commerce_provider_connections WHERE provider = 'stripe'").all();
  assert.equal(rows.results.length, 1);
  const row = rows.results[0]; const metadata = JSON.parse(row.safe_metadata_json);
  assert.equal(row.status, "connected"); assert.equal(row.integration_mode, "direct_merchant"); assert.equal(row.credential_custody, "environment_secret");
  assert.equal(row.environment, "test"); assert.equal(row.external_account_id, "acct_TestCanadian123"); assert.equal(row.country_code, "CA"); assert.equal(row.currency_code, "cad");
  assert.equal(row.credential_ciphertext, null); assert.ok(row.last_synchronized_at);
  assert.deepEqual(metadata, { account_display_name: "Third Railify Official", account_created: true, api_configured: true, webhook_configured: false, checkout_enabled: false, live_payments_enabled: false, live_payout_readiness: "unverified", charges_enabled: true, payouts_enabled: false, details_submitted: true, account_type: "standard", payment_methods: ["cards", "eligible_apple_pay", "eligible_google_pay"] });
  assert.doesNotMatch(JSON.stringify(row), /notARealRestrictedKey|support_email|external_accounts|individual|private@example/);
  const projected = overview.providers.find((provider) => provider.provider === "stripe");
  assert.equal(overview.stripeSecretConfigured, true); assert.equal(projected.status, "connected"); assert.equal(projected.apiConfigured, true);
  assert.equal(projected.webhookConfigured, false); assert.equal(projected.checkoutEnabled, false); assert.equal(projected.livePaymentsEnabled, false); assert.equal(projected.livePayoutReadiness, "unverified");
  assert.equal(projected.metadata.chargesEnabled, true); assert.equal(projected.metadata.payoutsEnabled, false); assert.equal(projected.metadata.detailsSubmitted, true);
  const apiSetting = await harness.commerceDb.prepare("SELECT value_json, updated_by_account_id FROM commerce_settings WHERE setting_key = 'stripe_api_configured'").first();
  assert.deepEqual(apiSetting, { value_json: "true", updated_by_account_id: "master" });
  const audit = await harness.commerceDb.prepare("SELECT action, result, metadata_json FROM commerce_audit WHERE action = 'stripe.account_verified'").first();
  assert.equal(audit.result, "success"); assert.match(audit.metadata_json, /acct_TestCanadian123/); assert.doesNotMatch(audit.metadata_json, /notARealRestrictedKey|Authorization|business_profile|external_accounts|individual/);
});

test("Stripe account verification fails closed for missing, live, mismatched, or malformed provider state", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const session = { accountId: "master", account: { adminLevel: "master" } };
  let called = 0; const shouldNotFetch = async () => { called += 1; throw new Error("unexpected fetch"); };
  await assert.rejects(verifyStripeAccount(commerceEnvironment(harness, { STRIPE_SECRET_KEY: "" }), session, shouldNotFetch), (error) => error.code === "stripe_credential_unavailable");
  await assert.rejects(verifyStripeAccount(commerceEnvironment(harness, { STRIPE_SECRET_KEY: "rk_live_notARealKey123" }), session, shouldNotFetch), (error) => error.code === "stripe_test_credential_required");
  await assert.rejects(verifyStripeAccount(commerceEnvironment(harness, { STRIPE_SECRET_KEY: "sk_live_notARealKey123" }), session, shouldNotFetch), (error) => error.code === "stripe_test_credential_required");
  await assert.rejects(verifyStripeAccount(commerceEnvironment(harness, { AUTH_ENVIRONMENT: "production", STRIPE_SECRET_KEY: "rk_test_notARealKey123" }), session, shouldNotFetch), (error) => error.code === "stripe_verification_environment_unsupported");
  assert.equal(called, 0);
  const testEnv = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "sk_test_notARealKey123" });
  await assert.rejects(verifyStripeAccount(testEnv, session, async () => Response.json({ id: "acct_WrongCountry", country: "US", default_currency: "cad" })), (error) => error.code === "stripe_account_mismatch");
  await assert.rejects(verifyStripeAccount(testEnv, session, async () => Response.json({ id: "acct_WrongCurrency", country: "CA", default_currency: "usd" })), (error) => error.code === "stripe_account_mismatch");
  await assert.rejects(verifyStripeAccount(testEnv, session, async () => Response.json({ id: "not-an-account", country: "CA", default_currency: "cad", raw_secret: "do-not-store" })), (error) => error.code === "stripe_provider_response_invalid");
  await assert.rejects(verifyStripeAccount({}, session, shouldNotFetch), (error) => error.code === "commerce_database_unavailable");
  const row = await harness.commerceDb.prepare("SELECT status, external_account_id, safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe'").first();
  assert.equal(row.status, "setup_required"); assert.equal(row.external_account_id, null); assert.equal(JSON.parse(row.safe_metadata_json).api_configured, false); assert.doesNotMatch(row.safe_metadata_json, /do-not-store/);
  const apiSetting = await harness.commerceDb.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'stripe_api_configured'").first();
  assert.equal(apiSetting.value_json, "false");
  const audits = await harness.commerceDb.prepare("SELECT result, metadata_json FROM commerce_audit WHERE action = 'stripe.account_verification_failed'").all();
  assert.ok(audits.results.length >= 5); assert.match(JSON.stringify(audits.results), /missing_configuration|account_mismatch|provider_error/); assert.doesNotMatch(JSON.stringify(audits.results), /notARealKey|do-not-store/);
});

test("later successful Stripe account verification preserves verified webhook configuration", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { STRIPE_SECRET_KEY: "rk_test_notARealRestrictedKey123" });
  const session = { accountId: "master", account: { adminLevel: "master" } };
  const row = await harness.commerceDb.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe'").first();
  const metadata = { ...JSON.parse(row.safe_metadata_json), webhook_configured: true };
  await harness.commerceDb.batch([
    harness.commerceDb.prepare("UPDATE commerce_provider_connections SET safe_metadata_json = ? WHERE provider = 'stripe'").bind(JSON.stringify(metadata)),
    harness.commerceDb.prepare("UPDATE commerce_settings SET value_json = 'true' WHERE setting_key = 'stripe_webhook_configured'"),
  ]);
  const overview = await verifyStripeAccount(env, session, async () => Response.json({ id: "acct_TestCanadian123", country: "CA", default_currency: "cad" }));
  assert.equal(overview.providers.find((provider) => provider.provider === "stripe").webhookConfigured, true);
  const stored = await harness.commerceDb.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe'").first();
  assert.equal(JSON.parse(stored.safe_metadata_json).webhook_configured, true);
});

test("provider status remains truthful and the Printful model has two independent transactions", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness); const session = { accountId: "master", account: { adminLevel: "master" } };
  const overview = await commerceOverview(env, session);
  assert.equal(overview.posture.checkout, "disabled"); assert.equal(overview.posture.livePaymentCapture, "disabled"); assert.equal(overview.posture.fulfillmentSubmission, "disabled");
  const stripe = overview.providers.find((provider) => provider.provider === "stripe");
  assert.equal(stripe.integrationMode, "direct_merchant"); assert.equal(stripe.credentialCustody, "environment_secret"); assert.equal(stripe.environment, "test"); assert.equal(stripe.status, "setup_required");
  assert.equal(stripe.accountCreated, true); assert.equal(stripe.apiConfigured, false); assert.equal(stripe.webhookConfigured, false); assert.equal(stripe.checkoutEnabled, false); assert.equal(stripe.livePaymentsEnabled, false); assert.equal(stripe.livePayoutReadiness, "unverified");
  assert.equal(stripe.externalAccountId, null); assert.equal(stripe.countryCode, "CA"); assert.equal(stripe.currencyCode, "CAD");
  assert.equal(overview.providers.find((provider) => provider.provider === "paypal").status, "deferred");
  assert.equal(overview.providers.find((provider) => provider.provider === "paypal").integrationMode, "direct_merchant");
  assertNoCommerceSecretsInPublicPayload(overview);
  assert.match(PRINTFUL_TWO_TRANSACTION_MODEL.customerTransaction, /Stripe/); assert.match(PRINTFUL_TWO_TRANSACTION_MODEL.fulfillmentTransaction, /Printful separately/);
  assert.ok(PRINTFUL_TWO_TRANSACTION_MODEL.trackedAmounts.includes("printful_refund_credit_amount"));
});

test("missing commerce infrastructure does not overstate the dedicated Stripe account", async () => {
  const overview = await commerceOverview({}, { accountId: "master", account: { adminLevel: "master" } });
  const stripe = overview.providers.find((provider) => provider.provider === "stripe");
  assert.equal(overview.databaseConfigured, false); assert.equal(overview.posture.checkout, "disabled"); assert.equal(overview.posture.livePaymentCapture, "disabled");
  assert.equal(stripe.accountCreated, true); assert.equal(stripe.apiConfigured, false); assert.equal(stripe.webhookConfigured, false); assert.equal(stripe.checkoutEnabled, false); assert.equal(stripe.livePaymentsEnabled, false); assert.equal(stripe.livePayoutReadiness, "unverified");
  assert.equal(PROVIDER_BLUEPRINTS.some((provider) => provider.provider !== "stripe" && provider.provider.startsWith("stripe")), false);
});

test("runtime commerce scaffold has no Connect request or secret requirement", async () => {
  const files = [
    new URL("../functions/_shared/commerce-core.js", import.meta.url),
    new URL("../functions/api/admin/commerce/[[path]].js", import.meta.url),
    new URL("../commerce-migrations/0001_commerce_control_plane.sql", import.meta.url),
    new URL("../.env.example", import.meta.url),
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /STRIPE_CONNECT_CLIENT_ID|STRIPE_CONNECTED_ACCOUNT_ID|STRIPE_PLATFORM_ACCOUNT_ID/i);
  assert.doesNotMatch(source, /Stripe-Account|application_fee_amount|transfer_data|account\.updated|requirements\.currently_due/i);
  assert.doesNotMatch(source, /stripe_connected_account|stripe_platform|account_link|onboarding_enabled/i);
  assert.doesNotMatch(source, /shawndclift@gmail\.com|thirdrailify@gmail\.com/i);
});
