import { AuthFailure, cleanText, nowIso, randomId, sendAccountEmail } from "./auth-core.js";
import {
  commerceAccessForSession,
  COMMERCE_TEMPLATE_VARIABLES,
  decryptCommerceSecret,
  encryptCommerceSecret,
  maskTaxIdentifier,
  requireCommerceDb,
  validateTemplate,
  writeCommerceAudit,
} from "./commerce-core.js";

export { COMMERCE_TEMPLATE_VARIABLES };

const TAX_TYPES = new Set(["gst_hst", "qst", "pst", "rst", "other"]);
const TAX_STATUSES = new Set(["unverified", "pending", "verified", "active", "inactive", "expired", "not_registered", "unavailable"]);
const ACCEPTED_TEST_ORDER_ID = "ord_e47b94a4-4252-438b-8ca7-c47470029940";

export async function taxRegistrationsPayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  const result = await requireCommerceDb(env).prepare(
    `SELECT id, registration_type, jurisdiction, country_code, province_code, masked_identifier,
            status, effective_date, expires_at, notes, document_disclosure_enabled, revision, updated_at
     FROM commerce_tax_registrations WHERE business_profile_id = 'primary'
     ORDER BY country_code, province_code, registration_type, jurisdiction`,
  ).all();
  return {
    ok: true,
    access,
    registrations: (result?.results || []).map(serializeTaxRegistration),
    calculation: { provider: "unconfigured", stripeTax: "not_enabled_unverified", ratesConfigured: false },
    readiness: { ready: false, status: "blocked", reason: "An explicit tax calculation strategy and operator-approved registrations are required." },
  };
}

export async function createTaxRegistration(env, session, input) {
  const db = requireCommerceDb(env);
  const id = randomId();
  const value = validateTaxRegistration(input, null);
  const timestamp = nowIso();
  const ciphertext = await encryptCommerceSecret(env, value.identifier, `tax-registration:${id}:identifier`);
  try {
    await db.prepare(
      `INSERT INTO commerce_tax_registrations (
         id, business_profile_id, registration_type, jurisdiction, country_code, province_code,
         identifier_ciphertext, masked_identifier, status, effective_date, expires_at, notes,
         document_disclosure_enabled, revision, created_at, updated_at, updated_by_account_id
       ) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(id, value.registrationType, value.jurisdiction, value.countryCode, value.provinceCode,
      ciphertext, maskTaxIdentifier(value.identifier), value.status, value.effectiveDate, value.expiresAt,
      value.notes, value.documentDisclosureEnabled ? 1 : 0, timestamp, timestamp, session.accountId).run();
  } catch (error) {
    if (/unique/i.test(String(error?.message || error))) throw new AuthFailure(409, "tax_registration_duplicate", "That jurisdiction and registration type already exist.");
    throw error;
  }
  await writeCommerceAudit(env, { actorAccountId: session.accountId, action: "tax_registration_created", targetType: "commerce_tax_registration", targetId: id, result: "success", metadata: { registrationType: value.registrationType, jurisdiction: value.jurisdiction, status: value.status } });
  return taxRegistrationsPayload(env, session);
}

export async function updateTaxRegistration(env, session, registrationId, input) {
  const db = requireCommerceDb(env);
  const id = validId(registrationId, "tax_registration_id_invalid");
  const current = await db.prepare("SELECT * FROM commerce_tax_registrations WHERE id = ? AND business_profile_id = 'primary'").bind(id).first();
  if (!current) throw new AuthFailure(404, "tax_registration_not_found", "The tax registration was not found.");
  const value = validateTaxRegistration(input, current);
  const ciphertext = value.identifier
    ? await encryptCommerceSecret(env, value.identifier, `tax-registration:${id}:identifier`)
    : current.identifier_ciphertext;
  const masked = value.identifier ? maskTaxIdentifier(value.identifier) : current.masked_identifier;
  const timestamp = nowIso();
  try {
    await db.prepare(
      `UPDATE commerce_tax_registrations SET registration_type=?, jurisdiction=?, country_code=?, province_code=?,
         identifier_ciphertext=?, masked_identifier=?, status=?, effective_date=?, expires_at=?, notes=?,
         document_disclosure_enabled=?, revision=revision+1, updated_at=?, updated_by_account_id=? WHERE id=?`,
    ).bind(value.registrationType, value.jurisdiction, value.countryCode, value.provinceCode, ciphertext, masked,
      value.status, value.effectiveDate, value.expiresAt, value.notes, value.documentDisclosureEnabled ? 1 : 0,
      timestamp, session.accountId, id).run();
  } catch (error) {
    if (/unique/i.test(String(error?.message || error))) throw new AuthFailure(409, "tax_registration_duplicate", "That jurisdiction and registration type already exist.");
    throw error;
  }
  await writeCommerceAudit(env, { actorAccountId: session.accountId, action: value.status === "inactive" ? "tax_registration_deactivated" : "tax_registration_updated", targetType: "commerce_tax_registration", targetId: id, result: "success", metadata: { registrationType: value.registrationType, jurisdiction: value.jurisdiction, status: value.status, identifierReplaced: Boolean(value.identifier) } });
  return taxRegistrationsPayload(env, session);
}

export async function productionReadinessPayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  const db = requireCommerceDb(env);
  const [profile, registrations, providersResult, settingsResult, catalogue, migration, templatesResult, acceptedOrder, acceptedWebhook] = await Promise.all([
    db.prepare("SELECT * FROM commerce_business_profiles WHERE id='primary'").first(),
    db.prepare("SELECT status, COUNT(*) count FROM commerce_tax_registrations GROUP BY status").all(),
    db.prepare("SELECT provider,status,environment,safe_metadata_json FROM commerce_provider_connections WHERE provider IN ('stripe','printful')").all(),
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled','live_payment_capture_enabled','fulfillment_submission_enabled','stripe_api_configured','stripe_webhook_configured','stripe_test_checkout_enabled','tax_calculation_provider','stripe_tax_enabled','shipping_strategy','transactional_email_enabled','customer_document_access_enabled')").all(),
    db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN visibility='public' AND status='active' THEN 1 ELSE 0 END) public_count FROM commerce_products").first(),
    db.prepare("SELECT status,phase,products_verified,variants_mapped,safe_state_json FROM commerce_catalogue_migrations WHERE id='permanent-printful-2026-08'").first(),
    db.prepare("SELECT template_kind,status,enabled,COUNT(*) count FROM commerce_templates GROUP BY template_kind,status,enabled").all(),
    db.prepare("SELECT id,payment_status,fulfillment_status,environment,customer_gross_amount,stripe_checkout_session_id,printful_order_id FROM commerce_orders WHERE id=?").bind(ACCEPTED_TEST_ORDER_ID).first(),
    db.prepare("SELECT provider_event_id FROM commerce_webhook_events WHERE provider='stripe' AND provider_event_id='evt_1U9OysB2jGrq9Tn1apdsFgi2' AND related_object_id='cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC' AND processing_status='processed' AND result_code='payment_confirmed'").first(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, null)]));
  const providers = Object.fromEntries((providersResult?.results || []).map((row) => [row.provider, { ...row, metadata: json(row.safe_metadata_json, {}) }]));
  const migrationState = json(migration?.safe_state_json, {});
  const activeTaxCount = (registrations?.results || []).filter((row) => ["verified", "active"].includes(row.status)).reduce((sum, row) => sum + Number(row.count || 0), 0);
  const emailReadyCount = (templatesResult?.results || []).filter((row) => row.template_kind === "email" && row.status === "ready" && row.enabled === 1).reduce((sum, row) => sum + Number(row.count || 0), 0);
  const receiptTemplateReady = (templatesResult?.results || []).some((row) => row.template_kind === "document" && row.status === "ready" && row.enabled === 1 && Number(row.count) > 0);
  const legalIdentity = Boolean(profile?.legal_business_name_ciphertext && profile?.business_registration_number_ciphertext);
  const address = Boolean(profile?.private_address_ciphertext);
  const merchantIdentity = Boolean(profile?.trading_name && profile?.country_code === "CA" && profile?.province_code === "ON" && profile?.currency_code === "CAD");
  const contact = Boolean(profile?.public_contact_email && profile?.support_email);
  const stripeTestConnected = providers.stripe?.status === "connected" && providers.stripe?.environment === "test" && providers.stripe?.metadata?.api_configured === true && settings.stripe_api_configured === true && providers.stripe?.metadata?.webhook_configured === true && settings.stripe_webhook_configured === true;
  const testAcceptancePassed = Boolean(acceptedOrder?.payment_status === "paid" && acceptedOrder?.environment === "test" && acceptedOrder?.customer_gross_amount === 1500 && acceptedOrder?.stripe_checkout_session_id === "cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC" && acceptedWebhook?.provider_event_id === "evt_1U9OysB2jGrq9Tn1apdsFgi2" && !acceptedOrder?.printful_order_id);
  const livePaymentsReady = providers.stripe?.status === "connected" && providers.stripe?.environment === "live" && providers.stripe?.metadata?.live_payments_enabled === true && settings.live_payment_capture_enabled === true;
  const businessReady = merchantIdentity && legalIdentity && address && contact;
  const taxStrategyReady = settings.tax_calculation_provider !== "unconfigured" && activeTaxCount > 0;
  const migrationComplete = migration?.status === "complete" && migrationState.manualPause !== true;
  const domains = {
    business: domain(businessReady, businessReady ? "Merchant, legal identity, address, and contact are configured." : "Operator legal identity, private address, business number, or support contact remains incomplete.", { merchantIdentity, legalIdentity, businessAddress: address, contact }),
    tax: domain(taxStrategyReady, taxStrategyReady ? "Tax registrations and calculation strategy are configured." : "Tax calculation provider is unconfigured; registrations are not treated as legal advice.", { registrationsConfigured: activeTaxCount > 0, calculationProvider: String(settings.tax_calculation_provider || "unconfigured"), stripeTax: settings.stripe_tax_enabled === true ? "enabled_unverified" : "not_enabled_unverified", ratesConfigured: false }),
    payments: domain(livePaymentsReady, stripeTestConnected && testAcceptancePassed ? "Stripe TEST acceptance passed; live credentials and payments remain disabled." : livePaymentsReady ? "Live Stripe payment configuration is enabled." : "Stripe TEST acceptance evidence is incomplete.", { stripeTestConnected, testAcceptancePassed, livePaymentsEnabled: settings.live_payment_capture_enabled === true }),
    catalogue: domain(Number(catalogue?.public_count || 0) > 0, `${Number(catalogue?.public_count || 0)} public products are served from permanent Commerce D1 authority.`, { totalProducts: Number(catalogue?.total || 0), publicProducts: Number(catalogue?.public_count || 0), merchandisingReady: Number(catalogue?.public_count || 0) > 0 }),
    shipping: domain(Boolean(settings.shipping_strategy && settings.shipping_strategy !== "unconfigured"), settings.shipping_strategy && settings.shipping_strategy !== "unconfigured" ? "Shipping strategy is configured." : "Shipping policy and rate calculation are not configured.", { strategy: String(settings.shipping_strategy || "unconfigured") }),
    fulfillment: domain(migrationComplete && settings.fulfillment_submission_enabled === true, migrationState.manualPause === true ? "Printful is connected; catalogue migration is manually paused and fulfillment is disabled." : "Printful catalogue migration or fulfillment activation remains incomplete.", { printfulConnected: providers.printful?.status === "connected", migrationPaused: migrationState.manualPause === true, migrationStatus: cleanText(migration?.status, 30) || "not_started", processedProducts: Number(migration?.products_verified || 0) + (Array.isArray(migrationState.blockedProducts) ? migrationState.blockedProducts.length : 0), plannedProducts: Number(migrationState.plannedProducts || 0), verifiedProducts: Number(migration?.products_verified || 0), blockedProducts: Array.isArray(migrationState.blockedProducts) ? migrationState.blockedProducts.length : 0, variantsMapped: Number(migration?.variants_mapped || 0), enabled: settings.fulfillment_submission_enabled === true }),
    communications: domain(Boolean(env?.RESEND_API_KEY && env?.MAIL_FROM && emailReadyCount >= 2 && settings.transactional_email_enabled === true), "Resend custody is server-side; required customer templates and the production send gate are not all enabled.", { providerConfigured: Boolean(env?.RESEND_API_KEY && env?.MAIL_FROM), readyTemplates: emailReadyCount, sendEnabled: settings.transactional_email_enabled === true }),
    documents: domain(receiptTemplateReady && businessReady && taxStrategyReady, receiptTemplateReady ? "Payment receipts are renderable; invoice readiness is blocked by business or tax configuration." : "Receipt and invoice document templates are incomplete.", { receiptTemplateReady, receiptReady: receiptTemplateReady, invoiceReady: receiptTemplateReady && businessReady && taxStrategyReady, customerAccessEnabled: settings.customer_document_access_enabled === true }),
    checkout: domain(settings.checkout_enabled === true, settings.checkout_enabled === true ? "Normal checkout is enabled." : "Normal checkout is disabled.", { normalCheckoutEnabled: settings.checkout_enabled === true, controlledTestCheckoutEnabled: settings.stripe_test_checkout_enabled === true }),
  };
  const mandatory = ["business", "tax", "payments", "catalogue", "shipping", "fulfillment", "communications", "documents", "checkout"];
  return { ok: true, access, authority: "Commerce D1", phase: "pre_cutover", productionReady: mandatory.every((key) => domains[key].ready), mandatoryDomains: mandatory, domains, checkedAt: nowIso() };
}

export async function templatePreviewPayload(env, session, templateKey, input) {
  await commerceAccessForSession(env, session);
  const source = await templateRow(requireCommerceDb(env), templateKey);
  const template = input?.template ? validateTemplate({ ...input.template, templateKey }) : serializeTemplateForValidation(source);
  const fixture = input?.orderId ? await orderVariables(requireCommerceDb(env), input.orderId) : syntheticVariables();
  return { ok: true, preview: renderCommerceTemplate(template, fixture.variables), source: fixture.source, test: fixture.test, orderId: fixture.orderId || null, variables: fixture.variables };
}

export function validateTemplatePlaceholders(template) {
  const unknown = new Set();
  for (const value of templateTextValues(template)) {
    for (const match of String(value || "").matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
      if (!COMMERCE_TEMPLATE_VARIABLES.includes(match[1].toLowerCase())) unknown.add(match[1].toLowerCase());
    }
    if (/\{\{[^}]*$|^[^{]*\}\}/.test(String(value || ""))) throw new AuthFailure(400, "template_placeholder_invalid", "A template placeholder is malformed.");
  }
  if (unknown.size) throw new AuthFailure(400, "template_placeholder_unknown", `Unsupported template variables: ${[...unknown].join(", ")}.`);
  return true;
}

export function renderCommerceTemplate(template, variables) {
  validateTemplatePlaceholders(template);
  const merge = (value) => String(value || "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_all, key) => cleanText(variables?.[key.toLowerCase()], 4000));
  const rendered = {
    templateKey: cleanText(template.templateKey, 60),
    displayName: cleanText(template.displayName, 120) || cleanText(template.templateKey, 60),
    subject: merge(template.subject), preheader: merge(template.preheader), heading: merge(template.heading),
    introduction: merge(template.introduction), bodyBlocks: (template.bodyBlocks || []).map(merge),
    ctaLabel: merge(template.ctaLabel), ctaUrl: merge(template.ctaUrl), supportText: merge(template.supportText), footer: merge(template.footer),
    accentColor: /^#[0-9a-f]{6}$/i.test(String(template.accentColor || "")) ? String(template.accentColor).toLowerCase() : "#f3c928",
  };
  rendered.text = [rendered.heading, rendered.introduction, ...rendered.bodyBlocks, rendered.ctaLabel && rendered.ctaUrl ? `${rendered.ctaLabel}: ${rendered.ctaUrl}` : "", rendered.supportText, rendered.footer].filter(Boolean).join("\n\n");
  rendered.html = `<!doctype html><html><body style="margin:0;background:#111;color:#f7f7f7;font-family:Arial,sans-serif"><main style="max-width:640px;margin:auto;padding:32px"><p style="color:${rendered.accentColor};font-weight:700">THIRD RAILIFY OFFICIAL</p><h1>${escapeHtml(rendered.heading)}</h1>${[rendered.introduction, ...rendered.bodyBlocks].filter(Boolean).map((value) => `<p>${escapeHtml(value).replaceAll("\n", "<br>")}</p>`).join("")}${rendered.ctaLabel && rendered.ctaUrl ? `<p><a href="${escapeAttribute(rendered.ctaUrl)}">${escapeHtml(rendered.ctaLabel)}</a></p>` : ""}<p>${escapeHtml(rendered.supportText)}</p><footer>${escapeHtml(rendered.footer)}</footer></main></body></html>`;
  return rendered;
}

export async function sendTestTemplateEmail(env, session, templateKey, input, fetchImpl = fetch) {
  const recipient = email(input?.recipient);
  const db = requireCommerceDb(env);
  const row = await templateRow(db, templateKey);
  if (row.template_kind !== "email") throw new AuthFailure(409, "template_email_required", "Only customer email templates can be test-sent.");
  const fixture = input?.orderId ? await orderVariables(db, input.orderId) : syntheticVariables();
  const rendered = renderCommerceTemplate(serializeTemplateForValidation(row), fixture.variables);
  const eventKey = `test-preview:${row.template_key}:${row.revision}:${fixture.orderId || "synthetic"}:${recipient}`;
  const deliveryKey = await commerceEmailDeliveryKey({ templateKey: row.template_key, templateRevision: Number(row.revision), orderId: fixture.orderId, eventKey, recipient, purpose: "test_preview" });
  const timestamp = nowIso();
  await db.prepare(
    `INSERT OR IGNORE INTO commerce_email_deliveries (id,delivery_key,template_key,template_revision,order_id,event_key,recipient_email,purpose,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'test_preview','pending',?,?)`,
  ).bind(randomId(), deliveryKey, row.template_key, Number(row.revision), fixture.orderId || null, eventKey, recipient, timestamp, timestamp).run();
  const existing = await db.prepare("SELECT id,status,provider_message_id FROM commerce_email_deliveries WHERE delivery_key=?").bind(deliveryKey).first();
  if (existing.status === "sent") return { ok: true, duplicate: true, status: "sent", recipient, providerMessageId: cleanText(existing.provider_message_id, 200) || null };
  const claimed = await db.prepare("UPDATE commerce_email_deliveries SET status='sending',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status IN ('pending','failed')").bind(timestamp, existing.id).run();
  if (Number(claimed?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "email_delivery_in_progress", "This deterministic test delivery is already in progress.");
  try {
    const result = await sendAccountEmail(env, { to: recipient, subject: `[TEST/PREVIEW] ${rendered.subject}`, html: rendered.html, text: rendered.text, replyTo: env?.MAIL_REPLY_TO || "info@thirdrailify.com", idempotencyKey: deliveryKey }, fetchImpl);
    await db.prepare("UPDATE commerce_email_deliveries SET status='sent',provider_message_id=?,sent_at=?,updated_at=? WHERE id=?").bind(result?.providerMessageId || null, nowIso(), nowIso(), existing.id).run();
  } catch (error) {
    await db.prepare("UPDATE commerce_email_deliveries SET status='failed',safe_metadata_json=?,updated_at=? WHERE id=?").bind(JSON.stringify({ error: cleanText(error?.message, 120) || "delivery_failed" }), nowIso(), existing.id).run();
    throw new AuthFailure(502, "email_delivery_failed", "The test email provider rejected the bounded delivery.");
  }
  await writeCommerceAudit(env, { actorAccountId: session.accountId, action: "template_test_email_requested", targetType: "commerce_template", targetId: row.template_key, result: "success", metadata: { purpose: "test_preview", source: fixture.source, deliveryKey } });
  return { ok: true, duplicate: false, status: "sent", recipient };
}

export async function commerceEmailDeliveryKey({ templateKey, templateRevision, orderId = null, eventKey, recipient, purpose = "transactional" }) {
  const normalized = {
    v: 1,
    templateKey: validId(templateKey, "template_key_invalid"),
    templateRevision: Number(templateRevision),
    orderId: orderId ? validId(orderId, "order_id_invalid") : null,
    eventKey: cleanText(eventKey, 200),
    recipient: email(recipient),
    purpose: purpose === "test_preview" ? "test_preview" : "transactional",
  };
  if (!Number.isSafeInteger(normalized.templateRevision) || normalized.templateRevision < 1 || !normalized.eventKey) throw new AuthFailure(400, "email_delivery_identity_invalid", "The deterministic email delivery identity is invalid.");
  return sha256Hex(JSON.stringify(normalized));
}

export async function orderDocumentPreviewPayload(env, session, orderId, documentType = "receipt") {
  await commerceAccessForSession(env, session);
  const db = requireCommerceDb(env);
  const type = documentTypeValue(documentType);
  const readiness = await productionReadinessPayload(env, session);
  const snapshot = await buildDocumentSnapshot(env, db, orderId, type, readiness.domains.documents.details.invoiceReady);
  return { ok: true, document: snapshot, access: readiness.access };
}

export async function issueOrderDocumentAccess(env, session, orderId, documentType = "receipt") {
  const db = requireCommerceDb(env);
  const enabled = json((await db.prepare("SELECT value_json FROM commerce_settings WHERE setting_key='customer_document_access_enabled'").first())?.value_json, false) === true;
  if (!enabled) throw new AuthFailure(409, "customer_document_access_disabled", "Customer document access remains disabled until production activation.");
  const type = documentTypeValue(documentType);
  const readiness = await productionReadinessPayload(env, session);
  const snapshot = await buildDocumentSnapshot(env, db, orderId, type, readiness.domains.documents.details.invoiceReady);
  if (!snapshot.available) throw new AuthFailure(409, "document_not_ready", snapshot.reason);
  const existing = await db.prepare("SELECT id,status FROM commerce_order_documents WHERE order_id=? AND document_type=?").bind(snapshot.orderReference, type).first();
  if (existing?.status === "issued") throw new AuthFailure(409, "document_already_issued", "This immutable document has already been issued; its access token is not recoverable.");
  const rawToken = randomToken();
  const hash = await sha256Hex(rawToken);
  const timestamp = nowIso();
  const id = existing?.id || randomId();
  await db.prepare(
    `INSERT INTO commerce_order_documents (id,order_id,document_type,display_reference,environment,status,template_key,template_revision,snapshot_json,access_token_hash,issued_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'issued',?,?,?, ?,?,?,?)
     ON CONFLICT(order_id,document_type) DO UPDATE SET status='issued',snapshot_json=excluded.snapshot_json,access_token_hash=excluded.access_token_hash,issued_at=excluded.issued_at,updated_at=excluded.updated_at`,
  ).bind(id, snapshot.orderReference, type, snapshot.displayReference, snapshot.test ? "test" : "live", snapshot.templateKey, snapshot.templateRevision, JSON.stringify(snapshot), hash, timestamp, timestamp, timestamp).run();
  await writeCommerceAudit(env, { actorAccountId: session.accountId, action: "order_document_issued", targetType: "commerce_order_document", targetId: id, result: "success", metadata: { documentType: type, environment: snapshot.test ? "test" : "live" } });
  return { ok: true, token: rawToken, documentId: id, document: snapshot };
}

export async function customerDocumentByToken(env, token) {
  const raw = String(token || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new AuthFailure(404, "document_not_found", "The receipt document was not found.");
  const hash = await sha256Hex(raw);
  const row = await requireCommerceDb(env).prepare("SELECT snapshot_json FROM commerce_order_documents WHERE access_token_hash=? AND status='issued'").bind(hash).first();
  if (!row) throw new AuthFailure(404, "document_not_found", "The receipt document was not found.");
  const document = json(row.snapshot_json, null);
  if (!document) throw new AuthFailure(503, "document_snapshot_invalid", "The immutable document snapshot is unavailable.");
  return { ok: true, document };
}

async function buildDocumentSnapshot(env, db, orderId, type, invoiceReady) {
  const id = validId(orderId, "order_id_invalid");
  const [order, itemsResult, profile, template] = await Promise.all([
    db.prepare("SELECT id,payment_status,fulfillment_status,currency_code,customer_gross_amount,environment,payment_confirmed_at,created_at FROM commerce_orders WHERE id=?").bind(id).first(),
    db.prepare("SELECT product_name,variant_name,option_values_json,unit_amount,quantity,line_total_amount FROM commerce_order_items WHERE order_id=? ORDER BY line_number").bind(id).all(),
    db.prepare("SELECT trading_name,legal_business_name_ciphertext,private_address_ciphertext,public_contact_email,support_email FROM commerce_business_profiles WHERE id='primary'").first(),
    templateRow(db, type === "receipt" ? "payment_receipt" : "invoice_document"),
  ]);
  if (!order) throw new AuthFailure(404, "order_not_found", "The commerce order was not found.");
  const available = type === "receipt" ? order.payment_status === "paid" : order.payment_status === "paid" && invoiceReady;
  const reason = available ? "" : type === "invoice" ? "Invoice readiness is blocked until legal business and tax configuration are complete." : "A payment receipt is available only after payment is confirmed.";
  let legalName = null;
  let legalAddress = null;
  if (profile?.legal_business_name_ciphertext) legalName = await decryptCommerceSecret(env, profile.legal_business_name_ciphertext, "business:legal-name");
  if (profile?.private_address_ciphertext) legalAddress = json(await decryptCommerceSecret(env, profile.private_address_ciphertext, "business:private-address"), null) || await decryptCommerceSecret(env, profile.private_address_ciphertext, "business:private-address");
  const items = (itemsResult?.results || []).map((item) => ({ productName: cleanText(item.product_name, 240), variantName: cleanText(item.variant_name, 300) || null, options: json(item.option_values_json, {}), unitAmount: Number(item.unit_amount), quantity: Number(item.quantity), lineTotalAmount: Number(item.line_total_amount) }));
  return {
    type, available, reason, test: order.environment === "test", marker: order.environment === "test" ? "TEST / SANDBOX" : "LIVE",
    displayReference: type === "receipt" ? id : `Invoice preview for ${id}`, orderReference: id,
    merchantName: cleanText(profile?.trading_name, 160) || "Third Railify Official",
    legalName: legalName || null, legalAddress: legalAddress || null,
    supportEmail: cleanText(profile?.support_email || profile?.public_contact_email, 254) || "info@thirdrailify.com",
    issuedAt: cleanText(order.payment_confirmed_at || order.created_at, 80), payment: order.payment_status === "paid" ? "Confirmed" : "Not confirmed",
    fulfillment: order.fulfillment_status === "disabled" ? "Disabled / not started" : cleanText(order.fulfillment_status, 40),
    items, subtotal: items.reduce((sum, item) => sum + item.lineTotalAmount, 0), shipping: null, tax: null,
    total: Number(order.customer_gross_amount), currency: cleanText(order.currency_code, 3).toUpperCase(),
    templateKey: template.template_key, templateRevision: Number(template.revision),
    disclosures: [], providerIds: undefined,
  };
}

function validateTaxRegistration(input, current) {
  const allowed = new Set(["registrationType", "jurisdiction", "countryCode", "provinceCode", "identifier", "status", "effectiveDate", "expiresAt", "notes", "documentDisclosureEnabled", "revision"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) throw new AuthFailure(400, "tax_registration_fields_invalid", "The tax registration fields are invalid.");
  if (current && Number(input.revision) !== Number(current.revision)) throw new AuthFailure(409, "tax_registration_revision_conflict", "This registration changed in another session. Reload before saving.");
  const registrationType = cleanText(input.registrationType ?? current?.registration_type, 30).toLowerCase();
  if (!TAX_TYPES.has(registrationType)) throw new AuthFailure(400, "tax_registration_type_invalid", "Registration type must be GST/HST, QST, PST, RST, or OTHER.");
  const countryCode = cleanText(input.countryCode ?? current?.country_code, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new AuthFailure(400, "tax_jurisdiction_invalid", "A two-letter country code is required.");
  const provinceCode = cleanText(input.provinceCode ?? current?.province_code, 3).toUpperCase() || null;
  if (provinceCode && !/^[A-Z]{2,3}$/.test(provinceCode)) throw new AuthFailure(400, "tax_jurisdiction_invalid", "The province or state code is invalid.");
  const jurisdiction = cleanText(input.jurisdiction ?? current?.jurisdiction ?? provinceCode ?? countryCode, 80).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 ._/-]{1,79}$/.test(jurisdiction)) throw new AuthFailure(400, "tax_jurisdiction_invalid", "The tax jurisdiction is invalid.");
  const identifier = privateText(input.identifier, 100);
  if (!current && !identifier) throw new AuthFailure(400, "tax_identifier_required", "A registration identifier is required and will be encrypted.");
  const status = cleanText(input.status ?? current?.status, 30).toLowerCase();
  if (!TAX_STATUSES.has(status)) throw new AuthFailure(400, "tax_registration_status_invalid", "The registration status is invalid.");
  const effectiveDate = optionalDate(input.effectiveDate ?? current?.effective_date, "tax_effective_date_invalid");
  const expiresAt = optionalDate(input.expiresAt ?? current?.expires_at, "tax_expiry_date_invalid");
  if (effectiveDate && expiresAt && expiresAt < effectiveDate) throw new AuthFailure(400, "tax_date_range_invalid", "The expiry date cannot precede the effective date.");
  return { registrationType, countryCode, provinceCode, jurisdiction, identifier, status, effectiveDate, expiresAt, notes: cleanText(input.notes ?? current?.notes, 1000) || null, documentDisclosureEnabled: input.documentDisclosureEnabled === true };
}

function serializeTaxRegistration(row) { return { id: cleanText(row.id, 160), registrationType: cleanText(row.registration_type, 30), jurisdiction: cleanText(row.jurisdiction, 80), countryCode: cleanText(row.country_code, 2), provinceCode: cleanText(row.province_code, 3) || null, maskedIdentifier: cleanText(row.masked_identifier, 40), status: cleanText(row.status, 30), effectiveDate: cleanText(row.effective_date, 10) || null, expiresAt: cleanText(row.expires_at, 10) || null, notes: cleanText(row.notes, 1000), documentDisclosureEnabled: row.document_disclosure_enabled === 1, revision: Number(row.revision), updatedAt: cleanText(row.updated_at, 80) }; }
function domain(ready, summary, details) { return { ready: Boolean(ready), status: ready ? "ready" : "blocked", summary, details }; }
function validId(value, code) { const id = cleanText(value, 160); if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(id)) throw new AuthFailure(400, code, "The identifier is invalid."); return id; }
function optionalDate(value, code) { const text = cleanText(value, 10); if (!text) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new AuthFailure(400, code, "Enter a valid ISO date."); return text; }
function privateText(value, length) { const text = String(value ?? "").trim(); if (text.length > length || /[\u0000-\u001f\u007f]/.test(text)) throw new AuthFailure(400, "private_value_invalid", "The private value is invalid."); return text; }
function email(value) { const result = cleanText(value, 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new AuthFailure(400, "email_invalid", "Enter a valid recipient email address."); return result; }
function json(value, fallback) { try { return value && typeof value === "object" ? value : JSON.parse(String(value || "")); } catch { return fallback; } }
function documentTypeValue(value) { const type = cleanText(value, 20).toLowerCase(); if (!new Set(["receipt", "invoice"]).has(type)) throw new AuthFailure(400, "document_type_invalid", "The document type is invalid."); return type; }
function serializeTemplateForValidation(row) { return { templateKey: row.template_key, displayName: row.display_name, subject: row.subject, preheader: row.preheader, heading: row.heading, introduction: row.introduction, bodyBlocks: json(row.body_blocks_json, []), ctaLabel: row.cta_label, ctaUrl: row.cta_url, supportText: row.support_text, footer: row.footer, accentColor: row.accent_color, status: row.status, enabled: row.enabled === 1, revision: Number(row.revision), templateKind: row.template_kind }; }
async function templateRow(db, key) { const templateKey = cleanText(key, 60); const row = await db.prepare("SELECT * FROM commerce_templates WHERE template_key=?").bind(templateKey).first(); if (!row) throw new AuthFailure(404, "template_not_found", "The commerce template was not found."); return row; }
function syntheticVariables() { return { source: "synthetic_fixture", test: true, orderId: null, variables: { order_reference: "TEST-ORDER-PREVIEW", customer_name: "Preview customer", merchant_name: "Third Railify Official", order_total: "15.00", currency: "CAD", product_summary: "Third Rail Farm | Black Glossy Mug — 11 oz / Black × 1", support_email: "info@thirdrailify.com", receipt_url: "https://example.invalid/test-receipt", shipping_method: "Not configured", tracking_number: "Not available" } }; }
async function orderVariables(db, orderId) { const id = validId(orderId, "order_id_invalid"); const [order, items] = await Promise.all([db.prepare("SELECT id,environment,currency_code,customer_gross_amount FROM commerce_orders WHERE id=?").bind(id).first(), db.prepare("SELECT product_name,variant_name,quantity FROM commerce_order_items WHERE order_id=? ORDER BY line_number").bind(id).all()]); if (!order) throw new AuthFailure(404, "order_not_found", "The commerce order was not found."); return { source: "selected_order", test: order.environment === "test", orderId: id, variables: { order_reference: id, customer_name: "Customer", merchant_name: "Third Railify Official", order_total: (Number(order.customer_gross_amount) / 100).toFixed(2), currency: cleanText(order.currency_code, 3).toUpperCase(), product_summary: (items?.results || []).map((item) => `${cleanText(item.product_name, 240)}${item.variant_name ? ` — ${cleanText(item.variant_name, 300)}` : ""} × ${Number(item.quantity)}`).join("; "), support_email: "info@thirdrailify.com", receipt_url: "", shipping_method: "Not configured", tracking_number: "Not available" } }; }
function templateTextValues(template) { return [template.subject, template.preheader, template.heading, template.introduction, ...(template.bodyBlocks || []), template.ctaLabel, template.ctaUrl, template.supportText, template.footer]; }
function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function escapeAttribute(value) { const text = cleanText(value, 500); if (!(text.startsWith("/") && !text.startsWith("//")) && !/^https:\/\//i.test(text)) return "#"; return escapeHtml(text); }
async function sha256Hex(value) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function randomToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, ""); }
