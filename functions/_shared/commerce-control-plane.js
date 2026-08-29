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
  isPrintfulCredentialConfigured,
  maskTaxIdentifier,
  requireCommerceDb,
  templatesPayload,
  validateTemplate,
  writeCommerceAudit,
} from "./commerce-core.js";
import { THIRD_RAIL_BRAND, thirdRailBrandAssets, thirdRailFontFaceCss } from "./thirdrail-brand.js";
import {
  fulfillmentOperationsPayload,
  normalizePrintfulOrderEvidence,
  reconcilePrintfulOrderEvidence,
} from "./printful-fulfillment.js";
import {
  buildPrintfulDraftCreateRequest,
  buildPrintfulOrderExternalId,
  normalizePrintfulApiError,
  PRINTFUL_ORDERS_URL,
  PRINTFUL_TARGET_STORE_ID,
  PrintfulApiError,
} from "./printful-api.js";

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
    templatesPayload(env, session),
    db.prepare("SELECT id,payment_status,fulfillment_status,environment,customer_gross_amount,stripe_checkout_session_id,printful_order_id FROM commerce_orders WHERE id=?").bind(ACCEPTED_TEST_ORDER_ID).first(),
    db.prepare("SELECT provider_event_id FROM commerce_webhook_events WHERE provider='stripe' AND provider_event_id='evt_1U9OysB2jGrq9Tn1apdsFgi2' AND related_object_id='cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC' AND processing_status='processed' AND result_code='payment_confirmed'").first(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, null)]));
  const providers = Object.fromEntries((providersResult?.results || []).map((row) => [row.provider, { ...row, metadata: json(row.safe_metadata_json, {}) }]));
  const migrationState = json(migration?.safe_state_json, {});
  const activeTaxCount = (registrations?.results || []).filter((row) => ["verified", "active"].includes(row.status)).reduce((sum, row) => sum + Number(row.count || 0), 0);
  const readableTemplates = templatesResult?.templates || [];
  const emailReadyCount = readableTemplates.filter((template) => template.templateKind === "email" && template.validity?.state !== "invalid" && template.status === "ready" && template.enabled).length;
  const receiptTemplateReady = readableTemplates.some((template) => template.templateKind === "document" && template.validity?.state !== "invalid" && template.status === "ready" && template.enabled);
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

const PRINTFUL_DRAFT_BUILDER_VERSION = "printful-draft-preview-v1";
const DELIVERY_SNAPSHOT_COLUMNS = ["order_id", "recipient_ciphertext", "destination_country_code", "shipping_strategy", "display_shipping_method", "shipping_amount", "currency_code", "source_quote_id"];
const SHIPPING_QUOTE_COLUMNS = ["id", "environment", "cart_fingerprint", "recipient_fingerprint", "currency_code", "shipping_strategy", "rate_options_json", "expires_at"];
const TRACKING_COLUMNS = ["tracking_number", "tracking_url", "carrier", "shipped_at", "delivered_at", "printful_shipment_id", "provider_order_status"];

export async function fulfillmentShippingPayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  if (!isCommerceDbConfigured(env)) return emptyFulfillmentShippingPayload(access, env);

  const db = requireCommerceDb(env);
  const [deliveryColumnsResult, quoteColumnsResult] = await Promise.all([
    db.prepare("PRAGMA table_info(commerce_order_delivery_snapshots)").all(),
    db.prepare("PRAGMA table_info(commerce_shipping_quotes)").all(),
  ]);
  const deliveryColumns = new Set((deliveryColumnsResult?.results || []).map((row) => cleanText(row.name, 80).toLowerCase()));
  const quoteColumns = new Set((quoteColumnsResult?.results || []).map((row) => cleanText(row.name, 80).toLowerCase()));
  const shippingColumns = DELIVERY_SNAPSHOT_COLUMNS.filter((column) => deliveryColumns.has(column));
  const shippingQuoteColumns = SHIPPING_QUOTE_COLUMNS.filter((column) => quoteColumns.has(column));
  const shippingDataImplemented = shippingColumns.length === DELIVERY_SNAPSHOT_COLUMNS.length;
  const shippingQuoteStorageImplemented = shippingQuoteColumns.length === SHIPPING_QUOTE_COLUMNS.length;
  const shippingSchemaReady = shippingDataImplemented && shippingQuoteStorageImplemented;
  const orderCountsSql = shippingDataImplemented
    ? `SELECT COUNT(*) total,
      SUM(CASE WHEN environment='test' THEN 1 ELSE 0 END) test_orders,
      SUM(CASE WHEN environment='live' THEN 1 ELSE 0 END) live_orders,
      SUM(CASE WHEN printful_order_id IS NOT NULL THEN 1 ELSE 0 END) provider_orders,
      SUM(CASE WHEN fulfillment_status<>'disabled' THEN 1 ELSE 0 END) fulfillment_evidence,
      SUM(CASE WHEN environment='test' AND EXISTS (SELECT 1 FROM commerce_order_delivery_snapshots d WHERE d.order_id=commerce_orders.id) THEN 1 ELSE 0 END) test_shipping_snapshots,
      SUM(CASE WHEN environment='live' AND EXISTS (SELECT 1 FROM commerce_order_delivery_snapshots d WHERE d.order_id=commerce_orders.id) THEN 1 ELSE 0 END) live_shipping_snapshots,
      MAX(CASE WHEN printful_order_id IS NOT NULL THEN updated_at END) last_provider_order_at
      FROM commerce_orders`
    : `SELECT COUNT(*) total,
      SUM(CASE WHEN environment='test' THEN 1 ELSE 0 END) test_orders,
      SUM(CASE WHEN environment='live' THEN 1 ELSE 0 END) live_orders,
      SUM(CASE WHEN printful_order_id IS NOT NULL THEN 1 ELSE 0 END) provider_orders,
      SUM(CASE WHEN fulfillment_status<>'disabled' THEN 1 ELSE 0 END) fulfillment_evidence,
      0 test_shipping_snapshots,0 live_shipping_snapshots,
      MAX(CASE WHEN printful_order_id IS NOT NULL THEN updated_at END) last_provider_order_at
      FROM commerce_orders`;
  const [canonicalReadiness, providerRow, settingsResult, productCounts, variantCounts, migrationRow, orderCounts, recentOrdersResult, orderColumnsResult, shipmentTemplate, lastAudit, candidate, operations] = await Promise.all([
    productionReadinessPayload(env, session),
    db.prepare("SELECT status,environment,integration_mode,external_account_id,safe_metadata_json,last_synchronized_at FROM commerce_provider_connections WHERE provider='printful'").first(),
    db.prepare(`SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN (
      'checkout_enabled','live_payment_capture_enabled','fulfillment_submission_enabled','printful_api_configured',
      'printful_order_mode','shipping_strategy','transactional_email_enabled','tax_calculation_provider',
      'customer_document_access_enabled','stripe_test_checkout_enabled')`).all(),
    db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='active' AND visibility='public' THEN 1 ELSE 0 END) storefront,
      SUM(CASE WHEN target_printful_product_id IS NOT NULL AND migration_status IN ('target_verified','target_native') THEN 1 ELSE 0 END) mapped,
      SUM(CASE WHEN migration_status='blocked' THEN 1 ELSE 0 END) blocked
      FROM commerce_products`).first(),
    db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN p.status='active' AND p.visibility='public' AND v.status='active' AND v.visibility='public' THEN 1 ELSE 0 END) storefront,
      SUM(CASE WHEN v.fulfillment_provider='printful' AND v.fulfillment_mapping_status='mapped'
        AND v.target_printful_product_id IS NOT NULL AND v.target_printful_sync_variant_id IS NOT NULL
        AND v.migration_status IN ('target_verified','target_native') THEN 1 ELSE 0 END) mapped,
      SUM(CASE WHEN v.migration_status='blocked' OR v.fulfillment_mapping_status='conflict' THEN 1 ELSE 0 END) blocked,
      SUM(CASE WHEN v.migration_status IN ('deferred','excluded') OR v.fulfillment_mapping_status='manual_review' THEN 1 ELSE 0 END) deferred,
      SUM(CASE WHEN v.is_sellable=0 THEN 1 ELSE 0 END) non_sellable,
      SUM(CASE WHEN NOT (v.fulfillment_provider='printful' AND v.fulfillment_mapping_status='mapped'
        AND v.target_printful_product_id IS NOT NULL AND v.target_printful_sync_variant_id IS NOT NULL
        AND v.migration_status IN ('target_verified','target_native'))
        AND v.migration_status NOT IN ('blocked','deferred','excluded')
        AND v.fulfillment_mapping_status NOT IN ('conflict','manual_review') THEN 1 ELSE 0 END) unmapped,
      SUM(CASE WHEN p.status='active' AND p.visibility='public' AND p.migration_status IN ('target_verified','target_native')
        AND p.target_printful_product_id IS NOT NULL AND v.status='active' AND v.visibility='public'
        AND v.is_sellable=1 AND v.availability_status='active' AND v.fulfillment_provider='printful'
        AND v.fulfillment_mapping_status='mapped' AND v.target_printful_product_id=p.target_printful_product_id
        AND v.target_printful_sync_variant_id IS NOT NULL AND v.migration_status IN ('target_verified','target_native') THEN 1 ELSE 0 END) potentially_fulfillable
      FROM commerce_product_variants v JOIN commerce_products p ON p.id=v.product_id`).first(),
    db.prepare("SELECT status,phase,products_verified,variants_mapped,provider_request_count,provider_failures,safe_state_json,updated_at,completed_at FROM commerce_catalogue_migrations WHERE id='permanent-printful-2026-08'").first(),
    db.prepare(orderCountsSql).first(),
    db.prepare(`SELECT id,environment,payment_status,fulfillment_status,printful_order_id,
      CASE WHEN printful_order_id IS NULL THEN 0 ELSE 1 END provider_order_recorded,
      json_extract(safe_metadata_json,'$.printfulOrderStatus') provider_order_status,
      json_extract(safe_metadata_json,'$.printfulConfirmationStatus') provider_confirmation_status,
      created_at,updated_at
      FROM commerce_orders WHERE fulfillment_status<>'disabled' OR printful_order_id IS NOT NULL
      ORDER BY updated_at DESC,id DESC LIMIT 8`).all(),
    db.prepare("PRAGMA table_info(commerce_orders)").all(),
    db.prepare("SELECT status,enabled,revision,updated_at FROM commerce_templates WHERE template_key='shipment_notification'").first(),
    db.prepare(`SELECT action,result,created_at FROM commerce_audit
      WHERE action LIKE '%fulfillment%' OR action LIKE '%shipment%' OR action LIKE 'printful.order%'
      ORDER BY created_at DESC LIMIT 1`).first(),
    db.prepare(`SELECT p.id product_id,p.title product_title,p.status product_status,p.visibility product_visibility,
      p.requires_shipping,p.target_printful_product_id product_target_id,p.migration_status product_migration_status,
      v.id variant_id,v.size_label,v.color_label,v.status variant_status,v.visibility variant_visibility,
      v.is_sellable,v.availability_status,v.fulfillment_provider,v.fulfillment_mapping_status,
      v.target_printful_product_id variant_target_product_id,v.target_printful_sync_variant_id,
      v.migration_status variant_migration_status
      FROM commerce_product_variants v JOIN commerce_products p ON p.id=v.product_id
      WHERE v.fulfillment_provider='printful' AND v.fulfillment_mapping_status='mapped'
        AND v.target_printful_sync_variant_id IS NOT NULL
      ORDER BY CASE WHEN v.migration_status IN ('target_verified','target_native') THEN 0 ELSE 1 END,
        CASE WHEN v.is_sellable=1 THEN 0 ELSE 1 END,p.title,v.id LIMIT 1`).first(),
    fulfillmentOperationsPayload(env),
  ]);

  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, null)]));
  const providerMetadata = json(providerRow?.safe_metadata_json, {});
  const migrationState = json(migrationRow?.safe_state_json, {});
  const orderColumns = new Set((orderColumnsResult?.results || []).map((row) => cleanText(row.name, 80).toLowerCase()));
  const legacyTrackingColumns = TRACKING_COLUMNS.filter((column) => orderColumns.has(column));
  const lifecycleSchemaReady = operations.state === "ready";
  const trackingColumns = lifecycleSchemaReady ? ["encrypted_tracking_number", "encrypted_tracking_url", "carrier", "service", "shipment_state", "provider_shipment_id"] : [];
  const orderModeSetting = cleanText(settings.printful_order_mode, 40).toLowerCase() || "unconfigured";
  const orderModeProvider = cleanText(providerMetadata.order_mode || providerMetadata.mode, 40).toLowerCase() || "unconfigured";
  const orderModeConsistent = orderModeSetting === orderModeProvider;
  const fulfillmentEnabled = settings.fulfillment_submission_enabled === true || providerMetadata.fulfillment_enabled === true;
  const shippingStrategy = cleanText(settings.shipping_strategy, 80).toLowerCase() || "unconfigured";
  const targetStoreConfigured = Boolean(cleanText(env?.PRINTFUL_STORE_ID, 40) && cleanText(providerRow?.external_account_id, 40));
  const credentialConfigured = isPrintfulCredentialConfigured(env);
  const providerConfigured = Boolean(providerRow?.status === "connected" && providerRow?.integration_mode === "fulfillment"
    && providerMetadata.api_configured === true && settings.printful_api_configured === true && targetStoreConfigured && credentialConfigured);
  const migrationBlockedProducts = Array.isArray(migrationState.blockedProducts) ? migrationState.blockedProducts.length : number(productCounts?.blocked);
  const mapping = {
    storefrontProducts: number(productCounts?.storefront), storefrontVariants: number(variantCounts?.storefront),
    totalProducts: number(productCounts?.total), totalVariants: number(variantCounts?.total),
    mappedProviderProducts: number(productCounts?.mapped), mappedProviderVariants: number(variantCounts?.mapped),
    unmappedVariants: number(variantCounts?.unmapped), blockedProducts: migrationBlockedProducts,
    blockedVariants: number(variantCounts?.blocked), deferredVariants: number(variantCounts?.deferred),
    nonSellableVariants: number(variantCounts?.non_sellable), potentiallyFulfillableVariants: number(variantCounts?.potentially_fulfillable),
    contract: "Printful + mapped + target product ID + target Sync Variant ID + target-verified/native migration",
  };
  const paymentTestEvidence = canonicalReadiness.domains.payments.details.testAcceptancePassed === true;
  const recipient = { source: "synthetic_fixture", name: "Preview customer", address1: "100 Preview Street", city: "London", region: "ON", postalCode: "N6A 1A1", countryCode: "CA" };
  const draftPreview = preparePrintfulDraftOrder({
    reference: "DRAFT-PREVIEW-NOT-AN-ORDER", environment: "test", paymentStatus: "synthetic_fixture",
    quantity: 1, candidate: candidate ? serializeDraftCandidate(candidate) : null, recipient,
    shippingStrategy, fulfillmentEnabled, orderMode: orderModeSetting, providerMode: orderModeProvider,
    requireSellable: true, previewOnly: true,
  });

  const readiness = {
    provider: statusProjection(providerConfigured ? "configured" : credentialConfigured || targetStoreConfigured ? "incomplete" : "unverified", providerConfigured ? "Persisted Printful configuration is internally consistent." : "Printful configuration is incomplete or not backed by all required local evidence."),
    catalogue: statusProjection(mapping.potentiallyFulfillableVariants > 0 && mapping.blockedProducts === 0 ? "ready" : mapping.mappedProviderVariants > 0 ? "partial" : "blocked", `${mapping.mappedProviderVariants} variants meet the provider mapping contract; ${mapping.potentiallyFulfillableVariants} are currently potentially fulfillable.`),
    customerShippingData: statusProjection(shippingDataImplemented ? number(orderCounts?.test_shipping_snapshots) + number(orderCounts?.live_shipping_snapshots) > 0 ? "available" : "implemented_no_evidence" : "migration_required", shippingDataImplemented ? "Encrypted order delivery snapshots are implemented; customer PII is not projected here." : "Commerce migration 0015 is required before encrypted delivery snapshots are available."),
    paymentAuthority: statusProjection(paymentTestEvidence ? "test_evidence_only" : settings.live_payment_capture_enabled === true ? "ready" : "production_disabled", paymentTestEvidence ? "One preserved signed-webhook TEST payment exists; it is not production authority." : "Production payment authority is disabled."),
    printfulOrderMode: statusProjection(orderModeConsistent && orderModeSetting === "draft_only" ? "draft_only" : orderModeSetting === "live" ? "live" : "disabled", orderModeConsistent ? `Canonical mode: ${orderModeSetting}.` : "Provider metadata and the canonical setting disagree."),
    fulfillment: statusProjection(fulfillmentEnabled ? "enabled" : "disabled", fulfillmentEnabled ? "Fulfillment submission is enabled." : "Fulfillment is intentionally disabled until production activation."),
    tracking: statusProjection(!lifecycleSchemaReady ? "migration_required" : operations.counts.shipments > 0 ? "available" : "implemented_no_evidence", !lifecycleSchemaReady ? "Commerce migration 0018 is required before normalized shipment authority is available." : operations.counts.shipments > 0 ? "Encrypted tracking and normalized shipment evidence are stored in Commerce D1." : "Normalized encrypted tracking storage is implemented; no shipment evidence exists."),
    production: statusProjection(canonicalReadiness.productionReady ? "enabled" : "blocked", canonicalReadiness.productionReady ? "All canonical commerce gates are ready." : "Canonical production commerce remains blocked."),
  };

  return {
    ok: true, databaseConfigured: true, authority: "Commerce D1 + server runtime configured-state projection", access, readiness,
    provider: {
      name: "Printful", state: cleanText(providerRow?.status, 40) || "unavailable", configured: providerConfigured,
      targetStoreConfigured, storeType: cleanText(providerMetadata.store_type, 40) || null,
      credentialConfigured, configurationEvidence: providerMetadata.last_verified_at ? "persisted_prior_verification" : "unverified",
      scopes: {
        products: providerMetadata.product_write_authority === true, files: providerMetadata.file_manage_authority === true,
        orders: providerMetadata.order_manage_authority === true, webhooks: providerMetadata.webhook_manage_authority === true,
        evidenceRecorded: Array.isArray(providerMetadata.oauth_scopes),
      },
      orderMode: orderModeSetting, providerOrderMode: orderModeProvider, orderModeConsistent,
      fulfillmentEnabled, localProviderOrderCount: operations.counts.total,
      lastProviderOrderAt: cleanText(orderCounts?.last_provider_order_at, 80) || null,
      lastConfigurationEvidenceAt: cleanText(providerRow?.last_synchronized_at, 80) || null,
    },
    migration: {
      id: "permanent-printful-2026-08", status: cleanText(migrationRow?.status, 40) || "not_recorded",
      phase: cleanText(migrationRow?.phase, 40) || "not_recorded", manuallyPaused: migrationState.manualPause === true,
      verifiedProducts: number(migrationRow?.products_verified), mappedVariants: number(migrationRow?.variants_mapped),
      blockedProducts: migrationBlockedProducts, deferredVariants: mapping.deferredVariants,
      providerRequestCount: number(migrationRow?.provider_request_count), providerFailures: number(migrationRow?.provider_failures),
      updatedAt: cleanText(migrationRow?.updated_at, 80) || null, completedAt: cleanText(migrationRow?.completed_at, 80) || null,
      mutableFromThisRoute: false,
    },
    mapping,
    pipeline: [
      pipelineStage("order_record", "Order recorded", shippingDataImplemented, shippingDataImplemented ? "commerce_orders + encrypted delivery snapshot when shipping is required" : "commerce_orders; delivery snapshot schema pending", "Checkout core", shippingDataImplemented ? "Implemented; local order and delivery snapshot precede payment provider creation." : "Commerce migration 0015 is required for delivery snapshots."),
      pipelineStage("payment_confirmed", "Payment confirmed", true, "commerce_orders.payment_status + signed Stripe webhook receipt", "Signed Stripe webhook", paymentTestEvidence ? "Implemented with TEST-only evidence." : "Implemented; no canonical evidence recorded."),
      pipelineStage("fulfillment_eligible", "Fulfillment eligibility", true, "Local settings, order, item snapshot, and provider mappings", "Future local workflow", "Preparation logic implemented; submission remains disabled."),
      pipelineStage("provider_draft", "Provider draft", true, "commerce_fulfillment_orders + fulfillment item correlations", "Controlled draft response normalization", operations.counts.total ? "A normalized provider order is recorded; confirmation remains unavailable." : "Draft recording is implemented; no provider order is recorded."),
      pipelineStage("submitted", "Submitted / processing", true, "Normalized provider state distinct from local payment", "Verified webhook or bounded reconciliation", "Lifecycle storage is implemented; provider submission remains disabled."),
      pipelineStage("shipment", "Shipped / delivered", true, "commerce_fulfillment_shipments + item coverage + encrypted tracking", "Verified webhook first; reconciliation fallback", operations.counts.shipments ? "Normalized shipment evidence exists." : "Shipment, partial coverage, return, and reshipment authority is implemented with no current evidence."),
    ],
    shipping: {
      schema: { state: shippingSchemaReady ? "ready" : "migration_required", migration: "0015_checkout_shipping_foundation.sql", quoteTable: shippingQuoteStorageImplemented, deliverySnapshotTable: shippingDataImplemented },
      customerData: { state: shippingDataImplemented ? number(orderCounts?.test_shipping_snapshots) + number(orderCounts?.live_shipping_snapshots) > 0 ? "available" : "implemented_no_evidence" : "migration_required", persistedFields: shippingDataImplemented ? ["encrypted_recipient", "destination_country", "destination_region", "shipping_method", "shipping_amount", "currency", "source_quote"] : [], orderSpecificPiiProjectedHere: false },
      rates: { state: !shippingQuoteStorageImplemented ? "migration_required" : shippingStrategy === "unconfigured" ? "implemented_disabled" : "configured", strategy: shippingStrategy, providerQuotePathImplemented: true, providerQuoteCalled: false },
    },
    tracking: { state: !lifecycleSchemaReady ? "migration_required" : operations.counts.shipments ? "available" : "implemented_no_evidence", persistedFields: trackingColumns, shipmentPollingImplemented: false, providerPollingPerformed: false },
    lifecycle: {
      schema: { state: lifecycleSchemaReady ? "ready" : "migration_required", migration: "0018_printful_fulfillment_lifecycle.sql" },
      providerOrderModel: { state: lifecycleSchemaReady ? "implemented" : "migration_required", authority: "commerce_fulfillment_orders" },
      draftRecording: { state: lifecycleSchemaReady ? "implemented" : "migration_required", idempotent: true },
      webhookReceiver: { state: "implemented", protocol: "printful_v2_beta_hmac_sha256", route: "/api/webhooks/printful" },
      webhookVerification: { state: printfulWebhookVerificationConfigured(env) ? "configured_unverified" : "not_configured" },
      providerSubscription: { state: providerMetadata.webhook_v2_subscription_verified === true ? "verified" : "not_configured_unverified" },
      shipmentNormalization: { state: lifecycleSchemaReady ? "implemented" : "migration_required", authority: "commerce_fulfillment_shipments" },
      partialShipmentHandling: { state: lifecycleSchemaReady ? "implemented" : "migration_required", authority: "normalized item coverage" },
      trackingStorage: { state: lifecycleSchemaReady ? "implemented_encrypted" : "migration_required" },
      carrierDeliveryPolling: { state: "not_implemented" },
      reconciliationFallback: { state: "implemented_inactive", automaticPolling: false },
      fulfillmentSubmission: { state: "disabled" },
    },
    operations,
    draftPreview,
    gates: fulfillmentGates({ canonicalReadiness, providerConfigured, orderModeSetting, orderModeConsistent, fulfillmentEnabled, shippingDataImplemented, shippingSchemaReady, shippingStrategy, mapping, settings }),
    dependencies: {
      business: { href: "/commerce/business" }, taxDocuments: { href: "/commerce/tax" }, customerEmails: { href: "/commerce/emails", shipmentTemplate: templateDependencyState(shipmentTemplate), sendsEnabled: settings.transactional_email_enabled === true },
      payments: { href: "/commerce/payments" }, products: { href: "/products" }, orders: { href: "/orders" },
    },
    evidence: {
      recent: (recentOrdersResult?.results || []).map((row) => ({ id: cleanText(row.id, 160), environment: row.environment === "live" ? "live" : "test", paymentStatus: cleanText(row.payment_status, 40), fulfillmentStatus: cleanText(row.fulfillment_status, 40), providerOrderRecorded: row.provider_order_recorded === 1, providerOrderId: cleanText(row.printful_order_id, 80) || null, providerOrderStatus: cleanText(row.provider_order_status, 40) || null, providerConfirmationStatus: cleanText(row.provider_confirmation_status, 40) || null, createdAt: cleanText(row.created_at, 80), updatedAt: cleanText(row.updated_at, 80) })),
      counts: { totalOrders: number(orderCounts?.total), testOrders: number(orderCounts?.test_orders), liveOrders: number(orderCounts?.live_orders), providerOrders: operations.counts.total, fulfillmentEvidence: operations.counts.total, testShippingSnapshots: number(orderCounts?.test_shipping_snapshots), liveShippingSnapshots: number(orderCounts?.live_shipping_snapshots), shipments: operations.counts.shipments },
      lastAudit: lastAudit ? { action: cleanText(lastAudit.action, 120), result: cleanText(lastAudit.result, 40), createdAt: cleanText(lastAudit.created_at, 80) } : null,
    },
    technical: { builderVersion: PRINTFUL_DRAFT_BUILDER_VERSION, providerCallsOnRead: false, providerCallsOnPreview: false, previewPersists: false, previewAuditedAsMutation: false, shippingDataCapability: shippingDataImplemented ? "implemented" : "migration_required", shippingRateCapability: !shippingQuoteStorageImplemented ? "migration_required" : shippingStrategy === "unconfigured" ? "implemented_disabled" : "configured", trackingCapability: lifecycleSchemaReady ? "implemented" : "migration_required", legacyTrackingColumns },
    safety: { checkoutEnabled: settings.checkout_enabled === true, controlledTestCheckoutEnabled: settings.stripe_test_checkout_enabled === true, livePaymentCaptureEnabled: settings.live_payment_capture_enabled === true, fulfillmentEnabled, orderMode: orderModeSetting, controlledTestDraftCreationImplemented: true, providerSubmissionAvailable: false, providerConfirmationAvailable: false, previewOnly: true, mutationsAvailableFromThisRoute: false },
    canonicalReadiness, checkedAt: nowIso(),
  };
}

export function preparePrintfulDraftOrder(input) {
  if (Array.isArray(input?.items)) {
    if (!input.items.length) return preparePrintfulDraftOrder({ ...input, items: undefined, candidate: null, quantity: 0 });
    const parts = input.items.map((item) => preparePrintfulDraftOrder({ ...input, items: undefined, candidate: item?.candidate || null, quantity: item?.quantity }));
    const blockers = [];
    for (const part of parts) for (const blocker of part.blockers) if (!blockers.some((entry) => entry.code === blocker.code)) blockers.push(blocker);
    const first = parts[0];
    return {
      ...first, eligible: blockers.length === 0, blockers, item: first.item, items: parts.map((part) => part.item).filter(Boolean),
      safePayloadPreview: first.safePayloadPreview ? { ...first.safePayloadPreview, items: parts.flatMap((part) => part.safePayloadPreview?.items || []) } : null,
      ...(input.projection === "internal" && first.internalDraftPayload ? { internalDraftPayload: { ...first.internalDraftPayload, items: parts.flatMap((part) => part.internalDraftPayload?.items || []) } } : {}),
    };
  }
  const blockers = [];
  const candidate = input?.candidate && typeof input.candidate === "object" ? input.candidate : null;
  const quantity = Number(input?.quantity);
  const orderMode = cleanText(input?.orderMode, 40).toLowerCase();
  const providerMode = cleanText(input?.providerMode, 40).toLowerCase();
  const recipient = input?.recipient && typeof input.recipient === "object" ? input.recipient : null;
  const recipientFields = ["name", "address1", "city", "postalCode", "countryCode"];
  const recipientMissing = recipientFields.filter((field) => !cleanText(recipient?.[field], field === "countryCode" ? 2 : 180));
  const shippingStrategy = cleanText(input?.shippingStrategy, 80).toLowerCase() || "unconfigured";
  const shippingMethod = cleanText(input?.shippingMethod, 100);
  const providerShippingMethodId = cleanText(input?.providerShippingMethodId, 120);
  const block = (code, message) => { if (!blockers.some((entry) => entry.code === code)) blockers.push({ code, message }); };

  if (!candidate) block("product_variant_missing", "No authoritative local product and variant mapping is available.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) block("quantity_invalid", "Quantity must be an integer between 1 and 20.");
  if (candidate && candidate.provider !== "printful") block("provider_unsupported", "The authoritative variant provider is not Printful.");
  if (candidate && (candidate.mappingStatus !== "mapped" || !candidate.targetVariantId || !candidate.targetProductId)) block("provider_mapping_missing", "The variant does not meet the authoritative Printful mapping contract.");
  if (candidate && candidate.productTargetId && candidate.targetProductId && candidate.productTargetId !== candidate.targetProductId) block("provider_mapping_ambiguous", "The product and variant target mappings disagree.");
  if (candidate && !new Set(["target_verified", "target_native"]).has(candidate.productMigrationStatus)) block("product_migration_unverified", "The product target mapping is not verified or target-native.");
  if (candidate && !new Set(["target_verified", "target_native"]).has(candidate.variantMigrationStatus)) block("variant_migration_unverified", "The variant target mapping is not verified or target-native.");
  if (candidate && input?.requireSellable === true && candidate.sellable !== true) block("variant_not_sellable", "The authoritative variant is not currently sellable.");
  if (candidate && (candidate.productStatus !== "active" || candidate.productVisibility !== "public" || candidate.variantStatus !== "active" || candidate.variantVisibility !== "public" || candidate.availability !== "active")) block("variant_unavailable", "The product or variant is not active, public, and available.");
  if (recipientMissing.length) block("recipient_incomplete", "A complete recipient name and postal address are required.");
  if (candidate?.requiresShipping !== false && shippingStrategy === "unconfigured") block("shipping_strategy_missing", "No authoritative shipping-rate strategy is configured.");
  if (candidate?.requiresShipping !== false && (!shippingMethod || !providerShippingMethodId)) block("shipping_method_missing", "An authoritative selected shipping method is required.");
  if (providerShippingMethodId && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(providerShippingMethodId)) block("shipping_method_invalid", "The selected provider shipping method is invalid.");
  if (input?.fulfillmentEnabled !== true) block("fulfillment_disabled", "Fulfillment submission is intentionally disabled.");
  if (orderMode !== "draft_only") block(orderMode === "live" ? "live_order_mode_rejected" : "printful_order_mode_invalid", "Preview preparation requires the canonical Printful mode to be draft_only.");
  if (providerMode && providerMode !== orderMode) block("printful_mode_contradictory", "The provider metadata and canonical Printful order mode disagree.");
  if (input?.environment === "live" && input?.previewOnly === true) block("live_preview_rejected", "A preview-only path cannot prepare a LIVE order.");
  if (input?.paymentStatus && !new Set(["paid", "synthetic_fixture"]).has(input.paymentStatus)) block("payment_not_confirmed", "A real order must have signed-webhook payment authority before fulfillment preparation.");

  const safeItem = candidate ? { localOrderItemId: cleanText(candidate.localOrderItemId, 160) || null, productId: cleanText(candidate.productId, 160), product: cleanText(candidate.productTitle, 240), variantId: cleanText(candidate.variantId, 160), variant: cleanText(candidate.variantLabel, 240) || "Standard", provider: cleanText(candidate.provider, 40), mappedProviderVariant: cleanText(candidate.targetVariantId, 240) || null, quantity: Number.isInteger(quantity) ? quantity : null } : null;
  return {
    builderVersion: PRINTFUL_DRAFT_BUILDER_VERSION, kind: "draft_preview", eligible: blockers.length === 0, blockers,
    labels: ["DRAFT PREVIEW", "NO PROVIDER REQUEST", "NOT SUBMITTED"],
    reference: cleanText(input?.reference, 160) || "DRAFT-PREVIEW", environment: input?.environment === "live" ? "live" : "test",
    item: safeItem,
    requirements: {
      recipient: { source: cleanText(recipient?.source, 40) || "missing", complete: recipientMissing.length === 0, missing: recipientMissing, countryCode: cleanText(recipient?.countryCode, 2).toUpperCase() || null, postalCodePresent: Boolean(cleanText(recipient?.postalCode, 24)) },
      shipping: { required: candidate?.requiresShipping !== false, strategy: shippingStrategy, configured: shippingStrategy !== "unconfigured" && Boolean(shippingMethod && providerShippingMethodId), method: shippingMethod || null },
    },
    safePayloadPreview: safeItem?.mappedProviderVariant ? { externalReference: cleanText(input?.reference, 160) || "DRAFT-PREVIEW", recipient: { source: cleanText(recipient?.source, 40) || "missing", countryCode: cleanText(recipient?.countryCode, 2).toUpperCase() || null, postalCodePresent: Boolean(cleanText(recipient?.postalCode, 24)) }, items: [{ providerVariantId: safeItem.mappedProviderVariant, quantity: safeItem.quantity }], shipping: { strategy: shippingStrategy, method: shippingMethod || null } } : null,
    ...(input?.projection === "internal" && safeItem?.mappedProviderVariant ? { internalDraftPayload: {
      shipping: providerShippingMethodId || null,
      recipient: {
        name: cleanText(recipient?.name, 120), address1: cleanText(recipient?.address1, 180),
        ...(cleanText(recipient?.address2, 180) ? { address2: cleanText(recipient.address2, 180) } : {}),
        city: cleanText(recipient?.city, 120), ...(cleanText(recipient?.region, 80) ? { state_code: cleanText(recipient.region, 80) } : {}),
        country_code: cleanText(recipient?.countryCode, 2).toUpperCase(), zip: cleanText(recipient?.postalCode, 24),
        ...(cleanText(recipient?.phone, 32) ? { phone: cleanText(recipient.phone, 32) } : {}),
      },
      items: [{ sync_variant_id: safeItem.mappedProviderVariant, quantity: safeItem.quantity }],
    } } : {}),
    submission: { available: false, mode: orderMode || "unconfigured", networkRequestMade: false, providerOrderCreated: false, localOrderMutated: false, migrationMutated: false },
  };
}

export async function prepareStoredPrintfulDraftOrder(env, rawOrderId) {
  const db = requireCommerceDb(env);
  const orderId = validId(rawOrderId, "order_id_invalid");
  const [order, delivery, itemResult, settingsResult, provider] = await Promise.all([
    db.prepare("SELECT id,environment,payment_status,fulfillment_status FROM commerce_orders WHERE id=?").bind(orderId).first(),
    db.prepare("SELECT * FROM commerce_order_delivery_snapshots WHERE order_id=?").bind(orderId).first(),
    db.prepare(`SELECT i.id order_item_id,i.product_id,i.variant_id,i.product_name,i.variant_name,i.quantity,i.requires_shipping,i.fulfillment_provider,i.fulfillment_variant_id,
      p.status product_status,p.visibility product_visibility,p.migration_status product_migration_status,p.target_printful_product_id product_target_id,
      v.status variant_status,v.visibility variant_visibility,v.is_sellable,v.availability_status,v.fulfillment_mapping_status,
      v.migration_status variant_migration_status,v.target_printful_product_id variant_target_product_id,v.target_printful_sync_variant_id
      FROM commerce_order_items i LEFT JOIN commerce_products p ON p.id=i.product_id LEFT JOIN commerce_product_variants v ON v.id=i.variant_id
      WHERE i.order_id=? ORDER BY i.line_number`).bind(orderId).all(),
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('fulfillment_submission_enabled','printful_order_mode')").all(),
    db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider='printful'").first(),
  ]);
  if (!order) throw new AuthFailure(404, "order_not_found", "The commerce order was not found.");
  if (!delivery) return preparePrintfulDraftOrder({ reference: orderId, environment: order.environment, paymentStatus: order.payment_status, items: [], recipient: null, shippingStrategy: "unconfigured", fulfillmentEnabled: false, orderMode: "draft_only", providerMode: "draft_only", projection: "internal" });
  const recipient = json(await decryptCommerceSecret(env, delivery.recipient_ciphertext, `order-delivery:${orderId}`), null);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, null)]));
  const providerMetadata = json(provider?.safe_metadata_json, {});
  const items = (itemResult?.results || []).map((row) => ({ quantity: Number(row.quantity), candidate: {
    localOrderItemId: cleanText(row.order_item_id, 160),
    productId: cleanText(row.product_id, 160), productTitle: cleanText(row.product_name, 240), productStatus: cleanText(row.product_status, 40), productVisibility: cleanText(row.product_visibility, 40),
    variantId: cleanText(row.variant_id, 160), variantLabel: cleanText(row.variant_name, 240) || "Standard", variantStatus: cleanText(row.variant_status, 40), variantVisibility: cleanText(row.variant_visibility, 40),
    sellable: row.is_sellable === 1, availability: cleanText(row.availability_status, 40), requiresShipping: row.requires_shipping === 1,
    provider: cleanText(row.fulfillment_provider, 40), mappingStatus: row.fulfillment_mapping_status === "mapped" && row.fulfillment_variant_id === row.target_printful_sync_variant_id ? "mapped" : "unmapped",
    productTargetId: cleanText(row.product_target_id, 240) || null, targetProductId: cleanText(row.variant_target_product_id, 240) || null,
    targetVariantId: cleanText(row.fulfillment_variant_id, 240) || null,
    productMigrationStatus: cleanText(row.product_migration_status, 40), variantMigrationStatus: cleanText(row.variant_migration_status, 40),
  } }));
  return preparePrintfulDraftOrder({
    reference: orderId, environment: order.environment, paymentStatus: order.payment_status, items,
    recipient: recipient ? { ...recipient, source: "encrypted_order_snapshot" } : null,
    shippingStrategy: delivery.shipping_strategy, shippingMethod: delivery.display_shipping_method,
    providerShippingMethodId: delivery.provider_shipping_method_id,
    fulfillmentEnabled: settings.fulfillment_submission_enabled === true,
    orderMode: cleanText(settings.printful_order_mode, 40) || "unconfigured",
    providerMode: cleanText(providerMetadata.order_mode || providerMetadata.mode, 40) || "unconfigured",
    requireSellable: true, previewOnly: order.environment !== "live", projection: "internal",
  });
}

export async function diagnoseStoredPrintfulDraftOrder(env, rawOrderId, options = {}) {
  const orderId = validId(rawOrderId, "order_id_invalid");
  validateDraftRepairConstraints(orderId, options);
  const prepared = await prepareStoredPrintfulDraftOrder(env, orderId);
  const unexpectedBlockers = prepared.blockers.filter((entry) => entry.code !== "fulfillment_disabled");
  requireDraftAcceptance(unexpectedBlockers.length === 0 && prepared.internalDraftPayload, unexpectedBlockers[0]?.code || "printful_draft_preparation_invalid", unexpectedBlockers[0]?.message || "The authoritative draft payload is unavailable.");
  const request = await buildPrintfulDraftCreateRequest({
    localOrderId: orderId,
    targetStoreId: env?.PRINTFUL_STORE_ID,
    shippingCode: prepared.internalDraftPayload.shipping,
    recipient: prepared.internalDraftPayload.recipient,
    syncVariantId: prepared.internalDraftPayload.items?.[0]?.sync_variant_id,
    quantity: prepared.internalDraftPayload.items?.[0]?.quantity,
  });
  return { ok: true, orderId, request: request.diagnostic };
}

export async function createStoredPrintfulDraftOrder(env, session, rawOrderId, fetchImpl = fetch, options = {}) {
  const db = requireCommerceDb(env);
  const orderId = validId(rawOrderId, "order_id_invalid");
  validateDraftRepairConstraints(orderId, options);
  const [order, itemResult, delivery, settingsResult, provider, migration, normalized] = await Promise.all([
    db.prepare(`SELECT o.id,o.environment,o.payment_status,o.fulfillment_status,o.stripe_checkout_session_id,
      o.printful_order_id,o.safe_metadata_json,o.payment_confirmed_at,o.customer_id,o.updated_at,
      c.id linked_customer_id,c.customer_kind,c.contact_name_ciphertext,c.contact_email_ciphertext
      FROM commerce_orders o LEFT JOIN commerce_customers c ON c.id=o.customer_id WHERE o.id=?`).bind(orderId).first(),
    db.prepare("SELECT product_id,variant_id,quantity FROM commerce_order_items WHERE order_id=? ORDER BY line_number").bind(orderId).all(),
    db.prepare("SELECT source_quote_id,provider_shipping_method_id,recipient_ciphertext FROM commerce_order_delivery_snapshots WHERE order_id=?").bind(orderId).first(),
    db.prepare(`SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN (
      'checkout_enabled','stripe_test_checkout_enabled','stripe_test_checkout_product_id','stripe_test_checkout_variant_id',
      'live_payment_capture_enabled','fulfillment_submission_enabled','transactional_email_enabled','stripe_tax_enabled',
      'printful_order_mode','shipping_strategy')`).all(),
    db.prepare("SELECT status,environment,integration_mode,external_account_id,currency_code,safe_metadata_json FROM commerce_provider_connections WHERE provider='printful'").first(),
    db.prepare("SELECT status,phase,step_lease_token FROM commerce_catalogue_migrations WHERE id='permanent-printful-2026-08'").first(),
    db.prepare("SELECT * FROM commerce_fulfillment_orders WHERE order_id=? AND provider='printful' LIMIT 1").bind(orderId).first(),
  ]);
  if (!order) throw new AuthFailure(404, "order_not_found", "The commerce order was not found.");

  const verifiedWebhook = await db.prepare(`SELECT provider_event_id FROM commerce_webhook_events
    WHERE provider='stripe' AND event_type='checkout.session.completed' AND livemode=0
      AND related_object_id=? AND processing_status='processed' AND result_code='payment_confirmed'
      AND length(payload_sha256)=64 LIMIT 1`).bind(order.stripe_checkout_session_id).first();
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, null)]));
  const providerMetadata = json(provider?.safe_metadata_json, {});
  const items = itemResult?.results || [];
  const item = items[0] || null;
  const existingMetadata = json(order.safe_metadata_json, {});

  requireDraftAcceptance(order.environment === "test", "printful_draft_test_only", "Only a controlled TEST order may create an acceptance draft.");
  requireDraftAcceptance(order.payment_status === "paid" && Boolean(order.payment_confirmed_at) && Boolean(verifiedWebhook), "printful_draft_payment_unverified", "A processed signed Stripe TEST webhook must confirm payment before drafting.");
  requireDraftAcceptance(Boolean(order.customer_id) && order.customer_id === order.linked_customer_id && order.customer_kind === "guest" && Boolean(order.contact_name_ciphertext) && Boolean(order.contact_email_ciphertext), "printful_draft_customer_missing", "The controlled TEST order must be linked to its encrypted Guest Customer authority.");
  requireDraftAcceptance(order.fulfillment_status === "disabled", "printful_draft_fulfillment_state_invalid", "The local order must remain outside fulfillment.");
  requireDraftAcceptance(settings.checkout_enabled === false && settings.live_payment_capture_enabled === false, "printful_draft_live_gate_open", "Normal checkout and live payments must remain disabled.");
  requireDraftAcceptance(settings.fulfillment_submission_enabled === false && providerMetadata.fulfillment_enabled !== true, "printful_draft_fulfillment_gate_open", "Fulfillment must remain disabled while creating the unconfirmed draft.");
  requireDraftAcceptance(settings.transactional_email_enabled === false && settings.stripe_tax_enabled === false, "printful_draft_side_effect_gate_open", "Customer email and Stripe Tax must remain disabled.");
  if (options.allowClosedAcceptance !== true) requireDraftAcceptance(settings.stripe_test_checkout_enabled === true, "printful_draft_acceptance_closed", "The controlled TEST acceptance window is not open.");
  requireDraftAcceptance(settings.printful_order_mode === "draft_only" && cleanText(providerMetadata.order_mode || providerMetadata.mode, 40) === "draft_only", "printful_draft_mode_invalid", "Printful must remain in draft_only mode.");
  if (options.allowClosedAcceptance !== true) requireDraftAcceptance(settings.shipping_strategy === "printful_dynamic", "printful_draft_shipping_invalid", "The order must use the controlled Printful shipping strategy.");
  requireDraftAcceptance(provider?.status === "connected" && provider?.environment === "staging" && provider?.integration_mode === "fulfillment" && String(provider?.currency_code || "").toUpperCase() === "CAD", "printful_draft_provider_invalid", "The configured Printful staging provider is unavailable.");
  requireDraftAcceptance(providerMetadata.api_configured === true && isPrintfulCredentialConfigured(env), "printful_draft_provider_unconfigured", "Printful order authority is not configured.");
  requireDraftAcceptance(cleanText(provider?.external_account_id, 40) === PRINTFUL_TARGET_STORE_ID && cleanText(env?.PRINTFUL_STORE_ID, 40) === PRINTFUL_TARGET_STORE_ID, "printful_draft_store_mismatch", "The Printful target store does not match the configured authority.");
  requireDraftAcceptance(migration && new Set(["completed", "completed_with_blocked_products"]).has(migration.status) && migration.phase === "completed" && !migration.step_lease_token, "printful_draft_migration_active", "The permanent Printful migration is not terminal.");
  requireDraftAcceptance(items.length === 1 && item && Number(item.quantity) === 1, "printful_draft_item_count_invalid", "The controlled acceptance draft is limited to one item at quantity one.");
  const expectedProductId = cleanText(options.expectedProductId || settings.stripe_test_checkout_product_id, 160);
  const expectedVariantId = cleanText(options.expectedVariantId || settings.stripe_test_checkout_variant_id, 160);
  requireDraftAcceptance(Boolean(expectedProductId && expectedVariantId) && item.product_id === expectedProductId && item.variant_id === expectedVariantId, "printful_draft_candidate_mismatch", "The paid order does not match the configured acceptance candidate.");
  requireDraftAcceptance(delivery && delivery.recipient_ciphertext && delivery.source_quote_id && delivery.provider_shipping_method_id, "printful_draft_delivery_missing", "The paid order has no authoritative encrypted delivery and shipping selection.");

  const externalId = await buildPrintfulOrderExternalId(orderId);

  if (order.printful_order_id || normalized) {
    const providerOrderId = cleanText(order.printful_order_id || normalized?.provider_order_id, 80);
    requireDraftAcceptance(Boolean(providerOrderId), "printful_draft_local_state_invalid", "The stored provider order identifier is invalid.");
    requireDraftAcceptance(!normalized || (normalized.provider_store_id === PRINTFUL_TARGET_STORE_ID && normalized.external_id === externalId && normalized.provider_state === "draft" && normalized.confirmation_state === "unconfirmed"), "printful_draft_local_state_invalid", "The normalized provider order is not the expected unconfirmed draft.");
    requireDraftAcceptance(!order.printful_order_id || (existingMetadata.printfulOrderStatus === "draft" && existingMetadata.printfulConfirmationStatus === "unconfirmed"), "printful_draft_local_state_invalid", "The stored provider order is not an unconfirmed draft.");
    await reconcilePrintfulOrderEvidence(env, {
      provider: "printful", providerStoreId: cleanText(provider.external_account_id, 40), providerOrderId,
      externalId, providerStatus: "draft", providerState: "draft", confirmationState: "unconfirmed",
      providerCreatedAt: null, providerUpdatedAt: null, occurredAt: cleanText(existingMetadata.printfulDraftRecordedAt || order.updated_at, 80) || nowIso(),
      failureCategory: null, items: [], shipments: [],
    }, { expectedStoreId: provider.external_account_id, localOrderId: orderId });
    return printfulDraftResult(orderId, providerOrderId, externalId, false, true, null);
  }

  const prepared = await prepareStoredPrintfulDraftOrder(env, orderId);
  const unexpectedBlockers = prepared.blockers.filter((entry) => entry.code !== "fulfillment_disabled");
  requireDraftAcceptance(unexpectedBlockers.length === 0 && prepared.internalDraftPayload, unexpectedBlockers[0]?.code || "printful_draft_preparation_invalid", unexpectedBlockers[0]?.message || "The authoritative draft payload is unavailable.");
  const createRequest = await buildPrintfulDraftCreateRequest({
    localOrderId: orderId,
    targetStoreId: provider.external_account_id,
    shippingCode: prepared.internalDraftPayload.shipping,
    recipient: prepared.internalDraftPayload.recipient,
    syncVariantId: prepared.internalDraftPayload.items?.[0]?.sync_variant_id,
    quantity: prepared.internalDraftPayload.items?.[0]?.quantity,
  });
  const headers = printfulOrderHeaders(env);
  let providerOrder = null;
  providerOrder = await lookupPrintfulDraft(fetchImpl, headers, externalId, provider.external_account_id, createRequest.payloadDigest, "printful_order_reconcile_before_create");

  let created = false;
  if (!providerOrder) {
    let response;
    try {
      response = await boundedPrintfulFetch(fetchImpl, createRequest.url, {
        method: createRequest.method, redirect: "manual", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(createRequest.body),
      }, { operation: "printful_order_draft_create", payloadDigest: createRequest.payloadDigest });
    } catch (error) {
      providerOrder = await lookupPrintfulDraft(fetchImpl, headers, externalId, provider.external_account_id, createRequest.payloadDigest, "printful_order_reconcile_after_ambiguous_create");
      if (!providerOrder) throw error;
    }
    if (response && !response.ok) {
      const rejection = await normalizePrintfulApiError(response, { operation: "printful_order_draft_create", payloadDigest: createRequest.payloadDigest });
      providerOrder = await lookupPrintfulDraft(fetchImpl, headers, externalId, provider.external_account_id, createRequest.payloadDigest, "printful_order_reconcile_after_rejection");
      if (!providerOrder) throw rejection;
    }
    if (response?.ok) {
      try { providerOrder = await normalizePrintfulDraftResponse(response, externalId, provider.external_account_id); }
      catch (error) {
        providerOrder = await lookupPrintfulDraft(fetchImpl, headers, externalId, provider.external_account_id, createRequest.payloadDigest, "printful_order_reconcile_after_invalid_response");
        if (!providerOrder) throw error;
      }
      created = true;
    }
  }

  const timestamp = nowIso();
  const nextMetadata = {
    ...existingMetadata,
    printfulExternalId: externalId,
    printfulOrderStatus: "draft",
    printfulConfirmationStatus: "unconfirmed",
    printfulDraftRecordedAt: timestamp,
  };
  const updated = await db.prepare(`UPDATE commerce_orders SET printful_order_id=?,safe_metadata_json=?,updated_at=?
    WHERE id=? AND printful_order_id IS NULL AND payment_status='paid' AND fulfillment_status='disabled'`)
    .bind(providerOrder.id, JSON.stringify(nextMetadata), timestamp, orderId).run();
  if (Number(updated?.meta?.changes || 0) !== 1) {
    const recovered = await db.prepare("SELECT printful_order_id,safe_metadata_json FROM commerce_orders WHERE id=?").bind(orderId).first();
    const recoveredMetadata = json(recovered?.safe_metadata_json, {});
    requireDraftAcceptance(recovered?.printful_order_id === providerOrder.id && recoveredMetadata.printfulConfirmationStatus === "unconfirmed", "printful_draft_link_failed", "The Printful draft could not be linked to the local order.");
  }
  await reconcilePrintfulOrderEvidence(env, providerOrder.evidence, { expectedStoreId: provider.external_account_id, actorAccountId: session?.accountId, localOrderId: orderId });
  await writeCommerceAudit(env, { actorAccountId: session?.accountId || null, action: created ? "printful.order_draft_created" : "printful.order_draft_reconciled", targetType: "commerce_order", targetId: orderId, result: "success", metadata: { provider: "printful", environment: "test", confirmed: false } });
  return printfulDraftResult(orderId, providerOrder.id, externalId, created, !created, createRequest.diagnostic);
}

function validateDraftRepairConstraints(orderId, options) {
  const expectedOrderId = cleanText(options?.expectedOrderId, 160);
  if (expectedOrderId && orderId !== expectedOrderId) throw new AuthFailure(409, "printful_draft_order_mismatch", "The controlled Printful draft order does not match the bounded acceptance order.");
}

function requireDraftAcceptance(condition, code, message) {
  if (!condition) throw new AuthFailure(409, code, message);
}

function printfulOrderHeaders(env) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${String(env.PRINTFUL_API_TOKEN).trim()}`,
    "X-PF-Store-Id": String(env.PRINTFUL_STORE_ID).trim(),
  };
}

async function boundedPrintfulFetch(fetchImpl, url, init, diagnostic = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try { return await fetchImpl(url, { ...init, signal: controller.signal }); }
  catch { throw new PrintfulApiError({ operation: diagnostic.operation || "printful_request", safeMessage: "Printful transport failed before a complete response was received.", retryable: true, payloadDigest: diagnostic.payloadDigest || null }); }
  finally { clearTimeout(timeout); }
}

async function lookupPrintfulDraft(fetchImpl, headers, externalId, storeId, payloadDigest, operation) {
  const response = await boundedPrintfulFetch(fetchImpl, `${PRINTFUL_ORDERS_URL}/@${encodeURIComponent(externalId)}`, { method: "GET", redirect: "manual", headers }, { operation, payloadDigest });
  if (response.status === 404) return null;
  if (!response.ok) throw await normalizePrintfulApiError(response, { operation, payloadDigest });
  return normalizePrintfulDraftResponse(response, externalId, storeId);
}

async function normalizePrintfulDraftResponse(response, externalId, storeId) {
  let payload;
  try { payload = await response.json(); } catch { throw new AuthFailure(502, "printful_draft_response_invalid", "Printful returned an invalid draft response."); }
  const result = payload?.code === 200 && payload?.result && typeof payload.result === "object" && !Array.isArray(payload.result) ? payload.result : null;
  const id = cleanText(result?.id, 80);
  const external = cleanText(result?.external_id, 160);
  const status = cleanText(result?.status, 40).toLowerCase();
  const resultStore = cleanText(result?.store, 40);
  if (!/^\d+$/.test(id) || external !== externalId || status !== "draft" || (resultStore && resultStore !== cleanText(storeId, 40))) {
    throw new AuthFailure(502, "printful_draft_response_invalid", "Printful did not return the expected unconfirmed draft.");
  }
  return { id, evidence: normalizePrintfulOrderEvidence(result, { expectedStoreId: storeId, expectedExternalId: externalId, occurredAt: nowIso() }) };
}

function printfulDraftResult(orderId, providerOrderId, externalId, created, reconciled, request) {
  return { ok: true, orderId, providerOrderId: cleanText(providerOrderId, 80), externalId, status: "draft", confirmed: false, created, reconciled, ...(request ? { request } : {}) };
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
  const db = requireCommerceDb(env);
  const source = await templateRow(db, templateKey);
  const template = input?.template ? validateTemplate({ ...input.template, templateKey }) : serializeTemplateForValidation(source);
  const fixture = input?.orderId ? await orderVariables(db, input.orderId) : await syntheticVariables(db);
  return { ok: true, preview: renderCommerceTemplate(template, fixture.variables, { assetOrigin: env?.THIRDRAILIFY_ADMIN_ORIGIN }), source: fixture.source, test: fixture.test, orderId: fixture.orderId || null, variables: fixture.variables };
}

const CUSTOMER_EMAIL_LIFECYCLES = Object.freeze({
  order_confirmation: "Confirms that the payment and local order record were accepted.",
  shipment_notification: "Presents fulfillment and tracking information after a shipment is confirmed.",
  cancellation: "Explains that an order was cancelled.",
  refund: "Explains a persisted refund outcome.",
  payment_failure: "Explains that payment was not completed.",
  invoice_notification: "Wraps a safe customer link to an invoice document.",
  receipt_notification: "Wraps a safe customer link to a payment receipt.",
});

const CUSTOMER_EMAIL_VARIABLES = Object.freeze([
  { key: "customer_name", group: "Customer", description: "Synthetic customer name in preview; workflow-provided name during delivery." },
  { key: "order_reference", group: "Order", description: "Opaque local order reference." },
  { key: "order_total", group: "Order", description: "Order total formatted from integer minor units." },
  { key: "currency", group: "Order", description: "Canonical commerce currency code." },
  { key: "product_summary", group: "Order", description: "Bounded plain-text item summary." },
  { key: "shipping_method", group: "Fulfillment", description: "Workflow-provided shipping method when available." },
  { key: "tracking_number", group: "Fulfillment", description: "Workflow-provided tracking number when available." },
  { key: "merchant_name", group: "Business", description: "Storefront trading name from Business Information." },
  { key: "support_email", group: "Business", description: "Public support contact from Business Information." },
  { key: "receipt_url", group: "Document", description: "Opaque customer-document URL minted only by the legitimate delivery workflow." },
]);

export async function customerEmailsControlPlanePayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  const sender = senderProjection(env);
  if (!isCommerceDbConfigured(env)) {
    return {
      ok: true, databaseConfigured: false, authority: "Commerce D1 + server environment", access,
      provider: providerProjection(env, sender, null, null), sender,
      templates: [],
      mergeVariables: CUSTOMER_EMAIL_VARIABLES,
      readiness: { state: "action_required", configurationReady: false, configuredTemplates: 0, totalTemplates: 0, minimumReadyTemplates: 2, customerSendsEnabled: false, productionLifecycleImplemented: false },
      dependencies: emptyEmailDependencies(),
      deliveries: emptyEmailDeliveries(),
      canonicalReadiness: null,
      safety: emailSafety(false),
      checkedAt: nowIso(),
    };
  }

  const db = requireCommerceDb(env);
  const [templatePayload, readiness, profile, settingsResult] = await Promise.all([
    templatesPayload(env, session),
    productionReadinessPayload(env, session),
    db.prepare("SELECT trading_name,currency_code,public_contact_email,support_email,legal_business_name_ciphertext,private_address_ciphertext FROM commerce_business_profiles WHERE id='primary'").first(),
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('transactional_email_enabled','customer_document_access_enabled')").all(),
  ]);
  const [timestampsRead, recentRead, countsRead, lastSuccessRead, lastFailureRead] = await Promise.all([
    optionalD1Read(() => db.prepare("SELECT template_key,updated_at FROM commerce_templates WHERE template_kind='email' ORDER BY template_key").all(), { results: [] }),
    optionalD1Read(() => db.prepare(`SELECT d.id,d.template_key,d.template_revision,d.order_id,d.purpose,d.status,d.provider_message_id,d.attempt_count,d.created_at,d.updated_at,d.sent_at,d.recipient_email,o.environment
                FROM commerce_email_deliveries d LEFT JOIN commerce_orders o ON o.id=d.order_id
                ORDER BY d.created_at DESC,d.id DESC LIMIT 12`).all(), { results: [] }),
    optionalD1Read(() => db.prepare(`SELECT CASE WHEN d.purpose='test_preview' OR o.environment='test' THEN 'test' WHEN o.environment='live' THEN 'live' ELSE 'unknown' END environment,d.status,COUNT(*) count
                FROM commerce_email_deliveries d LEFT JOIN commerce_orders o ON o.id=d.order_id GROUP BY environment,d.status`).all(), { results: [] }),
    optionalD1Read(() => db.prepare(`SELECT d.id,d.template_key,d.template_revision,d.order_id,d.purpose,d.status,d.provider_message_id,d.attempt_count,d.created_at,d.updated_at,d.sent_at,d.recipient_email,o.environment
                FROM commerce_email_deliveries d LEFT JOIN commerce_orders o ON o.id=d.order_id WHERE d.status='sent' ORDER BY COALESCE(d.sent_at,d.updated_at) DESC,d.id DESC LIMIT 1`).first(), null),
    optionalD1Read(() => db.prepare(`SELECT d.id,d.template_key,d.template_revision,d.order_id,d.purpose,d.status,d.provider_message_id,d.attempt_count,d.created_at,d.updated_at,d.sent_at,d.recipient_email,o.environment
                FROM commerce_email_deliveries d LEFT JOIN commerce_orders o ON o.id=d.order_id WHERE d.status='failed' ORDER BY d.updated_at DESC,d.id DESC LIMIT 1`).first(), null),
  ]);
  const timestampsResult = timestampsRead.value;
  const recentResult = recentRead.value;
  const countsResult = countsRead.value;
  const lastSuccess = lastSuccessRead.value;
  const lastFailure = lastFailureRead.value;
  const deliveryHistoryAvailable = recentRead.available && countsRead.available && lastSuccessRead.available && lastFailureRead.available;
  const timestamps = Object.fromEntries((timestampsResult?.results || []).map((row) => [row.template_key, cleanText(row.updated_at, 80) || null]));
  const emailTemplates = templatePayload.templates.filter((template) => template.templateKind === "email").map((template) => emailTemplateProjection(template, timestamps[template.templateKey]));
  const documentTemplates = Object.fromEntries(templatePayload.templates.filter((template) => template.templateKind === "document").map((template) => [template.templateKey, template]));
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, json(row.value_json, false)]));
  const customerSendsEnabled = settings.transactional_email_enabled === true;
  const configuredTemplates = emailTemplates.filter((template) => template.validity?.state !== "invalid" && template.status === "ready" && template.enabled).length;
  const configurationReady = sender.providerCredentialConfigured && sender.fromAddressConfigured && configuredTemplates >= 2;
  const manageSensitiveEvidence = access.isMasterAdmin || access.capabilities.includes("commerce.templates.manage");
  const recent = (recentResult?.results || []).map((row) => serializeEmailDelivery(row, manageSensitiveEvidence));
  const counts = { total: 0, test: 0, live: 0, unknown: 0, sent: 0, failed: 0, pending: 0, sending: 0 };
  for (const row of countsResult?.results || []) {
    const count = Number(row.count || 0); counts.total += count;
    if (row.environment in counts) counts[row.environment] += count;
    if (row.status in counts) counts[row.status] += count;
  }
  const businessContactComplete = Boolean(cleanText(profile?.trading_name, 160) && (cleanText(profile?.support_email, 254) || cleanText(profile?.public_contact_email, 254)));
  const communications = readiness.domains.communications;
  return {
    ok: true, databaseConfigured: true, authority: "Commerce D1 + server environment", access,
    provider: providerProjection(env, sender, lastSuccess ? serializeEmailDelivery(lastSuccess, manageSensitiveEvidence) : null, lastFailure ? serializeEmailDelivery(lastFailure, manageSensitiveEvidence) : null),
    sender: { ...sender, businessDisplayName: cleanText(profile?.trading_name, 160) || null, businessSupportEmail: cleanText(profile?.support_email || profile?.public_contact_email, 254) || null },
    templates: emailTemplates,
    mergeVariables: CUSTOMER_EMAIL_VARIABLES,
    readiness: {
      state: customerSendsEnabled ? (communications.ready ? "ready" : "action_required") : configurationReady ? "ready_but_disabled" : "incomplete",
      configurationReady, configuredTemplates, totalTemplates: emailTemplates.length, minimumReadyTemplates: 2,
      customerSendsEnabled, productionLifecycleImplemented: false,
    },
    dependencies: {
      business: { complete: businessContactComplete, canonicalReady: readiness.domains.business.ready, displayName: cleanText(profile?.trading_name, 160) || null, supportEmail: cleanText(profile?.support_email || profile?.public_contact_email, 254) || null, href: "/commerce/business" },
      documents: {
        receipt: templateDependency(documentTemplates.payment_receipt), invoice: templateDependency(documentTemplates.invoice_document),
        customerAccessEnabled: settings.customer_document_access_enabled === true, href: "/commerce/tax",
      },
      orders: { href: "/orders", orderSpecificHistoryOwner: true },
      paypalRequired: false,
    },
    deliveries: { state: deliveryHistoryAvailable ? "available" : "unavailable", recent, counts, lastSuccessful: lastSuccess ? serializeEmailDelivery(lastSuccess, manageSensitiveEvidence) : null, lastFailed: lastFailure ? serializeEmailDelivery(lastFailure, manageSensitiveEvidence) : null, idempotency: { implemented: true, authority: "Server-generated deterministic delivery key", retriesAvailableFromThisRoute: false } },
    canonicalReadiness: { productionReady: readiness.productionReady, communications },
    safety: emailSafety(customerSendsEnabled),
    checkedAt: nowIso(),
  };
}

function emailTemplateProjection(template, updatedAt = null) {
  return { ...template, purpose: CUSTOMER_EMAIL_LIFECYCLES[template.templateKey] || "Persisted customer lifecycle template.", updatedAt, productionTriggerImplemented: false };
}

function senderProjection(env) {
  const rawFrom = cleanText(env?.MAIL_FROM, 254);
  const bracketed = rawFrom.match(/^(.+?)\s*<([^<>]+)>$/);
  const candidateAddress = cleanText(bracketed?.[2] || rawFrom, 254).toLowerCase();
  const fromAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateAddress) ? candidateAddress : null;
  const replyCandidate = cleanText(env?.MAIL_REPLY_TO, 254).toLowerCase();
  const replyToAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyCandidate) ? replyCandidate : null;
  return {
    source: "server_environment", providerCredentialConfigured: Boolean(String(env?.RESEND_API_KEY || "").trim()),
    fromDisplayName: bracketed ? cleanText(bracketed[1].replace(/^['\"]|['\"]$/g, ""), 160) || null : null,
    fromAddress, fromAddressConfigured: Boolean(fromAddress), replyToAddress, replyToConfigured: Boolean(replyToAddress),
    sendingDomain: fromAddress ? fromAddress.split("@").at(-1) : null, externallyVerified: false,
  };
}

function providerProjection(env, sender, lastSuccessful, lastFailed) {
  return { name: "Resend", configured: Boolean(String(env?.RESEND_API_KEY || "").trim() && sender.fromAddressConfigured), credentialConfigured: sender.providerCredentialConfigured, senderConfigured: sender.fromAddressConfigured, replyToConfigured: sender.replyToConfigured, externalVerification: "unverified", lastSuccessful, lastFailed };
}

function serializeEmailDelivery(row, includeProviderReference) {
  const environment = row?.purpose === "test_preview" || row?.environment === "test" ? "test" : row?.environment === "live" ? "live" : "unknown";
  return {
    id: cleanText(row?.id, 160), templateKey: cleanText(row?.template_key, 60), templateRevision: Number(row?.template_revision || 1),
    orderId: cleanText(row?.order_id, 160) || null, environment, purpose: row?.purpose === "test_preview" ? "test_preview" : "transactional",
    status: ["pending", "sending", "sent", "failed"].includes(row?.status) ? row.status : "pending", attemptCount: Number(row?.attempt_count || 0),
    maskedRecipient: maskEmail(row?.recipient_email), providerMessageReference: includeProviderReference ? cleanText(row?.provider_message_id, 200) || null : null,
    failure: row?.status === "failed" ? "Provider delivery failed; no raw provider response is exposed." : null,
    createdAt: cleanText(row?.created_at, 80) || null, updatedAt: cleanText(row?.updated_at, 80) || null, sentAt: cleanText(row?.sent_at, 80) || null,
  };
}

function maskEmail(value) {
  const normalized = cleanText(value, 254).toLowerCase(); const separator = normalized.lastIndexOf("@");
  if (separator < 1) return "Not available";
  const local = normalized.slice(0, separator); const domain = normalized.slice(separator + 1);
  return `${local.slice(0, 1)}${local.length > 1 ? "***" : ""}@${domain}`;
}

function templateDependency(template) { return { configured: Boolean(template?.validity?.state !== "invalid" && template?.status === "ready" && template?.enabled), status: template?.validity?.state === "invalid" ? "invalid" : template?.status || "not_configured", enabled: Boolean(template?.validity?.state !== "invalid" && template?.enabled), revision: template?.revision || null }; }
function emptyEmailDependencies() { return { business: { complete: false, canonicalReady: false, displayName: null, supportEmail: null, href: "/commerce/business" }, documents: { receipt: templateDependency(null), invoice: templateDependency(null), customerAccessEnabled: false, href: "/commerce/tax" }, orders: { href: "/orders", orderSpecificHistoryOwner: true }, paypalRequired: false }; }
function emptyEmailDeliveries() { return { state: "unavailable", recent: [], counts: { total: 0, test: 0, live: 0, unknown: 0, sent: 0, failed: 0, pending: 0, sending: 0 }, lastSuccessful: null, lastFailed: null, idempotency: { implemented: true, authority: "Server-generated deterministic delivery key", retriesAvailableFromThisRoute: false } }; }
function emailSafety(customerSendsEnabled) { return { customerSendsEnabled, mutableFromThisRoute: false, testSendExposed: false, previewMutates: false, providerCallsOnRead: false, providerCallsOnPreview: false, productionLifecycleImplemented: false }; }

export function validateTemplatePlaceholders(template) {
  const unknown = new Set();
  for (const value of templateTextValues(template)) {
    const text = String(value || "");
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const key = match[1].trim().toLowerCase();
      if (!/^[a-z0-9_]+$/i.test(key) || !COMMERCE_TEMPLATE_VARIABLES.includes(key)) unknown.add(key || "invalid");
    }
    const remainder = text.replace(/\{\{[^{}]*\}\}/g, "");
    if (remainder.includes("{{") || remainder.includes("}}")) throw new AuthFailure(400, "template_placeholder_invalid", "A template placeholder is malformed.");
  }
  if (unknown.size) throw new AuthFailure(400, "template_placeholder_unknown", `Unsupported template variables: ${[...unknown].join(", ")}.`);
  return true;
}

export function renderCommerceTemplate(template, variables, options = {}) {
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
  const output = template.templateKind === "document"
    ? renderCommerceDocument(rendered, variables, options)
    : renderCommerceEmail(rendered, variables, options);
  rendered.text = output.text;
  rendered.html = output.html;
  return rendered;
}

function renderCommerceEmail(rendered, variables, options) {
  const assets = thirdRailBrandAssets(options.assetOrigin);
  const accent = rendered.accentColor;
  const safeCtaUrl = safeLinkUrl(rendered.ctaUrl);
  const paragraphs = [rendered.introduction, ...rendered.bodyBlocks].filter(Boolean);
  const contextRows = emailContextRows(rendered.templateKey, variables);
  const lifecycleLabel = emailLifecycleLabel(rendered.templateKey, rendered.displayName);
  const footer = rendered.footer || `${THIRD_RAIL_BRAND.name} · Customer communication`;
  const preheader = rendered.preheader ? `<div class="tr-preheader">${escapeHtml(rendered.preheader)}</div>` : "";
  const context = contextRows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 4px;border-collapse:collapse;border:1px solid #d5cebb;background:#ebe6d8">${contextRows.map(([label, value]) => `<tr><td style="width:38%;padding:10px 12px;border-bottom:1px solid #d5cebb;color:#817a65;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase">${escapeHtml(label)}</td><td style="padding:10px 12px;border-bottom:1px solid #d5cebb;color:#302d22;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`).join("")}</table>` : "";
  const cta = rendered.ctaLabel && safeCtaUrl ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 4px"><tr><td style="border-radius:6px;background:${accent}"><a href="${escapeHtml(safeCtaUrl)}" style="display:inline-block;min-width:150px;padding:14px 19px;color:#090907;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:12px;font-weight:800;letter-spacing:.06em;text-align:center;text-decoration:none;text-transform:uppercase">${escapeHtml(rendered.ctaLabel)}</a></td></tr></table>` : "";
  const support = rendered.supportText ? `<p style="margin:24px 0 0;padding-top:18px;border-top:1px solid #d5cebb;color:#655f4c;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:14px;line-height:1.55">${emailTextHtml(rendered.supportText)}</p>` : "";
  const text = [
    THIRD_RAIL_BRAND.wordmark,
    lifecycleLabel,
    rendered.heading,
    rendered.introduction,
    ...rendered.bodyBlocks,
    ...contextRows.map(([label, value]) => `${label}: ${value}`),
    rendered.ctaLabel && safeCtaUrl ? `${rendered.ctaLabel}: ${safeCtaUrl}` : "",
    rendered.supportText,
    footer,
  ].filter(Boolean).map(plainTextValue).join("\n\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(rendered.subject || rendered.heading)}</title><style>${thirdRailFontFaceCss(options.assetOrigin)}.tr-preheader{display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent}.tr-copy p{margin:0 0 15px;color:#4d493a;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:15px;line-height:1.65}.tr-copy h1{margin:0 0 18px;color:${THIRD_RAIL_BRAND.ink};font-family:${THIRD_RAIL_BRAND.displayFont};font-size:52px;font-weight:400;letter-spacing:.01em;line-height:.96;text-transform:uppercase;overflow-wrap:anywhere}@media(max-width:640px){.tr-card{width:100%!important}.tr-outer{padding:18px 8px!important}.tr-header{padding:19px 18px!important}.tr-pad{padding:28px 20px!important}.tr-copy h1{font-size:42px!important}.tr-context td{display:block!important;width:auto!important;text-align:left!important}}</style></head><body style="margin:0;padding:0;background:${THIRD_RAIL_BRAND.page};color:#f5f1e5;font-family:${THIRD_RAIL_BRAND.bodyFont}">${preheader}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:${THIRD_RAIL_BRAND.page}"><tr><td class="tr-outer" align="center" style="padding:34px 16px"><table role="presentation" class="tr-card" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:100%;border:1px solid #3b351d;border-radius:12px;background:${THIRD_RAIL_BRAND.cream}"><tr><td class="tr-header" style="padding:22px 28px;background:${THIRD_RAIL_BRAND.dark}"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td width="50" valign="middle"><img src="${assets.logo}" width="38" height="38" alt="Third Railify lightning logo" style="display:block;width:38px;height:38px;border:0;object-fit:contain"></td><td valign="middle"><strong style="display:block;color:#f5f1e5;font-family:${THIRD_RAIL_BRAND.displayFont};font-size:27px;font-weight:400;letter-spacing:.01em;line-height:1;text-transform:uppercase">${THIRD_RAIL_BRAND.wordmark}</strong><span style="display:block;margin-top:4px;color:#b7b19d;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:9px;font-weight:600;letter-spacing:.12em;text-transform:uppercase">Customer notification</span></td></tr></table></td></tr><tr><td height="5" style="height:5px;background:${accent}"></td></tr><tr><td class="tr-pad" style="padding:38px 42px"><div style="margin-bottom:12px;color:#8b7007;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase">${escapeHtml(lifecycleLabel)}</div><div class="tr-copy"><h1>${escapeHtml(rendered.heading)}</h1>${paragraphs.map((value) => `<p>${emailTextHtml(value)}</p>`).join("")}</div><div class="tr-context">${context}</div>${cta}${support}</td></tr><tr><td style="padding:20px 28px;border-top:1px solid #d5cebb;background:${THIRD_RAIL_BRAND.creamMuted};color:#655f4c;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:13px;line-height:1.55"><strong style="color:#3f3b2e;font-weight:600">${THIRD_RAIL_BRAND.name}</strong><br>${emailTextHtml(footer)}</td></tr></table><div style="padding:18px 8px;color:#77715f;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:10px;line-height:1.5">This transactional message was generated from the approved Third Railify commerce template.</div></td></tr></table></body></html>`;
  return { html, text };
}

function renderCommerceDocument(rendered, variables, options) {
  const assets = thirdRailBrandAssets(options.assetOrigin);
  const source = options.document || {};
  const type = source.type === "invoice" || rendered.templateKey === "invoice_document" ? "invoice" : "receipt";
  const typeLabel = type === "invoice" ? "INVOICE / SALES DOCUMENT" : "PAYMENT RECEIPT";
  const marker = cleanText(source.marker, 80) || "SAMPLE · TEST · NOT ISSUED";
  const merchantName = cleanText(source.merchantName || variables?.merchant_name, 160) || THIRD_RAIL_BRAND.name;
  const customerName = cleanText(source.customerName || variables?.customer_name, 160);
  const orderReference = cleanText(source.orderReference || variables?.order_reference, 160) || "NOT SUPPLIED";
  const issuedAt = cleanText(source.issuedAt, 80);
  const currency = cleanText(source.currency || variables?.currency, 3).toUpperCase() || "CAD";
  const items = Array.isArray(source.items) && source.items.length
    ? source.items.map((item) => ({ description: [cleanText(item.productName, 240), cleanText(item.variantName, 300)].filter(Boolean).join(" — "), quantity: Number(item.quantity) || "", amount: documentMoney(item.lineTotalAmount, currency) }))
    : [{ description: cleanText(variables?.product_summary, 1000) || "No line item supplied", quantity: "", amount: variableMoney(variables?.order_total, currency) }];
  const subtotal = source.subtotal === 0 || Number.isFinite(source.subtotal) ? documentMoney(source.subtotal, currency) : variableMoney(variables?.order_total, currency);
  const shipping = source.shipping === 0 || Number.isFinite(source.shipping) ? documentMoney(source.shipping, currency) : "—";
  const tax = source.tax === 0 || Number.isFinite(source.tax) ? documentMoney(source.tax, currency) : "—";
  const total = source.total === 0 || Number.isFinite(source.total) ? documentMoney(source.total, currency) : variableMoney(variables?.order_total, currency);
  const address = documentAddressLines(source.legalAddress);
  const disclosures = Array.isArray(source.disclosures) ? source.disclosures.map((value) => cleanText(value, 1000)).filter(Boolean) : [];
  const paragraphs = [rendered.introduction, ...rendered.bodyBlocks].filter(Boolean);
  const support = rendered.supportText || cleanText(source.supportEmail || variables?.support_email, 254);
  const footer = rendered.footer || `${THIRD_RAIL_BRAND.name} · ${typeLabel}`;
  const detailCells = [["REFERENCE", orderReference], ...(customerName ? [["CUSTOMER", customerName]] : []), ...(issuedAt ? [["DATE", issuedAt]] : [])];
  const text = [
    marker,
    THIRD_RAIL_BRAND.wordmark,
    typeLabel,
    rendered.heading,
    ...detailCells.map(([label, value]) => `${label}: ${value}`),
    rendered.introduction,
    ...rendered.bodyBlocks,
    "LINE ITEMS",
    ...items.map((item) => `${item.description}${item.quantity ? ` × ${item.quantity}` : ""} — ${item.amount}`),
    `Subtotal: ${subtotal}`,
    `Shipping: ${shipping}`,
    `Tax: ${tax}`,
    `Total: ${total}`,
    support,
    ...disclosures,
    footer,
  ].filter(Boolean).map(plainTextValue).join("\n\n");
  const details = detailCells.map(([label, value]) => `<td valign="top" style="padding:0 14px 18px 0"><span style="display:block;color:#817a65;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(label)}</span><strong style="display:block;margin-top:5px;color:#302d22;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:14px;font-weight:600;overflow-wrap:anywhere">${escapeHtml(value)}</strong></td>`).join("");
  const itemRows = items.map((item) => `<tr><td style="padding:13px 10px;border-bottom:1px solid #d9d2c0;color:#302d22;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:14px;line-height:1.4">${escapeHtml(item.description)}</td><td align="center" style="padding:13px 8px;border-bottom:1px solid #d9d2c0;color:#655f4c;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:11px">${escapeHtml(item.quantity)}</td><td align="right" style="padding:13px 10px;border-bottom:1px solid #d9d2c0;color:#302d22;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:14px;font-weight:600;white-space:nowrap">${escapeHtml(item.amount)}</td></tr>`).join("");
  const totals = [["Subtotal", subtotal], ["Shipping", shipping], ["Tax", tax], ["Total", total]].map(([label, value], index) => `<tr><td style="padding:${index === 3 ? "12px" : "7px"} 10px;color:${index === 3 ? THIRD_RAIL_BRAND.ink : "#655f4c"};font-family:${index === 3 ? THIRD_RAIL_BRAND.displayFont : THIRD_RAIL_BRAND.bodyFont};font-size:${index === 3 ? "22px" : "13px"};${index === 3 ? "border-top:2px solid #302d22;text-transform:uppercase" : ""}">${label}</td><td align="right" style="padding:${index === 3 ? "12px" : "7px"} 10px;color:${index === 3 ? THIRD_RAIL_BRAND.ink : "#302d22"};font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:${index === 3 ? "17px" : "13px"};font-weight:${index === 3 ? "700" : "600"};${index === 3 ? "border-top:2px solid #302d22" : ""};white-space:nowrap">${escapeHtml(value)}</td></tr>`).join("");
  const seller = source.legalName || address.length ? `<div style="margin-top:22px;padding-top:16px;border-top:1px solid #d5cebb;color:#655f4c;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:12px;line-height:1.55"><strong style="color:#3f3b2e">Seller</strong><br>${[cleanText(source.legalName, 240) || merchantName, ...address].map(escapeHtml).join("<br>")}</div>` : "";
  const disclosureHtml = disclosures.length ? `<div style="margin-top:18px;padding:14px;border:1px solid #d5cebb;background:#ebe6d8;color:#655f4c;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:12px;line-height:1.5">${disclosures.map((value) => `<p style="margin:0 0 7px">${emailTextHtml(value)}</p>`).join("")}</div>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(typeLabel)}</title><style>${thirdRailFontFaceCss(options.assetOrigin)}@media(max-width:680px){.tr-doc{width:100%!important}.tr-doc-outer{padding:12px 6px!important}.tr-doc-header{padding:18px!important}.tr-doc-body{padding:24px 18px!important}.tr-doc-title{font-size:42px!important}.tr-doc-details td{display:block!important;width:auto!important}.tr-doc-items th:nth-child(2),.tr-doc-items td:nth-child(2){display:none!important}}</style></head><body style="margin:0;padding:0;background:${THIRD_RAIL_BRAND.page};font-family:${THIRD_RAIL_BRAND.bodyFont}"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:${THIRD_RAIL_BRAND.page}"><tr><td class="tr-doc-outer" align="center" style="padding:30px 14px"><table role="presentation" class="tr-doc" width="680" cellspacing="0" cellpadding="0" border="0" style="width:680px;max-width:100%;border:1px solid #3b351d;border-radius:10px;background:${THIRD_RAIL_BRAND.cream}"><tr><td class="tr-doc-header" style="padding:22px 26px;background:${THIRD_RAIL_BRAND.dark}"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td width="50" valign="middle"><img src="${assets.logo}" width="38" height="38" alt="Third Railify lightning logo" style="display:block;width:38px;height:38px;border:0;object-fit:contain"></td><td valign="middle"><strong style="display:block;color:#f5f1e5;font-family:${THIRD_RAIL_BRAND.displayFont};font-size:27px;font-weight:400;line-height:1;text-transform:uppercase">${THIRD_RAIL_BRAND.wordmark}</strong><span style="display:block;margin-top:4px;color:#b7b19d;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:9px;font-weight:600;letter-spacing:.12em;text-transform:uppercase">${typeLabel}</span></td></tr></table></td></tr><tr><td height="5" style="height:5px;background:${rendered.accentColor}"></td></tr><tr><td style="padding:13px 26px;background:${THIRD_RAIL_BRAND.gold};color:#17160f;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:10px;font-weight:850;letter-spacing:.09em;text-align:center;text-transform:uppercase">${escapeHtml(marker)}</td></tr><tr><td class="tr-doc-body" style="padding:36px 38px"><div style="margin-bottom:10px;color:#8b7007;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase">${typeLabel}</div><h1 class="tr-doc-title" style="margin:0 0 24px;color:${THIRD_RAIL_BRAND.ink};font-family:${THIRD_RAIL_BRAND.displayFont};font-size:50px;font-weight:400;line-height:.96;text-transform:uppercase;overflow-wrap:anywhere">${escapeHtml(rendered.heading)}</h1><table role="presentation" class="tr-doc-details" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>${details}</tr></table>${paragraphs.map((value) => `<p style="margin:0 0 14px;color:#4d493a;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:14px;line-height:1.6">${emailTextHtml(value)}</p>`).join("")}<table class="tr-doc-items" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px;border-collapse:collapse;border:1px solid #d9d2c0"><thead><tr><th align="left" style="padding:10px;color:#817a65;background:#ebe6d8;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:9px;letter-spacing:.08em;text-transform:uppercase">Item</th><th align="center" style="padding:10px;color:#817a65;background:#ebe6d8;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:9px;letter-spacing:.08em;text-transform:uppercase">Qty</th><th align="right" style="padding:10px;color:#817a65;background:#ebe6d8;font-family:${THIRD_RAIL_BRAND.monoFont};font-size:9px;letter-spacing:.08em;text-transform:uppercase">Amount</th></tr></thead><tbody>${itemRows}</tbody></table><table role="presentation" width="260" align="right" cellspacing="0" cellpadding="0" border="0" style="width:260px;max-width:100%;margin-top:16px;border-collapse:collapse">${totals}</table><div style="clear:both"></div>${support ? `<p style="margin:26px 0 0;padding-top:18px;border-top:1px solid #d5cebb;color:#655f4c;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:13px;line-height:1.55">${emailTextHtml(support)}</p>` : ""}${seller}${disclosureHtml}</td></tr><tr><td style="padding:18px 26px;border-top:1px solid #d5cebb;background:${THIRD_RAIL_BRAND.creamMuted};color:#655f4c;font-family:${THIRD_RAIL_BRAND.bodyFont};font-size:12px;line-height:1.5"><strong style="color:#3f3b2e">${merchantName}</strong><br>${emailTextHtml(footer)}</td></tr></table></td></tr></table></body></html>`;
  return { html, text };
}

export async function sendTestTemplateEmail(env, session, templateKey, input, fetchImpl = fetch) {
  const recipient = email(input?.recipient);
  const db = requireCommerceDb(env);
  const row = await templateRow(db, templateKey);
  if (row.template_kind !== "email") throw new AuthFailure(409, "template_email_required", "Only customer email templates can be test-sent.");
  const fixture = input?.orderId ? await orderVariables(db, input.orderId) : await syntheticVariables(db);
  const rendered = renderCommerceTemplate(serializeTemplateForValidation(row), fixture.variables, { assetOrigin: env?.THIRDRAILIFY_ADMIN_ORIGIN });
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
  const [order, itemsResult, profile, template, delivery] = await Promise.all([
    db.prepare("SELECT id,payment_status,fulfillment_status,currency_code,customer_gross_amount,environment,payment_confirmed_at,created_at FROM commerce_orders WHERE id=?").bind(id).first(),
    db.prepare("SELECT product_name,variant_name,option_values_json,unit_amount,quantity,line_total_amount FROM commerce_order_items WHERE order_id=? ORDER BY line_number").bind(id).all(),
    db.prepare("SELECT trading_name,legal_business_name_ciphertext,private_address_ciphertext,public_contact_email,support_email FROM commerce_business_profiles WHERE id='primary'").first(),
    templateRow(db, type === "receipt" ? "payment_receipt" : "invoice_document"),
    db.prepare("SELECT display_shipping_method,shipping_amount,currency_code FROM commerce_order_delivery_snapshots WHERE order_id=?").bind(id).first(),
  ]);
  if (!order) throw new AuthFailure(404, "order_not_found", "The commerce order was not found.");
  const available = type === "receipt" ? order.payment_status === "paid" : order.payment_status === "paid" && invoiceReady;
  const reason = available ? "" : type === "invoice" ? "Invoice readiness is blocked until legal business and tax configuration are complete." : "A payment receipt is available only after payment is confirmed.";
  let legalName = null;
  let legalAddress = null;
  if (profile?.legal_business_name_ciphertext) legalName = await decryptCommerceSecret(env, profile.legal_business_name_ciphertext, "business:legal-name");
  if (profile?.private_address_ciphertext) legalAddress = json(await decryptCommerceSecret(env, profile.private_address_ciphertext, "business:private-address"), null) || await decryptCommerceSecret(env, profile.private_address_ciphertext, "business:private-address");
  const items = (itemsResult?.results || []).map((item) => ({ productName: cleanText(item.product_name, 240), variantName: cleanText(item.variant_name, 300) || null, options: json(item.option_values_json, {}), unitAmount: Number(item.unit_amount), quantity: Number(item.quantity), lineTotalAmount: Number(item.line_total_amount) }));
  const snapshot = {
    type, available, reason, test: order.environment === "test", marker: order.environment === "test" ? "TEST / SANDBOX" : "LIVE",
    displayReference: type === "receipt" ? id : `Invoice preview for ${id}`, orderReference: id,
    merchantName: cleanText(profile?.trading_name, 160) || "Third Railify Official",
    legalName: legalName || null, legalAddress: legalAddress || null,
    supportEmail: cleanText(profile?.support_email || profile?.public_contact_email, 254) || "info@thirdrailify.com",
    issuedAt: cleanText(order.payment_confirmed_at || order.created_at, 80), payment: order.payment_status === "paid" ? "Confirmed" : "Not confirmed",
    fulfillment: order.fulfillment_status === "disabled" ? "Disabled / not started" : cleanText(order.fulfillment_status, 40),
    items, subtotal: items.reduce((sum, item) => sum + item.lineTotalAmount, 0), shipping: delivery ? safeMoney(delivery.shipping_amount) : null, tax: null,
    total: Number(order.customer_gross_amount), currency: cleanText(order.currency_code, 3).toUpperCase(),
    templateKey: template.template_key, templateRevision: Number(template.revision),
    disclosures: [], providerIds: undefined,
  };
  const variables = {
    order_reference: id,
    customer_name: "",
    merchant_name: snapshot.merchantName,
    order_total: formatMinorUnits(snapshot.total),
    currency: snapshot.currency,
    product_summary: items.map((item) => `${item.productName}${item.variantName ? ` — ${item.variantName}` : ""} × ${item.quantity}`).join("; "),
    support_email: snapshot.supportEmail,
    receipt_url: "",
    shipping_method: cleanText(delivery?.display_shipping_method, 200),
    tracking_number: "",
  };
  const output = renderCommerceTemplate(serializeTemplateForValidation(template), variables, { assetOrigin: env?.THIRDRAILIFY_ADMIN_ORIGIN, document: snapshot });
  return { ...snapshot, html: output.html, text: output.text };
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
function emptyFulfillmentShippingPayload(access, env) {
  const status = (state, detail) => ({ state, detail });
  const draftPreview = preparePrintfulDraftOrder({ reference: "DRAFT-PREVIEW-NOT-AN-ORDER", environment: "test", quantity: 1, candidate: null, recipient: null, shippingStrategy: "unconfigured", fulfillmentEnabled: false, orderMode: "draft_only", providerMode: "draft_only", requireSellable: true, previewOnly: true });
  return {
    ok: true, databaseConfigured: false, authority: "Commerce D1 + server runtime configured-state projection", access,
    readiness: {
      provider: status("unverified", "Commerce D1 is unavailable."), catalogue: status("blocked", "Catalogue authority is unavailable."),
      customerShippingData: status("not_implemented", "Customer shipping-address capture is not available."), paymentAuthority: status("production_disabled", "Payment authority is unavailable."),
      printfulOrderMode: status("draft_only", "Safe default only; no persisted setting is available."), fulfillment: status("disabled", "Fulfillment submission is disabled."),
      tracking: status("unavailable", "Normalized shipment authority is unavailable while Commerce D1 is unavailable."), production: status("blocked", "Production commerce remains blocked."),
    },
    provider: { name: "Printful", state: "unavailable", configured: false, targetStoreConfigured: false, storeType: null, credentialConfigured: isPrintfulCredentialConfigured(env), configurationEvidence: "unverified", scopes: { products: false, files: false, orders: false, webhooks: false, evidenceRecorded: false }, orderMode: "draft_only", providerOrderMode: "unconfigured", orderModeConsistent: false, fulfillmentEnabled: false, localProviderOrderCount: 0, lastProviderOrderAt: null, lastConfigurationEvidenceAt: null },
    migration: { id: "permanent-printful-2026-08", status: "unavailable", phase: "unavailable", manuallyPaused: true, verifiedProducts: 0, mappedVariants: 0, blockedProducts: 0, deferredVariants: 0, providerRequestCount: 0, providerFailures: 0, updatedAt: null, completedAt: null, mutableFromThisRoute: false },
    mapping: { storefrontProducts: 0, storefrontVariants: 0, totalProducts: 0, totalVariants: 0, mappedProviderProducts: 0, mappedProviderVariants: 0, unmappedVariants: 0, blockedProducts: 0, blockedVariants: 0, deferredVariants: 0, nonSellableVariants: 0, potentiallyFulfillableVariants: 0, contract: "Printful + mapped + target product ID + target Sync Variant ID + target-verified/native migration" },
    pipeline: [],
    shipping: { schema: { state: "unavailable", migration: "0015_checkout_shipping_foundation.sql", quoteTable: false, deliverySnapshotTable: false }, customerData: { state: "unavailable", persistedFields: [], orderSpecificPiiProjectedHere: false }, rates: { state: "unavailable", strategy: "unconfigured", providerQuotePathImplemented: false, providerQuoteCalled: false } },
    tracking: { state: "unavailable", persistedFields: [], shipmentPollingImplemented: false, providerPollingPerformed: false },
    lifecycle: { providerOrderModel: { state: "unavailable", authority: "commerce_fulfillment_orders" }, draftRecording: { state: "unavailable", idempotent: true }, webhookReceiver: { state: "implemented", protocol: "printful_v2_beta_hmac_sha256", route: "/api/webhooks/printful" }, webhookVerification: { state: printfulWebhookVerificationConfigured(env) ? "configured_unverified" : "not_configured" }, providerSubscription: { state: "not_configured_unverified" }, shipmentNormalization: { state: "unavailable", authority: "commerce_fulfillment_shipments" }, partialShipmentHandling: { state: "unavailable", authority: "normalized item coverage" }, trackingStorage: { state: "unavailable" }, carrierDeliveryPolling: { state: "not_implemented" }, reconciliationFallback: { state: "implemented_inactive", automaticPolling: false }, fulfillmentSubmission: { state: "disabled" } },
    operations: { state: "unavailable", rows: [], page: 1, pageSize: 20, total: 0, totalPages: 0, counts: { total: 0, testOrders: 0, liveOrders: 0, livePartial: 0, liveShipped: 0, shipments: 0, testShipments: 0, liveShipments: 0 } },
    draftPreview, gates: [],
    dependencies: { business: { href: "/commerce/business" }, taxDocuments: { href: "/commerce/tax" }, customerEmails: { href: "/commerce/emails", shipmentTemplate: { configured: false, state: "not_configured", revision: null, updatedAt: null }, sendsEnabled: false }, payments: { href: "/commerce/payments" }, products: { href: "/products" }, orders: { href: "/orders" } },
    evidence: { recent: [], counts: { totalOrders: 0, testOrders: 0, liveOrders: 0, providerOrders: 0, fulfillmentEvidence: 0, testShippingSnapshots: 0, liveShippingSnapshots: 0, shipments: 0 }, lastAudit: null },
    technical: { builderVersion: PRINTFUL_DRAFT_BUILDER_VERSION, providerCallsOnRead: false, providerCallsOnPreview: false, previewPersists: false, previewAuditedAsMutation: false, shippingDataCapability: "not_implemented", shippingRateCapability: "not_configured", trackingCapability: "not_implemented" },
    safety: { checkoutEnabled: false, controlledTestCheckoutEnabled: false, livePaymentCaptureEnabled: false, fulfillmentEnabled: false, orderMode: "draft_only", providerSubmissionAvailable: false, previewOnly: true, mutationsAvailableFromThisRoute: false },
    canonicalReadiness: null, checkedAt: nowIso(),
  };
}
function serializeDraftCandidate(row) {
  return {
    productId: cleanText(row.product_id, 160), productTitle: cleanText(row.product_title, 240), productStatus: cleanText(row.product_status, 40), productVisibility: cleanText(row.product_visibility, 40),
    variantId: cleanText(row.variant_id, 160), variantLabel: [cleanText(row.size_label, 120), cleanText(row.color_label, 120)].filter(Boolean).join(" / ") || "Standard",
    variantStatus: cleanText(row.variant_status, 40), variantVisibility: cleanText(row.variant_visibility, 40), sellable: row.is_sellable === 1,
    availability: cleanText(row.availability_status, 40), requiresShipping: row.requires_shipping === 1,
    provider: cleanText(row.fulfillment_provider, 40), mappingStatus: cleanText(row.fulfillment_mapping_status, 40),
    productTargetId: cleanText(row.product_target_id, 240) || null, targetProductId: cleanText(row.variant_target_product_id, 240) || null,
    targetVariantId: cleanText(row.target_printful_sync_variant_id, 240) || null,
    productMigrationStatus: cleanText(row.product_migration_status, 40), variantMigrationStatus: cleanText(row.variant_migration_status, 40),
  };
}
function statusProjection(state, detail) { return { state, detail }; }
function printfulWebhookVerificationConfigured(env) {
  const publicKey = String(env?.PRINTFUL_WEBHOOK_V2_PUBLIC_KEY || "").trim();
  const secretHex = String(env?.PRINTFUL_WEBHOOK_V2_SECRET_HEX || "").trim();
  return /^[A-Za-z0-9+/_=-]{4,512}$/.test(publicKey) && /^[0-9a-fA-F]{64,1024}$/.test(secretHex) && secretHex.length % 2 === 0;
}
function pipelineStage(id, label, implemented, authority, transition, detail) { return { id, label, implemented: Boolean(implemented), authority, transition, detail }; }
function templateDependencyState(row) { return row ? { configured: true, state: row.status === "ready" && row.enabled === 1 ? "ready" : row.status === "disabled" ? "disabled" : "incomplete", revision: Number(row.revision), updatedAt: cleanText(row.updated_at, 80) || null } : { configured: false, state: "not_configured", revision: null, updatedAt: null }; }
function fulfillmentGates({ canonicalReadiness, providerConfigured, orderModeSetting, orderModeConsistent, fulfillmentEnabled, shippingDataImplemented, shippingSchemaReady, shippingStrategy, mapping, settings }) {
  const gate = (id, label, state, detail, href = null) => ({ id, label, state, detail, href });
  const domainGate = (id, label, value, href) => gate(id, label, value.ready ? "ready" : value.details?.enabled === false || value.details?.sendEnabled === false ? "disabled" : "incomplete", value.summary, href);
  return [
    domainGate("business", "Business information", canonicalReadiness.domains.business, "/commerce/business"),
    domainGate("tax_documents", "Tax & documents", canonicalReadiness.domains.tax, "/commerce/tax"),
    domainGate("payments", "Payment authority", canonicalReadiness.domains.payments, "/commerce/payments"),
    domainGate("customer_emails", "Customer emails", canonicalReadiness.domains.communications, "/commerce/emails"),
    gate("checkout", "Customer checkout", settings.checkout_enabled === true ? "ready" : "disabled", settings.checkout_enabled === true ? "Normal checkout is enabled." : "Normal checkout is intentionally disabled.", "/commerce/payments"),
    gate("customer_shipping", "Customer shipping data", shippingDataImplemented ? "ready" : "blocked", shippingDataImplemented ? "Normalized delivery data is available." : "Commerce migration 0015 is required for encrypted delivery snapshots.", "/orders"),
    gate("shipping_rates", "Shipping rate strategy", !shippingSchemaReady || shippingStrategy === "unconfigured" ? "blocked" : "ready", !shippingSchemaReady ? "Commerce migration 0015 is required for persisted shipping quotes." : shippingStrategy === "unconfigured" ? "The server quote adapter is implemented, but the canonical shipping strategy is unconfigured." : `Configured strategy: ${shippingStrategy}.`, null),
    gate("product_mapping", "Product mapping", mapping.potentiallyFulfillableVariants > 0 && mapping.blockedProducts === 0 ? "ready" : "blocked", `${mapping.mappedProviderVariants} mapped variants; ${mapping.blockedProducts} blocked products; ${mapping.potentiallyFulfillableVariants} potentially fulfillable variants.`, "/products"),
    gate("printful_provider", "Printful provider", providerConfigured ? "ready" : "incomplete", providerConfigured ? "Persisted local configuration is internally consistent." : "Provider configuration is incomplete or unverified.", null),
    gate("printful_order_mode", "Printful order mode", orderModeConsistent && orderModeSetting === "draft_only" ? "disabled" : "blocked", orderModeConsistent && orderModeSetting === "draft_only" ? "Draft-only is the maximum permitted mode; submission remains unavailable." : "The canonical and provider modes are unsafe or contradictory.", null),
    gate("fulfillment", "Fulfillment submission", fulfillmentEnabled ? "ready" : "disabled", fulfillmentEnabled ? "Fulfillment is enabled." : "Fulfillment submission is intentionally disabled.", null),
    gate("live_payments", "Live payment capture", settings.live_payment_capture_enabled === true ? "ready" : "disabled", settings.live_payment_capture_enabled === true ? "Live payment capture is enabled." : "Live payment capture is intentionally disabled.", "/commerce/payments"),
  ];
}
function number(value) { const result = Number(value); return Number.isSafeInteger(result) && result >= 0 ? result : 0; }
async function optionalD1Read(read, fallback) {
  try { return { available: true, value: await read() }; }
  catch { return { available: false, value: fallback }; }
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
async function syntheticVariables(db) { const profile = await emailBusinessIdentity(db); return { source: "synthetic_fixture", test: true, orderId: null, variables: { order_reference: "TEST-ORDER-PREVIEW", customer_name: "Preview customer", merchant_name: profile.merchantName, order_total: formatMinorUnits(1500), currency: profile.currency, product_summary: "Third Rail Farm | Black Glossy Mug — 11 oz / Black × 1", support_email: profile.supportEmail, receipt_url: "https://example.invalid/customer-document-preview", shipping_method: "Not configured", tracking_number: "Not available" } }; }
async function orderVariables(db, orderId) {
  const id = validId(orderId, "order_id_invalid");
  const [order, items, profile, delivery] = await Promise.all([
    db.prepare("SELECT id,environment,currency_code,customer_gross_amount FROM commerce_orders WHERE id=?").bind(id).first(),
    db.prepare("SELECT product_name,variant_name,quantity FROM commerce_order_items WHERE order_id=? ORDER BY line_number").bind(id).all(),
    emailBusinessIdentity(db),
    db.prepare("SELECT display_shipping_method FROM commerce_order_delivery_snapshots WHERE order_id=?").bind(id).first(),
  ]);
  if (!order) throw new AuthFailure(404, "order_not_found", "The commerce order was not found.");
  return { source: "selected_order", test: order.environment === "test", orderId: id, variables: {
    order_reference: id, customer_name: "Customer", merchant_name: profile.merchantName,
    order_total: formatMinorUnits(order.customer_gross_amount), currency: cleanText(order.currency_code, 3).toUpperCase() || profile.currency,
    product_summary: (items?.results || []).map((item) => `${cleanText(item.product_name, 240)}${item.variant_name ? ` — ${cleanText(item.variant_name, 300)}` : ""} × ${Number(item.quantity)}`).join("; "),
    support_email: profile.supportEmail, receipt_url: "", shipping_method: cleanText(delivery?.display_shipping_method, 100) || "Not configured", tracking_number: "Not available",
  } };
}
async function emailBusinessIdentity(db) { const row = await db.prepare("SELECT trading_name,currency_code,public_contact_email,support_email FROM commerce_business_profiles WHERE id='primary'").first(); return { merchantName: cleanText(row?.trading_name, 160) || "Third Railify Official", currency: cleanText(row?.currency_code, 3).toUpperCase() || "CAD", supportEmail: cleanText(row?.support_email || row?.public_contact_email, 254) || "info@thirdrailify.com" }; }
function formatMinorUnits(value) { const amount = Number(value); if (!Number.isSafeInteger(amount) || amount < 0) return "0.00"; return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`; }
function templateTextValues(template) { return [template.subject, template.preheader, template.heading, template.introduction, ...(template.bodyBlocks || []), template.ctaLabel, template.ctaUrl, template.supportText, template.footer]; }
function emailLifecycleLabel(templateKey, fallback) {
  return ({
    order_confirmation: "Order confirmation",
    shipment_notification: "Shipment update",
    cancellation: "Order status · Cancelled",
    refund: "Refund update",
    payment_failure: "Action needed · Payment incomplete",
    invoice_notification: "Invoice notification",
    receipt_notification: "Receipt notification",
  })[templateKey] || cleanText(fallback, 120) || "Customer notification";
}
function emailContextRows(templateKey, variables) {
  const rows = [];
  const orderReference = meaningfulVariable(variables?.order_reference);
  const total = meaningfulVariable(variables?.order_total);
  const currency = meaningfulVariable(variables?.currency);
  if (orderReference) rows.push(["Order reference", orderReference]);
  if (total) rows.push(["Order total", `${total}${currency ? ` ${currency}` : ""}`]);
  if (templateKey === "shipment_notification") {
    const method = meaningfulVariable(variables?.shipping_method);
    const tracking = meaningfulVariable(variables?.tracking_number);
    if (method) rows.push(["Shipping method", method]);
    if (tracking) rows.push(["Tracking number", tracking]);
  }
  return rows;
}
function meaningfulVariable(value) {
  const text = cleanText(value, 1000);
  return !text || /^(not available|not configured|unknown|n\/a)$/i.test(text) ? "" : text;
}
function safeLinkUrl(value) {
  const text = cleanText(value, 500);
  if ((text.startsWith("/") && !text.startsWith("//")) || /^https:\/\/[^\s]+$/i.test(text)) return text;
  return "";
}
function emailTextHtml(value) { return escapeHtml(value).replaceAll("\n", "<br>"); }
function plainTextValue(value) { return String(value || "").replaceAll("<", "‹").replaceAll(">", "›").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim(); }
function variableMoney(value, currency) { const text = cleanText(value, 80); return text ? `${text} ${currency}` : "—"; }
function documentMoney(value, currency) { const amount = Number(value); return Number.isSafeInteger(amount) ? `${(amount / 100).toFixed(2)} ${currency}` : "—"; }
function documentAddressLines(value) {
  if (!value) return [];
  if (typeof value === "string") return value.split(/\r?\n/).map((line) => cleanText(line, 240)).filter(Boolean).slice(0, 6);
  if (typeof value !== "object" || Array.isArray(value)) return [];
  return [value.line1, value.line2, [value.city, value.province || value.region, value.postalCode].filter(Boolean).join(" "), value.country].map((line) => cleanText(line, 240)).filter(Boolean);
}
function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
async function sha256Hex(value) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function randomToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, ""); }
