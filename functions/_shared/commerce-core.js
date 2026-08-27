import {
  AuthFailure,
  cleanText,
  loadAccountById,
  nowIso,
  randomId,
  requireAuthDb,
} from "./auth-core.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENVELOPE_VERSION = 1;
const ENCRYPTION_ALGORITHM = "A256GCM";
const MAX_SECRET_BYTES = 16 * 1024;
const ENCRYPTION_CONTEXT_PREFIX = "thirdrailify-commerce:v1:";

export const COMMERCE_CAPABILITIES = Object.freeze([
  "commerce.view",
  "commerce.business.manage",
  "commerce.payments.manage",
  "commerce.integrations.manage",
  "commerce.templates.manage",
]);

export const COMMERCE_STATUS_VALUES = Object.freeze([
  "unavailable",
  "setup_required",
  "pending",
  "connected",
  "restricted",
  "disabled",
  "error",
  "legacy_production",
  "deferred",
]);

export const COMMERCE_SAFE_POSTURE = Object.freeze({
  environment: "staging",
  checkout: "disabled",
  livePaymentCapture: "disabled",
  fulfillmentSubmission: "disabled",
  stripeAccount: "created",
  stripeApiConnection: "not_configured",
  stripeWebhook: "not_configured",
  stripeLivePayoutReadiness: "unverified",
  printfulApi: "disabled",
  paypal: "deferred",
  wix: "legacy_production",
});

export const PRINTFUL_TWO_TRANSACTION_MODEL = Object.freeze({
  customerTransaction: "Customer pays Third Railify through Stripe.",
  fulfillmentTransaction: "Printful separately charges the Third Railify Printful Wallet or configured Printful billing method.",
  trackedAmounts: Object.freeze([
    "customer_gross_amount",
    "stripe_fee_amount",
    "refund_amount",
    "printful_product_cost_amount",
    "printful_shipping_cost_amount",
    "printful_tax_amount",
    "printful_refund_credit_amount",
    "gross_margin_amount",
  ]),
});

export const PROVIDER_BLUEPRINTS = Object.freeze([
  Object.freeze({ provider: "stripe", label: "Stripe", status: "setup_required", integrationMode: "direct_merchant", credentialCustody: "environment_secret", environment: "test", countryCode: "CA", currencyCode: "CAD", accountCreated: true, apiConfigured: false, webhookConfigured: false, checkoutEnabled: false, livePaymentsEnabled: false, livePayoutReadiness: "unverified", metadata: Object.freeze({ accountDisplayName: "Third Railify Official", paymentMethods: Object.freeze(["cards", "eligible_apple_pay", "eligible_google_pay"]) }) }),
  Object.freeze({ provider: "printful", label: "Printful", status: "setup_required", integrationMode: "fulfillment", credentialCustody: "environment_secret", environment: "staging", currencyCode: "CAD" }),
  Object.freeze({ provider: "paypal", label: "PayPal", status: "deferred", integrationMode: "direct_merchant", credentialCustody: "admin_encrypted", environment: "deferred", countryCode: "CA", currencyCode: "CAD" }),
  Object.freeze({ provider: "printify", label: "Printify", status: "unavailable", credentialCustody: "no_secret", environment: "staging" }),
  Object.freeze({ provider: "wix", label: "Wix commerce", status: "legacy_production", integrationMode: "legacy", credentialCustody: "no_secret", environment: "legacy", countryCode: "CA", currencyCode: "CAD" }),
]);

export const TEMPLATE_BLUEPRINTS = Object.freeze([
  templateBlueprint("order_confirmation", "We received your Third Railify order", "Order received", "Your order has been received. Payment and fulfillment status will be confirmed separately."),
  templateBlueprint("shipment_notification", "Your Third Railify order has shipped", "Order shipped", "Tracking information will appear here after fulfillment confirms shipment."),
  templateBlueprint("cancellation", "Your Third Railify order was cancelled", "Order cancelled", "This order has been cancelled."),
  templateBlueprint("refund", "A refund was issued for your Third Railify order", "Refund issued", "Stripe has recorded a refund for this order."),
  templateBlueprint("payment_failure", "Payment was not completed", "Payment incomplete", "No order will be fulfilled from an incomplete payment."),
  templateBlueprint("invoice_notification", "Your Third Railify invoice", "Invoice available", "Your invoice details are available through the approved payment workflow."),
  templateBlueprint("receipt_notification", "Your Third Railify receipt", "Payment receipt", "This receipt reflects the authoritative payment record."),
]);

export function isCommerceDbConfigured(env) {
  return Boolean(env?.THIRDRAILIFY_COMMERCE_DB && typeof env.THIRDRAILIFY_COMMERCE_DB.prepare === "function");
}

export function requireCommerceDb(env) {
  if (!isCommerceDbConfigured(env)) {
    throw new AuthFailure(503, "commerce_database_unavailable", "Commerce persistence is not configured for this environment.");
  }
  return env.THIRDRAILIFY_COMMERCE_DB;
}

export async function commerceAccessForSession(env, session) {
  const isMasterAdmin = session?.account?.adminLevel === "master";
  if (isMasterAdmin) return { isMasterAdmin: true, capabilities: [...COMMERCE_CAPABILITIES] };
  const capabilities = new Set(["commerce.view"]);
  if (isCommerceDbConfigured(env) && session?.accountId) {
    const result = await env.THIRDRAILIFY_COMMERCE_DB
      .prepare("SELECT capability FROM commerce_permission_grants WHERE account_id = ? AND revoked_at IS NULL")
      .bind(session.accountId)
      .all();
    for (const row of result?.results || []) {
      if (COMMERCE_CAPABILITIES.includes(row.capability)) capabilities.add(row.capability);
    }
  }
  return { isMasterAdmin: false, capabilities: [...capabilities] };
}

export async function requireCommerceCapability(env, session, capability) {
  if (!COMMERCE_CAPABILITIES.includes(capability)) throw new Error("Unsupported commerce capability.");
  const access = await commerceAccessForSession(env, session);
  if (!access.capabilities.includes(capability)) {
    throw new AuthFailure(403, "commerce_capability_required", `The ${capability} capability is required.`);
  }
  return access;
}

export async function commerceOverview(env, session) {
  const access = await commerceAccessForSession(env, session);
  if (!isCommerceDbConfigured(env)) {
    return {
      ok: true,
      databaseConfigured: false,
      encryptionConfigured: hasValidEncryptionKeyShape(env),
      access,
      posture: COMMERCE_SAFE_POSTURE,
      providers: PROVIDER_BLUEPRINTS,
      business: publicBusinessProjection(defaultBusinessProfile()),
      completeness: { businessProfile: "setup_required", tax: "setup_required", templates: "setup_required" },
      counts: { products: null, orders: null, templates: null },
      checkedAt: nowIso(),
    };
  }

  const db = requireCommerceDb(env);
  const [providerResult, profile, taxCount, templateCount, productCount, orderCount] = await Promise.all([
    db.prepare("SELECT provider, integration_mode, credential_custody, status, environment, external_account_id, country_code, currency_code, safe_metadata_json, last_synchronized_at FROM commerce_provider_connections ORDER BY provider").all(),
    db.prepare("SELECT * FROM commerce_business_profiles WHERE id = 'primary'").first(),
    db.prepare("SELECT COUNT(*) AS count FROM commerce_tax_registrations").first(),
    db.prepare("SELECT COUNT(*) AS count FROM commerce_templates").first(),
    db.prepare("SELECT COUNT(*) AS count FROM commerce_products").first(),
    db.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first(),
  ]);
  const providers = (providerResult?.results || []).map(serializeProviderConnection);
  return {
    ok: true,
    databaseConfigured: true,
    encryptionConfigured: hasValidEncryptionKeyShape(env),
    access,
    posture: COMMERCE_SAFE_POSTURE,
    providers: providers.length ? providers : PROVIDER_BLUEPRINTS,
    business: publicBusinessProjection(profile || defaultBusinessProfile()),
    completeness: {
      businessProfile: profile ? businessCompleteness(profile) : "setup_required",
      tax: Number(taxCount?.count || 0) ? "pending" : "setup_required",
      templates: Number(templateCount?.count || 0) === TEMPLATE_BLUEPRINTS.length ? "pending" : "setup_required",
    },
    counts: {
      products: Number(productCount?.count || 0),
      orders: Number(orderCount?.count || 0),
      templates: Number(templateCount?.count || 0),
    },
    checkedAt: nowIso(),
  };
}

export async function businessProfilePayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  if (!isCommerceDbConfigured(env)) {
    return {
      ok: true,
      databaseConfigured: false,
      encryptionConfigured: hasValidEncryptionKeyShape(env),
      access,
      profile: businessProjection(defaultBusinessProfile(), []),
    };
  }
  const db = requireCommerceDb(env);
  const [profile, taxResult] = await Promise.all([
    db.prepare("SELECT * FROM commerce_business_profiles WHERE id = 'primary'").first(),
    db.prepare("SELECT registration_type, jurisdiction, masked_identifier, status FROM commerce_tax_registrations WHERE business_profile_id = 'primary' ORDER BY registration_type, jurisdiction").all(),
  ]);
  return {
    ok: true,
    databaseConfigured: true,
    encryptionConfigured: hasValidEncryptionKeyShape(env),
    access,
    profile: businessProjection(profile || defaultBusinessProfile(), taxResult?.results || []),
  };
}

export async function updateBusinessProfile(env, session, input) {
  const db = requireCommerceDb(env);
  await importEncryptionKey(env);
  const current = await db.prepare("SELECT * FROM commerce_business_profiles WHERE id = 'primary'").first();
  const values = validateBusinessProfile(input, current || defaultBusinessProfile());
  const timestamp = nowIso();
  const legalCiphertext = values.legalBusinessName
    ? await encryptCommerceSecret(env, values.legalBusinessName, "business:legal-name")
    : current?.legal_business_name_ciphertext || null;
  const privateAddressCiphertext = values.privateAddress
    ? await encryptCommerceSecret(env, values.privateAddress, "business:private-address")
    : current?.private_address_ciphertext || null;

  await db
    .prepare(
      `INSERT INTO commerce_business_profiles (
         id, trading_name, legal_business_name_ciphertext, country_code, province_code, currency_code,
         public_address_json, private_address_ciphertext, public_contact_email, support_email,
         public_phone, website_url, invoice_prefix, document_footer, tax_provider_state,
         invoice_accent_color, receipt_accent_color, revision,
         created_at, updated_at, updated_by_account_id
       ) VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         trading_name = excluded.trading_name,
         legal_business_name_ciphertext = excluded.legal_business_name_ciphertext,
         country_code = excluded.country_code,
         province_code = excluded.province_code,
         currency_code = excluded.currency_code,
         public_address_json = excluded.public_address_json,
         private_address_ciphertext = excluded.private_address_ciphertext,
         public_contact_email = excluded.public_contact_email,
         support_email = excluded.support_email,
         public_phone = excluded.public_phone,
         website_url = excluded.website_url,
         invoice_prefix = excluded.invoice_prefix,
         document_footer = excluded.document_footer,
         tax_provider_state = excluded.tax_provider_state,
         invoice_accent_color = excluded.invoice_accent_color,
         receipt_accent_color = excluded.receipt_accent_color,
         revision = commerce_business_profiles.revision + 1,
         updated_at = excluded.updated_at,
         updated_by_account_id = excluded.updated_by_account_id`,
    )
    .bind(
      values.tradingName,
      legalCiphertext,
      values.countryCode,
      values.provinceCode,
      values.currencyCode,
      JSON.stringify(values.publicAddress),
      privateAddressCiphertext,
      values.publicContactEmail || null,
      values.supportEmail || null,
      values.publicPhone || null,
      values.websiteUrl || null,
      values.invoicePrefix || null,
      values.documentFooter || null,
      values.taxProviderState,
      values.invoiceAccentColor,
      values.receiptAccentColor,
      current?.created_at || timestamp,
      timestamp,
      session.accountId,
    )
    .run();

  for (const registration of values.registrations) {
    if (!registration.identifier) continue;
    await upsertTaxRegistration(db, env, session.accountId, registration, timestamp);
  }
  await writeCommerceAudit(env, {
    actorAccountId: session.accountId,
    action: "business_profile_updated",
    targetType: "commerce_business_profile",
    targetId: "primary",
    result: "success",
    metadata: { fields: values.changedFieldNames, taxIdentifiers: values.registrations.filter((item) => item.identifier).map((item) => item.type) },
  });
  return businessProfilePayload(env, session);
}

export async function templatesPayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  if (!isCommerceDbConfigured(env)) {
    return { ok: true, databaseConfigured: false, access, templates: TEMPLATE_BLUEPRINTS };
  }
  const result = await requireCommerceDb(env)
    .prepare("SELECT * FROM commerce_templates ORDER BY template_key")
    .all();
  return {
    ok: true,
    databaseConfigured: true,
    access,
    templates: (result?.results || []).map(serializeTemplate),
  };
}

export async function updateTemplate(env, session, templateKey, input) {
  const template = validateTemplate({ ...input, templateKey });
  const db = requireCommerceDb(env);
  const timestamp = nowIso();
  const id = `template-${template.templateKey.replaceAll("_", "-")}`;
  await db
    .prepare(
      `INSERT INTO commerce_templates (
         id, template_key, subject, preheader, heading, introduction, body_blocks_json,
         cta_label, cta_url, support_text, footer, accent_color, status, revision,
         created_at, updated_at, updated_by_account_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(template_key) DO UPDATE SET
         subject = excluded.subject,
         preheader = excluded.preheader,
         heading = excluded.heading,
         introduction = excluded.introduction,
         body_blocks_json = excluded.body_blocks_json,
         cta_label = excluded.cta_label,
         cta_url = excluded.cta_url,
         support_text = excluded.support_text,
         footer = excluded.footer,
         accent_color = excluded.accent_color,
         status = excluded.status,
         revision = commerce_templates.revision + 1,
         updated_at = excluded.updated_at,
         updated_by_account_id = excluded.updated_by_account_id`,
    )
    .bind(
      id,
      template.templateKey,
      template.subject,
      template.preheader,
      template.heading,
      template.introduction,
      JSON.stringify(template.bodyBlocks),
      template.ctaLabel,
      template.ctaUrl,
      template.supportText,
      template.footer,
      template.accentColor,
      template.status,
      timestamp,
      timestamp,
      session.accountId,
    )
    .run();
  await writeCommerceAudit(env, {
    actorAccountId: session.accountId,
    action: "commerce_template_updated",
    targetType: "commerce_template",
    targetId: template.templateKey,
    result: "success",
    metadata: { status: template.status, revisionSource: "admin" },
  });
  return templatesPayload(env, session);
}

export async function permissionGrantsPayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  const result = await requireCommerceDb(env)
    .prepare("SELECT id, account_id, capability, granted_by_account_id, granted_at, revoked_by_account_id, revoked_at, reason FROM commerce_permission_grants ORDER BY granted_at DESC")
    .all();
  return { ok: true, access, grants: result?.results || [], capabilities: COMMERCE_CAPABILITIES };
}

export async function grantCommerceCapability(env, session, accountId, capability, reason = "") {
  if (session?.account?.adminLevel !== "master") throw new AuthFailure(403, "master_admin_required", "Master Admin access is required.");
  if (!COMMERCE_CAPABILITIES.includes(capability)) throw new AuthFailure(400, "invalid_capability", "The commerce capability is invalid.");
  const target = await loadAccountById(env, cleanText(accountId, 160));
  if (!target) throw new AuthFailure(404, "account_not_found", "The account was not found.");
  if (target.role !== "admin" || target.admin_level === "none" || target.status !== "active") {
    throw new AuthFailure(409, "admin_account_required", "Only an active Admin account can receive commerce authority.");
  }
  const db = requireCommerceDb(env);
  const timestamp = nowIso();
  await db
    .prepare("INSERT INTO commerce_permission_grants (id, account_id, capability, granted_by_account_id, granted_at, reason) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(randomId(), target.id, capability, session.accountId, timestamp, cleanText(reason, 300) || null)
    .run();
  await writeCommerceAudit(env, {
    actorAccountId: session.accountId,
    action: "commerce_capability_granted",
    targetType: "account",
    targetId: target.id,
    result: "success",
    metadata: { capability },
  });
}

export async function revokeCommerceCapability(env, session, accountId, capability) {
  if (session?.account?.adminLevel !== "master") throw new AuthFailure(403, "master_admin_required", "Master Admin access is required.");
  if (!COMMERCE_CAPABILITIES.includes(capability)) throw new AuthFailure(400, "invalid_capability", "The commerce capability is invalid.");
  const timestamp = nowIso();
  const result = await requireCommerceDb(env)
    .prepare("UPDATE commerce_permission_grants SET revoked_by_account_id = ?, revoked_at = ? WHERE account_id = ? AND capability = ? AND revoked_at IS NULL")
    .bind(session.accountId, timestamp, cleanText(accountId, 160), capability)
    .run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(404, "grant_not_found", "The active commerce grant was not found.");
  await writeCommerceAudit(env, {
    actorAccountId: session.accountId,
    action: "commerce_capability_revoked",
    targetType: "account",
    targetId: cleanText(accountId, 160),
    result: "success",
    metadata: { capability },
  });
}

export async function encryptCommerceSecret(env, plaintext, purpose = "secret") {
  const value = String(plaintext ?? "");
  const bytes = encoder.encode(value);
  if (!bytes.length || bytes.length > MAX_SECRET_BYTES) throw new AuthFailure(400, "secret_size_invalid", "The private value is empty or too large.");
  const key = await importEncryptionKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const context = cleanPurpose(purpose);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(`${ENCRYPTION_CONTEXT_PREFIX}${context}`), tagLength: 128 },
    key,
    bytes,
  );
  return JSON.stringify({ v: ENVELOPE_VERSION, alg: ENCRYPTION_ALGORITHM, ctx: context, iv: bytesToBase64Url(nonce), ct: bytesToBase64Url(new Uint8Array(ciphertext)) });
}

export async function decryptCommerceSecret(env, envelopeValue, purpose = "secret") {
  const envelope = parseEnvelope(envelopeValue);
  const context = cleanPurpose(purpose);
  if (envelope.ctx !== context) throw new AuthFailure(400, "encrypted_value_invalid", "The encrypted value is invalid.");
  const key = await importEncryptionKey(env);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv), additionalData: encoder.encode(`${ENCRYPTION_CONTEXT_PREFIX}${context}`), tagLength: 128 },
      key,
      base64UrlToBytes(envelope.ct),
    );
    return decoder.decode(plaintext);
  } catch {
    throw new AuthFailure(400, "encrypted_value_invalid", "The encrypted value could not be authenticated.");
  }
}

export async function importEncryptionKey(env) {
  const raw = String(env?.THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY || "").trim();
  if (!raw) throw new AuthFailure(503, "commerce_encryption_unavailable", "Commerce encryption is not configured.");
  let bytes;
  try {
    bytes = base64UrlToBytes(raw);
  } catch {
    throw new AuthFailure(503, "commerce_encryption_invalid", "Commerce encryption is not configured with a 256-bit key.");
  }
  if (bytes.length !== 32) throw new AuthFailure(503, "commerce_encryption_invalid", "Commerce encryption is not configured with a 256-bit key.");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function publicBusinessProjection(profile) {
  return {
    tradingName: cleanText(profile?.trading_name ?? profile?.tradingName, 160),
    countryCode: cleanText(profile?.country_code ?? profile?.countryCode, 2),
    provinceCode: cleanText(profile?.province_code ?? profile?.provinceCode, 3),
    currencyCode: cleanText(profile?.currency_code ?? profile?.currencyCode, 3),
    publicAddress: safeJson(profile?.public_address_json ?? profile?.publicAddress, {}),
    publicContactEmail: cleanText(profile?.public_contact_email ?? profile?.publicContactEmail, 254),
    supportEmail: cleanText(profile?.support_email ?? profile?.supportEmail, 254),
    publicPhone: cleanText(profile?.public_phone ?? profile?.publicPhone, 40),
    websiteUrl: cleanText(profile?.website_url ?? profile?.websiteUrl, 500),
    invoicePrefix: cleanText(profile?.invoice_prefix ?? profile?.invoicePrefix, 24),
    documentFooter: cleanText(profile?.document_footer ?? profile?.documentFooter, 1000),
    taxProviderState: cleanText(profile?.tax_provider_state ?? profile?.taxProviderState, 40) || "unavailable",
    invoiceAccentColor: safeAccentColor(profile?.invoice_accent_color ?? profile?.invoiceAccentColor),
    receiptAccentColor: safeAccentColor(profile?.receipt_accent_color ?? profile?.receiptAccentColor),
  };
}

export function businessProjection(profile, registrations = []) {
  return {
    ...publicBusinessProjection(profile),
    private: {
      legalBusinessNameStored: Boolean(profile?.legal_business_name_ciphertext),
      privateAddressStored: Boolean(profile?.private_address_ciphertext),
      registrations: registrations.map((row) => ({
        type: cleanText(row.registration_type, 40),
        jurisdiction: cleanText(row.jurisdiction, 20),
        maskedIdentifier: cleanText(row.masked_identifier, 40),
        status: cleanText(row.status, 30),
      })),
    },
  };
}

export function maskTaxIdentifier(value) {
  const normalized = String(value || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalized) return "";
  const visible = normalized.slice(-4);
  return `${"•".repeat(Math.max(4, Math.min(10, normalized.length - visible.length)))}${visible}`;
}

export function validateTemplate(raw) {
  const templateKey = cleanText(raw?.templateKey, 60);
  if (!TEMPLATE_BLUEPRINTS.some((item) => item.templateKey === templateKey)) throw new AuthFailure(400, "template_key_invalid", "The template type is invalid.");
  const template = {
    templateKey,
    subject: plainTemplateText(raw?.subject, 160, true),
    preheader: plainTemplateText(raw?.preheader, 200),
    heading: plainTemplateText(raw?.heading, 160, true),
    introduction: plainTemplateText(raw?.introduction, 1000),
    bodyBlocks: Array.isArray(raw?.bodyBlocks) ? raw.bodyBlocks.slice(0, 8).map((value) => plainTemplateText(value, 1000, true)) : [],
    ctaLabel: plainTemplateText(raw?.ctaLabel, 80),
    ctaUrl: validateCtaUrl(raw?.ctaUrl),
    supportText: plainTemplateText(raw?.supportText, 500),
    footer: plainTemplateText(raw?.footer, 1000),
    accentColor: /^#[0-9a-f]{6}$/i.test(String(raw?.accentColor || "")) ? String(raw.accentColor).toLowerCase() : "#f3c928",
    status: ["draft", "disabled", "ready"].includes(raw?.status) ? raw.status : "draft",
  };
  if (template.ctaLabel && !template.ctaUrl) throw new AuthFailure(400, "template_cta_invalid", "A CTA label requires a safe HTTPS or relative URL.");
  return template;
}

export function redactCommerceAuditMetadata(metadata) {
  const sensitiveKey = /(secret|token|credential|password|bank|routing|account.?number|card|pan|cvc|tax.?id|business.?number|gst|hst|legal.?name|private.?address)/i;
  const walk = (value, key = "") => {
    if (sensitiveKey.test(key)) return "[redacted]";
    if (Array.isArray(value)) return value.slice(0, 20).map((entry) => walk(entry));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 30).map(([entryKey, entryValue]) => [cleanText(entryKey, 80), walk(entryValue, entryKey)]));
    if (typeof value === "string") {
      return cleanText(value, 300)
        .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]+\b/g, "[redacted]")
        .replace(/\b\d{9,16}\b/g, "[redacted]");
    }
    return typeof value === "number" || typeof value === "boolean" || value === null ? value : cleanText(value, 80);
  };
  return walk(metadata && typeof metadata === "object" ? metadata : {});
}

export async function writeCommerceAudit(env, event) {
  const db = requireCommerceDb(env);
  const metadata = redactCommerceAuditMetadata(event.metadata);
  await db
    .prepare("INSERT INTO commerce_audit (id, actor_account_id, action, target_type, target_id, result, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      randomId(),
      cleanText(event.actorAccountId, 160) || null,
      cleanText(event.action, 100),
      cleanText(event.targetType, 80),
      cleanText(event.targetId, 160) || null,
      ["success", "rejected", "error"].includes(event.result) ? event.result : "error",
      JSON.stringify(metadata).slice(0, 2048),
      nowIso(),
    )
    .run();
}

function templateBlueprint(templateKey, subject, heading, introduction) {
  return Object.freeze({
    templateKey,
    subject,
    preheader: "",
    heading,
    introduction,
    bodyBlocks: [],
    ctaLabel: "",
    ctaUrl: "",
    supportText: "Questions? Contact info@thirdrailify.com.",
    footer: "",
    accentColor: "#f3c928",
    status: "draft",
    revision: 1,
  });
}

function defaultBusinessProfile() {
  return {
    trading_name: "Third Railify Official",
    legal_business_name_ciphertext: null,
    country_code: "CA",
    province_code: "ON",
    currency_code: "CAD",
    public_address_json: "{}",
    private_address_ciphertext: null,
    public_contact_email: "info@thirdrailify.com",
    support_email: "",
    public_phone: "",
    website_url: "",
    invoice_prefix: "",
    document_footer: "",
    tax_provider_state: "unavailable",
    invoice_accent_color: "#f3c928",
    receipt_accent_color: "#f3c928",
  };
}

function businessCompleteness(profile) {
  const required = [profile?.trading_name, profile?.country_code, profile?.province_code, profile?.currency_code, profile?.public_contact_email];
  return required.every(Boolean) ? "pending" : "setup_required";
}

function serializeProviderConnection(row) {
  const blueprint = PROVIDER_BLUEPRINTS.find((item) => item.provider === row.provider);
  const rawMetadata = safeJson(row.safe_metadata_json, {});
  const metadata = {
    accountDisplayName: cleanText(rawMetadata.account_display_name, 160) || undefined,
    paymentMethods: Array.isArray(rawMetadata.payment_methods) ? rawMetadata.payment_methods.map((value) => cleanText(value, 40)).filter(Boolean).slice(0, 12) : undefined,
  };
  return {
    provider: row.provider,
    label: blueprint?.label || row.provider,
    status: COMMERCE_STATUS_VALUES.includes(row.status) ? row.status : "error",
    integrationMode: cleanText(row.integration_mode, 40) || null,
    credentialCustody: row.credential_custody,
    environment: row.environment,
    externalAccountId: cleanText(row.external_account_id, 160) || null,
    countryCode: cleanText(row.country_code, 2) || null,
    currencyCode: cleanText(row.currency_code, 3) || null,
    accountCreated: rawMetadata.account_created === true,
    apiConfigured: rawMetadata.api_configured === true,
    webhookConfigured: rawMetadata.webhook_configured === true,
    checkoutEnabled: rawMetadata.checkout_enabled === true,
    livePaymentsEnabled: rawMetadata.live_payments_enabled === true,
    livePayoutReadiness: cleanText(rawMetadata.live_payout_readiness, 40) || "unverified",
    metadata,
    lastSynchronizedAt: cleanText(row.last_synchronized_at, 80) || null,
  };
}

function serializeTemplate(row) {
  return {
    templateKey: row.template_key,
    subject: row.subject,
    preheader: row.preheader,
    heading: row.heading,
    introduction: row.introduction,
    bodyBlocks: safeJson(row.body_blocks_json, []),
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_url,
    supportText: row.support_text,
    footer: row.footer,
    accentColor: row.accent_color,
    status: row.status,
    revision: Number(row.revision || 1),
  };
}

function validateBusinessProfile(input, current) {
  const tradingName = cleanText(input?.tradingName ?? current?.trading_name, 160);
  if (!tradingName) throw new AuthFailure(400, "trading_name_required", "A public trading name is required.");
  const countryCode = cleanText(input?.countryCode ?? current?.country_code, 2).toUpperCase();
  const provinceCode = cleanText(input?.provinceCode ?? current?.province_code, 3).toUpperCase();
  const currencyCode = cleanText(input?.currencyCode ?? current?.currency_code, 3).toUpperCase();
  if (countryCode !== "CA" || provinceCode !== "ON" || currencyCode !== "CAD") {
    throw new AuthFailure(400, "commerce_locale_locked", "This foundation is scoped to Ontario, Canada with CAD storefront currency.");
  }
  const publicContactEmail = validateOptionalEmail(input?.publicContactEmail);
  const supportEmail = validateOptionalEmail(input?.supportEmail);
  const websiteUrl = validateOptionalHttpsUrl(input?.websiteUrl);
  const publicAddress = validateAddress(input?.publicAddress);
  const privateAddress = plainPrivateValue(input?.privateAddress, 1200);
  const legalBusinessName = plainPrivateValue(input?.legalBusinessName, 240);
  return {
    tradingName,
    legalBusinessName,
    countryCode,
    provinceCode,
    currencyCode,
    publicAddress,
    privateAddress,
    publicContactEmail,
    supportEmail,
    publicPhone: cleanText(input?.publicPhone, 40),
    websiteUrl,
    invoicePrefix: cleanText(input?.invoicePrefix, 24),
    documentFooter: plainTemplateText(input?.documentFooter, 1000),
    taxProviderState: "unavailable",
    invoiceAccentColor: safeAccentColor(input?.invoiceAccentColor),
    receiptAccentColor: safeAccentColor(input?.receiptAccentColor),
    registrations: [
      { type: "business_number", jurisdiction: "CA", identifier: plainPrivateValue(input?.businessNumber, 40) },
      { type: "gst_hst", jurisdiction: "CA", identifier: plainPrivateValue(input?.gstHstNumber, 40) },
      { type: "provincial", jurisdiction: "ON", identifier: plainPrivateValue(input?.provincialRegistration, 80) },
    ],
    changedFieldNames: Object.keys(input && typeof input === "object" ? input : {}).filter((key) => !/(number|registration|legal|private)/i.test(key)).slice(0, 30),
  };
}

async function upsertTaxRegistration(db, env, accountId, registration, timestamp) {
  const ciphertext = await encryptCommerceSecret(env, registration.identifier, `tax:${registration.type}:${registration.jurisdiction}`);
  await db
    .prepare(
      `INSERT INTO commerce_tax_registrations (
         id, business_profile_id, registration_type, jurisdiction, identifier_ciphertext,
         masked_identifier, status, created_at, updated_at, updated_by_account_id
       ) VALUES (?, 'primary', ?, ?, ?, ?, 'unverified', ?, ?, ?)
       ON CONFLICT(business_profile_id, registration_type, jurisdiction) DO UPDATE SET
         identifier_ciphertext = excluded.identifier_ciphertext,
         masked_identifier = excluded.masked_identifier,
         status = 'unverified',
         updated_at = excluded.updated_at,
         updated_by_account_id = excluded.updated_by_account_id`,
    )
    .bind(randomId(), registration.type, registration.jurisdiction, ciphertext, maskTaxIdentifier(registration.identifier), timestamp, timestamp, accountId)
    .run();
}

function plainTemplateText(value, maxLength, required = false) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, maxLength);
  if (required && !text) throw new AuthFailure(400, "template_field_required", "Required template text is missing.");
  if (/<\/?[a-z][^>]*>|javascript\s*:|on[a-z]+\s*=|<script/i.test(text)) {
    throw new AuthFailure(400, "unsafe_template_content", "Templates accept structured plain text only.");
  }
  return text;
}

function plainPrivateValue(value, maxLength) {
  const text = String(value ?? "").trim().slice(0, maxLength);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new AuthFailure(400, "private_value_invalid", "The private value contains invalid characters.");
  return text;
}

function validateCtaUrl(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function validateOptionalHttpsUrl(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
    return url.toString();
  } catch {
    throw new AuthFailure(400, "website_url_invalid", "The website must be a valid HTTPS URL.");
  }
}

function validateOptionalEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  if (!email) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthFailure(400, "email_invalid", "Enter a valid email address.");
  return email;
}

function safeAccentColor(value) {
  const text = String(value || "");
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : "#f3c928";
}

function validateAddress(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    line1: cleanText(raw.line1, 180),
    line2: cleanText(raw.line2, 180),
    city: cleanText(raw.city, 120),
    province: cleanText(raw.province, 3).toUpperCase(),
    postalCode: cleanText(raw.postalCode, 12).toUpperCase(),
    country: cleanText(raw.country, 2).toUpperCase(),
  };
}

function safeJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function cleanPurpose(value) {
  const purpose = String(value || "secret").replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 120);
  return purpose || "secret";
}

function parseEnvelope(value) {
  let envelope;
  try {
    envelope = JSON.parse(String(value || ""));
  } catch {
    throw new AuthFailure(400, "encrypted_value_invalid", "The encrypted value is invalid.");
  }
  if (
    envelope?.v !== ENVELOPE_VERSION ||
    envelope?.alg !== ENCRYPTION_ALGORITHM ||
    typeof envelope?.ctx !== "string" ||
    typeof envelope?.iv !== "string" ||
    typeof envelope?.ct !== "string" ||
    base64UrlToBytes(envelope.iv).length !== 12 ||
    base64UrlToBytes(envelope.ct).length < 17
  ) {
    throw new AuthFailure(400, "encrypted_value_invalid", "The encrypted value is invalid.");
  }
  return envelope;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("Invalid base64url");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hasValidEncryptionKeyShape(env) {
  try {
    return base64UrlToBytes(String(env?.THIRDRAILIFY_COMMERCE_ENCRYPTION_KEY || "").trim()).length === 32;
  } catch {
    return false;
  }
}

export function assertNoCommerceSecretsInPublicPayload(payload) {
  const serialized = JSON.stringify(payload);
  if (/(credential_ciphertext|legal_business_name_ciphertext|private_address_ciphertext|identifier_ciphertext|client_secret|secret_key|bank_account|card_pan|cvc)/i.test(serialized)) {
    throw new Error("private_commerce_data_exposed");
  }
  return true;
}

export async function assertAuthDatabaseAvailable(env) {
  return requireAuthDb(env);
}
