import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import {
  customerDocumentByToken,
  businessInformationPayload,
  commerceEmailDeliveryKey,
  createTaxRegistration,
  issueOrderDocumentAccess,
  orderDocumentPreviewPayload,
  productionReadinessPayload,
  renderCommerceTemplate,
  sendTestTemplateEmail,
  taxRegistrationsPayload,
  templatePreviewPayload,
  updateTaxRegistration,
  validateTemplatePlaceholders,
} from "../functions/_shared/commerce-control-plane.js";
import { businessProfilePayload, updateBusinessProfile, updateTemplate } from "../functions/_shared/commerce-core.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases, insertTestProduct, insertTestVariant } from "./commerce-test-helpers.mjs";

const master = { accountId: "master-admin", account: { adminLevel: "master" } };
const acceptedOrderId = "ord_e47b94a4-4252-438b-8ca7-c47470029940";
const adminOrigin = "https://thirdrailify-admin.pages.dev";

test("permanent business profile keeps safe defaults and encrypts private legal fields with purpose-bound custody", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const updated = await updateBusinessProfile(env, master, {
    revision: 1,
    tradingName: "Third Railify Official", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD",
    publicContactEmail: "INFO@ThirdRailify.com", supportEmail: "support@thirdrailify.com", publicPhone: "", websiteUrl: "",
    publicAddress: {}, legalBusinessName: "Private Legal Entity", privatePhone: "+1 416 555 0100",
    businessRegistrationNumber: "PRIVATE-REG-123", privateAddress: { line1: "1 Private Way", city: "Toronto", province: "ON", postalCode: "M5V 1A1", country: "CA" },
    invoicePrefix: "", documentFooter: "", invoiceAccentColor: "#f3c928", receiptAccentColor: "#f3c928",
  });
  assert.equal(updated.profile.tradingName, "Third Railify Official");
  assert.equal(updated.profile.publicContactEmail, "info@thirdrailify.com");
  assert.equal(updated.profile.private.legalBusinessNameMasked, "Encrypted value configured");
  assert.equal(updated.profile.private.privateAddressMasked, "Encrypted address configured");
  assert.match(updated.profile.private.privatePhoneMasked, /0100$/);
  assert.match(updated.profile.private.businessRegistrationNumberMasked, /G123$/);
  const row = await harness.commerceDb.prepare("SELECT * FROM commerce_business_profiles WHERE id='primary'").first();
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /Private Legal Entity|Private Way|PRIVATE-REG-123|416 555/);
  assert.match(row.legal_business_name_ciphertext, /A256GCM/);
  const publicPayload = JSON.stringify((await businessProfilePayload(env, master)).profile);
  assert.doesNotMatch(publicPayload, /Private Legal Entity|Private Way|PRIVATE-REG-123|416 555|ciphertext|A256GCM/);
  const controlPlane = await businessInformationPayload(env, master);
  assert.equal(controlPlane.readiness.profile.coreIdentity, "complete");
  assert.equal(controlPlane.readiness.profile.legalIdentity, "complete");
  assert.equal(controlPlane.readiness.dependencies.paypalRequired, false);
  assert.equal(controlPlane.readiness.documentIdentity.taxRegistrationState, "not_configured");
  await assert.rejects(updateBusinessProfile(env, master, { unexpected: true }), /fields are invalid/i);
  await assert.rejects(updateBusinessProfile(env, master, { revision: 1, tradingName: "Stale" }), /changed in another session/i);
});

test("operator-owned business address and phone text save independently from transaction-disclosure readiness", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const address = { line1: "  Happy Birthday  ", line2: "<script>globalThis.businessProfileExecuted=true</script>", city: "", province: "region words", postalCode: "  unconventional postal text ✨  ", country: "" };
  const saved = await updateBusinessProfile(env, master, {
    revision: 1, tradingName: "Third Railify Official", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD",
    publicContactEmail: "info@thirdrailify.com", supportEmail: "", businessPhone: null, websiteUrl: "", businessAddress: address,
  });
  assert.deepEqual(saved.profile.businessAddress, { ...address, line1: "Happy Birthday", postalCode: "unconventional postal text ✨" });
  assert.deepEqual(saved.profile.publicAddress, saved.profile.businessAddress, "legacy Admin alias remains compatible");
  assert.equal(saved.profile.businessPhone, ""); assert.equal(saved.profile.publicPhone, "");
  const row = await harness.commerceDb.prepare("SELECT public_address_json,public_phone,revision FROM commerce_business_profiles WHERE id='primary'").first();
  assert.deepEqual(JSON.parse(row.public_address_json), saved.profile.businessAddress); assert.equal(row.public_phone, null); assert.equal(row.revision, 2);
  const readiness = await businessInformationPayload(env, master);
  assert.equal(readiness.canonicalReadiness.domains.business.ready, false);
  assert.equal(readiness.canonicalReadiness.domains.business.details.status, "transaction_disclosure_incomplete");
  assert.equal(readiness.canonicalReadiness.domains.business.details.semanticAddressVerification, false);
  assert.equal(readiness.canonicalReadiness.domains.business.details.globalSiteProjection, false);
  assert.equal(readiness.readiness.profile.address, "partial");
  await assert.rejects(updateBusinessProfile(env, master, { revision: 2, businessAddress: { line1: "x".repeat(181) } }), /180 characters or fewer/i);
  await assert.rejects(updateBusinessProfile(env, master, { revision: 2, businessAddress: { line1: "unsafe\u0000control" } }), /invalid control/i);
});

test("unauthorized business-profile mutation is rejected without changing operator data", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const response = await commerceRequest({
    request: jsonRequest(`${adminOrigin}/api/admin/commerce/business`, { method: "POST", origin: adminOrigin, body: { revision: 1, businessAddress: { line1: "Happy Birthday" } } }),
    env,
    data: { commerceFetch: async () => { throw new Error("provider call forbidden"); } },
  });
  assert.equal(response.status, 401);
  assert.equal((await harness.commerceDb.prepare("SELECT revision,public_address_json FROM commerce_business_profiles WHERE id='primary'").first()).revision, 1);
});

test("tax registrations validate, encrypt, mask, revise, and never invent rates", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const created = await createTaxRegistration(env, master, { registrationType: "gst_hst", jurisdiction: "CA", countryCode: "CA", provinceCode: "", identifier: "123456789RT0001", status: "unverified", effectiveDate: "", expiresAt: "", notes: "Operator supplied", documentDisclosureEnabled: false });
  assert.equal(created.registrations.length, 1);
  assert.match(created.registrations[0].maskedIdentifier, /0001$/);
  assert.equal(created.calculation.provider, "not_collecting");
  assert.equal(created.calculation.ratesConfigured, false);
  assert.doesNotMatch(JSON.stringify(created), /123456789RT0001|identifierCiphertext/);
  const row = await harness.commerceDb.prepare("SELECT * FROM commerce_tax_registrations").first();
  assert.match(row.identifier_ciphertext, /A256GCM/); assert.doesNotMatch(row.identifier_ciphertext, /123456789/);
  const revised = await updateTaxRegistration(env, master, row.id, { registrationType: "gst_hst", jurisdiction: "CA", countryCode: "CA", provinceCode: "", identifier: "", status: "inactive", effectiveDate: "", expiresAt: "", notes: "Deactivated by operator", documentDisclosureEnabled: false, revision: 1 });
  assert.equal(revised.registrations[0].status, "inactive"); assert.equal(revised.registrations[0].revision, 2);
  await assert.rejects(createTaxRegistration(env, master, { registrationType: "made_up", jurisdiction: "CA", countryCode: "CA", identifier: "x", status: "active" }), /GST\/HST/i);
  await assert.rejects(createTaxRegistration(env, master, { registrationType: "other", jurisdiction: "?", countryCode: "C", identifier: "x", status: "active" }), /country code/i);
  const taxPayload = await taxRegistrationsPayload(env, master); assert.equal(taxPayload.readiness.ready, true); assert.equal(taxPayload.calculation.provider, "not_collecting"); assert.equal(taxPayload.registrationState.configured, true); assert.equal(taxPayload.calculation.ratesConfigured, false);
});

test("template variables are allowlisted and preview uses the production renderer", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  const template = { templateKey: "order_confirmation", templateKind: "email", displayName: "Order confirmation", subject: "Paid {{order_reference}}", preheader: "", heading: "Thanks {{customer_name}}", introduction: "Total {{order_total}} {{currency}}", bodyBlocks: ["{{product_summary}}"], ctaLabel: "Receipt", ctaUrl: "{{receipt_url}}", supportText: "{{support_email}}", footer: "Third Railify Official", accentColor: "#f3c928", status: "ready", enabled: true, revision: 1 };
  const saved = await updateTemplate(env, master, "order_confirmation", template);
  assert.equal(saved.templates.find((entry) => entry.templateKey === "order_confirmation").enabled, true);
  const preview = await templatePreviewPayload(env, master, "order_confirmation", { template });
  const direct = renderCommerceTemplate(template, preview.variables);
  assert.equal(preview.preview.text, direct.text); assert.equal(preview.source, "synthetic_fixture"); assert.equal(preview.test, true);
  assert.throws(() => validateTemplatePlaceholders({ ...template, subject: "{{stripe_session_id}}" }), /Unsupported template variables/i);
  assert.throws(() => validateTemplatePlaceholders({ ...template, subject: "{{order_reference" }), /malformed/i);
  await assert.rejects(updateTemplate(env, master, "order_confirmation", { ...template, introduction: '<img src=x onerror="bad">' }), /structured plain text/i);
});

test("test email delivery is explicit, prefixed, audited, and deterministic across retries", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { RESEND_API_KEY: "resend-secret", MAIL_FROM: "Third Railify Official <alerts@notify.thirdrailify.com>", MAIL_REPLY_TO: "info@thirdrailify.com" });
  let calls = 0;
  const fetchImpl = async (url, init) => { calls += 1; assert.equal(url, "https://api.resend.com/emails"); assert.equal(init.headers.Authorization, "Bearer resend-secret"); assert.match(init.headers["Idempotency-Key"], /^[0-9a-f]{64}$/); const body = JSON.parse(init.body); assert.equal(body.to[0], "admin@example.test"); assert.match(body.subject, /^\[TEST\/PREVIEW\]/); assert.doesNotMatch(init.body, /resend-secret/); return Response.json({ id: "safe-provider-message-id" }); };
  const first = await sendTestTemplateEmail(env, master, "order_confirmation", { recipient: "Admin@Example.test" }, fetchImpl);
  const second = await sendTestTemplateEmail(env, master, "order_confirmation", { recipient: "admin@example.test" }, fetchImpl);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true); assert.equal(calls, 1);
  const ledger = await harness.commerceDb.prepare("SELECT status,attempt_count,provider_message_id,safe_metadata_json FROM commerce_email_deliveries").first();
  assert.deepEqual({ status: ledger.status, attempts: ledger.attempt_count, provider: ledger.provider_message_id }, { status: "sent", attempts: 1, provider: "safe-provider-message-id" });
  assert.doesNotMatch(JSON.stringify(ledger), /resend-secret|<html|admin@example/);
  const webhookDeliveryOne = await commerceEmailDeliveryKey({ templateKey: "order_confirmation", templateRevision: 2, orderId: acceptedOrderId, eventKey: "payment_confirmed", recipient: "customer@example.test" });
  const webhookDeliveryDuplicate = await commerceEmailDeliveryKey({ templateKey: "order_confirmation", templateRevision: 2, orderId: acceptedOrderId, eventKey: "payment_confirmed", recipient: "customer@example.test" });
  assert.equal(webhookDeliveryOne, webhookDeliveryDuplicate);
});

test("paid TEST receipt is truthful and opaque customer tokens cannot enumerate unrelated orders", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  await seedAcceptedOrder(harness.commerceDb);
  const preview = await orderDocumentPreviewPayload(env, master, acceptedOrderId, "receipt");
  assert.equal(preview.document.available, true); assert.equal(preview.document.marker, "TEST / SANDBOX");
  assert.equal(preview.document.merchantName, "Third Railify Official"); assert.equal(preview.document.payment, "Confirmed"); assert.equal(preview.document.fulfillment, "Disabled / not started");
  assert.equal(preview.document.items[0].productName, "Third Rail Farm | Black Glossy Mug"); assert.equal(preview.document.items[0].variantName, "11 oz / Black"); assert.equal(preview.document.total, 1500);
  assert.match(preview.document.html, /THIRD RAILIFY OFFICIAL/); assert.match(preview.document.html, /email-assets\/trzapcolorcon\.svg/); assert.match(preview.document.html, /PAYMENT RECEIPT/); assert.match(preview.document.html, /Third Rail Farm \| Black Glossy Mug/); assert.match(preview.document.text, /Payment receipt/i); assert.doesNotMatch(preview.document.text, /<\/?[a-z][^>]*>/i);
  assert.equal(preview.document.tax, null); assert.equal(preview.document.shipping, null); assert.equal(preview.document.legalName, null); assert.equal("stripeSessionId" in preview.document, false);
  const invoice = await orderDocumentPreviewPayload(env, master, acceptedOrderId, "invoice"); assert.equal(invoice.document.available, false); assert.match(invoice.document.reason, /tax configuration/i); assert.match(invoice.document.html, /INVOICE \/ SALES DOCUMENT/); assert.doesNotMatch(invoice.document.html, /<span[^>]*>PAYMENT RECEIPT<\/span>/);
  await assert.rejects(issueOrderDocumentAccess(env, master, acceptedOrderId, "receipt"), /remains disabled/i);
  await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key='customer_document_access_enabled'").run();
  const issued = await issueOrderDocumentAccess(env, master, acceptedOrderId, "receipt"); assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  const stored = await harness.commerceDb.prepare("SELECT access_token_hash,snapshot_json FROM commerce_order_documents").first(); assert.match(stored.access_token_hash, /^[0-9a-f]{64}$/); assert.equal(stored.snapshot_json.includes(issued.token), false);
  assert.equal((await customerDocumentByToken(env, issued.token)).document.orderReference, acceptedOrderId);
  await assert.rejects(customerDocumentByToken(env, "A".repeat(43)), /not found/i);
  await assert.rejects(customerDocumentByToken(env, "short"), /not found/i);
});

test("central readiness is derived and keeps test acceptance separate from production gates", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness, { RESEND_API_KEY: "configured", MAIL_FROM: "Third Railify Official <alerts@example.test>" });
  await seedAcceptedOrder(harness.commerceDb);
  await harness.commerceDb.prepare("UPDATE commerce_provider_connections SET status='connected',environment='test',safe_metadata_json=json_set(safe_metadata_json,'$.api_configured',json('true'),'$.webhook_configured',json('true')) WHERE provider='stripe'").run();
  await harness.commerceDb.prepare("UPDATE commerce_settings SET value_json='true' WHERE setting_key IN ('stripe_api_configured','stripe_webhook_configured')").run();
  await harness.commerceDb.prepare("INSERT INTO commerce_catalogue_migrations (id,status,phase,products_verified,variants_mapped,safe_state_json,updated_at) VALUES ('permanent-printful-2026-08','waiting','source_files',12,238,?,'now')").bind(JSON.stringify({ plannedProducts: 49, manualPause: true, blockedProducts: Array.from({ length: 28 }, (_, index) => ({ index })) })).run();
  const payload = await productionReadinessPayload(env, master);
  assert.equal(payload.productionReady, false); assert.equal(payload.domains.payments.details.stripeHistoricalAcceptancePassed, true); assert.equal(payload.domains.payments.details.stripeEnabled, false); assert.equal(payload.domains.payments.ready, false);
  assert.equal(payload.domains.catalogue.ready, true); assert.equal(payload.domains.shipping.ready, false); assert.equal(payload.domains.fulfillment.details.migrationPaused, true); assert.equal(payload.domains.fulfillment.details.processedProducts, 40);
  assert.equal(payload.domains.checkout.details.normalCheckoutEnabled, false); assert.equal(payload.domains.checkout.details.transactionDisclosureEnabled, false); assert.equal(payload.domains.tax.details.calculationProvider, "not_collecting"); assert.equal(payload.domains.tax.ready, true);
  assert.doesNotMatch(JSON.stringify(payload), /secret|identifier_ciphertext|tax_registration/);
  assert.equal("production_ready" in payload, false);
});

test("authenticated Commerce GET projections smoke across every control-plane surface without provider calls", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose);
  const env = commerceEnvironment(harness);
  await harness.commerceDb.prepare("INSERT INTO commerce_orders(id,payment_status,fulfillment_status,currency_code,customer_gross_amount,environment,checkout_status,created_at,updated_at) VALUES('ord-control-smoke','pending','disabled','CAD',0,'test','checkout_pending','2026-08-29T00:00:00Z','2026-08-29T00:00:00Z')").run();
  await ensureEnvironmentMasters(env);
  const account = await loadAccountByEmail(env, "master-one@example.test");
  const session = await createSession(env, new Request(`${adminOrigin}/`, { headers: { Origin: adminOrigin } }), account, adminOrigin);
  const cookie = cookiePair(session.cookie);
  let providerCalls = 0;
  const paths = [
    "overview", "payments", "business", "tax", "emails", "fulfillment",
    "products/list?page=1&pageSize=20", "collections/list?page=1&pageSize=20", "orders?page=1&pageSize=20", "orders/ord-control-smoke",
  ];
  for (const path of paths) {
    const response = await commerceRequest({
      request: jsonRequest(`${adminOrigin}/api/admin/commerce/${path}`, { method: "GET", origin: adminOrigin, cookie }),
      env,
      data: { commerceFetch: async () => { providerCalls += 1; throw new Error("provider call forbidden"); } },
    });
    assert.equal(response.status, 200, path);
    const payload = await response.json(); assert.equal(payload.ok, true, path);
    assert.doesNotMatch(JSON.stringify(payload), /The template fields are invalid|The account service is temporarily unavailable/i, path);
  }
  assert.equal(providerCalls, 0);
});

async function seedAcceptedOrder(db) {
  await insertTestProduct(db, { id: "product-acceptance", slug: "third-rail-farm-black-glossy-mug", title: "Third Rail Farm | Black Glossy Mug", unitAmount: 1500 });
  await insertTestVariant(db, { id: "variant-acceptance", productId: "product-acceptance", unitAmount: 1500, sizeLabel: "11 oz", colorLabel: "Black", optionValuesJson: '{"Size":"11 oz","Color":"Black"}' });
  await db.prepare(`INSERT INTO commerce_orders (id,payment_status,fulfillment_status,currency_code,customer_gross_amount,environment,checkout_status,stripe_checkout_session_id,payment_confirmed_at,created_at,updated_at)
    VALUES (?,'paid','disabled','CAD',1500,'test','checkout_created','cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC','2026-08-28T00:00:00Z','2026-08-28T00:00:00Z','2026-08-28T00:00:00Z')`).bind(acceptedOrderId).run();
  await db.prepare(`INSERT INTO commerce_order_items (id,order_id,line_number,product_id,variant_id,product_name,variant_name,option_values_json,currency_code,unit_amount,quantity,line_total_amount,requires_shipping,created_at)
    VALUES ('item-acceptance',?,1,'product-acceptance','variant-acceptance','Third Rail Farm | Black Glossy Mug','11 oz / Black','{"Size":"11 oz","Color":"Black"}','CAD',1500,1,1500,1,'2026-08-28T00:00:00Z')`).bind(acceptedOrderId).run();
  await db.prepare(`INSERT INTO commerce_webhook_events (provider,provider_event_id,event_type,received_at,livemode,related_object_id,related_object_type,processing_status,processed_at,result_code)
    VALUES ('stripe','evt_1U9OysB2jGrq9Tn1apdsFgi2','checkout.session.completed','2026-08-28T00:00:00Z',0,'cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC','checkout.session','processed','2026-08-28T00:00:00Z','payment_confirmed')`).run();
}
