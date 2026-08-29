import { AuthFailure, cleanText, enforceRateLimit, nowIso, randomId, verifyTurnstile } from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";

const PRINTFUL_SHIPPING_RATES_URL = "https://api.printful.com/shipping/rates";
const SHIPPING_QUOTE_TTL_MS = 15 * 60 * 1000;
const MAX_LINES = 20;
const MAX_QUANTITY = 20;
const MAX_TOTAL_QUANTITY = 100;
const MAX_MINOR_AMOUNT = 2_147_483_647;
const REGION_REQUIRED_COUNTRIES = new Set(["AU", "CA", "US"]);
const ISO_COUNTRIES = new Set((
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" "));

export function normalizeCartItems(value) {
  if (!Array.isArray(value) || value.length === 0) throw new AuthFailure(400, "checkout_cart_empty", "At least one cart line is required.");
  if (value.length > MAX_LINES) throw new AuthFailure(400, "checkout_cart_too_large", "The cart contains too many lines.");
  const items = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !new Set(["productId", "variantId", "quantity"]).has(key))) {
      throw new AuthFailure(400, "checkout_line_invalid", "Each cart line may contain only productId, variantId, and quantity.");
    }
    const productId = localId(item.productId, "checkout_product_id_invalid", "A cart line contains an invalid product identifier.");
    const variantId = item.variantId === undefined || item.variantId === null ? null : localId(item.variantId, "checkout_variant_id_invalid", "A cart line contains an invalid variant identifier.");
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) throw new AuthFailure(400, "checkout_quantity_invalid", "Cart quantities must be bounded positive integers.");
    return { productId, variantId, quantity: item.quantity };
  }).sort((left, right) => `${left.productId}:${left.variantId || ""}`.localeCompare(`${right.productId}:${right.variantId || ""}`));
  if (new Set(items.map((item) => `${item.productId}:${item.variantId || ""}`)).size !== items.length) throw new AuthFailure(400, "checkout_line_duplicate", "A product variant may appear only once in a checkout request.");
  if (items.reduce((sum, item) => sum + item.quantity, 0) > MAX_TOTAL_QUANTITY) throw new AuthFailure(400, "checkout_quantity_total_invalid", "The cart contains too many total items.");
  return items;
}

export function normalizeDeliveryRecipient(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthFailure(400, "delivery_recipient_invalid", "Delivery details are required.");
  const allowed = new Set(["name", "company", "address1", "address2", "city", "region", "postalCode", "countryCode", "phone"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new AuthFailure(400, "delivery_recipient_fields_invalid", "Delivery details contain unsupported fields.");
  const countryCode = safeField(value.countryCode, 2, "country code", true).toUpperCase();
  if (!ISO_COUNTRIES.has(countryCode)) throw new AuthFailure(400, "delivery_country_invalid", "Choose a valid two-letter destination country code.");
  const recipient = {
    name: safeField(value.name, 120, "recipient name", true),
    ...(safeField(value.company, 120, "company", false) ? { company: safeField(value.company, 120, "company", false) } : {}),
    address1: safeField(value.address1, 180, "address line 1", true),
    address2: safeField(value.address2, 180, "address line 2", false) || null,
    city: safeField(value.city, 120, "city or locality", true),
    region: safeField(value.region, 80, "state, province, or region", false).toUpperCase() || null,
    postalCode: safeField(value.postalCode, 24, "postal code", true).toUpperCase(),
    countryCode,
    phone: safePhone(value.phone),
  };
  if (REGION_REQUIRED_COUNTRIES.has(countryCode) && !recipient.region) throw new AuthFailure(400, "delivery_region_required", "A state, province, or region is required for this destination.");
  if (!postalCodeValid(recipient.postalCode, countryCode)) throw new AuthFailure(400, "delivery_postal_code_invalid", "Enter a valid postal or ZIP code format for the destination.");
  return recipient;
}

export async function recipientFingerprint(recipient) {
  return sha256Hex(JSON.stringify({
    name: recipient.name, company: recipient.company || null, address1: recipient.address1, address2: recipient.address2,
    city: recipient.city, region: recipient.region, postalCode: recipient.postalCode,
    countryCode: recipient.countryCode, phone: recipient.phone,
  }));
}

export async function authoritativeCartLines(db, items, { gate = "normal", environment = "test" } = {}) {
  const placeholders = items.map(() => "?").join(",");
  const [productResult, variantCountResult] = await Promise.all([
    db.prepare(
      `SELECT id,title,currency_code,status,unit_amount,checkout_environment,visibility,max_checkout_quantity,
              requires_shipping,migration_status,target_printful_product_id
       FROM commerce_products WHERE id IN (${placeholders})`,
    ).bind(...items.map((item) => item.productId)).all(),
    db.prepare(`SELECT product_id,COUNT(*) variant_count FROM commerce_product_variants WHERE product_id IN (${placeholders}) GROUP BY product_id`).bind(...items.map((item) => item.productId)).all(),
  ]);
  const products = new Map((productResult?.results || []).map((row) => [row.id, row]));
  const variantCounts = new Map((variantCountResult?.results || []).map((row) => [row.product_id, Number(row.variant_count)]));
  const variantIds = items.map((item) => item.variantId).filter(Boolean);
  const variantResult = variantIds.length ? await db.prepare(
    `SELECT id,product_id,status,visibility,is_sellable,availability_status,unit_amount,currency_code,sku,
            size_label,color_label,option_values_json,fulfillment_provider,fulfillment_mapping_status,migration_status,
            target_printful_product_id,target_printful_sync_variant_id,target_catalogue_variant_id
     FROM commerce_product_variants WHERE id IN (${variantIds.map(() => "?").join(",")})`,
  ).bind(...variantIds).all() : { results: [] };
  const variants = new Map((variantResult?.results || []).map((row) => [row.id, row]));

  return items.map((item) => {
    const product = products.get(item.productId);
    if (!product) throw new AuthFailure(400, "checkout_product_unknown", "A requested product does not exist.");
    if (product.status !== "active" || product.visibility !== "public" || product.checkout_environment !== environment) throw new AuthFailure(409, "checkout_product_unavailable", "A requested product is not available for this checkout environment.");
    if (String(product.currency_code || "").toUpperCase() !== "CAD") throw new AuthFailure(409, "checkout_product_currency_invalid", "A requested product is not priced in CAD.");
    const hasVariants = (variantCounts.get(item.productId) || 0) > 0;
    if (hasVariants && !item.variantId) throw new AuthFailure(400, "checkout_variant_required", "A concrete product variant is required.");
    if (!hasVariants && item.variantId) throw new AuthFailure(400, "checkout_variant_unknown", "The requested product does not have variants.");
    const variant = item.variantId ? variants.get(item.variantId) : null;
    if (item.variantId && (!variant || variant.product_id !== item.productId)) throw new AuthFailure(400, "checkout_variant_unknown", "The requested product variant does not exist.");
    if (variant && (variant.status !== "active" || variant.visibility !== "public" || variant.is_sellable !== 1 || variant.availability_status !== "active")) throw new AuthFailure(409, "checkout_variant_unavailable", "The requested product variant is not sellable and available.");
    const requiresShipping = product.requires_shipping === 1;
    if (requiresShipping && (!variant || variant.fulfillment_provider !== "printful" || variant.fulfillment_mapping_status !== "mapped" || !variant.target_printful_sync_variant_id)) throw new AuthFailure(409, "checkout_variant_fulfillment_unavailable", "The requested physical variant has no authoritative fulfillment mapping.");
    if (gate === "shipping_quote" && requiresShipping && !numericProviderId(variant?.target_catalogue_variant_id)) throw new AuthFailure(409, "shipping_catalogue_variant_unavailable", "The requested physical variant has no authoritative Printful Catalog variant mapping.");
    if (gate === "controlled_test" && (product.migration_status !== "target_verified" || !product.target_printful_product_id || !variant || variant.migration_status !== "target_verified" || !variant.target_printful_product_id || variant.target_printful_product_id !== product.target_printful_product_id)) throw new AuthFailure(409, "checkout_variant_migration_unverified", "The controlled test variant is not fully verified against its target mapping.");
    if (variant && String(variant.currency_code || "").toUpperCase() !== "CAD") throw new AuthFailure(409, "checkout_variant_currency_invalid", "The requested product variant is not priced in CAD.");
    const unitAmount = Number(variant ? variant.unit_amount : product.unit_amount);
    const maxQuantity = Number(product.max_checkout_quantity);
    if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0 || unitAmount > 100_000_000) throw new AuthFailure(409, "checkout_product_price_invalid", "A requested product has no valid authoritative price.");
    if (!Number.isSafeInteger(maxQuantity) || item.quantity > maxQuantity) throw new AuthFailure(409, "checkout_quantity_unavailable", "A requested quantity is not permitted.");
    const productName = cleanText(product.title, 240);
    if (!productName) throw new AuthFailure(409, "checkout_product_name_invalid", "A requested product has no valid authoritative name.");
    return {
      productId: item.productId, variantId: variant?.id || null, productName,
      variantName: variant ? [cleanText(variant.size_label, 120), cleanText(variant.color_label, 120)].filter(Boolean).join(" / ") || null : null,
      sku: variant ? cleanText(variant.sku, 240) || null : null,
      optionValues: variant ? parseJson(variant.option_values_json, {}) : {}, currencyCode: "CAD",
      unitAmount, quantity: item.quantity, lineTotalAmount: unitAmount * item.quantity, requiresShipping,
      fulfillmentProvider: requiresShipping ? variant?.fulfillment_provider || null : null,
      fulfillmentVariantId: requiresShipping ? cleanText(variant?.target_printful_sync_variant_id, 240) || null : null,
      catalogueVariantId: requiresShipping ? cleanText(variant?.target_catalogue_variant_id, 240) || null : null,
    };
  });
}

export function authoritativeSubtotal(lines) {
  const amount = lines.reduce((sum, line) => sum + line.lineTotalAmount, 0);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_MINOR_AMOUNT) throw new AuthFailure(409, "checkout_total_invalid", "The authoritative cart total is outside the permitted range.");
  return amount;
}

export async function authoritativeCartFingerprint(lines) {
  return sha256Hex(JSON.stringify(lines.map((line) => ({
    productId: line.productId, variantId: line.variantId, currencyCode: line.currencyCode,
    unitAmount: line.unitAmount, quantity: line.quantity, lineTotalAmount: line.lineTotalAmount,
    requiresShipping: line.requiresShipping, fulfillmentProvider: line.fulfillmentProvider,
    fulfillmentVariantId: line.fulfillmentVariantId, catalogueVariantId: line.catalogueVariantId,
  }))));
}

export async function createShippingQuote(env, request, input, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !new Set(["items", "recipient", "turnstileToken"]).has(key))) throw new AuthFailure(400, "shipping_quote_request_invalid", "The shipping quote request is invalid.");
  const items = normalizeCartItems(input.items);
  const recipient = normalizeDeliveryRecipient(input.recipient);
  const configuration = await requireShippingConfiguration(env, db);
  if (!configuration.allowedCountries.includes(recipient.countryCode)) {
    throw new AuthFailure(409, "shipping_country_unavailable", "Shipping is not currently available for this destination.");
  }
  await enforceRateLimit(env, request, "shipping_quote", await sha256Hex(JSON.stringify(items)));
  if (configuration.turnstileRequired) await verifyTurnstile(env, request, input.turnstileToken, "commerce_shipping_quote", fetchImpl);
  const lines = await authoritativeCartLines(db, items, { gate: "shipping_quote", environment: configuration.environment });
  const subtotalAmount = authoritativeSubtotal(lines);
  const cartFingerprint = await authoritativeCartFingerprint(lines);
  const addressFingerprint = await recipientFingerprint(recipient);
  const requiresShipping = lines.some((line) => line.requiresShipping);
  const strategy = requiresShipping ? configuration.strategy : "none";
  const provider = requiresShipping ? "printful" : null;
  const providerRates = requiresShipping
    ? await requestPrintfulShippingRates(env, recipient, lines, fetchImpl)
    : [{ providerRateId: null, name: "No shipping required", amount: 0, currency: "CAD", minDeliveryDays: null, maxDeliveryDays: null, minDeliveryDate: null, maxDeliveryDate: null }];
  const options = await Promise.all(providerRates.map(async (rate, index) => ({
    optionId: `shr_${(await sha256Hex(`${cartFingerprint}\n${addressFingerprint}\n${rate.providerRateId || "none"}\n${index}`)).slice(0, 24)}`,
    ...rate,
    totalAmount: checkedTotal(subtotalAmount, rate.amount),
  })));
  const quoteId = `shq_${randomId()}`;
  const createdAt = nowIso();
  const expiresAt = nowIso(Date.now() + SHIPPING_QUOTE_TTL_MS);
  await db.prepare(
    `INSERT INTO commerce_shipping_quotes
      (id,environment,cart_fingerprint,recipient_fingerprint,currency_code,shipping_strategy,provider,rate_options_json,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(quoteId, configuration.environment, cartFingerprint, addressFingerprint, "CAD", strategy, provider, JSON.stringify(options), createdAt, expiresAt).run();
  return {
    ok: true,
    quote: {
      id: quoteId, environment: configuration.environment, currency: "CAD", expiresAt,
      subtotalAmount, requiresShipping, checkoutAvailable: configuration.checkoutAvailable,
      options: options.map(publicRateOption),
    },
  };
}

export async function publicShippingMarketsPayload(env) {
  const db = requireCommerceDb(env);
  const result = await db.prepare("SELECT country_code,display_name FROM commerce_shipping_markets WHERE status='active' AND strategy='printful_dynamic' ORDER BY display_name,country_code").all();
  return {
    ok: true,
    authority: "Commerce D1",
    markets: (result?.results || []).map((row) => ({ countryCode: row.country_code, displayName: row.display_name })),
  };
}

export async function resolveShippingSelection(db, { lines, recipient, quoteId, optionId, environment = "test" }) {
  const normalizedRecipient = normalizeDeliveryRecipient(recipient);
  const id = quoteIdentifier(quoteId);
  const selectedId = optionIdentifier(optionId);
  const quote = await db.prepare("SELECT * FROM commerce_shipping_quotes WHERE id=? LIMIT 1").bind(id).first();
  if (!quote) throw new AuthFailure(409, "shipping_quote_not_found", "The shipping quote is unavailable. Request current rates again.");
  if (Date.parse(quote.expires_at) <= Date.now()) throw new AuthFailure(409, "shipping_quote_expired", "The shipping quote has expired. Request current rates again.");
  if (quote.environment !== environment) throw new AuthFailure(409, "shipping_quote_environment_mismatch", "The shipping quote does not match this checkout environment.");
  if (String(quote.currency_code).toUpperCase() !== "CAD") throw new AuthFailure(409, "shipping_quote_currency_mismatch", "The shipping quote currency does not match checkout.");
  const [cartFingerprint, addressFingerprint] = await Promise.all([authoritativeCartFingerprint(lines), recipientFingerprint(normalizedRecipient)]);
  if (quote.cart_fingerprint !== cartFingerprint) throw new AuthFailure(409, "shipping_quote_cart_mismatch", "The cart changed after rates were requested. Request current rates again.");
  if (quote.recipient_fingerprint !== addressFingerprint) throw new AuthFailure(409, "shipping_quote_recipient_mismatch", "Delivery details changed after rates were requested. Request current rates again.");
  const options = parseQuoteOptions(quote.rate_options_json);
  const selected = options.find((option) => option.optionId === selectedId);
  if (!selected) throw new AuthFailure(409, "shipping_option_invalid", "The selected shipping method is not part of this quote.");
  return {
    quoteId: id, quotedAt: cleanText(quote.created_at, 80), expiresAt: cleanText(quote.expires_at, 80),
    strategy: quote.shipping_strategy, provider: quote.provider || null,
    recipient: normalizedRecipient, recipientFingerprint: addressFingerprint,
    option: selected,
  };
}

export function stripeShippingRateFields(form, selection) {
  if (!selection || selection.option.amount < 0) return;
  form.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  form.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(selection.option.amount));
  form.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "cad");
  form.set("shipping_options[0][shipping_rate_data][display_name]", selection.option.name.slice(0, 100));
  if (selection.option.minDeliveryDays) {
    form.set("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]", "business_day");
    form.set("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]", String(selection.option.minDeliveryDays));
  }
  if (selection.option.maxDeliveryDays) {
    form.set("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]", "business_day");
    form.set("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]", String(selection.option.maxDeliveryDays));
  }
}

export function printfulShippingRateRequest(recipient, lines) {
  const physical = lines.filter((line) => line.requiresShipping);
  if (!physical.length) throw new AuthFailure(409, "shipping_not_required", "This cart does not require provider shipping rates.");
  return {
    recipient: {
      name: recipient.name, ...(recipient.company ? { company: recipient.company } : {}), ...(recipient.phone ? { phone: recipient.phone } : {}),
      address1: recipient.address1, ...(recipient.address2 ? { address2: recipient.address2 } : {}),
      city: recipient.city, ...(recipient.region ? { state_code: recipient.region } : {}),
      country_code: recipient.countryCode, zip: recipient.postalCode,
    },
    items: physical.map((line) => ({ variant_id: numericProviderId(line.catalogueVariantId), quantity: line.quantity })),
    currency: "CAD", locale: "en_US",
  };
}

export function normalizePrintfulShippingRates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.code !== 200 || !Array.isArray(value.result)) throw new AuthFailure(502, "shipping_provider_response_invalid", "The shipping provider returned an invalid response.");
  if (!value.result.length) throw new AuthFailure(409, "shipping_rates_unavailable", "No shipping methods are available for this cart and destination.");
  if (value.result.length > 20) throw new AuthFailure(502, "shipping_provider_response_invalid", "The shipping provider returned too many methods.");
  const seen = new Set();
  return value.result.map((rate) => {
    const providerRateId = providerMethodId(rate?.id);
    if (seen.has(providerRateId)) throw new AuthFailure(502, "shipping_provider_response_invalid", "The shipping provider returned duplicate methods.");
    seen.add(providerRateId);
    const currency = cleanText(rate?.currency, 3).toUpperCase();
    if (currency !== "CAD") throw new AuthFailure(502, "shipping_provider_currency_mismatch", "The shipping provider returned a different currency.");
    const name = displayText(rate?.name, 100, "shipping method");
    return {
      providerRateId, name, amount: decimalToMinor(rate?.rate), currency,
      minDeliveryDays: optionalPositiveInteger(rate?.minDeliveryDays, 365), maxDeliveryDays: optionalPositiveInteger(rate?.maxDeliveryDays, 365),
      minDeliveryDate: optionalIsoDate(rate?.minDeliveryDate), maxDeliveryDate: optionalIsoDate(rate?.maxDeliveryDate),
    };
  });
}

async function requireShippingConfiguration(env, db) {
  const [settingsResult, provider, stripe, marketsResult] = await Promise.all([
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('shipping_strategy','checkout_turnstile_required','commerce_environment','checkout_enabled')").all(),
    db.prepare("SELECT status,environment,integration_mode,currency_code,safe_metadata_json FROM commerce_provider_connections WHERE provider='printful' LIMIT 1").first(),
    db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider='stripe' LIMIT 1").first(),
    db.prepare("SELECT country_code FROM commerce_shipping_markets WHERE status='active' AND strategy='printful_dynamic' ORDER BY country_code").all(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, parseJson(row.value_json, null)]));
  const strategy = cleanText(settings.shipping_strategy, 80).toLowerCase() || "unconfigured";
  if (strategy === "unconfigured") throw new AuthFailure(409, "shipping_unavailable", "Shipping calculation is not available yet.");
  if (strategy !== "printful_dynamic") throw new AuthFailure(409, "shipping_strategy_unsupported", "Shipping calculation is not available for the configured strategy.");
  const metadata = parseJson(provider?.safe_metadata_json, {});
  if (!provider || provider.status !== "connected" || provider.integration_mode !== "fulfillment" || String(provider.currency_code || "").toUpperCase() !== "CAD" || metadata.api_configured !== true || !String(env?.PRINTFUL_API_TOKEN || "").trim()) throw new AuthFailure(503, "shipping_provider_not_ready", "The shipping provider is not configured for rate calculation.");
  const stripeMetadata = parseJson(stripe?.safe_metadata_json, {});
  const allowedCountries = (marketsResult?.results || []).map((row) => cleanText(row.country_code, 2).toUpperCase()).filter(Boolean);
  if (!allowedCountries.length) throw new AuthFailure(409, "shipping_markets_unavailable", "No shipping destinations are currently enabled.");
  return { strategy, environment: commerceEnvironment(settings.commerce_environment, env?.AUTH_ENVIRONMENT), turnstileRequired: settings.checkout_turnstile_required === true, checkoutAvailable: settings.checkout_enabled === true && stripeMetadata.checkout_enabled === true, allowedCountries };
}

async function requestPrintfulShippingRates(env, recipient, lines, fetchImpl) {
  const credential = String(env.PRINTFUL_API_TOKEN).trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetchImpl(PRINTFUL_SHIPPING_RATES_URL, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(printfulShippingRateRequest(recipient, lines)),
    });
  } catch {
    throw new AuthFailure(502, "shipping_provider_unavailable", "Shipping calculation is temporarily unavailable.");
  } finally { clearTimeout(timeout); }
  if (!response?.ok) throw new AuthFailure(502, "shipping_provider_rejected", "The shipping provider could not calculate rates.");
  let payload;
  try { payload = await response.json(); } catch { throw new AuthFailure(502, "shipping_provider_response_invalid", "The shipping provider returned an invalid response."); }
  return normalizePrintfulShippingRates(payload);
}

function parseQuoteOptions(value) {
  const parsed = parseJson(value, null);
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 20) throw new AuthFailure(503, "shipping_quote_invalid", "The stored shipping quote is invalid.");
  return parsed.map((option) => ({
    optionId: optionIdentifier(option?.optionId), providerRateId: option?.providerRateId === null ? null : providerMethodId(option?.providerRateId),
    name: displayText(option?.name, 100, "shipping method"), amount: minorAmount(option?.amount), currency: option?.currency === "CAD" ? "CAD" : invalidQuote(),
    minDeliveryDays: optionalPositiveInteger(option?.minDeliveryDays, 365), maxDeliveryDays: optionalPositiveInteger(option?.maxDeliveryDays, 365),
    minDeliveryDate: optionalIsoDate(option?.minDeliveryDate), maxDeliveryDate: optionalIsoDate(option?.maxDeliveryDate), totalAmount: minorAmount(option?.totalAmount),
  }));
}

function publicRateOption(option) { return { id: option.optionId, name: option.name, amount: option.amount, currency: option.currency, totalAmount: option.totalAmount, delivery: option.minDeliveryDays || option.maxDeliveryDays || option.minDeliveryDate || option.maxDeliveryDate ? { minDays: option.minDeliveryDays, maxDays: option.maxDeliveryDays, minDate: option.minDeliveryDate, maxDate: option.maxDeliveryDate } : null }; }
function safeField(value, maximum, label, required) { const raw = String(value ?? ""); if (raw.length > maximum * 2) throw new AuthFailure(400, "delivery_field_too_long", `The ${label} is too long.`); const text = raw.trim().replace(/[ \t]+/g, " "); if (required && !text) throw new AuthFailure(400, "delivery_field_required", `The ${label} is required.`); if (text.length > maximum) throw new AuthFailure(400, "delivery_field_too_long", `The ${label} is too long.`); if (/[\u0000-\u001f\u007f<>]/.test(text)) throw new AuthFailure(400, "delivery_field_unsafe", `The ${label} contains unsupported characters.`); return text; }
function safePhone(value) { const phone = safeField(value, 32, "phone number", false); if (!phone) return null; if (!/^\+?[0-9][0-9 ().-]{5,30}$/.test(phone)) throw new AuthFailure(400, "delivery_phone_invalid", "Enter a valid phone number format."); return phone; }
function postalCodeValid(value, country) { if (!/^[A-Z0-9][A-Z0-9 -]{1,22}[A-Z0-9]$/.test(value)) return false; if (country === "CA") return /^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/.test(value); if (country === "US") return /^\d{5}(?:-\d{4})?$/.test(value); if (country === "AU") return /^\d{4}$/.test(value); return true; }
function localId(value, code, message) { const id = cleanText(value, 160); if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(id)) throw new AuthFailure(400, code, message); return id; }
function numericProviderId(value) { const id = cleanText(value, 20); if (!/^[1-9]\d{0,18}$/.test(id)) throw new AuthFailure(409, "shipping_catalogue_variant_unavailable", "The requested physical variant has no authoritative Printful Catalog variant mapping."); return id; }
function providerMethodId(value) { const id = cleanText(value, 120); if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id)) throw new AuthFailure(502, "shipping_provider_response_invalid", "The shipping provider returned an invalid method identifier."); return id; }
function quoteIdentifier(value) { const id = cleanText(value, 80); if (!/^shq_[0-9a-f-]{36}$/.test(id)) throw new AuthFailure(400, "shipping_quote_id_invalid", "A valid shipping quote is required."); return id; }
function optionIdentifier(value) { const id = cleanText(value, 40); if (!/^shr_[0-9a-f]{24}$/.test(id)) throw new AuthFailure(400, "shipping_option_id_invalid", "A valid shipping method selection is required."); return id; }
function displayText(value, maximum, label) { const text = cleanText(value, maximum); if (!text || /[\u0000-\u001f\u007f<>]/.test(text)) throw new AuthFailure(502, "shipping_provider_response_invalid", `The provider returned an invalid ${label}.`); return text; }
function decimalToMinor(value) { const match = String(value ?? "").trim().match(/^(\d{1,8})(?:\.(\d{1,2}))?$/); if (!match) throw new AuthFailure(502, "shipping_provider_response_invalid", "The shipping provider returned an invalid amount."); return minorAmount(Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"))); }
function minorAmount(value) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0 || number > MAX_MINOR_AMOUNT) throw new AuthFailure(503, "shipping_quote_invalid", "A shipping amount is invalid."); return number; }
function checkedTotal(subtotal, shipping) { const total = subtotal + shipping; if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_MINOR_AMOUNT) throw new AuthFailure(409, "checkout_total_invalid", "The authoritative order total is outside the permitted range."); return total; }
function optionalPositiveInteger(value, maximum) { if (value === undefined || value === null || value === "") return null; const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new AuthFailure(502, "shipping_provider_response_invalid", "The shipping provider returned an invalid delivery estimate."); return number; }
function optionalIsoDate(value) { if (value === undefined || value === null || value === "") return null; const text = cleanText(value, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new AuthFailure(502, "shipping_provider_response_invalid", "The shipping provider returned an invalid delivery date."); return text; }
function commerceEnvironment(setting, runtime) { const value = cleanText(setting || runtime, 30).toLowerCase(); if (["staging", "test"].includes(value)) return "test"; if (["production", "live"].includes(value)) return "live"; throw new AuthFailure(503, "commerce_environment_invalid", "The commerce environment is not configured."); }
function invalidQuote() { throw new AuthFailure(503, "shipping_quote_invalid", "The stored shipping quote is invalid."); }
function parseJson(value, fallback) { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }
async function sha256Hex(value) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
