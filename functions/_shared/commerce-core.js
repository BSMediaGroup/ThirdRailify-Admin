import {
  AuthFailure,
  cleanText,
  nowIso,
  randomId,
  requireAuthDb,
} from "./auth-core.js";
import { accessForSession, requireAdminCapability } from "./admin-capabilities.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENVELOPE_VERSION = 1;
const ENCRYPTION_ALGORITHM = "A256GCM";
const MAX_SECRET_BYTES = 16 * 1024;
const ENCRYPTION_CONTEXT_PREFIX = "thirdrailify-commerce:v1:";
const STRIPE_ACCOUNT_URL = "https://api.stripe.com/v1/account";
const PRINTFUL_STORES_URL = "https://api.printful.com/stores";
const PRINTFUL_PRODUCTS_URL = "https://api.printful.com/store/products?limit=1";
const PRINTFUL_SCOPES_URL = "https://api.printful.com/v2/oauth-scopes";
const PRINTFUL_EXPECTED_STORE_NAME = "Third Railify API";
const MAX_PRINTFUL_CREDENTIAL_LENGTH = 4096;
const PRINTFUL_WIX_SOURCE_STORE_ID = "16847493";
const PRINTFUL_API_TARGET_STORE_ID = "18668025";
const PRODUCT_PAGE_SIZES = Object.freeze([20, 50, 75, 100]);
const PRODUCT_BULK_OPERATIONS = Object.freeze(["show", "hide", "feature", "unfeature"]);
const COLLECTION_PAGE_SIZES = Object.freeze([20, 50, 75, 100]);
const COLLECTION_BULK_OPERATIONS = Object.freeze(["show", "hide"]);

export const COMMERCE_CAPABILITIES = Object.freeze([
  "commerce.view",
  "commerce.catalogue.manage",
  "commerce.business.manage",
  "commerce.payments.manage",
  "commerce.integrations.manage",
  "commerce.templates.manage",
  "commerce.operations.manage",
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
  printfulApi: "verification_available",
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
  Object.freeze({ provider: "stripe", label: "Stripe", status: "setup_required", integrationMode: "direct_merchant", credentialCustody: "environment_secret", environment: "test", countryCode: "CA", currencyCode: "CAD", accountCreated: true, apiConfigured: false, webhookEndpointReady: true, webhookSigningConfigured: false, webhookConfigured: false, checkoutEnabled: false, livePaymentsEnabled: false, livePayoutReadiness: "unverified", metadata: Object.freeze({ accountDisplayName: "Third Railify Official", paymentMethods: Object.freeze(["cards", "eligible_apple_pay", "eligible_google_pay"]) }) }),
  Object.freeze({ provider: "printful", label: "Printful", status: "setup_required", integrationMode: "fulfillment", credentialCustody: "environment_secret", environment: "staging", currencyCode: "CAD", apiConfigured: false, webhookConfigured: false, metadata: Object.freeze({ accessLevel: "single_store", orderMode: "draft_only", fulfillmentEnabled: false, credentialConfigured: false, existingWixStoreUntouched: true, providerApi: "real" }) }),
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
  templateBlueprint("payment_receipt", "Payment receipt", "Payment receipt", "Payment confirmed for {{order_reference}}.", "document", "Payment receipt", true),
  templateBlueprint("invoice_document", "Invoice / sales document", "Invoice / sales document", "Document for {{order_reference}}.", "document", "Invoice / sales document"),
]);

export const COMMERCE_TEMPLATE_VARIABLES = Object.freeze([
  "order_reference", "customer_name", "merchant_name", "order_total", "currency",
  "product_summary", "support_email", "receipt_url", "shipping_method", "tracking_number",
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

export function stripeTestCredentialKind(value) {
  const credential = String(value || "").trim();
  if (/^rk_test_[A-Za-z0-9]+$/.test(credential)) return "restricted_test";
  if (/^sk_test_[A-Za-z0-9]+$/.test(credential)) return "secret_test";
  return null;
}

export function isStripeTestCredentialConfigured(env) {
  return isStripeVerificationEnvironment(env) && Boolean(stripeTestCredentialKind(env?.STRIPE_SECRET_KEY));
}

export function isStripeWebhookSigningConfigured(env) {
  const secret = String(env?.STRIPE_WEBHOOK_SECRET || "");
  return /^whsec_[^\s]{6,}$/.test(secret) && secret.length <= 512;
}

export function isPrintfulCredentialConfigured(env) {
  return Boolean(printfulCredential(env));
}

export function isStripeLiveCredentialConfigured(env) {
  return /^sk_live_[A-Za-z0-9_]{8,}$/.test(String(env?.STRIPE_LIVE_SECRET_KEY || "").trim());
}

export function isStripeLiveWebhookSigningConfigured(env) {
  const secret = String(env?.STRIPE_LIVE_WEBHOOK_SECRET || "");
  return /^whsec_[^\s]{6,}$/.test(secret) && secret.length <= 512;
}

export function stripeCredentialForEnvironment(env, environment) {
  if (environment === "live") return isStripeLiveCredentialConfigured(env) ? String(env.STRIPE_LIVE_SECRET_KEY).trim() : "";
  return isStripeTestCredentialConfigured(env) ? String(env.STRIPE_SECRET_KEY).trim() : "";
}

export function printfulCatalogueSnapshotAvailability(env) {
  const sourceStoreId = safeConfiguredStoreId(env?.PRINTFUL_WIX_SOURCE_STORE_ID);
  const targetStoreId = safeConfiguredStoreId(env?.PRINTFUL_STORE_ID);
  const configurationReady = sourceStoreId === PRINTFUL_WIX_SOURCE_STORE_ID
    && targetStoreId === PRINTFUL_API_TARGET_STORE_ID
    && sourceStoreId !== targetStoreId;
  return {
    available: Boolean(configurationReady && isCommerceDbConfigured(env) && isPrintfulCredentialConfigured(env)),
    configurationReady,
    actionPath: "/api/admin/commerce/printful/catalogue/snapshot",
    source: { id: PRINTFUL_WIX_SOURCE_STORE_ID, name: "Third Railify Official", type: "wix" },
    target: { id: PRINTFUL_API_TARGET_STORE_ID, name: PRINTFUL_EXPECTED_STORE_NAME, type: "native" },
    sourceTargetDistinct: sourceStoreId !== null && targetStoreId !== null && sourceStoreId !== targetStoreId,
  };
}

export async function commerceAccessForSession(env, session) {
  const adminAccess = await accessForSession(env, session);
  return { isMasterAdmin: adminAccess.isMasterAdmin, capabilities: adminAccess.capabilities.filter((capability) => COMMERCE_CAPABILITIES.includes(capability)) };
}

export async function requireCommerceCapability(env, session, capability) {
  if (!COMMERCE_CAPABILITIES.includes(capability)) throw new AuthFailure(403, "unknown_admin_capability", "The requested Admin capability is not registered.");
  await requireAdminCapability(env, session, capability);
  return commerceAccessForSession(env, session);
}

export async function commerceOverview(env, session) {
  const access = await commerceAccessForSession(env, session);
  if (!isCommerceDbConfigured(env)) {
    return {
      ok: true,
      databaseConfigured: false,
      encryptionConfigured: hasValidEncryptionKeyShape(env),
      stripeSecretConfigured: isStripeTestCredentialConfigured(env),
      printfulSecretConfigured: isPrintfulCredentialConfigured(env),
      printfulCatalogueSnapshot: printfulCatalogueSnapshotAvailability(env),
      access,
      posture: COMMERCE_SAFE_POSTURE,
      providers: providerBlueprints(env),
      business: browserSafeBusinessProjection(defaultBusinessProfile()),
      completeness: { businessProfile: "setup_required", tax: "setup_required", templates: "setup_required" },
      counts: { products: null, orders: null, templates: null },
      checkedAt: nowIso(),
    };
  }

  const db = requireCommerceDb(env);
  const [providerResult, settingResult, profile, taxCount, templateCount, productCount, orderCount] = await Promise.all([
    db.prepare("SELECT provider, integration_mode, credential_custody, status, environment, external_account_id, country_code, currency_code, safe_metadata_json, last_synchronized_at FROM commerce_provider_connections ORDER BY provider").all(),
    db.prepare("SELECT setting_key, value_json FROM commerce_settings WHERE setting_key IN ('stripe_api_configured', 'stripe_webhook_configured', 'printful_api_configured', 'printful_order_mode', 'fulfillment_submission_enabled')").all(),
    db.prepare("SELECT * FROM commerce_business_profiles WHERE id = 'primary'").first(),
    db.prepare("SELECT COUNT(*) AS count FROM commerce_tax_registrations").first(),
    db.prepare("SELECT COUNT(*) AS count FROM commerce_templates").first(),
    db.prepare("SELECT COUNT(*) AS count FROM commerce_products").first(),
    db.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first(),
  ]);
  const settings = Object.fromEntries((settingResult?.results || []).map((row) => [row.setting_key, safeJson(row.value_json, false)]));
  const providers = (providerResult?.results || []).map((row) => serializeProviderConnection(row, env, settings));
  return {
    ok: true,
    databaseConfigured: true,
    encryptionConfigured: hasValidEncryptionKeyShape(env),
    stripeSecretConfigured: isStripeTestCredentialConfigured(env),
    printfulSecretConfigured: isPrintfulCredentialConfigured(env),
    printfulCatalogueSnapshot: printfulCatalogueSnapshotAvailability(env),
    access,
    posture: COMMERCE_SAFE_POSTURE,
    providers: providers.length ? providers : providerBlueprints(env),
    business: browserSafeBusinessProjection(profile || defaultBusinessProfile()),
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

export async function merchandisingProductsPayload(env, session) {
  const access = session ? await commerceAccessForSession(env, session) : null;
  if (!isCommerceDbConfigured(env)) {
    return { ok: true, databaseConfigured: false, access, products: [], featured: [], updatedAt: null };
  }
  const db = requireCommerceDb(env);
  const [result, variantResult, membershipResult] = await Promise.all([
    db.prepare(`SELECT id, slug, title, status, visibility, currency_code, unit_amount,
                       max_checkout_quantity, requires_shipping, is_featured, featured_order,
                       migration_status, safe_metadata_json, source_provider,
                       target_printful_product_id, legacy_printful_source_product_id,
                       legacy_wix_external_product_id, provider_store_id, provider_presence,
                       provider_reconciliation_status, provider_last_seen_at, provider_reconciled_at,
                       provider_snapshot_hash, archived_at, archived_reason, updated_at
                FROM commerce_products
                ORDER BY is_featured DESC, featured_order ASC, slug ASC`).all(),
    db.prepare(`SELECT id, product_id, local_variant_key, status, visibility,
                       is_sellable, availability_status, unit_amount, currency_code, sku,
                       size_label, color_label, option_values_json, fulfillment_provider,
                       fulfillment_mapping_status, migration_status, target_printful_product_id,
                       target_printful_sync_variant_id, target_catalogue_product_id,
                       target_catalogue_variant_id, legacy_source_product_id,
                       legacy_source_variant_id, legacy_wix_external_product_id,
                       legacy_wix_external_variant_id, safe_metadata_json, updated_at
                       , provider_store_id, provider_presence, provider_last_seen_at,
                       provider_reconciled_at, provider_snapshot_hash, archived_at
                FROM commerce_product_variants ORDER BY product_id, local_variant_key, id`).all(),
    db.prepare(`SELECT pc.product_id, c.id, c.title, c.slug, c.visibility, c.display_order
                FROM commerce_product_collections pc
                JOIN commerce_collections c ON c.id = pc.collection_id
                WHERE c.status = 'active'
                ORDER BY pc.product_id, c.display_order, c.slug`).all(),
  ]);
  const variants = new Map();
  for (const row of variantResult?.results || []) {
    const list = variants.get(row.product_id) || [];
    list.push(serializeMerchandisingVariant(row));
    variants.set(row.product_id, list);
  }
  const memberships = new Map();
  for (const row of membershipResult?.results || []) {
    const list = memberships.get(row.product_id) || [];
    list.push({ id: cleanText(row.id, 160), title: cleanText(row.title, 160), slug: cleanText(row.slug, 180), visibility: row.visibility, displayOrder: Number(row.display_order) });
    memberships.set(row.product_id, list);
  }
  const products = (result?.results || []).map((row) => serializeMerchandisingProduct(row, variants.get(row.id) || [], memberships.get(row.id) || []));
  return {
    ok: true,
    databaseConfigured: true,
    access,
    products,
    featured: products.filter((product) => product.featured),
    updatedAt: products.reduce((latest, product) => !latest || product.updatedAt > latest ? product.updatedAt : latest, "" ) || null,
  };
}

export async function merchandisingProductListPayload(env, session, input = {}) {
  const options = normalizeProductListOptions(input);
  const payload = await merchandisingProductsPayload(env, session);
  const matching = filterMerchandisingProducts(payload.products, options);
  const totalItems = matching.length;
  const totalPages = totalItems ? Math.ceil(totalItems / options.pageSize) : 0;
  const page = totalPages ? Math.min(options.page, totalPages) : 1;
  const start = (page - 1) * options.pageSize;
  const categories = [...new Set(payload.products.flatMap((product) => product.categories))].sort((a, b) => a.localeCompare(b));
  const migrationStatuses = [...new Set(payload.products.map((product) => product.migrationStatus).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    ok: true,
    databaseConfigured: payload.databaseConfigured,
    access: payload.access,
    items: matching.slice(start, start + options.pageSize),
    featured: payload.featured,
    page,
    pageSize: options.pageSize,
    totalItems,
    totalPages,
    filters: { query: options.query, visibility: options.visibility, status: options.status, migration: options.migration, category: options.category, featured: options.featured, catalogue: options.catalogue, sort: options.sort },
    facets: { categories, migrationStatuses },
    totals: {
      products: payload.products.some((product) => product.provider.presence === "current") ? payload.products.filter((product) => product.provider.presence === "current").length : payload.products.length,
      totalProducts: payload.products.length,
      currentProducts: payload.products.filter((product) => product.provider.presence === "current").length,
      archivedProducts: payload.products.filter((product) => product.provider.presence !== "current" || product.provider.archivedAt).length,
      providerMissingProducts: payload.products.filter((product) => product.provider.presence === "provider_missing").length,
      wrongStoreProducts: payload.products.filter((product) => product.provider.presence === "wrong_store").length,
      needsReviewProducts: payload.products.filter((product) => ["needs_review", "ambiguous"].includes(product.provider.reconciliationStatus)).length,
      publicProducts: payload.products.filter((product) => product.provider.presence === "current" && product.visibility === "public" && product.status === "active").length,
      variants: payload.products.filter((product) => product.provider.presence === "current").reduce((total, product) => total + product.variantCount, 0),
      featuredProducts: payload.featured.filter((product) => product.provider.presence === "current").length,
    },
    updatedAt: payload.updatedAt,
  };
}

export async function merchandisingProductPayload(env, session, productId) {
  const payload = await merchandisingProductsPayload(env, session);
  const product = payload.products.find((entry) => entry.id === cleanText(productId, 160));
  if (!product) throw new AuthFailure(404, "commerce_product_not_found", "The commerce product was not found.");
  return { ok: true, databaseConfigured: payload.databaseConfigured, access: payload.access, product };
}

export async function updateMerchandisingProduct(env, session, productId, input) {
  const db = requireCommerceDb(env);
  const id = cleanText(productId, 160);
  const current = await db.prepare("SELECT id, safe_metadata_json, is_featured, featured_order, provider_presence FROM commerce_products WHERE id = ?").bind(id).first();
  if (!current) throw new AuthFailure(404, "commerce_product_not_found", "The commerce product was not found.");
  await requireCurrentProviderProductWhenReconciled(db, current);
  requireExactFields(input, ["title", "slug", "description", "primaryImageUrl", "additionalImages", "categories", "tags", "featured", "visibility", "status", "displayOrder", "maxQuantity", "unitAmount", "currencyCode"], "commerce_product_fields_invalid");
  const title = requiredPlainText(input.title, 240, "commerce_product_title_invalid");
  const slug = cleanText(input.slug, 180).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new AuthFailure(400, "commerce_product_slug_invalid", "The product slug is invalid.");
  const description = plainMerchText(input.description, 12000);
  const primaryImageUrl = validateMerchandisingUrl(input.primaryImageUrl);
  const additionalImages = validateStringArray(input.additionalImages, 24, 4096, "commerce_product_images_invalid").map(validateMerchandisingUrl).filter(Boolean);
  const categories = validateStringArray(input.categories, 20, 120, "commerce_product_categories_invalid");
  const collectionRows = categories.length ? await db.prepare(`SELECT id, title FROM commerce_collections WHERE status = 'active' AND title IN (${categories.map(() => "?").join(",")}) COLLATE NOCASE`).bind(...categories).all() : { results: [] };
  if ((collectionRows?.results || []).length !== categories.length) throw new AuthFailure(400, "commerce_product_collection_unknown", "Every product collection must reference an active collection.");
  const tags = validateStringArray(input.tags, 30, 80, "commerce_product_tags_invalid");
  const visibility = normalizeProductVisibility(input.visibility);
  const status = ["active", "disabled"].includes(input.status) ? input.status : invalidMerch("commerce_product_status_invalid", "Product status is invalid.");
  const displayOrder = boundedMerchInteger(input.displayOrder, 0, 999999, "commerce_product_display_order_invalid");
  const maxQuantity = boundedMerchInteger(input.maxQuantity, 1, 20, "commerce_product_max_quantity_invalid");
  const featured = normalizeProductFeatured(input.featured);
  const unitAmount = input.unitAmount === null ? null : boundedMerchInteger(input.unitAmount, 1, 100_000_000, "commerce_product_price_invalid");
  if (String(input.currencyCode || "").toUpperCase() !== "CAD") throw new AuthFailure(400, "commerce_product_currency_invalid", "Product currency must be CAD.");
  const timestamp = nowIso();
  let featuredOrder = null;
  if (featured === 1) {
    if (current.is_featured === 1 && Number.isSafeInteger(Number(current.featured_order))) featuredOrder = Number(current.featured_order);
    else {
      const maximum = await db.prepare("SELECT COALESCE(MAX(featured_order), 0) maximum FROM commerce_products WHERE is_featured = 1").first();
      featuredOrder = Number(maximum?.maximum || 0) + 10;
    }
  }
  const previousMetadata = safeJson(current.safe_metadata_json, {});
  const metadata = { ...previousMetadata, description, publicImage: primaryImageUrl, publicImages: additionalImages, categories, tags, displayOrder };
  const requestedImages = [primaryImageUrl, ...additionalImages].filter(Boolean);
  const providerImages = safeStoredStringArray(previousMetadata.providerCatalogue?.imageUrls, []).map(validateStoredHttpsUrl).filter(Boolean);
  if (primaryImageUrl && sameOrderedStrings(requestedImages, providerImages) && previousMetadata.imageAuthority?.kind === "current_provider") metadata.imageAuthority = previousMetadata.imageAuthority;
  else if (primaryImageUrl) metadata.imageAuthority = { kind: "editorial_override", source: "admin_product_editor", updatedAt: timestamp };
  else delete metadata.imageAuthority;
  const metadataJson = JSON.stringify(metadata);
  if (metadataJson.length > 16384) throw new AuthFailure(400, "commerce_product_metadata_too_large", "Product merchandising metadata is too large.");
  const remainingFeatured = current.is_featured === 1 && featured === 0
    ? (await db.prepare("SELECT id, featured_order FROM commerce_products WHERE is_featured = 1 AND id <> ? ORDER BY featured_order, slug").bind(id).all())?.results || []
    : [];
  try {
    const statements = [db.prepare(`UPDATE commerce_products SET title = ?, slug = ?, safe_metadata_json = ?, is_featured = ?,
                      featured_order = ?,
                      visibility = ?, status = ?, max_checkout_quantity = ?, unit_amount = ?, updated_at = ?
                      WHERE id = ?`)
      .bind(title, slug, metadataJson, featured, featuredOrder, visibility, status, maxQuantity, unitAmount, timestamp, id),
      db.prepare("DELETE FROM commerce_product_collections WHERE product_id = ?").bind(id)];
    for (const row of collectionRows?.results || []) statements.push(db.prepare("INSERT INTO commerce_product_collections (product_id, collection_id, assigned_at, assigned_by_account_id) VALUES (?, ?, ?, ?)").bind(id, row.id, timestamp, session?.accountId || null));
    remainingFeatured.forEach((row, index) => { const order = (index + 1) * 10; if (Number(row.featured_order) !== order) statements.push(db.prepare("UPDATE commerce_products SET featured_order = ?, updated_at = ? WHERE id = ?").bind(order, timestamp, row.id)); });
    await db.batch(statements);
  } catch (error) {
    if (/unique/i.test(String(error?.message || error))) throw new AuthFailure(409, "commerce_product_slug_duplicate", "The product slug is already in use.");
    throw error;
  }
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.product_updated", targetType: "commerce_product", targetId: id, result: "success", metadata: { fields: Object.keys(input).sort(), visibility, status, featured: Boolean(featured) } });
  return merchandisingProductPayload(env, session, id);
}

export async function updateMerchandisingVariant(env, session, productId, variantId, input) {
  const db = requireCommerceDb(env);
  const product = cleanText(productId, 160);
  const id = cleanText(variantId, 160);
  const current = await db.prepare("SELECT v.id, v.safe_metadata_json, p.provider_presence FROM commerce_product_variants v JOIN commerce_products p ON p.id=v.product_id WHERE v.id = ? AND v.product_id = ?").bind(id, product).first();
  if (!current) throw new AuthFailure(404, "commerce_variant_not_found", "The commerce product variant was not found.");
  await requireCurrentProviderProductWhenReconciled(db, current);
  requireExactFields(input, ["displayLabel", "size", "color", "options", "unitAmount", "currencyCode", "status", "visibility", "sellable", "availability"], "commerce_variant_fields_invalid");
  const displayLabel = plainMerchText(input.displayLabel, 240) || null;
  const size = plainMerchText(input.size, 120) || null;
  const color = plainMerchText(input.color, 120) || null;
  const options = validateOptionValues(input.options);
  const unitAmount = boundedMerchInteger(input.unitAmount, 1, 100_000_000, "commerce_variant_price_invalid");
  if (String(input.currencyCode || "").toUpperCase() !== "CAD") throw new AuthFailure(400, "commerce_variant_currency_invalid", "Variant currency must be CAD.");
  const status = ["active", "disabled"].includes(input.status) ? input.status : invalidMerch("commerce_variant_status_invalid", "Variant status is invalid.");
  const visibility = ["private", "public"].includes(input.visibility) ? input.visibility : invalidMerch("commerce_variant_visibility_invalid", "Variant visibility is invalid.");
  const sellable = input.sellable === true ? 1 : input.sellable === false ? 0 : invalidMerch("commerce_variant_sellable_invalid", "Variant sellability is invalid.");
  const availability = ["active", "temporarily_out_of_stock", "discontinued"].includes(input.availability) ? input.availability : invalidMerch("commerce_variant_availability_invalid", "Variant availability is invalid.");
  const metadata = { ...safeJson(current.safe_metadata_json, {}), displayLabel };
  const metadataJson = JSON.stringify(metadata);
  if (metadataJson.length > 16384) throw new AuthFailure(400, "commerce_variant_metadata_too_large", "Variant merchandising metadata is too large.");
  await db.prepare(`UPDATE commerce_product_variants SET safe_metadata_json = ?, size_label = ?, color_label = ?,
                    option_values_json = ?, unit_amount = ?, status = ?, visibility = ?, is_sellable = ?,
                    availability_status = ?, updated_at = ? WHERE id = ? AND product_id = ?`)
    .bind(metadataJson, size, color, JSON.stringify(options), unitAmount, status, visibility, sellable, availability, nowIso(), id, product).run();
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.variant_updated", targetType: "commerce_product_variant", targetId: id, result: "success", metadata: { productId: product, fields: Object.keys(input).sort(), visibility, status, sellable: Boolean(sellable), availability } });
  return merchandisingProductPayload(env, session, product);
}

export async function updateFeaturedProducts(env, session, input) {
  const db = requireCommerceDb(env);
  const featuredIds = Array.isArray(input?.featuredIds) ? input.featuredIds.map((value) => cleanText(value, 160)) : null;
  if (!featuredIds || featuredIds.length > 100 || featuredIds.some((value) => !value)) {
    throw new AuthFailure(400, "featured_products_invalid", "Featured products must be a bounded ordered product list.");
  }
  if (new Set(featuredIds).size !== featuredIds.length) {
    throw new AuthFailure(400, "featured_products_duplicate", "A product can appear only once in the featured order.");
  }
  if (featuredIds.length) {
    const placeholders = featuredIds.map(() => "?").join(",");
    const found = await db.prepare(`SELECT id FROM commerce_products WHERE id IN (${placeholders})
      AND (NOT EXISTS (SELECT 1 FROM commerce_products WHERE provider_presence='current') OR (provider_presence='current' AND provider_reconciliation_status='current'))`).bind(...featuredIds).all();
    if ((found?.results || []).length !== featuredIds.length) {
      throw new AuthFailure(409, "featured_product_not_current", "Every Featured preference must reference a current provider product.");
    }
  }
  const timestamp = nowIso();
  const statements = [db.prepare("UPDATE commerce_products SET is_featured = 0, featured_order = NULL, updated_at = ? WHERE is_featured = 1").bind(timestamp)];
  featuredIds.forEach((id, index) => statements.push(db.prepare("UPDATE commerce_products SET is_featured = 1, featured_order = ?, updated_at = ? WHERE id = ?").bind((index + 1) * 10, timestamp, id)));
  await db.batch(statements);
  await writeCommerceAudit(env, {
    actorAccountId: session?.accountId,
    action: "products.featured_updated",
    targetType: "commerce_products",
    result: "success",
    metadata: { featuredCount: featuredIds.length, productIds: featuredIds },
  });
  return merchandisingProductsPayload(env, session);
}

export async function updateMerchandisingProductFeatured(env, session, productId, input) {
  const db = requireCommerceDb(env);
  const id = cleanText(productId, 160);
  if (!id) throw new AuthFailure(400, "commerce_product_id_invalid", "The commerce product ID is invalid.");
  requireExactFields(input, ["featured"], "commerce_product_featured_fields_invalid");
  const featured = normalizeProductFeatured(input.featured);
  const current = await db.prepare("SELECT id, status, is_featured, featured_order, updated_at, provider_presence, provider_reconciliation_status, archived_at FROM commerce_products WHERE id = ?").bind(id).first();
  if (!current) throw new AuthFailure(404, "commerce_product_not_found", "The commerce product was not found.");
  await requireFeaturedProductCurrent(db, current);
  const alreadyEqual = Number(current.is_featured) === featured && (featured === 0 || Number.isSafeInteger(Number(current.featured_order)));
  if (alreadyEqual) return { ok: true, changed: false, product: featuredMutationProduct(current) };

  const timestamp = nowIso();
  try {
    if (featured === 1) {
      await db.prepare(`UPDATE commerce_products
                        SET is_featured = 1,
                            featured_order = (SELECT COALESCE(MAX(featured_order), 0) + 10 FROM commerce_products WHERE is_featured = 1),
                            updated_at = ?
                        WHERE id = ? AND is_featured = 0`).bind(timestamp, id).run();
    } else {
      await db.prepare("UPDATE commerce_products SET is_featured = 0, featured_order = NULL, updated_at = ? WHERE id = ? AND is_featured = 1").bind(timestamp, id).run();
    }
    const updated = await db.prepare("SELECT id, is_featured, featured_order, updated_at FROM commerce_products WHERE id = ?").bind(id).first();
    await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.product_featured_updated", targetType: "commerce_product", targetId: id, result: "success", metadata: { featured: Boolean(featured) } });
    return { ok: true, changed: true, product: featuredMutationProduct(updated) };
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    console.error("commerce_product_featured_update_failed", { errorName: cleanText(error?.name, 80) || "Error" });
    throw new AuthFailure(500, "commerce_product_featured_update_failed", "Could not update Featured status. Try again.");
  }
}

function featuredMutationProduct(row) {
  return { id: cleanText(row.id, 160), featured: Number(row.is_featured) === 1, featuredOrder: Number.isSafeInteger(Number(row.featured_order)) ? Number(row.featured_order) : null, updatedAt: cleanText(row.updated_at, 80) || null };
}

export async function bulkUpdateMerchandisingProducts(env, session, input) {
  const db = requireCommerceDb(env);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["operation", "productIds", "matching", "confirmMatching", "expectedCount"].includes(key))) {
    throw new AuthFailure(400, "commerce_product_bulk_fields_invalid", "The bulk product mutation fields are invalid.");
  }
  const operation = cleanText(input.operation, 40);
  if (!PRODUCT_BULK_OPERATIONS.includes(operation)) throw new AuthFailure(400, "commerce_product_bulk_operation_invalid", "The bulk product operation is invalid.");
  const usesMatching = input.matching !== undefined;
  const usesIds = input.productIds !== undefined;
  if (usesMatching === usesIds) throw new AuthFailure(400, "commerce_product_bulk_selection_invalid", "Choose explicit product IDs or one confirmed matching selection.");

  const payload = await merchandisingProductsPayload(env, session);
  let products;
  let selection;
  if (usesMatching) {
    if (Object.keys(input).some((key) => !["operation", "matching", "confirmMatching", "expectedCount"].includes(key)) || !input.matching || typeof input.matching !== "object" || Array.isArray(input.matching) || Object.keys(input.matching).some((key) => !["query", "search", "visibility", "status", "migration", "category", "featured", "catalogue", "sort"].includes(key))) {
      throw new AuthFailure(400, "commerce_product_bulk_selection_invalid", "The matching product selection is invalid.");
    }
    if (input.confirmMatching !== true || !Number.isSafeInteger(input.expectedCount) || input.expectedCount < 1) {
      throw new AuthFailure(400, "commerce_product_bulk_confirmation_required", "Confirm the current filtered result count before applying this bulk operation.");
    }
    const options = normalizeProductListOptions({ ...input.matching, page: 1, pageSize: 100 });
    products = filterMerchandisingProducts(payload.products, options);
    if (products.length !== input.expectedCount) throw new AuthFailure(409, "commerce_product_bulk_match_changed", "The matching product count changed. Review and confirm the current result set again.");
    selection = "matching";
  } else {
    if (Object.keys(input).some((key) => !["operation", "productIds"].includes(key))) throw new AuthFailure(400, "commerce_product_bulk_selection_invalid", "The explicit product selection is invalid.");
    const ids = Array.isArray(input.productIds) ? input.productIds.map((value) => cleanText(value, 160)) : null;
    if (!ids || !ids.length || ids.length > 1000 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new AuthFailure(400, "commerce_product_bulk_ids_invalid", "Bulk product IDs must be a unique bounded list.");
    }
    const byId = new Map(payload.products.map((product) => [product.id, product]));
    const unknownIds = ids.filter((id) => !byId.has(id));
    if (unknownIds.length) throw new AuthFailure(400, "commerce_product_unknown", "Every bulk product ID must reference an authoritative catalogue product.");
    products = ids.map((id) => byId.get(id));
    selection = "explicit";
  }
  if (["show", "feature"].includes(operation) && await hasAppliedCatalogueReconciliation(db)) {
    const inactive = products.filter((product) => product.provider?.presence !== "current" || product.provider?.reconciliationStatus !== "current");
    if (inactive.length) throw new AuthFailure(409, "commerce_product_provider_inactive", "Archived or non-current products cannot be published or featured.");
  }

  const timestamp = nowIso();
  const statements = [];
  const updatedIds = [];
  if (operation === "show" || operation === "hide") {
    const visibility = normalizeProductVisibility(operation === "show" ? "public" : "private");
    for (const product of products) {
      if (product.visibility === visibility) continue;
      statements.push(db.prepare("UPDATE commerce_products SET visibility = ?, updated_at = ? WHERE id = ?").bind(visibility, timestamp, product.id));
      updatedIds.push(product.id);
    }
  } else if (operation === "feature") {
    normalizeProductFeatured(true);
    let nextOrder = payload.featured.reduce((maximum, product) => Math.max(maximum, product.featuredOrder || 0), 0);
    for (const product of products) {
      if (product.featured) continue;
      nextOrder += 10;
      statements.push(db.prepare("UPDATE commerce_products SET is_featured = 1, featured_order = ?, updated_at = ? WHERE id = ?").bind(nextOrder, timestamp, product.id));
      updatedIds.push(product.id);
    }
  } else {
    normalizeProductFeatured(false);
    const selected = new Set(products.map((product) => product.id));
    for (const product of products) {
      if (!product.featured) continue;
      statements.push(db.prepare("UPDATE commerce_products SET is_featured = 0, featured_order = NULL, updated_at = ? WHERE id = ?").bind(timestamp, product.id));
      updatedIds.push(product.id);
    }
    payload.featured.filter((product) => !selected.has(product.id)).forEach((product, index) => {
      const order = (index + 1) * 10;
      if (product.featuredOrder !== order) statements.push(db.prepare("UPDATE commerce_products SET featured_order = ?, updated_at = ? WHERE id = ?").bind(order, timestamp, product.id));
    });
  }
  if (statements.length) await db.batch(statements);
  const result = {
    ok: true,
    operation,
    selection,
    matched: products.length,
    requested: products.length,
    updated: updatedIds.length,
    unchanged: products.length - updatedIds.length,
    rejected: 0,
    errors: [],
    updatedIds,
  };
  await writeCommerceAudit(env, {
    actorAccountId: session?.accountId,
    action: "commerce.products_bulk_updated",
    targetType: "commerce_products",
    result: "success",
    metadata: { operation, selection, matched: result.matched, updated: result.updated, unchanged: result.unchanged, productIds: products.map((product) => product.id) },
  });
  return result;
}

export async function collectionListPayload(env, session, input = {}) {
  const options = normalizeCollectionListOptions(input);
  const access = session ? await commerceAccessForSession(env, session) : null;
  if (!isCommerceDbConfigured(env)) return emptyCollectionListPayload(access, options);
  const db = requireCommerceDb(env);
  const { where, bindings } = collectionListWhere(options);
  const countRow = await db.prepare(`SELECT COUNT(*) total FROM commerce_collections c WHERE ${where}`).bind(...bindings).first();
  const totalItems = Number(countRow?.total || 0);
  const totalPages = totalItems ? Math.ceil(totalItems / options.pageSize) : 0;
  const page = totalPages ? Math.min(options.page, totalPages) : 1;
  const start = (page - 1) * options.pageSize;
  const [result, totals] = await Promise.all([
    db.prepare(`SELECT c.id, c.slug, c.title, c.description, c.visibility, c.status, c.display_order, c.revision,
                       c.created_at, c.updated_at,
                       (SELECT COUNT(*) FROM commerce_product_collections pc WHERE pc.collection_id = c.id) assigned_product_count,
                       (SELECT COUNT(*) FROM commerce_product_collections pc
                          JOIN commerce_products p ON p.id = pc.product_id
                         WHERE pc.collection_id = c.id AND p.status = 'active' AND p.visibility = 'public'
                           AND (json_extract(p.safe_metadata_json, '$.publicImage') IS NOT NULL OR json_extract(p.safe_metadata_json, '$.public_image') IS NOT NULL OR json_extract(p.safe_metadata_json, '$.public_image_captured') = 1)
                           AND (p.unit_amount IS NOT NULL OR json_extract(p.safe_metadata_json, '$.public_price_captured') = 1 OR EXISTS (SELECT 1 FROM commerce_product_variants v WHERE v.product_id = p.id AND v.unit_amount IS NOT NULL))) public_product_count,
                       (SELECT COALESCE(json_extract(p.safe_metadata_json, '$.publicImage'), json_extract(p.safe_metadata_json, '$.public_image'))
                          FROM commerce_product_collections pc
                          JOIN commerce_products p ON p.id = pc.product_id
                         WHERE pc.collection_id = c.id
                           AND COALESCE(json_extract(p.safe_metadata_json, '$.publicImage'), json_extract(p.safe_metadata_json, '$.public_image')) IS NOT NULL
                         ORDER BY CAST(COALESCE(json_extract(p.safe_metadata_json, '$.displayOrder'), 1000) AS INTEGER), p.slug LIMIT 1) thumbnail_url
                  FROM commerce_collections c WHERE ${where}
                  ORDER BY ${collectionSortSql(options.sort)} LIMIT ? OFFSET ?`).bind(...bindings, options.pageSize, start).all(),
    db.prepare(`SELECT COUNT(*) collections,
                       SUM(CASE WHEN visibility = 'public' THEN 1 ELSE 0 END) public_collections,
                       SUM(CASE WHEN visibility = 'hidden' THEN 1 ELSE 0 END) hidden_collections,
                       SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_product_collections pc WHERE pc.collection_id = commerce_collections.id) THEN 1 ELSE 0 END) empty_collections
                  FROM commerce_collections WHERE status = 'active'`).first(),
  ]);
  const items = (result?.results || []).map(serializeCollectionListRow);
  return {
    ok: true, databaseConfigured: true, access, items, page, pageSize: options.pageSize, totalItems, totalPages,
    startIndex: totalItems ? start + 1 : 0, endIndex: totalItems ? start + items.length : 0,
    filters: { query: options.query, visibility: options.visibility, contents: options.contents, sort: options.sort },
    totals: { collections: Number(totals?.collections || 0), publicCollections: Number(totals?.public_collections || 0), hiddenCollections: Number(totals?.hidden_collections || 0), emptyCollections: Number(totals?.empty_collections || 0) },
    updatedAt: items.reduce((latest, item) => !latest || item.updatedAt > latest ? item.updatedAt : latest, "") || null,
  };
}

export async function collectionDetailPayload(env, session, collectionId) {
  const access = session ? await commerceAccessForSession(env, session) : null;
  const db = requireCommerceDb(env);
  const id = collectionIdValue(collectionId);
  const row = await db.prepare(`SELECT c.id, c.slug, c.title, c.description, c.visibility, c.status, c.display_order, c.revision,
                                       c.created_at, c.updated_at,
                                       (SELECT COUNT(*) FROM commerce_product_collections pc WHERE pc.collection_id = c.id) assigned_product_count,
                                       (SELECT COUNT(*) FROM commerce_product_collections pc JOIN commerce_products p ON p.id = pc.product_id
                                         WHERE pc.collection_id = c.id AND p.status = 'active' AND p.visibility = 'public'
                                           AND (json_extract(p.safe_metadata_json, '$.publicImage') IS NOT NULL OR json_extract(p.safe_metadata_json, '$.public_image') IS NOT NULL OR json_extract(p.safe_metadata_json, '$.public_image_captured') = 1)
                                           AND (p.unit_amount IS NOT NULL OR json_extract(p.safe_metadata_json, '$.public_price_captured') = 1 OR EXISTS (SELECT 1 FROM commerce_product_variants v WHERE v.product_id = p.id AND v.unit_amount IS NOT NULL))) public_product_count,
                                       (SELECT COALESCE(json_extract(p.safe_metadata_json, '$.publicImage'), json_extract(p.safe_metadata_json, '$.public_image')) FROM commerce_product_collections pc JOIN commerce_products p ON p.id = pc.product_id WHERE pc.collection_id = c.id AND COALESCE(json_extract(p.safe_metadata_json, '$.publicImage'), json_extract(p.safe_metadata_json, '$.public_image')) IS NOT NULL ORDER BY p.slug LIMIT 1) thumbnail_url
                                  FROM commerce_collections c WHERE c.id = ? AND c.status = 'active'`).bind(id).first();
  if (!row) throw new AuthFailure(404, "commerce_collection_not_found", "The commerce collection was not found.");
  return { ok: true, databaseConfigured: true, access, collection: serializeCollectionListRow(row) };
}

export async function collectionProductsListPayload(env, session, collectionId, input = {}) {
  const access = session ? await commerceAccessForSession(env, session) : null;
  const db = requireCommerceDb(env);
  const id = collectionIdValue(collectionId);
  if (!await db.prepare("SELECT id FROM commerce_collections WHERE id = ? AND status = 'active'").bind(id).first()) throw new AuthFailure(404, "commerce_collection_not_found", "The commerce collection was not found.");
  const options = normalizeCollectionProductOptions(input);
  const where = ["1 = 1"];
  const bindings = [];
  if (options.query) { const pattern = `%${escapeSqlLike(options.query)}%`; where.push("(p.title LIKE ? ESCAPE '\\' OR p.slug LIKE ? ESCAPE '\\')"); bindings.push(pattern, pattern); }
  if (options.visibility === "public") where.push("p.status = 'active' AND p.visibility = 'public'");
  if (options.visibility === "hidden") where.push("NOT (p.status = 'active' AND p.visibility = 'public')");
  where.push("(NOT EXISTS (SELECT 1 FROM commerce_catalogue_reconciliation_runs WHERE state = 'applied') OR p.provider_presence = 'current')");
  const membership = "EXISTS (SELECT 1 FROM commerce_product_collections pc WHERE pc.product_id = p.id AND pc.collection_id = ?)";
  if (options.membership === "assigned") { where.push(membership); bindings.push(id); }
  if (options.membership === "available") { where.push(`NOT ${membership}`); bindings.push(id); }
  const whereSql = where.join(" AND ");
  const countRow = await db.prepare(`SELECT COUNT(*) total FROM commerce_products p WHERE ${whereSql}`).bind(...bindings).first();
  const totalItems = Number(countRow?.total || 0);
  const totalPages = totalItems ? Math.ceil(totalItems / options.pageSize) : 0;
  const page = totalPages ? Math.min(options.page, totalPages) : 1;
  const start = (page - 1) * options.pageSize;
  const result = await db.prepare(`SELECT p.id, p.slug, p.title, p.status, p.visibility, p.unit_amount, p.safe_metadata_json, p.updated_at,
                                          EXISTS (SELECT 1 FROM commerce_product_collections pc WHERE pc.product_id = p.id AND pc.collection_id = ?) assigned
                                     FROM commerce_products p WHERE ${whereSql}
                                     ORDER BY p.title COLLATE NOCASE, p.slug, p.id LIMIT ? OFFSET ?`).bind(id, ...bindings, options.pageSize, start).all();
  const items = (result?.results || []).map((row) => {
    const metadata = safeJson(row.safe_metadata_json, {});
    const amount = Number.isSafeInteger(Number(row.unit_amount)) ? Number(row.unit_amount) : null;
    return { id: cleanText(row.id, 160), slug: cleanText(row.slug, 180), title: cleanText(row.title, 240), primaryImageUrl: validateStoredHttpsUrl(metadata.publicImage || metadata.public_image), status: cleanText(row.status, 40), visibility: cleanText(row.visibility, 20), assigned: Boolean(row.assigned), priceLabel: amount === null ? "Price unavailable" : formatCadMinor(amount), updatedAt: cleanText(row.updated_at, 80) };
  });
  return { ok: true, databaseConfigured: true, access, collectionId: id, items, page, pageSize: options.pageSize, totalItems, totalPages, startIndex: totalItems ? start + 1 : 0, endIndex: totalItems ? start + items.length : 0, filters: { query: options.query, visibility: options.visibility, membership: options.membership } };
}

export async function bulkUpdateCollections(env, session, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["operation", "collectionIds", "matching", "confirmMatching", "expectedCount"].includes(key))) throw new AuthFailure(400, "commerce_collection_bulk_fields_invalid", "The bulk collection mutation fields are invalid.");
  const operation = cleanText(input.operation, 40);
  if (!COLLECTION_BULK_OPERATIONS.includes(operation)) throw new AuthFailure(400, "commerce_collection_bulk_operation_invalid", "The bulk collection operation is invalid.");
  const usesMatching = input.matching !== undefined;
  const usesIds = input.collectionIds !== undefined;
  if (usesMatching === usesIds) throw new AuthFailure(400, "commerce_collection_bulk_selection_invalid", "Choose explicit collection IDs or one confirmed matching selection.");
  const db = requireCommerceDb(env);
  let ids;
  let selection;
  if (usesMatching) {
    if (!input.matching || typeof input.matching !== "object" || Array.isArray(input.matching) || Object.keys(input.matching).some((key) => !["query", "search", "visibility", "contents", "sort"].includes(key))) throw new AuthFailure(400, "commerce_collection_bulk_selection_invalid", "The matching collection selection is invalid.");
    if (input.confirmMatching !== true || !Number.isSafeInteger(input.expectedCount) || input.expectedCount < 1 || input.expectedCount > 1000) throw new AuthFailure(400, "commerce_collection_bulk_confirmation_required", "Confirm the current filtered result count before applying this bulk operation.");
    const options = normalizeCollectionListOptions({ ...input.matching, page: 1, pageSize: 100 });
    const { where, bindings } = collectionListWhere(options);
    const result = await db.prepare(`SELECT c.id FROM commerce_collections c WHERE ${where} ORDER BY ${collectionSortSql(options.sort)} LIMIT 1001`).bind(...bindings).all();
    ids = (result?.results || []).map((row) => cleanText(row.id, 160));
    if (ids.length !== input.expectedCount) throw new AuthFailure(409, "commerce_collection_bulk_match_changed", "The matching collection count changed. Review and confirm the current result set again.");
    selection = "matching";
  } else {
    ids = validatedIdentifiers(input.collectionIds, 1000, "commerce_collection_bulk_ids_invalid");
    if (!ids.length) throw new AuthFailure(400, "commerce_collection_bulk_ids_invalid", "Choose at least one collection.");
    const found = await db.prepare(`SELECT id FROM commerce_collections WHERE status = 'active' AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    if ((found?.results || []).length !== ids.length) throw new AuthFailure(400, "commerce_collection_unknown", "Every bulk collection ID must reference an active collection.");
    selection = "explicit";
  }
  const visibility = operation === "show" ? "public" : "hidden";
  const timestamp = nowIso();
  const result = await db.prepare(`UPDATE commerce_collections SET visibility = ?, revision = revision + 1, updated_at = ?, updated_by_account_id = ? WHERE status = 'active' AND visibility <> ? AND id IN (${ids.map(() => "?").join(",")})`).bind(visibility, timestamp, session?.accountId || null, visibility, ...ids).run();
  const updated = Number(result?.meta?.changes || 0);
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.collections_bulk_updated", targetType: "commerce_collections", result: "success", metadata: { operation, selection, matched: ids.length, updated, unchanged: ids.length - updated, collectionIds: ids } });
  return { ok: true, operation, selection, matched: ids.length, requested: ids.length, updated, unchanged: ids.length - updated, rejected: 0, errors: [], updatedIds: ids };
}

export async function updateCollectionMemberships(env, session, collectionId, input) {
  const db = requireCommerceDb(env); const id = collectionIdValue(collectionId);
  requireExactFields(input, ["operation", "productIds", "revision"], "commerce_collection_membership_fields_invalid");
  const operation = ["add", "remove"].includes(input.operation) ? input.operation : invalidMerch("commerce_collection_membership_operation_invalid", "The collection membership operation is invalid.");
  const productIds = validatedIdentifiers(input.productIds, 100, "commerce_collection_products_invalid");
  if (!productIds.length) throw new AuthFailure(400, "commerce_collection_products_invalid", "Choose at least one product.");
  const revision = boundedMerchInteger(input.revision, 1, Number.MAX_SAFE_INTEGER, "commerce_collection_revision_invalid");
  await requireCurrentCollection(db, id, revision);
  await requireKnownProducts(db, productIds);
  if (operation === "add" && await hasAppliedCatalogueReconciliation(db)) {
    const current = await db.prepare(`SELECT id FROM commerce_products WHERE provider_presence = 'current' AND id IN (${productIds.map(() => "?").join(",")})`).bind(...productIds).all();
    if ((current?.results || []).length !== productIds.length) throw new AuthFailure(409, "commerce_collection_product_not_current", "Archived or non-current products cannot be added to storefront collections.");
  }
  const existingResult = await db.prepare(`SELECT product_id FROM commerce_product_collections WHERE collection_id = ? AND product_id IN (${productIds.map(() => "?").join(",")})`).bind(id, ...productIds).all();
  const existing = new Set((existingResult?.results || []).map((row) => row.product_id));
  const changedIds = operation === "add" ? productIds.filter((productId) => !existing.has(productId)) : productIds.filter((productId) => existing.has(productId));
  const timestamp = nowIso();
  if (!changedIds.length) {
    await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.collection_memberships_updated", targetType: "commerce_collection", targetId: id, result: "success", metadata: { operation, requested: productIds.length, updated: 0, unchanged: productIds.length, productIds } });
    return { ok: true, collectionId: id, revision, operation, requested: productIds.length, updated: 0, unchanged: productIds.length, updatedIds: [] };
  }
  const statements = [];
  if (operation === "add") for (const productId of changedIds) statements.push(db.prepare("INSERT OR IGNORE INTO commerce_product_collections (product_id, collection_id, assigned_at, assigned_by_account_id) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM commerce_collections WHERE id = ? AND status = 'active' AND revision = ?)").bind(productId, id, timestamp, session?.accountId || null, id, revision));
  if (operation === "remove") statements.push(db.prepare(`DELETE FROM commerce_product_collections WHERE collection_id = ? AND product_id IN (${changedIds.map(() => "?").join(",")}) AND EXISTS (SELECT 1 FROM commerce_collections WHERE id = ? AND status = 'active' AND revision = ?)` ).bind(id, ...changedIds, id, revision));
  statements.push(db.prepare("UPDATE commerce_collections SET revision = revision + 1, updated_at = ?, updated_by_account_id = ? WHERE id = ? AND status = 'active' AND revision = ?").bind(timestamp, session?.accountId || null, id, revision));
  const results = await db.batch(statements);
  if (Number(results.at(-1)?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "commerce_collection_revision_conflict", "This collection changed in another session. Reload before saving.");
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.collection_memberships_updated", targetType: "commerce_collection", targetId: id, result: "success", metadata: { operation, requested: productIds.length, updated: changedIds.length, unchanged: productIds.length - changedIds.length, productIds } });
  return { ok: true, collectionId: id, revision: revision + 1, operation, requested: productIds.length, updated: changedIds.length, unchanged: productIds.length - changedIds.length, updatedIds: changedIds };
}

export async function collectionsPayload(env, session) {
  const access = session ? await commerceAccessForSession(env, session) : null;
  if (!isCommerceDbConfigured(env)) return { ok: true, databaseConfigured: false, access, collections: [], products: [], updatedAt: null };
  const db = requireCommerceDb(env);
  const [collectionResult, membershipResult, productPayload] = await Promise.all([
    db.prepare(`SELECT id, slug, title, description, visibility, status, display_order, revision,
                       created_at, updated_at
                FROM commerce_collections WHERE status = 'active'
                ORDER BY display_order, slug`).all(),
    db.prepare("SELECT product_id, collection_id FROM commerce_product_collections ORDER BY collection_id, product_id").all(),
    merchandisingProductsPayload(env, session),
  ]);
  const productById = new Map(productPayload.products.map((product) => [product.id, product]));
  const idsByCollection = new Map();
  for (const row of membershipResult?.results || []) {
    const list = idsByCollection.get(row.collection_id) || [];
    list.push(cleanText(row.product_id, 160));
    idsByCollection.set(row.collection_id, list);
  }
  const collections = (collectionResult?.results || []).map((row) => {
    const productIds = idsByCollection.get(row.id) || [];
    return {
      id: cleanText(row.id, 160), slug: cleanText(row.slug, 180), title: cleanText(row.title, 160),
      description: cleanText(row.description, 2000), visibility: row.visibility, status: row.status,
      displayOrder: Number(row.display_order), revision: Number(row.revision),
      assignedProductCount: productIds.length,
      publicProductCount: productIds.filter((id) => productById.get(id)?.readiness.displayable).length,
      productIds, createdAt: cleanText(row.created_at, 80), updatedAt: cleanText(row.updated_at, 80),
    };
  });
  return { ok: true, databaseConfigured: true, access, collections, products: productPayload.products, updatedAt: collections.reduce((latest, item) => !latest || item.updatedAt > latest ? item.updatedAt : latest, "") || null };
}

export async function collectionOptionsPayload(env, session) {
  const access = session ? await commerceAccessForSession(env, session) : null;
  if (!isCommerceDbConfigured(env)) return { ok: true, databaseConfigured: false, access, collections: [], updatedAt: null };
  const result = await requireCommerceDb(env).prepare(`SELECT id, slug, title, description, visibility, status, display_order, revision, created_at, updated_at
                                                         FROM commerce_collections WHERE status = 'active' ORDER BY display_order, slug, id LIMIT 1000`).all();
  const collections = (result?.results || []).map((row) => serializeCollectionListRow({ ...row, assigned_product_count: 0, public_product_count: 0, thumbnail_url: null }));
  return { ok: true, databaseConfigured: true, access, collections, updatedAt: collections.reduce((latest, item) => !latest || item.updatedAt > latest ? item.updatedAt : latest, "") || null };
}

export async function createCollection(env, session, input) {
  const db = requireCommerceDb(env);
  requireExactFields(input, ["title", "slug", "description", "visibility", "displayOrder"], "commerce_collection_fields_invalid");
  const title = requiredPlainText(input.title, 160, "commerce_collection_title_invalid");
  const slug = collectionSlug(input.slug);
  const description = plainMerchText(input.description, 2000);
  const visibility = collectionVisibility(input.visibility);
  const displayOrder = boundedMerchInteger(input.displayOrder, 0, 999999, "commerce_collection_display_order_invalid");
  const id = `collection-${randomId()}`;
  const timestamp = nowIso();
  try {
    await db.prepare(`INSERT INTO commerce_collections (id, slug, title, description, visibility, status, display_order, revision, created_at, updated_at, updated_by_account_id)
                      VALUES (?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, ?)`)
      .bind(id, slug, title, description, visibility, displayOrder, timestamp, timestamp, session?.accountId || null).run();
  } catch (error) { throwCollectionConflict(error); }
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.collection_created", targetType: "commerce_collection", targetId: id, result: "success", metadata: { slug, visibility, displayOrder } });
  return collectionDetailPayload(env, session, id);
}

export async function updateCollection(env, session, collectionId, input) {
  const db = requireCommerceDb(env); const id = collectionIdValue(collectionId);
  requireExactFields(input, ["title", "description", "visibility", "displayOrder", "revision"], "commerce_collection_fields_invalid");
  const title = requiredPlainText(input.title, 160, "commerce_collection_title_invalid");
  const description = plainMerchText(input.description, 2000);
  const visibility = collectionVisibility(input.visibility);
  const displayOrder = boundedMerchInteger(input.displayOrder, 0, 999999, "commerce_collection_display_order_invalid");
  const revision = boundedMerchInteger(input.revision, 1, Number.MAX_SAFE_INTEGER, "commerce_collection_revision_invalid");
  const timestamp = nowIso();
  try {
    const result = await db.prepare(`UPDATE commerce_collections SET title=?, description=?, visibility=?, display_order=?, revision=revision+1, updated_at=?, updated_by_account_id=?
                                     WHERE id=? AND status='active' AND revision=?`)
      .bind(title, description, visibility, displayOrder, timestamp, session?.accountId || null, id, revision).run();
    if (Number(result?.meta?.changes || 0) !== 1) { await requireCurrentCollection(db, id, revision); throw new AuthFailure(409, "commerce_collection_revision_conflict", "This collection changed in another session. Reload before saving."); }
  } catch (error) { if (error instanceof AuthFailure) throw error; throwCollectionConflict(error); }
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.collection_updated", targetType: "commerce_collection", targetId: id, result: "success", metadata: { visibility, displayOrder, revision } });
  return collectionDetailPayload(env, session, id);
}

export async function updateCollectionOrder(env, session, input) {
  const db = requireCommerceDb(env);
  requireExactFields(input, ["collectionIds"], "commerce_collection_order_fields_invalid");
  const collectionIds = validatedIdentifiers(input.collectionIds, 1000, "commerce_collection_order_invalid");
  const current = await db.prepare("SELECT id FROM commerce_collections WHERE status='active' ORDER BY id").all();
  const currentIds = (current?.results || []).map((row) => row.id).sort();
  if (collectionIds.length !== currentIds.length || [...collectionIds].sort().some((id, index) => id !== currentIds[index])) throw new AuthFailure(400, "commerce_collection_order_incomplete", "Collection order must include every active collection exactly once.");
  const timestamp = nowIso();
  await db.batch(collectionIds.map((id, index) => db.prepare("UPDATE commerce_collections SET display_order=?, revision=revision+1, updated_at=?, updated_by_account_id=? WHERE id=? AND status='active'").bind((index + 1) * 10, timestamp, session?.accountId || null, id)));
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.collections_reordered", targetType: "commerce_collections", result: "success", metadata: { collectionIds } });
  return collectionOptionsPayload(env, session);
}

export async function updateCollectionProducts(env, session, collectionId, input) {
  const db = requireCommerceDb(env); const id = collectionIdValue(collectionId);
  requireExactFields(input, ["productIds", "revision"], "commerce_collection_assignment_fields_invalid");
  const productIds = validatedIdentifiers(input.productIds, 2000, "commerce_collection_products_invalid");
  const revision = boundedMerchInteger(input.revision, 1, Number.MAX_SAFE_INTEGER, "commerce_collection_revision_invalid");
  await requireCurrentCollection(db, id, revision);
  await requireKnownProducts(db, productIds);
  const timestamp = nowIso();
  const statements = [db.prepare("DELETE FROM commerce_product_collections WHERE collection_id=?").bind(id)];
  for (const productId of productIds) statements.push(db.prepare("INSERT INTO commerce_product_collections (product_id, collection_id, assigned_at, assigned_by_account_id) VALUES (?, ?, ?, ?)").bind(productId, id, timestamp, session?.accountId || null));
  statements.push(db.prepare("UPDATE commerce_collections SET revision=revision+1, updated_at=?, updated_by_account_id=? WHERE id=? AND revision=?").bind(timestamp, session?.accountId || null, id, revision));
  await db.batch(statements);
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.collection_products_updated", targetType: "commerce_collection", targetId: id, result: "success", metadata: { productCount: productIds.length, productIds } });
  return collectionDetailPayload(env, session, id);
}

export async function updateProductCollections(env, session, productId, input) {
  const db = requireCommerceDb(env); const id = cleanText(productId, 160);
  requireExactFields(input, ["collectionIds"], "commerce_product_collection_fields_invalid");
  const collectionIds = validatedIdentifiers(input.collectionIds, 200, "commerce_product_collections_invalid");
  if (!await db.prepare("SELECT id FROM commerce_products WHERE id=?").bind(id).first()) throw new AuthFailure(404, "commerce_product_not_found", "The commerce product was not found.");
  if (collectionIds.length) {
    const found = await db.prepare(`SELECT id FROM commerce_collections WHERE status='active' AND id IN (${collectionIds.map(() => "?").join(",")})`).bind(...collectionIds).all();
    if ((found?.results || []).length !== collectionIds.length) throw new AuthFailure(400, "commerce_collection_unknown", "Every collection assignment must reference an active collection.");
  }
  const timestamp = nowIso();
  const statements = [db.prepare("DELETE FROM commerce_product_collections WHERE product_id=?").bind(id)];
  for (const collectionId of collectionIds) statements.push(db.prepare("INSERT INTO commerce_product_collections (product_id, collection_id, assigned_at, assigned_by_account_id) VALUES (?, ?, ?, ?)").bind(id, collectionId, timestamp, session?.accountId || null));
  await db.batch(statements);
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.product_collections_updated", targetType: "commerce_product", targetId: id, result: "success", metadata: { collectionCount: collectionIds.length, collectionIds } });
  return merchandisingProductPayload(env, session, id);
}

export async function archiveCollection(env, session, collectionId, input) {
  const db = requireCommerceDb(env); const id = collectionIdValue(collectionId);
  requireExactFields(input, ["revision", "confirmArchive"], "commerce_collection_archive_fields_invalid");
  if (input.confirmArchive !== true) throw new AuthFailure(400, "commerce_collection_archive_confirmation_required", "Explicit collection archive confirmation is required.");
  const revision = boundedMerchInteger(input.revision, 1, Number.MAX_SAFE_INTEGER, "commerce_collection_revision_invalid");
  const result = await db.prepare("UPDATE commerce_collections SET status='archived', visibility='hidden', revision=revision+1, updated_at=?, updated_by_account_id=? WHERE id=? AND status='active' AND revision=?").bind(nowIso(), session?.accountId || null, id, revision).run();
  if (Number(result?.meta?.changes || 0) !== 1) { await requireCurrentCollection(db, id, revision); throw new AuthFailure(409, "commerce_collection_revision_conflict", "This collection changed in another session. Reload before saving."); }
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.collection_archived", targetType: "commerce_collection", targetId: id, result: "success", metadata: { assignmentsPreserved: true } });
  return { ok: true, collectionId: id, archived: true, assignmentsPreserved: true };
}

export async function deleteCollection(env, session, collectionId, input) {
  const db = requireCommerceDb(env); const id = collectionIdValue(collectionId);
  requireExactFields(input, ["confirmDelete"], "commerce_collection_delete_fields_invalid");
  if (input.confirmDelete !== true) throw new AuthFailure(400, "commerce_collection_delete_confirmation_required", "Explicit collection deletion confirmation is required.");
  const collection = await db.prepare("SELECT id FROM commerce_collections WHERE id=?").bind(id).first();
  if (!collection) throw new AuthFailure(404, "commerce_collection_not_found", "The commerce collection was not found.");
  const assigned = await db.prepare("SELECT COUNT(*) count FROM commerce_product_collections WHERE collection_id=?").bind(id).first();
  if (Number(assigned?.count || 0) > 0) throw new AuthFailure(409, "commerce_collection_not_empty", "Remove every product assignment before deleting this collection.");
  await db.prepare("DELETE FROM commerce_collections WHERE id=?").bind(id).run();
  await writeCommerceAudit(env, { actorAccountId: session?.accountId, action: "commerce.collection_deleted", targetType: "commerce_collection", targetId: id, result: "success", metadata: { assignedProductCount: 0 } });
  return { ok: true, collectionId: id, deleted: true, productsDeleted: 0 };
}

export async function verifyStripeAccount(env, session, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  const correlationId = randomId();
  const current = await db
    .prepare("SELECT id, safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe' LIMIT 1")
    .first();
  if (!current) {
    await writeStripeVerificationAudit(env, session, "missing_configuration", "rejected", { correlationId });
    throw new AuthFailure(503, "stripe_provider_unavailable", "The Stripe provider connection is not configured.");
  }

  if (!isStripeVerificationEnvironment(env)) {
    await writeStripeVerificationAudit(env, session, "missing_configuration", "rejected", { correlationId });
    throw new AuthFailure(503, "stripe_verification_environment_unsupported", "Stripe test verification is unavailable in this environment.");
  }

  const credential = String(env?.STRIPE_SECRET_KEY || "").trim();
  if (!credential) {
    await writeStripeVerificationAudit(env, session, "missing_configuration", "rejected", { correlationId });
    throw new AuthFailure(503, "stripe_credential_unavailable", "The Stripe test credential is not configured.");
  }
  if (!stripeTestCredentialKind(credential)) {
    await writeStripeVerificationAudit(env, session, "missing_configuration", "rejected", { correlationId });
    throw new AuthFailure(503, "stripe_test_credential_required", "A valid Stripe test credential is required in this staging environment.");
  }

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    response = await fetchImpl(STRIPE_ACCOUNT_URL, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential}`,
      },
    });
  } catch {
    await writeStripeVerificationAudit(env, session, "provider_error", "error", { correlationId });
    throw new AuthFailure(502, "stripe_provider_unavailable", "Stripe account verification is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response?.ok) {
    await writeStripeVerificationAudit(env, session, "provider_error", "error", { correlationId, providerStatus: Number(response?.status || 0) });
    throw new AuthFailure(502, "stripe_provider_error", "Stripe rejected the account verification request.");
  }

  let providerAccount;
  try {
    providerAccount = await response.json();
  } catch {
    await writeStripeVerificationAudit(env, session, "provider_error", "error", { correlationId });
    throw new AuthFailure(502, "stripe_provider_response_invalid", "Stripe returned an invalid account verification response.");
  }

  const account = normalizeStripeAccount(providerAccount);
  if (!account) {
    await writeStripeVerificationAudit(env, session, "provider_error", "error", { correlationId });
    throw new AuthFailure(502, "stripe_provider_response_invalid", "Stripe returned an invalid account verification response.");
  }
  if (account.country !== "CA" || account.defaultCurrency !== "cad") {
    await writeStripeVerificationAudit(env, session, "account_mismatch", "rejected", {
      correlationId,
      accountId: account.id,
      country: account.country,
      currency: account.defaultCurrency,
    });
    throw new AuthFailure(409, "stripe_account_mismatch", "The configured Stripe account is not the required Canadian CAD merchant account.");
  }

  const timestamp = nowIso();
  const existingMetadata = safeJson(current.safe_metadata_json, {});
  const safeMetadata = {
    account_display_name: account.displayName || "Third Railify Official",
    account_created: true,
    api_configured: true,
    webhook_configured: existingMetadata.webhook_configured === true,
    checkout_enabled: false,
    live_payments_enabled: false,
    live_payout_readiness: "unverified",
    charges_enabled: account.chargesEnabled,
    payouts_enabled: account.payoutsEnabled,
    details_submitted: account.detailsSubmitted,
    ...(account.type ? { account_type: account.type } : {}),
    ...(Array.isArray(existingMetadata.payment_methods) ? { payment_methods: existingMetadata.payment_methods.slice(0, 12) } : {}),
  };
  let updates;
  try {
    updates = await db.batch([
      db.prepare(
      `UPDATE commerce_provider_connections
       SET integration_mode = 'direct_merchant', credential_custody = 'environment_secret',
           status = 'connected', environment = 'test', external_account_id = ?,
           country_code = 'CA', currency_code = 'cad', safe_metadata_json = ?,
           last_synchronized_at = ?, updated_at = ?
       WHERE provider = 'stripe'`,
      ).bind(account.id, JSON.stringify(safeMetadata), timestamp, timestamp),
      configuredSettingStatement(db, "stripe_api_configured", timestamp, session?.accountId),
    ]);
  } catch {
    await writeStripeVerificationAudit(env, session, "persistence_error", "error", { correlationId, accountId: account.id });
    throw new AuthFailure(503, "stripe_provider_persistence_failed", "The verified Stripe account could not be saved.");
  }
  if (Number(updates?.[0]?.meta?.changes || 0) !== 1 || Number(updates?.[1]?.meta?.changes || 0) !== 1) {
    await writeStripeVerificationAudit(env, session, "persistence_error", "error", { correlationId, accountId: account.id });
    throw new AuthFailure(503, "stripe_provider_persistence_failed", "The verified Stripe account could not be saved.");
  }

  await writeStripeVerificationAudit(env, session, "success", "success", {
    correlationId,
    accountId: account.id,
    country: account.country,
    currency: account.defaultCurrency,
  });
  return commerceOverview(env, session);
}

export async function verifyPrintfulStore(env, session, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  const correlationId = randomId();
  const current = await db
    .prepare("SELECT id, external_account_id, safe_metadata_json FROM commerce_provider_connections WHERE provider = 'printful' LIMIT 1")
    .first();
  if (!current) {
    throw new AuthFailure(503, "printful_provider_unavailable", "The Printful provider connection is not configured.");
  }

  const credential = printfulCredential(env);
  if (!credential) {
    throw new AuthFailure(503, "printful_credential_unavailable", "The store-scoped Printful credential is not configured.");
  }
  const configuredStoreId = configuredPrintfulStoreId(env);

  const storesPayload = await printfulGet(fetchImpl, PRINTFUL_STORES_URL, credential, "stores");
  const store = normalizePrintfulStoreList(storesPayload);
  if (isWixPrintfulStore(store)) {
    throw new AuthFailure(409, "printful_wix_store_rejected", "The configured credential resolves to a Wix-connected Printful store and was rejected.");
  }
  if (normalizeStoreName(store.name) !== normalizeStoreName(PRINTFUL_EXPECTED_STORE_NAME) || store.type !== "native") {
    throw new AuthFailure(409, "printful_store_identity_ambiguous", "The configured credential does not resolve unambiguously to the dedicated Third Railify API store.");
  }

  const persistedStoreId = optionalPrintfulStoreId(current.external_account_id, "printful_persisted_store_invalid");
  if ((configuredStoreId && configuredStoreId !== store.id) || (persistedStoreId && persistedStoreId !== store.id) || (configuredStoreId && !persistedStoreId)) {
    throw new AuthFailure(409, "printful_store_mismatch", "The configured, token-resolved, and persisted Printful Store IDs do not agree.");
  }

  const productsPayload = await printfulGet(fetchImpl, PRINTFUL_PRODUCTS_URL, credential, "products");
  const productProbe = normalizePrintfulProductProbe(productsPayload);
  const scopesPayload = await printfulGet(fetchImpl, PRINTFUL_SCOPES_URL, credential, "scopes");
  const scopes = normalizePrintfulManageScopes(scopesPayload);
  const timestamp = nowIso();
  const existingMetadata = safeJson(current.safe_metadata_json, {});
  const safeMetadata = {
    ...existingMetadata,
    mode: "draft_only",
    order_mode: "draft_only",
    api_active: true,
    api_configured: true,
    credential_configured: true,
    credential_custody: "cloudflare_secret_server_only",
    access_level: "single_store",
    provider_api: "real",
    store_name: store.name,
    store_type: store.type,
    product_count: productProbe.total,
    oauth_scopes: scopes.values,
    product_write_authority: scopes.products,
    file_manage_authority: scopes.files,
    order_manage_authority: scopes.orders,
    webhook_manage_authority: scopes.webhooks,
    webhook_configured: false,
    fulfillment_enabled: false,
    parallel_store_planned: false,
    existing_wix_store_untouched: true,
    last_verified_at: timestamp,
  };
  delete safeMetadata.token;
  delete safeMetadata.authorization;
  delete safeMetadata.raw_response;

  let updates;
  try {
    updates = await db.batch([
      db.prepare(
        `UPDATE commerce_provider_connections
         SET integration_mode = 'fulfillment', credential_custody = 'environment_secret',
             credential_ciphertext = NULL, status = 'connected', environment = 'staging',
             external_account_id = ?, currency_code = 'CAD', safe_metadata_json = ?,
             last_synchronized_at = ?, updated_at = ?
         WHERE provider = 'printful'`,
      ).bind(store.id, JSON.stringify(safeMetadata), timestamp, timestamp),
      safeSettingStatement(db, "printful_api_configured", true, timestamp, session?.accountId),
      safeSettingStatement(db, "printful_order_mode", "draft_only", timestamp, session?.accountId),
    ]);
  } catch {
    throw new AuthFailure(503, "printful_provider_persistence_failed", "The verified Printful store could not be saved.");
  }
  if (updates.some((update) => Number(update?.meta?.changes || 0) !== 1)) {
    throw new AuthFailure(503, "printful_provider_persistence_failed", "The verified Printful store could not be saved.");
  }

  await writeCommerceAudit(env, {
    actorAccountId: session?.accountId,
    action: "printful.store_verified",
    targetType: "commerce_provider_connection",
    targetId: "printful",
    result: "success",
    metadata: {
      provider: "printful",
      storeId: Number(store.id),
      storeName: store.name,
      storeType: store.type,
      productCount: productProbe.total,
      oauthScopes: scopes.values,
      productWriteAuthority: scopes.products,
      fileManageAuthority: scopes.files,
      orderManageAuthority: scopes.orders,
      webhookManageAuthority: scopes.webhooks,
      result: "verified",
      correlationId,
    },
  });
  return commerceOverview(env, session);
}

export async function recordVerifiedStripeWebhookReceipt(env, receipt, orderTransition = null) {
  const db = requireCommerceDb(env);
  const provider = await db.prepare("SELECT id FROM commerce_provider_connections WHERE provider = 'stripe' LIMIT 1").first();
  if (!provider) {
    throw new AuthFailure(503, "stripe_provider_unavailable", "The Stripe provider connection is not configured.");
  }

  const livemode = receipt.livemode === true;
  const environment = livemode ? "live" : "test";
  const webhookSetting = livemode ? "stripe_live_webhook_configured" : "stripe_webhook_configured";
  const metadataPath = livemode ? "$.live_webhook_configured" : "$.webhook_configured";
  const statements = [
    db.prepare(
      `INSERT OR IGNORE INTO commerce_webhook_events (
         provider, provider_event_id, event_type, event_created_at, received_at, livemode,
         api_version, related_object_id, related_object_type, processing_status,
         processed_at, result_code, payload_sha256
       ) VALUES ('stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      receipt.eventId,
      receipt.eventType,
      receipt.eventCreatedAt,
      receipt.receivedAt,
      livemode ? 1 : 0,
      receipt.apiVersion,
      receipt.relatedObjectId,
      receipt.relatedObjectType,
      receipt.processingStatus,
      receipt.receivedAt,
      receipt.resultCode,
      receipt.payloadSha256,
    ),
    db.prepare(
      `UPDATE commerce_provider_connections
       SET safe_metadata_json = json_set(safe_metadata_json, ?, json('true')),
           last_synchronized_at = ?, updated_at = ?
       WHERE provider = 'stripe'`,
    ).bind(metadataPath, receipt.receivedAt, receipt.receivedAt),
    configuredSettingStatement(db, webhookSetting, receipt.receivedAt, null),
  ];
  let transitionIndex = -1;
  let jobIndex = -1;
  if (orderTransition) {
    transitionIndex = statements.length;
    if (orderTransition.failed === true) {
      statements.push(db.prepare(`UPDATE commerce_orders SET payment_status='failed',payment_failed_at=COALESCE(payment_failed_at,?),checkout_failure_code='stripe_payment_failed',updated_at=?
        WHERE id=? AND stripe_checkout_session_id=? AND environment=? AND checkout_status='checkout_created' AND payment_status='pending'`)
        .bind(receipt.receivedAt, receipt.receivedAt, orderTransition.orderId, orderTransition.sessionId, environment));
    } else {
      statements.push(db.prepare(
        `UPDATE commerce_orders
         SET payment_status = 'paid', stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
             customer_gross_amount=?,tax_amount=?,tax_status=?,tax_reason=?,
             fulfillment_status=CASE WHEN environment='live' THEN 'pending' ELSE fulfillment_status END,
             payment_confirmed_at = COALESCE(payment_confirmed_at, ?), updated_at = ?
         WHERE id = ? AND stripe_checkout_session_id = ? AND environment = ?
           AND checkout_status = 'checkout_created' AND payment_status = 'pending'`,
      ).bind(orderTransition.paymentIntentId, orderTransition.amountTotal, orderTransition.taxAmount || 0, orderTransition.taxStatus || "not_calculated", orderTransition.taxStatus === "not_collecting" ? "stripe_tax_not_collecting" : null, receipt.receivedAt, receipt.receivedAt, orderTransition.orderId, orderTransition.sessionId, environment));
      if (environment === "live") {
        jobIndex = statements.length;
        statements.push(db.prepare(`INSERT OR IGNORE INTO commerce_operation_jobs
          (id,job_kind,event_key,order_id,environment,payload_digest,state,next_attempt_at,created_at,updated_at)
          SELECT ?,'fulfillment_submit',?,id,'live',?,'pending',?,?,? FROM commerce_orders
          WHERE id=? AND environment='live' AND payment_status='paid' AND fulfillment_status='pending'`)
          .bind(`coj_${randomId()}`, `${receipt.eventId}:fulfillment`, receipt.payloadSha256, receipt.receivedAt, receipt.receivedAt, receipt.receivedAt, orderTransition.orderId));
        statements.push(db.prepare(`INSERT OR IGNORE INTO commerce_operation_jobs
          (id,job_kind,event_key,order_id,environment,payload_digest,state,next_attempt_at,created_at,updated_at)
          SELECT ?,'email_send',?,id,'live',?,'pending',?,?,? FROM commerce_orders
          WHERE id=? AND environment='live' AND payment_status='paid'
            AND (SELECT value_json FROM commerce_settings WHERE setting_key='transactional_email_enabled')='true'`)
          .bind(`coj_${randomId()}`, `${receipt.eventId}:order_confirmation`, receipt.payloadSha256, receipt.receivedAt, receipt.receivedAt, receipt.receivedAt, orderTransition.orderId));
      }
    }
  }
  let updates;
  try {
    updates = await db.batch(statements);
  } catch {
    throw new AuthFailure(503, "stripe_webhook_storage_unavailable", "Stripe webhook receipt storage is unavailable.");
  }
  if (Number(updates?.[1]?.meta?.changes || 0) !== 1 || Number(updates?.[2]?.meta?.changes || 0) !== 1) {
    throw new AuthFailure(503, "stripe_webhook_storage_unavailable", "Stripe webhook receipt storage is unavailable.");
  }
  return {
    duplicate: Number(updates?.[0]?.meta?.changes || 0) === 0,
    orderTransitioned: transitionIndex >= 0 ? Number(updates?.[transitionIndex]?.meta?.changes || 0) === 1 : false,
    jobEnqueued: jobIndex >= 0 ? Number(updates?.[jobIndex]?.meta?.changes || 0) === 1 : false,
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
  const maskedValues = {};
  if (hasValidEncryptionKeyShape(env) && profile?.private_phone_ciphertext) {
    maskedValues.privatePhone = maskPrivateValue(await decryptCommerceSecret(env, profile.private_phone_ciphertext, "business:private-phone"));
  }
  if (hasValidEncryptionKeyShape(env) && profile?.business_registration_number_ciphertext) {
    maskedValues.businessRegistrationNumber = maskPrivateValue(await decryptCommerceSecret(env, profile.business_registration_number_ciphertext, "business:registration-number"));
  }
  return {
    ok: true,
    databaseConfigured: true,
    encryptionConfigured: hasValidEncryptionKeyShape(env),
    access,
    profile: businessProjection(profile || defaultBusinessProfile(), taxResult?.results || [], maskedValues),
  };
}

export async function updateBusinessProfile(env, session, input) {
  const db = requireCommerceDb(env);
  await importEncryptionKey(env);
  const current = await db.prepare("SELECT * FROM commerce_business_profiles WHERE id = 'primary'").first();
  const values = validateBusinessProfile(input, current || defaultBusinessProfile());
  if (current && values.revision !== Number(current.revision)) {
    throw new AuthFailure(409, "business_profile_revision_conflict", "This business profile changed in another session. Reload before saving.");
  }
  const timestamp = nowIso();
  const legalCiphertext = values.legalBusinessName
    ? await encryptCommerceSecret(env, values.legalBusinessName, "business:legal-name")
    : current?.legal_business_name_ciphertext || null;
  const privateAddressCiphertext = values.privateAddress
    ? await encryptCommerceSecret(env, JSON.stringify(values.privateAddress), "business:private-address")
    : current?.private_address_ciphertext || null;
  const privatePhoneCiphertext = values.privatePhone
    ? await encryptCommerceSecret(env, values.privatePhone, "business:private-phone")
    : current?.private_phone_ciphertext || null;
  const businessRegistrationNumberCiphertext = values.businessRegistrationNumber
    ? await encryptCommerceSecret(env, values.businessRegistrationNumber, "business:registration-number")
    : current?.business_registration_number_ciphertext || null;

  await db
    .prepare(
      `INSERT INTO commerce_business_profiles (
         id, trading_name, legal_business_name_ciphertext, country_code, province_code, currency_code,
         public_address_json, private_address_ciphertext, public_contact_email, support_email,
         public_phone, website_url, invoice_prefix, document_footer, tax_provider_state,
         invoice_accent_color, receipt_accent_color, private_phone_ciphertext,
         business_registration_number_ciphertext, revision,
         created_at, updated_at, updated_by_account_id
       ) VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
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
         private_phone_ciphertext = excluded.private_phone_ciphertext,
         business_registration_number_ciphertext = excluded.business_registration_number_ciphertext,
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
      privatePhoneCiphertext,
      businessRegistrationNumberCiphertext,
      current?.created_at || timestamp,
      timestamp,
      session.accountId,
    )
    .run();

  await writeCommerceAudit(env, {
    actorAccountId: session.accountId,
    action: "business_profile_updated",
    targetType: "commerce_business_profile",
    targetId: "primary",
    result: "success",
    metadata: { changedFields: values.changedFieldNames },
  });
  return businessProfilePayload(env, session);
}

export async function templatesPayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  if (!isCommerceDbConfigured(env)) {
    return { ok: true, databaseConfigured: false, access, templates: TEMPLATE_BLUEPRINTS.map((template) => ({ ...template, validity: validTemplateReadState() })) };
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
  const current = await db.prepare("SELECT revision FROM commerce_templates WHERE template_key=?").bind(template.templateKey).first();
  const revision = Number(input?.revision);
  if (current && (!Number.isSafeInteger(revision) || revision !== Number(current.revision))) throw new AuthFailure(409, "template_revision_conflict", "This template changed after you opened it. Reload the latest version before saving.");
  const timestamp = nowIso();
  const id = `template-${template.templateKey.replaceAll("_", "-")}`;
  const updated = await db
    .prepare(
      `INSERT INTO commerce_templates (
         id, template_key, template_kind, display_name, subject, preheader, heading, introduction, body_blocks_json,
         cta_label, cta_url, support_text, footer, accent_color, status, revision, enabled,
         created_at, updated_at, updated_by_account_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(template_key) DO UPDATE SET
         template_kind = excluded.template_kind,
         display_name = excluded.display_name,
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
         enabled = excluded.enabled,
         revision = commerce_templates.revision + 1,
         updated_at = excluded.updated_at,
          updated_by_account_id = excluded.updated_by_account_id
        WHERE commerce_templates.revision = ?`,
    )
    .bind(
      id,
      template.templateKey,
      template.templateKind,
      template.displayName,
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
      template.enabled ? 1 : 0,
      timestamp,
      timestamp,
      session.accountId,
      revision,
    )
    .run();
  if (Number(updated?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "template_revision_conflict", "This template changed after you opened it. Reload the latest version before saving.");
  const action = template.templateKey === "payment_receipt" ? "receipt_template_updated" : template.templateKey === "invoice_document" ? "invoice_template_updated" : "customer_email_template_updated";
  await writeCommerceAudit(env, {
    actorAccountId: session.accountId,
    action,
    targetType: "commerce_template",
    targetId: template.templateKey,
    result: "success",
    metadata: { templateKind: template.templateKind, status: template.status, enabled: template.enabled, revision: revision + 1, revisionSource: "admin" },
  });
  return templatesPayload(env, session);
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

export function browserSafeBusinessProjection(profile) {
  const businessAddress = safeJson(profile?.public_address_json ?? profile?.businessAddress ?? profile?.publicAddress, {});
  const businessPhone = String(profile?.public_phone ?? profile?.businessPhone ?? profile?.publicPhone ?? "");
  return {
    tradingName: cleanText(profile?.trading_name ?? profile?.tradingName, 160),
    countryCode: cleanText(profile?.country_code ?? profile?.countryCode, 2),
    provinceCode: cleanText(profile?.province_code ?? profile?.provinceCode, 3),
    currencyCode: cleanText(profile?.currency_code ?? profile?.currencyCode, 3),
    businessAddress,
    businessPhone,
    // Compatibility aliases for existing authenticated Admin consumers. These
    // names do not grant or imply general-Public projection.
    publicAddress: businessAddress,
    publicContactEmail: cleanText(profile?.public_contact_email ?? profile?.publicContactEmail, 254),
    supportEmail: cleanText(profile?.support_email ?? profile?.supportEmail, 254),
    publicPhone: businessPhone,
    websiteUrl: cleanText(profile?.website_url ?? profile?.websiteUrl, 500),
    invoicePrefix: cleanText(profile?.invoice_prefix ?? profile?.invoicePrefix, 24),
    documentFooter: cleanText(profile?.document_footer ?? profile?.documentFooter, 1000),
    taxProviderState: cleanText(profile?.tax_provider_state ?? profile?.taxProviderState, 40) || "unavailable",
    invoiceAccentColor: safeAccentColor(profile?.invoice_accent_color ?? profile?.invoiceAccentColor),
    receiptAccentColor: safeAccentColor(profile?.receipt_accent_color ?? profile?.receiptAccentColor),
    revision: Number(profile?.revision || 1),
    updatedAt: cleanText(profile?.updated_at ?? profile?.updatedAt, 80) || null,
  };
}

export const publicBusinessProjection = browserSafeBusinessProjection;

export function businessProjection(profile, registrations = [], maskedValues = {}) {
  return {
    ...browserSafeBusinessProjection(profile),
    private: {
      legalBusinessNameStored: Boolean(profile?.legal_business_name_ciphertext),
      privateAddressStored: Boolean(profile?.private_address_ciphertext),
      privatePhoneStored: Boolean(profile?.private_phone_ciphertext),
      businessRegistrationNumberStored: Boolean(profile?.business_registration_number_ciphertext),
      legalBusinessNameMasked: profile?.legal_business_name_ciphertext ? "Encrypted value configured" : "",
      privateAddressMasked: profile?.private_address_ciphertext ? "Encrypted address configured" : "",
      privatePhoneMasked: cleanText(maskedValues.privatePhone, 80) || (profile?.private_phone_ciphertext ? "••••" : ""),
      businessRegistrationNumberMasked: cleanText(maskedValues.businessRegistrationNumber, 100) || (profile?.business_registration_number_ciphertext ? "••••" : ""),
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
  const blueprint = TEMPLATE_BLUEPRINTS.find((item) => item.templateKey === templateKey);
  if (!blueprint) throw new AuthFailure(400, "template_key_invalid", "The template type is invalid.");
  const allowed = new Set(["templateKey", "templateKind", "displayName", "subject", "preheader", "heading", "introduction", "bodyBlocks", "ctaLabel", "ctaUrl", "supportText", "footer", "accentColor", "status", "enabled", "revision"]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !allowed.has(key))) throw new AuthFailure(400, "template_fields_invalid", "The template fields are invalid.");
  const template = {
    templateKey,
    templateKind: blueprint.templateKind,
    displayName: plainTemplateText(raw?.displayName ?? blueprint.displayName, 120, true),
    subject: headerTemplateText(raw?.subject, 160, true, "subject"),
    preheader: headerTemplateText(raw?.preheader, 200, false, "preheader"),
    heading: plainTemplateText(raw?.heading, 160, true),
    introduction: plainTemplateText(raw?.introduction, 1000),
    bodyBlocks: Array.isArray(raw?.bodyBlocks) ? raw.bodyBlocks.slice(0, 8).map((value) => plainTemplateText(value, 1000, true)) : [],
    ctaLabel: plainTemplateText(raw?.ctaLabel, 80),
    ctaUrl: validateCtaUrl(raw?.ctaUrl),
    supportText: plainTemplateText(raw?.supportText, 500),
    footer: plainTemplateText(raw?.footer, 1000),
    accentColor: /^#[0-9a-f]{6}$/i.test(String(raw?.accentColor || "")) ? String(raw.accentColor).toLowerCase() : "#f3c928",
    status: ["draft", "disabled", "ready"].includes(raw?.status) ? raw.status : "draft",
    enabled: raw?.enabled === true && raw?.status !== "disabled",
  };
  if (template.ctaLabel && !template.ctaUrl) throw new AuthFailure(400, "template_cta_invalid", "A CTA label requires a safe HTTPS or relative URL.");
  validateTemplateVariables(template);
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

function normalizeStripeAccount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = cleanText(value.id, 160);
  if (!/^acct_[A-Za-z0-9]+$/.test(id)) return null;
  const country = cleanText(value.country, 2).toUpperCase();
  const defaultCurrency = cleanText(value.default_currency, 3).toLowerCase();
  const displayName = cleanText(value.business_profile?.name || value.settings?.dashboard?.display_name, 160);
  const type = cleanText(value.type, 40).toLowerCase();
  return {
    id,
    country,
    defaultCurrency,
    displayName,
    chargesEnabled: value.charges_enabled === true,
    payoutsEnabled: value.payouts_enabled === true,
    detailsSubmitted: value.details_submitted === true,
    type: ["standard", "express", "custom"].includes(type) ? type : "",
  };
}

function printfulCredential(env) {
  const credential = String(env?.PRINTFUL_API_TOKEN || "").trim();
  if (!credential || credential.length > MAX_PRINTFUL_CREDENTIAL_LENGTH || /[\u0000-\u001F\u007F]/.test(credential)) return "";
  return credential;
}

function safeConfiguredStoreId(value) {
  const raw = String(value ?? "").trim();
  return /^[1-9]\d{0,19}$/.test(raw) ? raw : null;
}

function configuredPrintfulStoreId(env) {
  const raw = String(env?.PRINTFUL_STORE_ID ?? "").trim();
  if (!raw) return null;
  return requiredPrintfulStoreId(raw, "printful_store_configuration_invalid");
}

function optionalPrintfulStoreId(value, errorCode) {
  const raw = String(value ?? "").trim();
  return raw ? requiredPrintfulStoreId(raw, errorCode) : null;
}

function requiredPrintfulStoreId(value, errorCode) {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : String(value || "").trim();
  if (!/^[1-9]\d{0,14}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new AuthFailure(409, errorCode, "The Printful Store ID is invalid.");
  }
  return raw;
}

async function printfulGet(fetchImpl, url, credential, resource) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential}`,
      },
    });
  } catch {
    throw new AuthFailure(502, "printful_provider_unavailable", "Printful verification is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) {
    throw new AuthFailure(502, "printful_provider_error", "Printful rejected the read-only verification request.");
  }
  try {
    return await response.json();
  } catch {
    throw new AuthFailure(502, `printful_${resource}_response_invalid`, "Printful returned an invalid verification response.");
  }
}

function normalizePrintfulStoreList(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.code !== 200 || !Array.isArray(value.result)) {
    throw new AuthFailure(502, "printful_stores_response_invalid", "Printful returned an invalid store response.");
  }
  const total = Number(value.paging?.total);
  if (!Number.isSafeInteger(total) || total !== 1 || value.result.length !== 1) {
    throw new AuthFailure(409, value.result.length > 1 || total > 1 ? "printful_store_scope_invalid" : "printful_store_unavailable", "The Printful credential must resolve to exactly one authorized store.");
  }
  const raw = value.result[0];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AuthFailure(502, "printful_stores_response_invalid", "Printful returned an invalid store response.");
  }
  const id = requiredPrintfulStoreId(raw.id, "printful_stores_response_invalid");
  const name = cleanText(raw.name, 160);
  const type = cleanText(raw.type, 40).toLowerCase();
  if (!name || !type) {
    throw new AuthFailure(502, "printful_stores_response_invalid", "Printful returned an invalid store response.");
  }
  return { id, name, type };
}

function normalizePrintfulProductProbe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.code !== 200 || !Array.isArray(value.result)) {
    throw new AuthFailure(502, "printful_products_response_invalid", "Printful returned an invalid product response.");
  }
  const total = Number(value.paging?.total);
  if (!Number.isSafeInteger(total) || total < 0 || value.result.length > 1 || total < value.result.length) {
    throw new AuthFailure(502, "printful_products_response_invalid", "Printful returned an invalid product response.");
  }
  return { total };
}

function normalizePrintfulManageScopes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.data)) {
    throw new AuthFailure(502, "printful_scopes_response_invalid", "Printful returned an invalid OAuth scope response.");
  }
  const values = value.data.map((scope) => cleanText(scope?.value, 160).toLowerCase()).filter(Boolean).sort();
  if (!values.length || new Set(values).size !== values.length) {
    throw new AuthFailure(502, "printful_scopes_response_invalid", "Printful returned missing or duplicate OAuth scopes.");
  }
  const includesWrite = (names, prefix) => values.some((scope) => names.includes(scope) || (scope.startsWith(`${prefix}/`) && scope.endsWith("/write")));
  const authority = {
    values,
    products: includesWrite(["sync_products", "sync_products/write", "products", "products/write"], "sync_products") || includesWrite(["products", "products/write"], "products"),
    files: includesWrite(["files", "files/write", "file_library", "file_library/write"], "files"),
    orders: includesWrite(["orders", "orders/write"], "orders"),
    webhooks: includesWrite(["webhooks", "webhooks/write"], "webhooks"),
  };
  if (!authority.products) throw new AuthFailure(409, "printful_product_write_scope_missing", "The permanent Printful token lacks Sync Product write authority.");
  if (!authority.files || !authority.orders || !authority.webhooks) throw new AuthFailure(409, "printful_expected_manage_scopes_missing", "The permanent Printful token does not expose all expected file, order, and webhook manage scopes.");
  return authority;
}

function normalizeStoreName(value) {
  return cleanText(value, 160).toLocaleLowerCase("en").replace(/\s+/g, " ");
}

function isWixPrintfulStore(store) {
  return /wix/i.test(store.type) || /\bwix\b/i.test(store.name);
}

async function writeStripeVerificationAudit(env, session, resultCategory, result, safe = {}) {
  await writeCommerceAudit(env, {
    actorAccountId: session?.accountId,
    action: result === "success" ? "stripe.account_verified" : "stripe.account_verification_failed",
    targetType: "commerce_provider_connection",
    targetId: "stripe",
    result,
    metadata: {
      provider: "stripe",
      environment: "test",
      result: resultCategory,
      ...safe,
    },
  });
}

function templateBlueprint(templateKey, subject, heading, introduction, templateKind = "email", displayName = "", enabled = false) {
  return Object.freeze({
    templateKey,
    templateKind,
    displayName: displayName || templateKey.replaceAll("_", " "),
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
    enabled,
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
    private_phone_ciphertext: null,
    business_registration_number_ciphertext: null,
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

function serializeProviderConnection(row, env, settings = {}) {
  const blueprint = PROVIDER_BLUEPRINTS.find((item) => item.provider === row.provider);
  const rawMetadata = safeJson(row.safe_metadata_json, {});
  const metadata = {
    accountDisplayName: cleanText(rawMetadata.account_display_name, 160) || undefined,
    paymentMethods: Array.isArray(rawMetadata.payment_methods) ? rawMetadata.payment_methods.map((value) => cleanText(value, 40)).filter(Boolean).slice(0, 12) : undefined,
    chargesEnabled: rawMetadata.charges_enabled === true,
    payoutsEnabled: rawMetadata.payouts_enabled === true,
    detailsSubmitted: rawMetadata.details_submitted === true,
    accountType: cleanText(rawMetadata.account_type, 40) || undefined,
    storeName: cleanText(rawMetadata.store_name, 160) || undefined,
    storeType: cleanText(rawMetadata.store_type, 40) || undefined,
    productCount: Number.isSafeInteger(Number(rawMetadata.product_count)) && Number(rawMetadata.product_count) >= 0 ? Number(rawMetadata.product_count) : undefined,
    credentialConfigured: rawMetadata.credential_configured === true,
    accessLevel: cleanText(rawMetadata.access_level, 40) || undefined,
    orderMode: cleanText(rawMetadata.order_mode || rawMetadata.mode, 40) || undefined,
    fulfillmentEnabled: rawMetadata.fulfillment_enabled === true,
    existingWixStoreUntouched: rawMetadata.existing_wix_store_untouched === true,
    providerApi: cleanText(rawMetadata.provider_api, 40) || undefined,
  };
  const providerApiConfigured = row.provider === "stripe"
    ? rawMetadata.api_configured === true && settings.stripe_api_configured === true
    : row.provider === "printful"
      ? rawMetadata.api_configured === true && settings.printful_api_configured === true
      : rawMetadata.api_configured === true;
  const providerWebhookConfigured = row.provider === "stripe"
    ? rawMetadata.webhook_configured === true && settings.stripe_webhook_configured === true
    : rawMetadata.webhook_configured === true;
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
    apiConfigured: providerApiConfigured,
    webhookEndpointReady: row.provider === "stripe",
    webhookSigningConfigured: row.provider === "stripe" && isStripeWebhookSigningConfigured(env),
    webhookConfigured: providerWebhookConfigured,
    checkoutEnabled: rawMetadata.checkout_enabled === true,
    livePaymentsEnabled: rawMetadata.live_payments_enabled === true,
    livePayoutReadiness: cleanText(rawMetadata.live_payout_readiness, 40) || "unverified",
    metadata,
    lastSynchronizedAt: cleanText(row.last_synchronized_at, 80) || null,
  };
}

function configuredSettingStatement(db, settingKey, timestamp, accountId) {
  return safeSettingStatement(db, settingKey, true, timestamp, accountId);
}

function safeSettingStatement(db, settingKey, value, timestamp, accountId) {
  return db.prepare(
    `INSERT INTO commerce_settings (setting_key, value_json, classification, updated_at, updated_by_account_id)
     VALUES (?, ?, 'safe', ?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET
       value_json = excluded.value_json,
       classification = 'safe',
       updated_at = excluded.updated_at,
       updated_by_account_id = excluded.updated_by_account_id`,
  ).bind(settingKey, JSON.stringify(value), timestamp, cleanText(accountId, 160) || null);
}

function providerBlueprints(env) {
  return PROVIDER_BLUEPRINTS.map((provider) => {
    if (provider.provider === "stripe") return { ...provider, webhookSigningConfigured: isStripeWebhookSigningConfigured(env) };
    if (provider.provider === "printful") return { ...provider, metadata: { ...provider.metadata, credentialConfigured: isPrintfulCredentialConfigured(env) } };
    return provider;
  });
}

function serializeTemplate(row) {
  const stored = {
    templateKey: row.template_key,
    templateKind: row.template_kind || "email",
    displayName: row.display_name || String(row.template_key || "").replaceAll("_", " "),
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
    enabled: row.enabled === 1,
    revision: Number(row.revision || 1),
  };
  try {
    return { ...validateTemplate(stored), revision: stored.revision, validity: validTemplateReadState() };
  } catch (error) {
    const templateKey = cleanText(row?.template_key, 60);
    const blueprint = TEMPLATE_BLUEPRINTS.find((item) => item.templateKey === templateKey);
    const displayName = safeStoredTemplateLabel(row?.display_name, templateKey);
    return {
      templateKey,
      templateKind: blueprint?.templateKind || (row?.template_kind === "document" ? "document" : "email"),
      displayName,
      subject: "",
      preheader: "",
      heading: "",
      introduction: "",
      bodyBlocks: [],
      ctaLabel: "",
      ctaUrl: "",
      supportText: "",
      footer: "",
      accentColor: "#f3c928",
      status: "disabled",
      enabled: false,
      revision: Number.isSafeInteger(stored.revision) && stored.revision >= 1 ? stored.revision : 1,
      validity: {
        state: "invalid",
        action: "action_required",
        code: error instanceof AuthFailure ? error.code : "template_storage_invalid",
        message: "Persisted template fields require review before this template can be previewed or enabled.",
      },
    };
  }
}

function validTemplateReadState() {
  return { state: "valid", action: "none", code: null, message: null };
}

function safeStoredTemplateLabel(value, templateKey) {
  const label = cleanText(value, 120);
  if (label && !/[\u0000-\u001f\u007f]/.test(label) && !/<\/?[a-z][^>]*>|javascript\s*:|on[a-z]+\s*=/i.test(label)) return label;
  return cleanText(templateKey, 60).replaceAll("_", " ") || "Invalid commerce template";
}

function serializeMerchandisingProduct(row, variants = [], collections = []) {
  const metadata = safeJson(row.safe_metadata_json, {});
  const primaryImageUrl = validateStoredHttpsUrl(metadata.publicImage || metadata.public_image);
  const additionalImages = safeStoredStringArray(metadata.publicImages, []);
  const categories = collections.length ? collections.map((collection) => collection.title) : safeStoredStringArray(metadata.categories, []);
  const tags = safeStoredStringArray(metadata.tags, []);
  const prices = variants.map((variant) => variant.unitAmount).filter(Number.isSafeInteger);
  if (!prices.length && Number.isSafeInteger(Number(row.unit_amount))) prices.push(Number(row.unit_amount));
  const minimum = prices.length ? Math.min(...prices) : null;
  const maximum = prices.length ? Math.max(...prices) : null;
  const hasImage = Boolean(primaryImageUrl) || metadata.public_image_captured === true;
  const hasPrice = minimum !== null || metadata.public_price_captured === true;
  const imageProvenance = metadata.imageAuthority?.kind === "editorial_override" ? "editorial_override"
    : metadata.imageAuthority?.kind === "current_provider" || metadata.providerCatalogue?.imageProvenance === "current_printful_customer_safe" || metadata.providerCatalogue?.imageProvenance === "printful_sync_product_and_catalogue_mockups" ? "current_provider"
      : primaryImageUrl ? "legacy" : "missing";
  const imageReview = row.provider_presence === "current" && !primaryImageUrl;
  const activeVariants = variants.filter((variant) => variant.status === "active" && variant.visibility === "public");
  const sellableVariants = activeVariants.filter((variant) => variant.sellable && variant.availability === "active");
  return {
    id: cleanText(row.id, 160),
    slug: cleanText(row.slug, 180),
    title: cleanText(row.title, 240),
    description: cleanText(metadata.description, 12000),
    primaryImageUrl,
    additionalImages,
    categories,
    collectionIds: collections.map((collection) => collection.id),
    tags,
    status: cleanText(row.status, 40),
    visibility: cleanText(row.visibility, 20),
    currencyCode: String(row.currency_code || "").toUpperCase(),
    unitAmount: Number.isSafeInteger(Number(row.unit_amount)) ? Number(row.unit_amount) : null,
    price: { minimum, maximum, label: minimum === null ? "Unavailable" : minimum === maximum ? formatCadMinor(minimum) : `${formatCadMinor(minimum)}–${formatCadMinor(maximum)}` },
    maxQuantity: Number(row.max_checkout_quantity || 20),
    requiresShipping: row.requires_shipping === 1,
    featured: row.is_featured === 1,
    featuredOrder: row.is_featured === 1 && Number.isInteger(Number(row.featured_order)) ? Number(row.featured_order) : null,
    displayOrder: Number.isSafeInteger(Number(metadata.displayOrder)) ? Number(metadata.displayOrder) : Number(row.featured_order || 1000),
    migrationStatus: cleanText(row.migration_status, 40),
    sourceProvider: cleanText(row.source_provider, 40),
    integration: {
      targetPrintfulProductId: cleanText(row.target_printful_product_id, 240) || null,
      legacyPrintfulSourceProductId: cleanText(row.legacy_printful_source_product_id, 240) || null,
      legacyWixExternalProductId: cleanText(row.legacy_wix_external_product_id, 240) || null,
    },
    provider: {
      storeId: cleanText(row.provider_store_id, 40) || null,
      presence: cleanText(row.provider_presence, 40) || "legacy",
      reconciliationStatus: cleanText(row.provider_reconciliation_status, 40) || "legacy",
      lastSeenAt: cleanText(row.provider_last_seen_at, 80) || null,
      reconciledAt: cleanText(row.provider_reconciled_at, 80) || null,
      snapshotFingerprint: cleanText(row.provider_snapshot_hash, 64) || null,
      archivedAt: cleanText(row.archived_at, 80) || null,
      archivedReason: cleanText(row.archived_reason, 160) || null,
    },
    variantCount: variants.length,
    activeVariantCount: activeVariants.length,
    sellableVariantCount: sellableVariants.length,
    readiness: { displayable: row.status === "active" && row.visibility === "public" && hasImage && hasPrice, checkout: sellableVariants.length > 0, fulfillment: fulfillmentReadiness(variants) },
    variants,
    displayData: { hasImage, hasPrice, ready: hasImage && hasPrice, imageProvenance, imageReview },
    updatedAt: cleanText(row.updated_at, 80),
  };
}

function serializeMerchandisingVariant(row) {
  const options = safeJson(row.option_values_json, {});
  const metadata = safeJson(row.safe_metadata_json, {});
  const size = cleanText(row.size_label, 120) || null;
  const color = cleanText(row.color_label, 120) || null;
  return {
    id: cleanText(row.id, 160), productId: cleanText(row.product_id, 160), localVariantKey: cleanText(row.local_variant_key, 180),
    displayLabel: cleanText(metadata.displayLabel, 240) || [size, color].filter(Boolean).join(" / ") || "Standard",
    status: cleanText(row.status, 40), visibility: cleanText(row.visibility, 20), sellable: row.is_sellable === 1,
    availability: cleanText(row.availability_status, 40), unitAmount: Number(row.unit_amount), currencyCode: String(row.currency_code || "").toUpperCase(),
    sku: cleanText(row.sku, 240) || null, size, color, options,
    fulfillmentProvider: cleanText(row.fulfillment_provider, 40), fulfillmentMappingStatus: cleanText(row.fulfillment_mapping_status, 40), migrationStatus: cleanText(row.migration_status, 40),
    integration: {
      targetPrintfulProductId: cleanText(row.target_printful_product_id, 240) || null,
      targetPrintfulVariantId: cleanText(row.target_printful_sync_variant_id, 240) || null,
      targetCatalogueProductId: cleanText(row.target_catalogue_product_id, 240) || null,
      targetCatalogueVariantId: cleanText(row.target_catalogue_variant_id, 240) || null,
      legacySourceProductId: cleanText(row.legacy_source_product_id, 240) || null,
      legacySourceVariantId: cleanText(row.legacy_source_variant_id, 240) || null,
      legacyWixProductId: cleanText(row.legacy_wix_external_product_id, 240) || null,
      legacyWixVariantId: cleanText(row.legacy_wix_external_variant_id, 240) || null,
    },
    provider: { storeId: cleanText(row.provider_store_id, 40) || null, presence: cleanText(row.provider_presence, 40) || "legacy", lastSeenAt: cleanText(row.provider_last_seen_at, 80) || null, reconciledAt: cleanText(row.provider_reconciled_at, 80) || null, snapshotFingerprint: cleanText(row.provider_snapshot_hash, 64) || null, archivedAt: cleanText(row.archived_at, 80) || null },
    updatedAt: cleanText(row.updated_at, 80),
  };
}

function fulfillmentReadiness(variants) { if (variants.some((variant) => variant.migrationStatus === "blocked" || variant.fulfillmentMappingStatus === "conflict")) return "blocked"; if (variants.length && variants.every((variant) => variant.fulfillmentMappingStatus === "mapped")) return "mapped"; return "pending"; }
function formatCadMinor(value) { return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(value / 100); }
function normalizeProductListOptions(input = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const pageValue = Number.parseInt(String(value.page ?? "1"), 10);
  const pageSizeValue = Number.parseInt(String(value.pageSize ?? "20"), 10);
  const choice = (candidate, allowed, fallback) => allowed.includes(candidate) ? candidate : fallback;
  return {
    page: Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1,
    pageSize: PRODUCT_PAGE_SIZES.includes(pageSizeValue) ? pageSizeValue : 20,
    query: cleanText(value.query ?? value.search, 200).toLowerCase(),
    visibility: choice(cleanText(value.visibility, 40), ["all", "public", "private"], "all"),
    status: choice(cleanText(value.status, 40), ["all", "active", "disabled", "pending", "restricted", "error", "legacy_production"], "all"),
    migration: cleanText(value.migration, 80) || "all",
    category: cleanText(value.category, 160) || "all",
    featured: choice(cleanText(value.featured, 40), ["all", "featured", "not_featured"], "all"),
    catalogue: choice(cleanText(value.catalogue, 40), ["current", "all", "archived", "provider_missing", "wrong_store", "needs_review"], "current"),
    sort: choice(cleanText(value.sort, 40), ["display", "name", "price"], "display"),
  };
}
function filterMerchandisingProducts(products, options) {
  const hasCurrentAuthority = products.some((product) => product.provider.presence === "current");
  const next = products.filter((product) => {
    const searchable = `${product.title} ${product.slug} ${product.categories.join(" ")} ${product.tags.join(" ")}`.toLowerCase();
    return (!options.query || searchable.includes(options.query))
      && (options.visibility === "all" || product.visibility === options.visibility)
      && (options.status === "all" || product.status === options.status)
      && (options.migration === "all" || product.migrationStatus === options.migration)
      && (options.category === "all" || product.categories.includes(options.category))
      && (options.featured === "all" || (options.featured === "featured" ? product.featured : !product.featured))
      && (!hasCurrentAuthority || options.catalogue === "all"
        || (options.catalogue === "current" && product.provider.presence === "current")
        || (options.catalogue === "archived" && (product.provider.presence !== "current" || Boolean(product.provider.archivedAt)))
        || (options.catalogue === "provider_missing" && product.provider.presence === "provider_missing")
        || (options.catalogue === "wrong_store" && product.provider.presence === "wrong_store")
        || (options.catalogue === "needs_review" && ["needs_review", "ambiguous"].includes(product.provider.reconciliationStatus)));
  });
  next.sort(options.sort === "name"
    ? (a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug)
    : options.sort === "price"
      ? (a, b) => (a.price.minimum ?? Infinity) - (b.price.minimum ?? Infinity) || a.slug.localeCompare(b.slug)
      : (a, b) => Number(b.featured) - Number(a.featured) || (a.featuredOrder ?? Infinity) - (b.featuredOrder ?? Infinity) || a.displayOrder - b.displayOrder || a.slug.localeCompare(b.slug));
  return next;
}
function normalizeProductVisibility(value) { return ["private", "public"].includes(value) ? value : invalidMerch("commerce_product_visibility_invalid", "Product visibility is invalid."); }
function normalizeProductFeatured(value) { return value === true ? 1 : value === false ? 0 : invalidMerch("commerce_product_featured_invalid", "Featured state is invalid."); }
async function requireCurrentProviderProductWhenReconciled(db, product) { const current = await db.prepare("SELECT 1 current FROM commerce_products WHERE provider_presence='current' LIMIT 1").first(); if (current && product.provider_presence !== "current") throw new AuthFailure(409, "commerce_product_provider_inactive", "This archived or provider-missing product is not eligible for storefront curation."); }
async function requireFeaturedProductCurrent(db, product) {
  const authority = await db.prepare("SELECT 1 current FROM commerce_products WHERE provider_presence='current' LIMIT 1").first();
  if (!authority) {
    if (!["active", "legacy_production"].includes(product.status)) throw new AuthFailure(409, "commerce_product_not_current", "Only an active legacy product can be Featured before provider reconciliation.");
    return;
  }
  if (product.provider_presence !== "current") {
    if (product.provider_presence === "provider_missing") throw new AuthFailure(409, "provider_missing", "This product is missing from the current provider store and cannot be Featured.");
    if (product.provider_presence === "wrong_store") throw new AuthFailure(409, "wrong_store", "This product belongs to the wrong provider store and cannot be Featured.");
    if (product.provider_reconciliation_status === "archived" || product.archived_at) throw new AuthFailure(409, "archived_product", "Archived products cannot be Featured.");
    throw new AuthFailure(409, "commerce_product_not_current", "Only a current provider product can be Featured.");
  }
  if (product.provider_reconciliation_status === "ambiguous") throw new AuthFailure(409, "ambiguous_product", "This product has ambiguous provider identity and cannot be Featured.");
  if (product.provider_reconciliation_status !== "current") throw new AuthFailure(409, "product_not_current", "This product requires provider review before it can be Featured.");
}
function requireExactFields(input, allowed, code) { if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in input))) throw new AuthFailure(400, code, "The merchandising mutation fields are invalid."); }
function requiredPlainText(value, maximum, code) { const text = plainMerchText(value, maximum); if (!text) throw new AuthFailure(400, code, "A required merchandising value is invalid."); return text; }
function plainMerchText(value, maximum) { const text = cleanText(value, maximum); return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""); }
function boundedMerchInteger(value, minimum, maximum, code) { const number = Number(value); if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new AuthFailure(400, code, "A bounded integer merchandising value is invalid."); return number; }
function invalidMerch(code, message) { throw new AuthFailure(400, code, message); }
function validateMerchandisingUrl(value) { const text = plainMerchText(value, 4096); if (!text) return null; try { const url = new URL(text); if (url.protocol !== "https:" || url.username || url.password) throw new Error(); return url.href; } catch { throw new AuthFailure(400, "commerce_product_image_invalid", "Product images must use safe HTTPS URLs."); } }
function validateStringArray(value, maximum, itemLength, code) { if (!Array.isArray(value) || value.length > maximum) throw new AuthFailure(400, code, "The merchandising list is invalid."); const result = [...new Set(value.map((item) => plainMerchText(item, itemLength)).filter(Boolean))]; if (result.length !== value.length && value.some((item) => !plainMerchText(item, itemLength))) throw new AuthFailure(400, code, "The merchandising list is invalid."); return result; }
function validateOptionValues(value) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 12) throw new AuthFailure(400, "commerce_variant_options_invalid", "Variant options are invalid."); const entries = Object.entries(value).map(([key, item]) => [plainMerchText(key, 80), plainMerchText(item, 120)]).filter(([key, item]) => key && item); if (entries.length !== Object.keys(value).length) throw new AuthFailure(400, "commerce_variant_options_invalid", "Variant options are invalid."); return Object.fromEntries(entries); }
function validateStoredHttpsUrl(value) { const text = cleanText(value, 4096); if (!text) return null; try { const url = new URL(text); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; } }
function safeStoredStringArray(value, fallback) { try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) && parsed.length ? parsed.map((item) => cleanText(item, 4096)).filter(Boolean) : Array.isArray(fallback) ? fallback.map((item) => cleanText(item, 4096)).filter(Boolean) : []; } catch { return Array.isArray(fallback) ? fallback.map((item) => cleanText(item, 4096)).filter(Boolean) : []; } }
function sameOrderedStrings(left, right) { const a = [...new Set(left.filter(Boolean))], b = [...new Set(right.filter(Boolean))]; return a.length === b.length && a.every((value, index) => value === b[index]); }
function collectionSlug(value) { const slug = cleanText(value, 180).toLowerCase(); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new AuthFailure(400, "commerce_collection_slug_invalid", "Collection slugs may contain lowercase letters, numbers, and single hyphens only."); return slug; }
function collectionVisibility(value) { return ["public", "hidden"].includes(value) ? value : invalidMerch("commerce_collection_visibility_invalid", "Collection visibility is invalid."); }
function collectionIdValue(value) { const id = cleanText(value, 160); if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(id)) throw new AuthFailure(400, "commerce_collection_id_invalid", "The commerce collection identity is invalid."); return id; }
function normalizeCollectionListOptions(input = {}) {
  const pageSizeCandidate = Number(input.pageSize ?? 20);
  const pageSize = COLLECTION_PAGE_SIZES.includes(pageSizeCandidate) ? pageSizeCandidate : 20;
  const pageCandidate = Number(input.page ?? 1);
  const page = Number.isSafeInteger(pageCandidate) && pageCandidate > 0 ? pageCandidate : 1;
  const query = cleanText(input.query ?? input.search, 120);
  const visibility = ["all", "public", "hidden"].includes(input.visibility) ? input.visibility : "all";
  const contents = ["all", "empty", "contains_products"].includes(input.contents) ? input.contents : "all";
  const sort = ["display", "title_asc", "title_desc", "product_count", "updated_desc"].includes(input.sort) ? input.sort : "display";
  return { page, pageSize, query, visibility, contents, sort };
}
function normalizeCollectionProductOptions(input = {}) {
  const base = normalizeCollectionListOptions(input);
  const membership = ["all", "assigned", "available"].includes(input.membership) ? input.membership : "all";
  const visibility = ["all", "public", "hidden"].includes(input.visibility) ? input.visibility : "all";
  return { page: base.page, pageSize: base.pageSize, query: base.query, membership, visibility };
}
function collectionListWhere(options) {
  const where = ["c.status = 'active'"];
  const bindings = [];
  if (options.query) { const pattern = `%${escapeSqlLike(options.query)}%`; where.push("(c.title LIKE ? ESCAPE '\\' OR c.slug LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')"); bindings.push(pattern, pattern, pattern); }
  if (options.visibility !== "all") { where.push("c.visibility = ?"); bindings.push(options.visibility); }
  if (options.contents === "empty") where.push("NOT EXISTS (SELECT 1 FROM commerce_product_collections pc_filter WHERE pc_filter.collection_id = c.id)");
  if (options.contents === "contains_products") where.push("EXISTS (SELECT 1 FROM commerce_product_collections pc_filter WHERE pc_filter.collection_id = c.id)");
  return { where: where.join(" AND "), bindings };
}
function collectionSortSql(sort) {
  if (sort === "title_asc") return "c.title COLLATE NOCASE ASC, c.slug ASC, c.id ASC";
  if (sort === "title_desc") return "c.title COLLATE NOCASE DESC, c.slug DESC, c.id DESC";
  if (sort === "product_count") return "assigned_product_count DESC, c.title COLLATE NOCASE ASC, c.id ASC";
  if (sort === "updated_desc") return "c.updated_at DESC, c.title COLLATE NOCASE ASC, c.id ASC";
  return "c.display_order ASC, c.slug ASC, c.id ASC";
}
function serializeCollectionListRow(row) {
  return { id: cleanText(row.id, 160), slug: cleanText(row.slug, 180), title: cleanText(row.title, 160), description: cleanText(row.description, 2000), visibility: row.visibility, status: row.status, displayOrder: Number(row.display_order), revision: Number(row.revision), assignedProductCount: Number(row.assigned_product_count || 0), publicProductCount: Number(row.public_product_count || 0), thumbnailUrl: validateStoredHttpsUrl(row.thumbnail_url), createdAt: cleanText(row.created_at, 80), updatedAt: cleanText(row.updated_at, 80) };
}
function emptyCollectionListPayload(access, options) { return { ok: true, databaseConfigured: false, access, items: [], page: 1, pageSize: options.pageSize, totalItems: 0, totalPages: 0, startIndex: 0, endIndex: 0, filters: { query: options.query, visibility: options.visibility, contents: options.contents, sort: options.sort }, totals: { collections: 0, publicCollections: 0, hiddenCollections: 0, emptyCollections: 0 }, updatedAt: null }; }
function escapeSqlLike(value) { return String(value).replace(/[\\%_]/g, (character) => `\\${character}`); }
function validatedIdentifiers(value, maximum, code) { if (!Array.isArray(value) || value.length > maximum) throw new AuthFailure(400, code, "The identity list is invalid."); const ids = value.map((item) => cleanText(item, 160)); if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(id))) throw new AuthFailure(400, code, "The identity list is invalid."); if (new Set(ids).size !== ids.length) throw new AuthFailure(400, code, "Duplicate identities are not allowed."); return ids; }
async function requireKnownProducts(db, ids) { if (!ids.length) return; const result = await db.prepare(`SELECT id FROM commerce_products WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all(); if ((result?.results || []).length !== ids.length) throw new AuthFailure(400, "commerce_product_unknown", "Every assignment must reference a known product."); }
async function hasAppliedCatalogueReconciliation(db) { return Boolean(await db.prepare("SELECT 1 applied FROM commerce_catalogue_reconciliation_runs WHERE state='applied' LIMIT 1").first()); }
async function requireCurrentCollection(db, id, revision) { const row = await db.prepare("SELECT id, revision, status FROM commerce_collections WHERE id=?").bind(id).first(); if (!row || row.status !== "active") throw new AuthFailure(404, "commerce_collection_not_found", "The commerce collection was not found."); if (Number(row.revision) !== Number(revision)) throw new AuthFailure(409, "commerce_collection_revision_conflict", "This collection changed in another session. Reload before saving."); return row; }
function throwCollectionConflict(error) { if (/unique/i.test(String(error?.message || error))) throw new AuthFailure(409, "commerce_collection_slug_or_title_duplicate", "Collection title and slug must both be unique."); throw error; }

function validateBusinessProfile(input, current) {
  const allowed = new Set(["revision", "tradingName", "legalBusinessName", "countryCode", "provinceCode", "currencyCode", "publicContactEmail", "supportEmail", "businessPhone", "publicPhone", "websiteUrl", "businessAddress", "publicAddress", "privateAddress", "privatePhone", "businessRegistrationNumber", "invoicePrefix", "documentFooter", "invoiceAccentColor", "receiptAccentColor"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) throw new AuthFailure(400, "business_profile_fields_invalid", "The business profile fields are invalid.");
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new AuthFailure(400, "business_profile_revision_invalid", "The business profile revision is required.");
  const tradingName = validateBusinessText(input?.tradingName ?? current?.trading_name, 160, "trading_name_invalid");
  if (!tradingName) throw new AuthFailure(400, "trading_name_required", "A public trading name is required.");
  const countryCode = cleanText(input?.countryCode ?? current?.country_code, 2).toUpperCase();
  const provinceCode = cleanText(input?.provinceCode ?? current?.province_code, 3).toUpperCase();
  const currencyCode = cleanText(input?.currencyCode ?? current?.currency_code, 3).toUpperCase();
  if (countryCode !== "CA" || provinceCode !== "ON" || currencyCode !== "CAD") {
    throw new AuthFailure(400, "commerce_locale_locked", "This foundation is scoped to Ontario, Canada with CAD storefront currency.");
  }
  const publicContactEmail = validateOptionalEmail(input?.publicContactEmail ?? current?.public_contact_email, "public_contact_email_invalid");
  const supportEmail = validateOptionalEmail(input?.supportEmail ?? current?.support_email, "support_email_invalid");
  const websiteUrl = validateOptionalHttpsUrl(input?.websiteUrl ?? current?.website_url);
  if (Object.hasOwn(input, "businessAddress") && Object.hasOwn(input, "publicAddress")) throw new AuthFailure(400, "business_profile_fields_invalid", "Send businessAddress without its legacy alias.");
  if (Object.hasOwn(input, "businessPhone") && Object.hasOwn(input, "publicPhone")) throw new AuthFailure(400, "business_profile_fields_invalid", "Send businessPhone without its legacy alias.");
  const businessAddressInput = Object.hasOwn(input, "businessAddress") ? input.businessAddress : Object.hasOwn(input, "publicAddress") ? input.publicAddress : safeJson(current?.public_address_json, {});
  const publicAddress = validateAddress(businessAddressInput, "business_address");
  const privateAddress = Object.hasOwn(input, "privateAddress") ? validatePrivateAddress(input.privateAddress) : null;
  const legalBusinessName = plainPrivateValue(input?.legalBusinessName, 240);
  const businessPhoneInput = Object.hasOwn(input, "businessPhone") ? input.businessPhone : Object.hasOwn(input, "publicPhone") ? input.publicPhone : current?.public_phone;
  const publicPhone = validateBusinessPhone(businessPhoneInput, "business_phone_invalid");
  const privatePhone = validateBusinessPhone(input?.privatePhone, "private_phone_invalid");
  return {
    revision,
    tradingName,
    legalBusinessName,
    countryCode,
    provinceCode,
    currencyCode,
    publicAddress,
    privateAddress,
    privatePhone,
    businessRegistrationNumber: plainPrivateValue(input?.businessRegistrationNumber, 100),
    publicContactEmail,
    supportEmail,
    publicPhone,
    websiteUrl,
    invoicePrefix: cleanText(input?.invoicePrefix ?? current?.invoice_prefix, 24),
    documentFooter: plainTemplateText(input?.documentFooter ?? current?.document_footer, 1000),
    taxProviderState: "unavailable",
    invoiceAccentColor: safeAccentColor(input?.invoiceAccentColor ?? current?.invoice_accent_color),
    receiptAccentColor: safeAccentColor(input?.receiptAccentColor ?? current?.receipt_accent_color),
    changedFieldNames: businessAuditCategories(input, current, { tradingName, publicContactEmail, supportEmail, publicPhone, websiteUrl, publicAddress, countryCode, provinceCode, currencyCode }),
  };
}

function businessAuditCategories(input, current, values) {
  const categories = new Set();
  const keys = new Set(Object.keys(input || {}));
  if (keys.has("tradingName") && values.tradingName !== cleanText(current?.trading_name, 160)) categories.add("storefront_identity");
  if ((keys.has("publicContactEmail") && values.publicContactEmail !== cleanText(current?.public_contact_email, 254).toLowerCase()) || (keys.has("supportEmail") && values.supportEmail !== cleanText(current?.support_email, 254).toLowerCase()) || ((keys.has("businessPhone") || keys.has("publicPhone")) && values.publicPhone !== cleanText(current?.public_phone, 80)) || (keys.has("websiteUrl") && values.websiteUrl !== cleanText(current?.website_url, 500))) categories.add("contact_information");
  if ((keys.has("businessAddress") || keys.has("publicAddress")) && JSON.stringify(values.publicAddress) !== JSON.stringify(validateAddress(safeJson(current?.public_address_json, {}), "business_address"))) categories.add("business_address");
  if (keys.has("legalBusinessName") && input.legalBusinessName) categories.add("legal_name");
  if (keys.has("privateAddress")) categories.add("business_address");
  if (keys.has("privatePhone") && input.privatePhone) categories.add("private_phone");
  if (keys.has("businessRegistrationNumber") && input.businessRegistrationNumber) categories.add("business_registration");
  if (["invoicePrefix", "documentFooter", "invoiceAccentColor", "receiptAccentColor"].some((key) => keys.has(key))) categories.add("document_identity");
  if ((keys.has("countryCode") && values.countryCode !== cleanText(current?.country_code, 2).toUpperCase()) || (keys.has("provinceCode") && values.provinceCode !== cleanText(current?.province_code, 3).toUpperCase()) || (keys.has("currencyCode") && values.currencyCode !== cleanText(current?.currency_code, 3).toUpperCase())) categories.add("commerce_defaults");
  return [...categories];
}

function validateBusinessText(value, maxLength, code) {
  return validateOperatorText(value, maxLength, code);
}

function validateBusinessPhone(value, code) {
  return validateOperatorText(value, 80, code);
}

function maskPrivateValue(value) {
  const normalized = String(value || "").replace(/[^a-zA-Z0-9]/g, "");
  if (!normalized) return "";
  return `${"•".repeat(Math.max(4, Math.min(10, normalized.length - 4)))}${normalized.slice(-4)}`;
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

function headerTemplateText(value, maxLength, required, field) {
  const raw = String(value ?? "");
  if (raw.length > maxLength) throw new AuthFailure(400, `template_${field}_too_long`, `The email ${field} is too long.`);
  if (/[\r\n\u0000-\u001f\u007f]/.test(raw)) throw new AuthFailure(400, `template_${field}_invalid`, `The email ${field} cannot contain line breaks or control characters.`);
  return plainTemplateText(raw, maxLength, required);
}

function validateTemplateVariables(template) {
  const values = [template.subject, template.preheader, template.heading, template.introduction, ...template.bodyBlocks, template.ctaLabel, template.ctaUrl, template.supportText, template.footer];
  const unknown = new Set();
  for (const value of values) {
    const text = String(value || "");
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const key = match[1].trim().toLowerCase();
      if (!/^[a-z0-9_]+$/i.test(key) || !COMMERCE_TEMPLATE_VARIABLES.includes(key)) unknown.add(key || "invalid");
    }
    const remainder = text.replace(/\{\{[^{}]*\}\}/g, "");
    if (remainder.includes("{{") || remainder.includes("}}")) throw new AuthFailure(400, "template_placeholder_invalid", "A template placeholder is malformed.");
  }
  if (unknown.size) throw new AuthFailure(400, "template_placeholder_unknown", `Unsupported template variables: ${[...unknown].join(", ")}.`);
}

function validatePrivateAddress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthFailure(400, "private_address_invalid", "The legal business address fields are invalid.");
  const allowed = new Set(["line1", "line2", "city", "province", "postalCode", "country"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new AuthFailure(400, "private_address_invalid", "The private address fields are invalid.");
  const result = {
    line1: validateBusinessText(value.line1, 180, "private_address_invalid"),
    line2: validateBusinessText(value.line2, 180, "private_address_invalid"),
    city: validateBusinessText(value.city, 120, "private_address_invalid"),
    province: validateOperatorText(value.province, 120, "private_address_invalid"),
    postalCode: validateOperatorText(value.postalCode, 64, "private_address_invalid"),
    country: validateOperatorText(value.country, 120, "private_address_invalid"),
  };
  return result;
}

function plainPrivateValue(value, maxLength) {
  const text = String(value ?? "").trim().slice(0, maxLength);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new AuthFailure(400, "private_value_invalid", "The private value contains invalid characters.");
  if (/<\/?[a-z][^>]*>|javascript\s*:|on[a-z]+\s*=|<script/i.test(text)) throw new AuthFailure(400, "private_value_invalid", "Private business values accept plain text only.");
  return text;
}

function validateCtaUrl(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  if (text === "{{receipt_url}}") return text;
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

function validateOptionalEmail(value, code = "email_invalid") {
  const email = cleanText(value, 254).toLowerCase();
  if (!email) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthFailure(400, code, "Enter a valid email address.");
  return email;
}

function safeAccentColor(value) {
  const text = String(value || "");
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : "#f3c928";
}

function validateAddress(value, prefix = "public_address") {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const allowed = new Set(["line1", "line2", "city", "province", "postalCode", "country"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new AuthFailure(400, `${prefix}_invalid`, "The address fields are invalid.");
  const result = {
    line1: validateBusinessText(raw.line1, 180, `${prefix}_invalid`),
    line2: validateBusinessText(raw.line2, 180, `${prefix}_invalid`),
    city: validateBusinessText(raw.city, 120, `${prefix}_invalid`),
    province: validateBusinessText(raw.province, 120, `${prefix}_invalid`),
    postalCode: validateBusinessText(raw.postalCode, 64, `${prefix}_invalid`),
    country: validateBusinessText(raw.country, 120, `${prefix}_invalid`),
  };
  return result;
}

function validateOperatorText(value, maxLength, code) {
  const raw = String(value ?? "");
  if (raw.length > maxLength) throw new AuthFailure(400, `${code}_too_long`, `The field must be ${maxLength} characters or fewer.`);
  if (/[\u0000-\u001F\u007F]/u.test(raw) || hasUnpairedSurrogate(raw)) throw new AuthFailure(400, code, "The field contains invalid control or malformed characters.");
  return raw.trim();
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
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

function isStripeVerificationEnvironment(env) {
  return ["staging", "test"].includes(cleanText(env?.AUTH_ENVIRONMENT, 20).toLowerCase());
}

export function assertNoCommerceSecretsInPublicPayload(payload) {
  const serialized = JSON.stringify(payload);
  if (/(credential_ciphertext|legal_business_name_ciphertext|private_address_ciphertext|recipient_ciphertext|identifier_ciphertext|client_secret|secret_key|bank_account|card_pan|cvc)/i.test(serialized)) {
    throw new Error("private_commerce_data_exposed");
  }
  return true;
}

export async function assertAuthDatabaseAvailable(env) {
  return requireAuthDb(env);
}
