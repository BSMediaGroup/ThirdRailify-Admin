import assert from "node:assert/strict";
import test from "node:test";
import {
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
  validateTemplate,
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

test("provider status remains truthful and the Printful model has two independent transactions", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness); const session = { accountId: "master", account: { adminLevel: "master" } };
  const overview = await commerceOverview(env, session);
  assert.equal(overview.posture.checkout, "disabled"); assert.equal(overview.posture.livePaymentCapture, "disabled"); assert.equal(overview.posture.fulfillmentSubmission, "disabled");
  assert.equal(overview.providers.find((provider) => provider.provider === "stripe_connected_account").status, "setup_required");
  assert.equal(overview.providers.find((provider) => provider.provider === "paypal").status, "deferred");
  assert.match(PRINTFUL_TWO_TRANSACTION_MODEL.customerTransaction, /Stripe/); assert.match(PRINTFUL_TWO_TRANSACTION_MODEL.fulfillmentTransaction, /Printful separately/);
});
