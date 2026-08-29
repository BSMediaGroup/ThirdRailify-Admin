import { AuthFailure, cleanText, nowIso, randomId, sendAccountEmail } from "./auth-core.js";
import {
  businessProfilePayload,
  commerceOverview,
  commerceAccessForSession,
  COMMERCE_TEMPLATE_VARIABLES,
  decryptCommerceSecret,
  encryptCommerceSecret,
  isStripeTestCredentialConfigured,
  isStripeWebhookSigningConfigured,
  isCommerceDbConfigured,
  maskTaxIdentifier,
  requireCommerceDb,
  validateTemplate,
  writeCommerceAudit,
} from "./commerce-core.js";

export { COMMERCE_TEMPLATE_VARIABLES };

const TAX_TYPES = new Set(["gst_hst", "qst", "pst", "rst", "other"]);
const TAX_STATUSES = new Set(["unverified", "pending", "verified", "active", "inactive", "expired", "not_registered", "unavailable"]);
const ACCEPTED_TEST_ORDER_ID = "ord_e47b94a4-4252-438b-8ca7-c47470029940";
const ACCEPTED_TEST_SESSION_ID = "cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC";
const ACCEPTED_TEST_EVENT_ID = "evt_1U9OysB2jGrq9Tn1apdsFgi2";

export async function businessInformationPayload(env, session) {
  const business = await businessProfilePayload(env, session);
  if (!isCommerceDbConfigured(env)) {
    return {
      ...business,
      authority: "Commerce D1",
      privacy: businessPrivacyBoundary(),
      readiness: emptyBusinessReadiness(),
      canonicalReadiness: null,
    };
  }
  const db = requireCommerceDb(env);
  const [canonicalReadiness, templateResult] = await Promise.all([
    productionReadinessPayload(env, session),
    db.prepare("SELECT template_key,status,enabled,revision FROM commerce_templates WHERE template_key IN ('payment_receipt','invoice_document','order_confirmation','receipt_notification') ORDER BY template_key").all(),
  ]);
  const profile = business.profile;
  const templates = Object.fromEntries((templateResult?.results || []).map((row) => [row.template_key, row]));
  const registrations = profile.private.registrations;
  const activeTaxRegistrations = registrations.filter((item) => ["active", "verified"].includes(item.status));
  const coreItems = [
    readinessItem("trading_name", "Trading name", Boolean(profile.tradingName), profile.tradingName || "Not configured"),
    readinessItem("merchant_country", "Merchant country", profile.countryCode === "CA", profile.countryCode === "CA" ? "Canada" : "Action required"),
    readinessItem("merchant_region", "Merchant region", profile.provinceCode === "ON", profile.provinceCode === "ON" ? "Ontario" : "Action required"),
    readinessItem("commerce_currency", "Commerce currency", profile.currencyCode === "CAD", profile.currencyCode || "Not configured"),
  ];
  const contactItems = [
    readinessItem("public_contact", "Public contact email", Boolean(profile.publicContactEmail), profile.publicContactEmail || "Not configured"),
    readinessItem("support_contact", "Customer support email", Boolean(profile.supportEmail), profile.supportEmail || "Not configured"),
    optionalReadinessItem("public_phone", "Public phone", Boolean(profile.publicPhone), profile.publicPhone || "Not configured / not required"),
    optionalReadinessItem("website", "Website", Boolean(profile.websiteUrl), profile.websiteUrl || "Not configured / not required"),
  ];
  const legalItems = [
    storedReadinessItem("legal_name", "Legal business name", profile.private.legalBusinessNameStored),
    storedReadinessItem("business_address", "Legal business address", profile.private.privateAddressStored),
    storedReadinessItem("business_registration", "Business registration number", profile.private.businessRegistrationNumberStored),
  ];
  const taxState = activeTaxRegistrations.length ? "complete" : registrations.length ? "unverified" : "not_configured";
  const receiptTemplateReady = templates.payment_receipt?.status === "ready" && Number(templates.payment_receipt?.enabled) === 1;
  const invoiceTemplateReady = templates.invoice_document?.status === "ready" && Number(templates.invoice_document?.enabled) === 1;
  const readiness = {
    overallStatus: canonicalReadiness.domains.business.ready ? "complete" : "action_required",
    completion: businessCompletion([...coreItems, ...contactItems.slice(0, 2), ...legalItems]),
    groups: [
      readinessGroup("core", "Core merchant identity", coreItems),
      readinessGroup("contact", "Customer contact", contactItems),
      readinessGroup("legal", "Legal / document identity", legalItems),
      readinessGroup("tax", "Tax", [statusReadinessItem("tax_registration", "Tax registration status", taxState, activeTaxRegistrations.length ? `${activeTaxRegistrations.length} active or verified registration${activeTaxRegistrations.length === 1 ? "" : "s"}` : registrations.length ? "Stored registrations remain unverified or inactive" : "Not configured in Tax & documents")]),
      readinessGroup("communications", "Customer communications", [canonicalDomainItem("transactional_email", "Transactional sender", canonicalReadiness.domains.communications)]),
      readinessGroup("documents", "Documents", [readinessItem("receipt_template", "Receipt template", receiptTemplateReady, receiptTemplateReady ? "Ready and enabled" : "Action required"), readinessItem("invoice_template", "Invoice template", invoiceTemplateReady, invoiceTemplateReady ? "Ready and enabled" : "Not ready")]),
      readinessGroup("fulfillment", "Fulfillment", [canonicalDomainItem("fulfillment", "Fulfillment provider", canonicalReadiness.domains.fulfillment)]),
    ],
    profile: {
      coreIdentity: coreItems.every((item) => item.state === "complete") ? "complete" : "action_required",
      publicContact: profile.publicContactEmail && profile.supportEmail ? "complete" : profile.publicContactEmail || profile.supportEmail ? "partial" : "not_configured",
      legalIdentity: legalItems.every((item) => item.state === "unverified") ? "complete" : legalItems.some((item) => item.state === "unverified") ? "partial" : "not_configured",
      address: profile.private.privateAddressStored ? "complete" : "not_configured",
      tax: taxState,
      documents: canonicalReadiness.domains.documents.ready ? "complete" : receiptTemplateReady ? "partial" : "action_required",
      productionCommerce: canonicalReadiness.productionReady ? "complete" : "action_required",
    },
    dependencies: {
      tax: canonicalReadiness.domains.tax,
      communications: canonicalReadiness.domains.communications,
      documents: canonicalReadiness.domains.documents,
      fulfillment: canonicalReadiness.domains.fulfillment,
      payments: canonicalReadiness.domains.payments,
      checkout: canonicalReadiness.domains.checkout,
      paypalRequired: false,
    },
    documentIdentity: {
      tradingName: profile.tradingName,
      legalNameStored: profile.private.legalBusinessNameStored,
      addressStored: profile.private.privateAddressStored,
      contactEmail: profile.supportEmail || profile.publicContactEmail || null,
      taxRegistrationState: taxState,
      receiptTemplate: templateState(templates.payment_receipt),
      invoiceTemplate: templateState(templates.invoice_document),
    },
  };
  return { ...business, authority: "Commerce D1", privacy: businessPrivacyBoundary(), readiness, canonicalReadiness };
}

export async function taxRegistrationsPayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  const db = requireCommerceDb(env);
  const [result, settingsResult, documentCounts, latestDocument] = await Promise.all([
    db.prepare(
      `SELECT id, registration_type, jurisdiction, country_code, province_code, masked_identifier,
              status, effective_date, expires_at, notes, document_disclosure_enabled, revision, updated_at
       FROM commerce_tax_registrations WHERE business_profile_id = 'primary'
       ORDER BY country_code, province_code, registration_type, jurisdiction`,
    ).all(),
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('tax_calculation_provider','stripe_tax_enabled','transactional_email_enabled','customer_document_access_enabled')").all(),
    db.prepare("SELECT status,COUNT(*) count FROM commerce_order_documents GROUP BY status").all(),
    db.prepare("SELECT document_type,status,created_at FROM commerce_order_documents ORDER BY created_at DESC LIMIT 1").first(),
  ]);
  const registrations = (result?.results || []).map(serializeTaxRegistration);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, null)]));
  const activeRegistrationCount = registrations.filter((registration) => ["active", "verified"].includes(registration.status)).length;
  const calculationProvider = cleanText(settings.tax_calculation_provider, 40) || "unconfigured";
  const ready = calculationProvider !== "unconfigured" && activeRegistrationCount > 0;
  const counts = Object.fromEntries((documentCounts?.results || []).map((row) => [cleanText(row.status, 30), Number(row.count || 0)]));
  return {
    ok: true,
    authority: "Commerce D1",
    access,
    registrations,
    registrationState: { configured: registrations.length > 0, activeCount: activeRegistrationCount, externallyVerified: false },
    calculation: { provider: calculationProvider, stripeTax: settings.stripe_tax_enabled === true ? "enabled_unverified" : "not_enabled_unverified", ratesConfigured: false },
    documents: {
      tokenizedAccessSupported: true,
      customerAccessEnabled: settings.customer_document_access_enabled === true,
      deliveryEnabled: settings.transactional_email_enabled === true,
      previewCount: Number(counts.preview || 0),
      issuedCount: Number(counts.issued || 0),
      revokedCount: Number(counts.revoked || 0),
      lastGeneratedAt: cleanText(latestDocument?.created_at, 80) || null,
      lastGeneratedType: cleanText(latestDocument?.document_type, 20) || null,
      lastGeneratedStatus: cleanText(latestDocument?.status, 20) || null,
    },
    readiness: { ready, status: ready ? "ready" : "blocked", reason: ready ? "An operator-approved registration and explicit calculation strategy are configured." : "An explicit tax calculation strategy and operator-approved registrations are required." },
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
  const revision = Number(input?.revision);
  if (!Number.isSafeInteger(revision) || revision !== Number(current.revision)) throw new AuthFailure(409, "tax_registration_revision_conflict", "This tax registration changed after you opened it. Reload the latest version before saving.");
  const value = validateTaxRegistration(input, current);
  const ciphertext = value.identifier
    ? await encryptCommerceSecret(env, value.identifier, `tax-registration:${id}:identifier`)
    : current.identifier_ciphertext;
  const masked = value.identifier ? maskTaxIdentifier(value.identifier) : current.masked_identifier;
  const timestamp = nowIso();
  let updated;
  try {
    updated = await db.prepare(
      `UPDATE commerce_tax_registrations SET registration_type=?, jurisdiction=?, country_code=?, province_code=?,
         identifier_ciphertext=?, masked_identifier=?, status=?, effective_date=?, expires_at=?, notes=?,
         document_disclosure_enabled=?, revision=revision+1, updated_at=?, updated_by_account_id=? WHERE id=? AND revision=?`,
    ).bind(value.registrationType, value.jurisdiction, value.countryCode, value.provinceCode, ciphertext, masked,
      value.status, value.effectiveDate, value.expiresAt, value.notes, value.documentDisclosureEnabled ? 1 : 0,
      timestamp, session.accountId, id, revision).run();
  } catch (error) {
    if (/unique/i.test(String(error?.message || error))) throw new AuthFailure(409, "tax_registration_duplicate", "That jurisdiction and registration type already exist.");
    throw error;
  }
  if (Number(updated?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "tax_registration_revision_conflict", "This tax registration changed after you opened it. Reload the latest version before saving.");
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

export async function paymentsControlPlanePayload(env, session) {
  const overview = await commerceOverview(env, session);
  const access = overview.access;
  const canSeeTechnicalIds = access.isMasterAdmin || access.capabilities.includes("commerce.payments.manage");
  const apiCredentialConfigured = isStripeTestCredentialConfigured(env);
  const webhookSigningSecretConfigured = isStripeWebhookSigningConfigured(env);
  const stripeOverview = overview.providers.find((provider) => provider.provider === "stripe") || null;

  if (!overview.databaseConfigured) {
    return emptyPaymentsControlPlane({ overview, stripeOverview, access, apiCredentialConfigured, webhookSigningSecretConfigured });
  }

  const db = requireCommerceDb(env);
  const [readiness, profile, settingsResult, providerRow, paypalRow, acceptedOrder, acceptedWebhook, paymentRows, webhookCounts, latestProcessed, latestFailed] = await Promise.all([
    productionReadinessPayload(env, session),
    db.prepare("SELECT trading_name,country_code,province_code,currency_code,public_contact_email,support_email,legal_business_name_ciphertext,private_address_ciphertext,business_registration_number_ciphertext FROM commerce_business_profiles WHERE id='primary'").first(),
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled','live_payment_capture_enabled','fulfillment_submission_enabled','stripe_api_configured','stripe_webhook_configured','stripe_test_checkout_enabled','transactional_email_enabled')").all(),
    db.prepare("SELECT integration_mode,status,environment,external_account_id,country_code,currency_code,safe_metadata_json,last_synchronized_at FROM commerce_provider_connections WHERE provider='stripe'").first(),
    db.prepare("SELECT integration_mode,status,environment,country_code,currency_code,safe_metadata_json,last_synchronized_at FROM commerce_provider_connections WHERE provider='paypal'").first(),
    db.prepare(`SELECT o.id,o.environment,o.currency_code,o.customer_gross_amount,o.refund_amount,o.payment_status,
                       o.checkout_status,o.stripe_checkout_session_id,o.stripe_payment_intent_id,o.created_at,
                       o.checkout_created_at,o.payment_confirmed_at,o.fulfillment_status,o.printful_order_id,
                       i.product_name,i.variant_name,i.quantity
                FROM commerce_orders o
                LEFT JOIN commerce_order_items i ON i.order_id=o.id AND i.line_number=1
                WHERE o.id=?`).bind(ACCEPTED_TEST_ORDER_ID).first(),
    db.prepare(`SELECT provider_event_id,event_type,event_created_at,received_at,livemode,related_object_id,
                       related_object_type,processing_status,processed_at,result_code,payload_sha256
                FROM commerce_webhook_events
                WHERE provider='stripe' AND provider_event_id=?`).bind(ACCEPTED_TEST_EVENT_ID).first(),
    db.prepare(`SELECT environment,
                       SUM(CASE WHEN payment_status IN ('paid','partially_refunded','refunded') THEN 1 ELSE 0 END) successful_payments,
                       SUM(CASE WHEN payment_status IN ('paid','partially_refunded','refunded') THEN customer_gross_amount ELSE 0 END) gross_amount,
                       SUM(CASE WHEN payment_status IN ('partially_refunded','refunded') THEN 1 ELSE 0 END) refunded_payments,
                       SUM(CASE WHEN payment_status IN ('paid','partially_refunded','refunded') THEN refund_amount ELSE 0 END) refund_amount,
                       SUM(CASE WHEN payment_status IN ('paid','partially_refunded','refunded') THEN customer_gross_amount-refund_amount ELSE 0 END) net_after_refunds
                FROM commerce_orders
                WHERE customer_payment_provider='stripe'
                GROUP BY environment`).all(),
    db.prepare(`SELECT COUNT(*) total_count,
                       SUM(CASE WHEN processing_status='processed' THEN 1 ELSE 0 END) processed_count,
                       SUM(CASE WHEN processing_status='error' THEN 1 ELSE 0 END) failure_count,
                       SUM(CASE WHEN livemode=0 THEN 1 ELSE 0 END) test_count,
                       SUM(CASE WHEN livemode=1 THEN 1 ELSE 0 END) live_count
                FROM commerce_webhook_events WHERE provider='stripe'`).first(),
    db.prepare(`SELECT provider_event_id,event_type,event_created_at,received_at,livemode,related_object_id,
                       related_object_type,processing_status,processed_at,result_code
                FROM commerce_webhook_events WHERE provider='stripe' AND processing_status='processed'
                ORDER BY received_at DESC LIMIT 1`).first(),
    db.prepare(`SELECT provider_event_id,event_type,event_created_at,received_at,livemode,related_object_id,
                       related_object_type,processing_status,processed_at,result_code
                FROM commerce_webhook_events WHERE provider='stripe' AND processing_status='error'
                ORDER BY received_at DESC LIMIT 1`).first(),
  ]);

  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, null)]));
  const metadata = json(providerRow?.safe_metadata_json, {});
  const apiVerified = Boolean(providerRow?.status === "connected" && providerRow?.environment === "test" && providerRow?.integration_mode === "direct_merchant" && metadata.api_configured === true && settings.stripe_api_configured === true);
  const webhookAcceptanceVerified = Boolean(metadata.webhook_configured === true && settings.stripe_webhook_configured === true);
  const canonicalTestAccepted = acceptedTestEvidenceValid(acceptedOrder, acceptedWebhook);
  const businessDomain = readiness.domains.business;
  const taxDomain = readiness.domains.tax;
  const communicationsDomain = readiness.domains.communications;
  const documentsDomain = readiness.domains.documents;
  const fulfillmentDomain = readiness.domains.fulfillment;
  const checkoutEnabled = settings.checkout_enabled === true;
  const livePaymentsEnabled = settings.live_payment_capture_enabled === true;
  const fulfillmentEnabled = settings.fulfillment_submission_enabled === true;
  const controlledTestEnabled = settings.stripe_test_checkout_enabled === true;
  const summaries = paymentSummaries(paymentRows?.results || []);
  const merchantCountryReady = profile?.country_code === "CA" && providerRow?.country_code?.toUpperCase() === "CA";
  const merchantCurrencyReady = profile?.currency_code === "CAD" && providerRow?.currency_code?.toUpperCase() === "CAD";
  const stripeState = apiVerified && webhookAcceptanceVerified && canonicalTestAccepted ? "verified" : apiCredentialConfigured || webhookSigningSecretConfigured ? "configured" : "unverified";

  return {
    ok: true,
    databaseConfigured: true,
    access,
    authority: "Commerce D1 and server runtime configuration",
    overall: {
      stripeState,
      technicalConfiguration: apiVerified && webhookAcceptanceVerified ? "verified" : apiCredentialConfigured || webhookSigningSecretConfigured ? "configured" : "unverified",
      testAcceptance: canonicalTestAccepted ? "verified" : "unverified",
      productionPayments: livePaymentsEnabled && checkoutEnabled ? "configured" : "disabled",
      payoutReadiness: "unverified",
      productionReady: readiness.domains.payments.ready === true && checkoutEnabled,
    },
    merchant: merchantProjection(profile, businessDomain),
    stripe: {
      provider: "stripe",
      displayName: cleanText(metadata.account_display_name, 160) || profile?.trading_name || "Third Railify Official",
      integrationMode: providerRow?.integration_mode === "direct_merchant" ? "direct_merchant" : "unavailable",
      environment: providerRow?.environment === "live" ? "live" : "test",
      accountCreated: metadata.account_created === true,
      accountId: canSeeTechnicalIds ? safeProviderId(providerRow?.external_account_id, "acct_") : null,
      accountIdRestricted: !canSeeTechnicalIds && Boolean(providerRow?.external_account_id),
      countryCode: cleanCode(providerRow?.country_code, 2),
      currencyCode: cleanCode(providerRow?.currency_code, 3),
      apiCredentialConfigured,
      apiVerified,
      webhookSigningSecretConfigured,
      webhookAcceptanceVerified,
      checkoutEnabled,
      livePaymentsEnabled,
      chargesEnabledInTest: apiVerified && typeof metadata.charges_enabled === "boolean" ? metadata.charges_enabled : null,
      payoutsEnabledInTest: apiVerified && typeof metadata.payouts_enabled === "boolean" ? metadata.payouts_enabled : null,
      detailsSubmittedInTest: apiVerified && typeof metadata.details_submitted === "boolean" ? metadata.details_submitted : null,
      lastVerifiedAt: cleanText(providerRow?.last_synchronized_at, 80) || null,
    },
    paypal: paypalProjection(paypalRow),
    gates: [
      paymentGate("direct_merchant", "Stripe direct merchant architecture", providerRow?.integration_mode === "direct_merchant" ? "ready" : "action_required", providerRow?.integration_mode === "direct_merchant" ? "Dedicated merchant account; no Connect or connected-account flow." : "The stored provider mode is not direct merchant."),
      paymentGate("api_credential", "Server API credential", apiCredentialConfigured ? "ready" : "action_required", apiCredentialConfigured ? "A recognizable TEST credential is present in server-only runtime custody." : "The server TEST credential is not configured."),
      paymentGate("api_verification", "Stripe TEST API verification", apiVerified ? "ready" : "unverified", apiVerified ? "Persisted CA/CAD account verification evidence is present." : "Credential presence has not been promoted to verified account evidence."),
      paymentGate("webhook_secret", "Webhook signing secret", webhookSigningSecretConfigured ? "ready" : "action_required", webhookSigningSecretConfigured ? "A valid-shaped signing secret is present in server-only runtime custody." : "The server signing secret is not configured."),
      paymentGate("test_acceptance", "Controlled TEST checkout", canonicalTestAccepted ? "ready" : "unverified", canonicalTestAccepted ? "The canonical TEST order and signed payment-confirmation event agree." : "Canonical TEST payment acceptance is not proven."),
      paymentGate("webhook_acceptance", "Webhook TEST acceptance", webhookAcceptanceVerified ? "ready" : "unverified", webhookAcceptanceVerified ? "Persisted signed sandbox receipt proof is present; provider endpoint state was not queried." : "No accepted signed sandbox event proves the webhook path."),
      paymentGate("business", "Business profile", businessDomain.ready ? "ready" : "action_required", businessDomain.summary, "/commerce/business"),
      paymentGate("merchant_country", "Merchant country", merchantCountryReady ? "ready" : "action_required", merchantCountryReady ? "Business and Stripe evidence agree on Canada." : "Stored business and provider country evidence does not agree on Canada.", "/commerce/business"),
      paymentGate("commerce_currency", "Commerce currency", merchantCurrencyReady ? "ready" : "action_required", merchantCurrencyReady ? "Business and Stripe evidence agree on CAD." : "Stored business and provider currency evidence does not agree on CAD.", "/commerce/business"),
      paymentGate("tax", "Tax configuration", taxDomain.ready ? "ready" : "action_required", taxDomain.summary, "/commerce/tax"),
      paymentGate("communications", "Customer receipts and email", communicationsDomain.ready ? "ready" : communicationsDomain.details.sendEnabled === false ? "disabled" : "action_required", communicationsDomain.summary, "/commerce/emails"),
      paymentGate("documents", "Receipt and invoice readiness", documentsDomain.ready ? "ready" : "action_required", documentsDomain.summary, "/commerce/tax"),
      paymentGate("fulfillment", "Fulfillment", fulfillmentEnabled && fulfillmentDomain.ready ? "ready" : "disabled", fulfillmentDomain.summary, "/commerce/fulfillment"),
      paymentGate("checkout", "Public checkout", checkoutEnabled ? "ready" : "disabled", checkoutEnabled ? "Normal checkout is enabled." : "Normal checkout remains explicitly disabled."),
      paymentGate("live_payments", "Live payment capture", livePaymentsEnabled ? "ready" : "disabled", livePaymentsEnabled ? "Live payment capture is enabled." : "Live payment capture remains explicitly disabled."),
      paymentGate("payouts", "Payout readiness", "unverified", "Third Railify does not store Stripe balance, schedule, bank, or payout execution state."),
    ],
    productionActivation: {
      checkout: { enabled: checkoutEnabled, state: checkoutEnabled ? "configured" : "disabled" },
      livePayments: { enabled: livePaymentsEnabled, state: livePaymentsEnabled ? "configured" : "disabled" },
      fulfillment: { enabled: fulfillmentEnabled, state: fulfillmentEnabled ? "configured" : "disabled" },
      controlledTestCheckout: { enabled: controlledTestEnabled, state: controlledTestEnabled ? "configured" : "disabled" },
      mutableFromThisRoute: false,
    },
    testEvidence: canonicalTestAccepted ? serializeTestEvidence(acceptedOrder, acceptedWebhook) : null,
    webhookHealth: {
      endpointImplemented: true,
      signingSecretConfigured: webhookSigningSecretConfigured,
      acceptanceVerified: webhookAcceptanceVerified,
      externallyVerified: false,
      environment: "test",
      counts: {
        total: safeCount(webhookCounts?.total_count),
        processed: safeCount(webhookCounts?.processed_count),
        failed: safeCount(webhookCounts?.failure_count),
        test: safeCount(webhookCounts?.test_count),
        live: safeCount(webhookCounts?.live_count),
        duplicates: null,
      },
      latestProcessed: serializeWebhookEvidence(latestProcessed),
      latestFailed: serializeWebhookEvidence(latestFailed),
      idempotency: { implemented: true, evidence: "Unique provider and event ID ledger; duplicate count is not persisted." },
    },
    paymentSummary: {
      currencyCode: "CAD",
      live: summaries.live,
      test: summaries.test,
      processingFees: { available: false, reason: "Stripe processing fees are not included because no authoritative fee projection is available." },
    },
    paymentMethods: [
      { id: "card", label: "Card payments", state: "configured", detail: "Stripe-hosted Checkout architecture supported; production checkout is disabled." },
      { id: "apple_pay", label: "Apple Pay", state: "unverified", detail: "Provider-managed eligibility depends on Stripe, device, and domain configuration; enablement is not proven." },
      { id: "google_pay", label: "Google Pay", state: "unverified", detail: "Provider-managed eligibility depends on Stripe, device, and domain configuration; enablement is not proven." },
    ],
    payoutState: {
      state: "unverified",
      management: "managed_in_stripe",
      balanceIntegrationAvailable: false,
      payoutIntegrationAvailable: false,
      bankDestinationStored: false,
      nextPayout: null,
      availableBalance: null,
      pendingBalance: null,
      schedule: null,
      testCapabilityObserved: apiVerified && typeof metadata.payouts_enabled === "boolean" ? metadata.payouts_enabled : null,
    },
    dependencies: [
      dependency("business", "Business information", businessDomain, "/commerce/business"),
      dependency("tax", "Tax configuration", taxDomain, "/commerce/tax"),
      dependency("documents", "Receipts and invoices", documentsDomain, "/commerce/tax"),
      dependency("communications", "Customer emails", communicationsDomain, "/commerce/emails"),
      dependency("fulfillment", "Fulfillment", fulfillmentDomain, "/commerce/fulfillment"),
    ],
    technical: {
      checkoutArchitecture: "stripe_hosted_checkout_sessions",
      directMerchant: providerRow?.integration_mode === "direct_merchant",
      stripeConnect: false,
      connectedAccounts: false,
      stripeAccountHeader: false,
      destinationCharges: false,
      applicationFees: false,
      transfers: false,
      publishableKeyRequired: false,
      providerMutationAvailable: false,
    },
    checkedAt: nowIso(),
  };
}

function emptyPaymentsControlPlane({ overview, stripeOverview, access, apiCredentialConfigured, webhookSigningSecretConfigured }) {
  return {
    ok: true,
    databaseConfigured: false,
    access,
    authority: "Server runtime configuration; Commerce D1 unavailable",
    overall: { stripeState: apiCredentialConfigured || webhookSigningSecretConfigured ? "configured" : "unavailable", technicalConfiguration: "unverified", testAcceptance: "unverified", productionPayments: "disabled", payoutReadiness: "unverified", productionReady: false },
    merchant: { displayName: overview.business.tradingName, countryCode: overview.business.countryCode, provinceCode: overview.business.provinceCode, currencyCode: overview.business.currencyCode, publicContactEmail: overview.business.publicContactEmail || null, supportEmail: overview.business.supportEmail || null, completeness: "unavailable", legalIdentityStored: false, privateAddressStored: false, businessRegistrationStored: false },
    stripe: { provider: "stripe", displayName: "Third Railify Official", integrationMode: "direct_merchant", environment: "test", accountCreated: stripeOverview?.accountCreated === true, accountId: null, accountIdRestricted: false, countryCode: stripeOverview?.countryCode || "CA", currencyCode: stripeOverview?.currencyCode || "CAD", apiCredentialConfigured, apiVerified: false, webhookSigningSecretConfigured, webhookAcceptanceVerified: false, checkoutEnabled: false, livePaymentsEnabled: false, chargesEnabledInTest: null, payoutsEnabledInTest: null, detailsSubmittedInTest: null, lastVerifiedAt: null },
    paypal: { provider: "paypal", state: "deferred", integrationMode: "direct_merchant", environment: "deferred", countryCode: "CA", currencyCode: "CAD", credentialConfigured: false, donationsEnabled: false, membershipEnabled: false, shopCheckoutEnabled: false, providerMutationAvailable: false, lastVerifiedAt: null },
    gates: [paymentGate("authority", "Commerce D1 authority", "action_required", "Commerce D1 is unavailable, so persisted payments evidence cannot be verified."), paymentGate("checkout", "Public checkout", "disabled", "Normal checkout remains disabled."), paymentGate("live_payments", "Live payment capture", "disabled", "Live payment capture remains disabled."), paymentGate("payouts", "Payout readiness", "unverified", "No Stripe balance, payout, or bank state is available.")],
    productionActivation: { checkout: { enabled: false, state: "disabled" }, livePayments: { enabled: false, state: "disabled" }, fulfillment: { enabled: false, state: "disabled" }, controlledTestCheckout: { enabled: false, state: "disabled" }, mutableFromThisRoute: false },
    testEvidence: null,
    webhookHealth: { endpointImplemented: true, signingSecretConfigured: webhookSigningSecretConfigured, acceptanceVerified: false, externallyVerified: false, environment: "test", counts: { total: null, processed: null, failed: null, test: null, live: null, duplicates: null }, latestProcessed: null, latestFailed: null, idempotency: { implemented: true, evidence: "Unique provider and event ID ledger requires Commerce D1." } },
    paymentSummary: { currencyCode: "CAD", live: unavailablePaymentSummary(), test: unavailablePaymentSummary(), processingFees: { available: false, reason: "Stripe processing fees are not available." } },
    paymentMethods: [{ id: "card", label: "Card payments", state: "configured", detail: "Stripe-hosted Checkout architecture supported; production checkout is disabled." }, { id: "apple_pay", label: "Apple Pay", state: "unverified", detail: "Provider-managed eligibility is not verified." }, { id: "google_pay", label: "Google Pay", state: "unverified", detail: "Provider-managed eligibility is not verified." }],
    payoutState: { state: "unverified", management: "managed_in_stripe", balanceIntegrationAvailable: false, payoutIntegrationAvailable: false, bankDestinationStored: false, nextPayout: null, availableBalance: null, pendingBalance: null, schedule: null, testCapabilityObserved: null },
    dependencies: [],
    technical: { checkoutArchitecture: "stripe_hosted_checkout_sessions", directMerchant: true, stripeConnect: false, connectedAccounts: false, stripeAccountHeader: false, destinationCharges: false, applicationFees: false, transfers: false, publishableKeyRequired: false, providerMutationAvailable: false },
    checkedAt: nowIso(),
  };
}

function acceptedTestEvidenceValid(order, webhook) {
  return Boolean(order?.id === ACCEPTED_TEST_ORDER_ID && order.environment === "test" && order.currency_code === "CAD" && Number(order.customer_gross_amount) === 1500 && order.payment_status === "paid" && order.fulfillment_status === "disabled" && !order.printful_order_id && order.stripe_checkout_session_id === ACCEPTED_TEST_SESSION_ID && webhook?.provider_event_id === ACCEPTED_TEST_EVENT_ID && webhook.event_type === "checkout.session.completed" && Number(webhook.livemode) === 0 && webhook.related_object_id === ACCEPTED_TEST_SESSION_ID && webhook.related_object_type === "checkout.session" && webhook.processing_status === "processed" && webhook.result_code === "payment_confirmed" && typeof webhook.payload_sha256 === "string" && webhook.payload_sha256.length === 64);
}

function serializeTestEvidence(order, webhook) {
  return { orderId: order.id, environment: "test", amount: safeMoney(order.customer_gross_amount), refundAmount: safeMoney(order.refund_amount), currencyCode: "CAD", paymentStatus: order.payment_status, checkoutStatus: order.checkout_status, fulfillmentStatus: order.fulfillment_status, productName: cleanText(order.product_name, 240) || null, variantName: cleanText(order.variant_name, 240) || null, quantity: safeCount(order.quantity), stripeSessionId: safeProviderId(order.stripe_checkout_session_id, "cs_test_"), paymentIntentId: safeProviderId(order.stripe_payment_intent_id, "pi_"), webhookEventId: safeProviderId(webhook.provider_event_id, "evt_"), webhookResult: cleanText(webhook.result_code, 80) || null, createdAt: cleanText(order.created_at, 80) || null, checkoutCreatedAt: cleanText(order.checkout_created_at, 80) || null, paymentConfirmedAt: cleanText(order.payment_confirmed_at, 80) || null, webhookReceivedAt: cleanText(webhook.received_at, 80) || null };
}

function paymentSummaries(rows) {
  const result = { live: zeroPaymentSummary(), test: zeroPaymentSummary() };
  for (const row of rows) {
    if (row.environment !== "live" && row.environment !== "test") continue;
    result[row.environment] = { available: true, successfulPayments: safeCount(row.successful_payments), grossAmount: safeMoney(row.gross_amount), refundedPayments: safeCount(row.refunded_payments), refundAmount: safeMoney(row.refund_amount), netAfterRefunds: safeSignedMoney(row.net_after_refunds) };
  }
  return result;
}

function zeroPaymentSummary() { return { available: true, successfulPayments: 0, grossAmount: 0, refundedPayments: 0, refundAmount: 0, netAfterRefunds: 0 }; }
function unavailablePaymentSummary() { return { available: false, successfulPayments: null, grossAmount: null, refundedPayments: null, refundAmount: null, netAfterRefunds: null }; }
function safeCount(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
function safeMoney(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
function safeSignedMoney(value) { const number = Number(value); return Number.isSafeInteger(number) ? number : null; }
function safeProviderId(value, prefix) { const id = cleanText(value, 255); return id && id.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(id) ? id : null; }
function cleanCode(value, length) { const code = cleanText(value, length).toUpperCase(); return code.length === length ? code : null; }
function paymentGate(id, label, state, detail, href = null) { return { id, label, state, detail, href }; }
function dependency(id, label, domainValue, href) { return { id, label, state: domainValue.ready ? "ready" : domainValue.details?.enabled === false || domainValue.details?.sendEnabled === false ? "disabled" : "action_required", detail: domainValue.summary, href }; }
function merchantProjection(profile, businessDomain) { return { displayName: cleanText(profile?.trading_name, 160) || "Third Railify Official", countryCode: cleanCode(profile?.country_code, 2), provinceCode: cleanCodeRange(profile?.province_code, 2, 3), currencyCode: cleanCode(profile?.currency_code, 3), publicContactEmail: cleanText(profile?.public_contact_email, 254) || null, supportEmail: cleanText(profile?.support_email, 254) || null, completeness: businessDomain.ready ? "ready" : "incomplete", legalIdentityStored: Boolean(profile?.legal_business_name_ciphertext), privateAddressStored: Boolean(profile?.private_address_ciphertext), businessRegistrationStored: Boolean(profile?.business_registration_number_ciphertext) }; }
function cleanCodeRange(value, minimum, maximum) { const code = cleanText(value, maximum).toUpperCase(); return code.length >= minimum && code.length <= maximum ? code : null; }
function paypalProjection(row) { const metadata = json(row?.safe_metadata_json, {}); return { provider: "paypal", state: ["disabled", "deferred", "setup_required"].includes(row?.status) ? row.status : "deferred", integrationMode: row?.integration_mode === "direct_merchant" ? "direct_merchant" : "unavailable", environment: cleanText(row?.environment, 20) || "deferred", countryCode: cleanCode(row?.country_code, 2), currencyCode: cleanCode(row?.currency_code, 3), credentialConfigured: metadata.credentials_configured === true, donationsEnabled: metadata.donations_active === true, membershipEnabled: metadata.vip_active === true, shopCheckoutEnabled: metadata.shop_processor === true, providerMutationAvailable: false, lastVerifiedAt: cleanText(row?.last_synchronized_at, 80) || null }; }
function serializeWebhookEvidence(row) { return row ? { eventId: safeProviderId(row.provider_event_id, "evt_"), eventType: cleanText(row.event_type, 255) || null, eventCreatedAt: Number.isSafeInteger(Number(row.event_created_at)) ? Number(row.event_created_at) : null, receivedAt: cleanText(row.received_at, 80) || null, processedAt: cleanText(row.processed_at, 80) || null, environment: Number(row.livemode) === 1 ? "live" : "test", relatedObjectId: safeProviderId(row.related_object_id, "cs_"), relatedObjectType: cleanText(row.related_object_type, 120) || null, processingStatus: cleanText(row.processing_status, 40) || null, resultCode: cleanText(row.result_code, 80) || null } : null; }

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
function readinessItem(id, label, complete, detail) { return { id, label, state: complete ? "complete" : "incomplete", detail }; }
function optionalReadinessItem(id, label, configured, detail) { return { id, label, state: configured ? "complete" : "not_required", detail }; }
function storedReadinessItem(id, label, stored) { return { id, label, state: stored ? "unverified" : "incomplete", detail: stored ? "Configured and encrypted; not externally verified" : "Not configured" }; }
function statusReadinessItem(id, label, state, detail) { return { id, label, state, detail }; }
function canonicalDomainItem(id, label, value) { return { id, label, state: value.ready ? "complete" : value.details?.sendEnabled === false || value.details?.enabled === false ? "disabled" : "incomplete", detail: value.summary }; }
function readinessGroup(id, label, items) {
  const actionable = items.filter((item) => item.state !== "not_required");
  const state = actionable.some((item) => item.state === "incomplete" || item.state === "not_configured") ? "action_required"
    : actionable.some((item) => item.state === "disabled") ? "disabled"
      : actionable.some((item) => item.state === "unverified") ? "unverified" : "complete";
  return { id, label, state, items };
}
function businessCompletion(items) {
  const required = items.filter((item) => item.state !== "not_required");
  const complete = required.filter((item) => item.state === "complete" || item.state === "unverified").length;
  return { complete, total: required.length, percent: required.length ? Math.round((complete / required.length) * 100) : 0 };
}
function templateState(row) { return !row ? { state: "not_configured", revision: null } : { state: row.status === "ready" && Number(row.enabled) === 1 ? "complete" : row.status === "disabled" ? "disabled" : "incomplete", revision: Number(row.revision) }; }
function businessPrivacyBoundary() {
  return {
    publicSafe: ["trading_name", "public_contact_email", "support_email", "public_phone", "website_url", "public_address"],
    adminOnly: ["profile_revision", "updated_at", "readiness", "template_status"],
    sensitive: ["legal_business_name", "legal_business_address", "private_phone", "business_registration_number"],
  };
}
function emptyBusinessReadiness() {
  return {
    overallStatus: "action_required",
    completion: { complete: 0, total: 9, percent: 0 },
    groups: [],
    profile: { coreIdentity: "action_required", publicContact: "not_configured", legalIdentity: "not_configured", address: "not_configured", tax: "not_configured", documents: "action_required", productionCommerce: "action_required" },
    dependencies: { paypalRequired: false },
    documentIdentity: { tradingName: "Third Railify Official", legalNameStored: false, addressStored: false, contactEmail: null, taxRegistrationState: "not_configured", receiptTemplate: { state: "not_configured", revision: null }, invoiceTemplate: { state: "not_configured", revision: null } },
  };
}
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
