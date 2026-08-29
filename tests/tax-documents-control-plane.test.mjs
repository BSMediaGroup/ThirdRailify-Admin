import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as commerceRequest } from "../functions/api/admin/commerce/[[path]].js";
import { createTaxRegistration, taxRegistrationsPayload, templatePreviewPayload, updateTaxRegistration } from "../functions/_shared/commerce-control-plane.js";
import { updateTemplate } from "../functions/_shared/commerce-core.js";
import { createSession, ensureEnvironmentMasters, loadAccountByEmail } from "../functions/_shared/auth-core.js";
import { cookiePair, jsonRequest } from "./auth-test-helpers.mjs";
import { commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const ADMIN_ORIGIN = "https://thirdrailify-admin.pages.dev";
const master = { accountId: "master-test", account: { adminLevel: "master" } };

test("tax registration custody is masked, audited, normalized, document-aware, and revision-safe", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness);
  const secret = "123456789RT0001";
  const created = await createTaxRegistration(env, master, { registrationType: "gst_hst", jurisdiction: "on", countryCode: "ca", provinceCode: "on", identifier: secret, status: "unverified", effectiveDate: "2026-08-29", expiresAt: "", notes: "Operator supplied", documentDisclosureEnabled: false });
  const registration = created.registrations[0]; assert.equal(registration.countryCode, "CA"); assert.equal(registration.provinceCode, "ON"); assert.equal(registration.jurisdiction, "ON"); assert.match(registration.maskedIdentifier, /0001$/); assert.doesNotMatch(JSON.stringify(created), new RegExp(secret));
  assert.equal(created.registrationState.externallyVerified, false); assert.equal(created.calculation.provider, "unconfigured"); assert.equal(created.calculation.ratesConfigured, false); assert.equal(created.documents.tokenizedAccessSupported, true); assert.equal(created.documents.customerAccessEnabled, false);
  const stored = await harness.commerceDb.prepare("SELECT identifier_ciphertext,masked_identifier,revision FROM commerce_tax_registrations WHERE id=?").bind(registration.id).first(); assert.doesNotMatch(stored.identifier_ciphertext, new RegExp(secret)); assert.equal(stored.revision, 1);
  const mutation = { registrationType: registration.registrationType, jurisdiction: "ON", countryCode: registration.countryCode, provinceCode: registration.provinceCode, identifier: "", status: "inactive", effectiveDate: registration.effectiveDate, expiresAt: registration.expiresAt, notes: registration.notes, documentDisclosureEnabled: registration.documentDisclosureEnabled, revision: 1 };
  const updated = await updateTaxRegistration(env, master, registration.id, mutation); assert.equal(updated.registrations[0].revision, 2); assert.equal(updated.registrations[0].status, "inactive");
  await assert.rejects(updateTaxRegistration(env, master, registration.id, { ...mutation, status: "active" }), /changed after you opened it/i);
  const audit = await harness.commerceDb.prepare("SELECT action,metadata_json FROM commerce_audit WHERE target_id=? ORDER BY created_at").bind(registration.id).all(); assert.deepEqual(audit.results.map((row) => row.action), ["tax_registration_created", "tax_registration_deactivated"]); assert.doesNotMatch(JSON.stringify(audit.results), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(await taxRegistrationsPayload(env, master)), /identifier_ciphertext|A256GCM|access_token_hash/i);
});

test("receipt and invoice templates enforce structured allowlists and optimistic revisions without preview side effects", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness);
  const row = await harness.commerceDb.prepare("SELECT * FROM commerce_templates WHERE template_key='payment_receipt'").first(); const template = serializeTemplate(row);
  const saved = await updateTemplate(env, master, "payment_receipt", { ...template, footer: "Receipt footer {{support_email}}" }); const receipt = saved.templates.find((item) => item.templateKey === "payment_receipt"); assert.equal(receipt.revision, 2);
  await assert.rejects(updateTemplate(env, master, "payment_receipt", { ...template, footer: "Stale overwrite" }), /changed after you opened it/i);
  await assert.rejects(updateTemplate(env, master, "invoice_document", { ...serializeTemplate(await harness.commerceDb.prepare("SELECT * FROM commerce_templates WHERE template_key='invoice_document'").first()), heading: "{{unknown_legal_value}}" }), /Unsupported template variables/i);
  await assert.rejects(updateTemplate(env, master, "invoice_document", { ...serializeTemplate(await harness.commerceDb.prepare("SELECT * FROM commerce_templates WHERE template_key='invoice_document'").first()), introduction: '<img src=x onerror="send()">' }), /structured plain text/i);
  const previewInput = serializeTemplate(await harness.commerceDb.prepare("SELECT * FROM commerce_templates WHERE template_key='payment_receipt'").first());
  const before = await tableCounts(harness.commerceDb); const preview = await templatePreviewPayload(env, master, "payment_receipt", { template: previewInput }); const after = await tableCounts(harness.commerceDb);
  assert.equal(preview.test, true); assert.equal(preview.source, "synthetic_fixture"); assert.match(preview.preview.text, /TEST-ORDER-PREVIEW/); assert.match(preview.preview.text, /PAYMENT RECEIPT/); assert.match(preview.preview.html, /SAMPLE · TEST · NOT ISSUED/); assert.match(preview.preview.html, /email-assets\/trzapcolorcon\.svg/); assert.match(preview.preview.html, /Third Railify lightning logo/); assert.match(preview.preview.html, /<th[^>]*>Item<\/th>/); assert.deepEqual(after, before);
  const invoiceInput = serializeTemplate(await harness.commerceDb.prepare("SELECT * FROM commerce_templates WHERE template_key='invoice_document'").first());
  const invoice = await templatePreviewPayload(env, master, "invoice_document", { template: invoiceInput });
  assert.match(invoice.preview.text, /INVOICE \/ SALES DOCUMENT/); assert.match(invoice.preview.html, /INVOICE \/ SALES DOCUMENT/); assert.doesNotMatch(invoice.preview.html, /PAYMENT RECEIPT<\/span><\/td><\/tr><tr><td height/); assert.match(invoice.preview.html, /American Captain|Blinker/); assert.deepEqual(await tableCounts(harness.commerceDb), before);
  const audits = await harness.commerceDb.prepare("SELECT action,metadata_json FROM commerce_audit WHERE target_id='payment_receipt'").all(); assert.equal(audits.results.at(-1).action, "receipt_template_updated"); assert.doesNotMatch(JSON.stringify(audits.results), /<img|unknown_legal_value/);
});

test("view-only admins can read masked tax/templates and render a CSRF-protected preview but cannot mutate either authority", async (t) => {
  const harness = await createCommerceDatabases(); t.after(harness.dispose); const env = commerceEnvironment(harness); await ensureEnvironmentMasters(env); const now = new Date().toISOString();
  await harness.authDb.prepare("INSERT INTO accounts (id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES ('tax-viewer','tax-viewer@example.test','Tax Viewer','admin','full','active',?,?,?,'test')").bind(now, now, now).run();
  const account = await loadAccountByEmail(env, "tax-viewer@example.test"); const session = await createSession(env, new Request(`${ADMIN_ORIGIN}/`, { headers: { Origin: ADMIN_ORIGIN } }), account, ADMIN_ORIGIN); const cookie = cookiePair(session.cookie);
  for (const path of ["tax", "templates"]) { const response = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/${path}`, { method: "GET", origin: ADMIN_ORIGIN, cookie }), env, data: {} }); assert.equal(response.status, 200); }
  const template = serializeTemplate(await harness.commerceDb.prepare("SELECT * FROM commerce_templates WHERE template_key='payment_receipt'").first());
  const preview = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/templates/payment_receipt/preview`, { origin: ADMIN_ORIGIN, cookie, csrfToken: session.csrfToken, body: { template } }), env, data: {} }); assert.equal(preview.status, 200); assert.equal((await preview.json()).source, "synthetic_fixture");
  const noCsrfPreview = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/templates/payment_receipt/preview`, { origin: ADMIN_ORIGIN, cookie, body: { template } }), env, data: {} }); assert.equal(noCsrfPreview.status, 403);
  const taxMutation = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/tax`, { origin: ADMIN_ORIGIN, cookie, csrfToken: session.csrfToken, body: { registrationType: "gst_hst", jurisdiction: "ON", countryCode: "CA", provinceCode: "ON", identifier: "PRIVATE", status: "unverified" } }), env, data: {} }); assert.equal(taxMutation.status, 403);
  const templateMutation = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/templates/payment_receipt`, { origin: ADMIN_ORIGIN, cookie, csrfToken: session.csrfToken, body: template }), env, data: {} }); assert.equal(templateMutation.status, 403);
  const wrongOrigin = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/tax`, { method: "GET", origin: "https://evil.example", cookie }), env, data: {} }); assert.equal(wrongOrigin.status, 403);
  const unauthenticated = await commerceRequest({ request: jsonRequest(`${ADMIN_ORIGIN}/api/admin/commerce/tax`, { method: "GET", origin: ADMIN_ORIGIN }), env, data: {} }); assert.equal(unauthenticated.status, 401);
});

async function tableCounts(db) { const [documents, deliveries, orders] = await Promise.all([db.prepare("SELECT COUNT(*) count FROM commerce_order_documents").first(), db.prepare("SELECT COUNT(*) count FROM commerce_email_deliveries").first(), db.prepare("SELECT COUNT(*) count FROM commerce_orders").first()]); return { documents: documents.count, deliveries: deliveries.count, orders: orders.count }; }
function serializeTemplate(row) { return { templateKey: row.template_key, templateKind: row.template_kind, displayName: row.display_name, subject: row.subject, preheader: row.preheader, heading: row.heading, introduction: row.introduction, bodyBlocks: JSON.parse(row.body_blocks_json), ctaLabel: row.cta_label, ctaUrl: row.cta_url, supportText: row.support_text, footer: row.footer, accentColor: row.accent_color, status: row.status, enabled: row.enabled === 1, revision: Number(row.revision) }; }
