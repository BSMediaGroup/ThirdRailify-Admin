import {
  AuthFailure,
  cleanText,
  enforceRateLimit,
  nowIso,
  randomId,
  verifyTurnstile,
} from "./auth-core.js";
import {
  commerceAccessForSession,
  isStripeTestCredentialConfigured,
  isStripeWebhookSigningConfigured,
  recordVerifiedStripeWebhookReceipt,
  requireCommerceDb,
} from "./commerce-core.js";

const encoder = new TextEncoder();
const STRIPE_CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";

export const CHECKOUT_MAX_LINES = 20;
export const CHECKOUT_MAX_QUANTITY = 20;
export const CHECKOUT_MAX_TOTAL = 2_147_483_647;

export async function createStripeCheckoutSession(env, request, input, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  const configuration = await requireCheckoutConfiguration(env, db);
  const cartRequest = validateCheckoutRequest(input);
  const checkoutRequestDigest = await sha256Hex(JSON.stringify(cartRequest.items));
  let order = await loadOrderByCheckoutRequest(db, cartRequest.checkoutRequestId);

  if (order) {
    if (order.checkout_request_digest !== checkoutRequestDigest) {
      throw new AuthFailure(409, "checkout_request_conflict", "This checkout request identifier is already associated with a different cart.");
    }
    const linked = linkedCheckoutResponse(order);
    if (linked) return linked;
  }

  if (configuration.turnstileRequired) {
    await verifyTurnstile(env, request, input.turnstileToken, "commerce_checkout", fetchImpl);
  }
  await enforceRateLimit(env, request, "checkout", cartRequest.checkoutRequestId);

  let lines;
  if (order) {
    lines = await loadOrderItems(db, order.id);
    if (!lines.length) throw new AuthFailure(503, "checkout_order_incomplete", "The existing checkout order is incomplete.");
  } else {
    lines = await authoritativeCartLines(db, cartRequest.items);
    const timestamp = nowIso();
    const orderId = `ord_${randomId()}`;
    const cartDigest = await authoritativeCartDigest(lines);
    const expectedAmount = totalAmount(lines);
    const statements = [
      db.prepare(
        `INSERT INTO commerce_orders (
           id, customer_payment_provider, payment_status, fulfillment_status, currency_code,
           customer_gross_amount, checkout_request_id, checkout_request_digest, cart_digest,
           environment, checkout_status, safe_metadata_json, created_at, updated_at
         ) VALUES (?, 'stripe', 'pending', 'disabled', 'CAD', ?, ?, ?, ?, 'test', 'checkout_pending', '{}', ?, ?)`,
      ).bind(orderId, expectedAmount, cartRequest.checkoutRequestId, checkoutRequestDigest, cartDigest, timestamp, timestamp),
      ...lines.map((line, index) => db.prepare(
        `INSERT INTO commerce_order_items (
           id, order_id, line_number, product_id, variant_id, product_name, variant_name,
           sku, option_values_json, currency_code, unit_amount, quantity, line_total_amount,
           requires_shipping, fulfillment_provider, fulfillment_variant_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CAD', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        randomId(), orderId, index + 1, line.productId, line.variantId, line.productName,
        line.variantName, line.sku, JSON.stringify(line.optionValues), line.unitAmount,
        line.quantity, line.lineTotalAmount, line.requiresShipping ? 1 : 0,
        line.fulfillmentProvider, line.fulfillmentVariantId, timestamp,
      )),
    ];
    try {
      await db.batch(statements);
    } catch {
      order = await loadOrderByCheckoutRequest(db, cartRequest.checkoutRequestId);
      if (!order || order.checkout_request_digest !== checkoutRequestDigest) {
        throw new AuthFailure(503, "checkout_order_persistence_failed", "The checkout order could not be initialized.");
      }
    }
    order ||= await loadOrderByCheckoutRequest(db, cartRequest.checkoutRequestId);
    if (!order) throw new AuthFailure(503, "checkout_order_persistence_failed", "The checkout order could not be initialized.");
  }

  const linked = linkedCheckoutResponse(order);
  if (linked) return linked;
  const expectedAmount = Number(order.customer_gross_amount);
  if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= 0 || expectedAmount !== totalAmount(lines)) {
    throw new AuthFailure(503, "checkout_order_incomplete", "The checkout order total is invalid.");
  }

  await db.prepare(
    "UPDATE commerce_orders SET checkout_status = 'checkout_pending', checkout_failure_code = NULL, updated_at = ? WHERE id = ? AND payment_status = 'pending'",
  ).bind(nowIso(), order.id).run();

  const publicOrigin = configuredPublicOrigin(env);
  const body = stripeCheckoutBody(order, lines, publicOrigin);
  const credential = String(env.STRIPE_SECRET_KEY).trim();
  const idempotencyKey = await stripeCheckoutIdempotencyKey(order.id, order.checkout_request_id);
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    response = await fetchImpl(STRIPE_CHECKOUT_URL, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body,
    });
  } catch {
    await markCheckoutFailure(db, order.id, "stripe_provider_unavailable");
    throw new AuthFailure(502, "stripe_checkout_unavailable", "Stripe Checkout is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response?.ok) {
    await markCheckoutFailure(db, order.id, "stripe_provider_rejected");
    throw new AuthFailure(502, "stripe_checkout_rejected", "Stripe rejected the Checkout Session request.");
  }

  let rawSession;
  try {
    rawSession = await response.json();
  } catch {
    await markCheckoutFailure(db, order.id, "stripe_response_invalid");
    throw new AuthFailure(502, "stripe_checkout_response_invalid", "Stripe returned an invalid Checkout Session response.");
  }
  const session = normalizeCreatedCheckoutSession(rawSession, order, expectedAmount);
  if (!session) {
    await markCheckoutFailure(db, order.id, "stripe_response_invalid");
    throw new AuthFailure(502, "stripe_checkout_response_invalid", "Stripe returned an invalid test Checkout Session.");
  }

  const timestamp = nowIso();
  let result;
  try {
    result = await db.prepare(
      `UPDATE commerce_orders
       SET stripe_checkout_session_id = ?, stripe_checkout_url = ?, checkout_status = 'checkout_created',
           checkout_failure_code = NULL, checkout_created_at = COALESCE(checkout_created_at, ?), updated_at = ?
       WHERE id = ? AND checkout_request_id = ?
         AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ?)`,
    ).bind(session.id, session.url, timestamp, timestamp, order.id, order.checkout_request_id, session.id).run();
  } catch {
    throw new AuthFailure(503, "checkout_session_link_failed", "The Stripe Checkout Session could not be linked to its local order.");
  }
  if (Number(result?.meta?.changes || 0) !== 1) {
    const recovered = await loadOrderByCheckoutRequest(db, order.checkout_request_id);
    const recoveredResponse = linkedCheckoutResponse(recovered);
    if (recoveredResponse?.sessionId === session.id) return recoveredResponse;
    throw new AuthFailure(503, "checkout_session_link_failed", "The Stripe Checkout Session could not be linked to its local order.");
  }
  return { ok: true, orderId: order.id, sessionId: session.id, checkoutUrl: session.url };
}

export async function processStripeCheckoutCompleted(env, event, receipt) {
  const db = requireCommerceDb(env);
  const existing = await db.prepare(
    "SELECT provider_event_id FROM commerce_webhook_events WHERE provider = 'stripe' AND provider_event_id = ? LIMIT 1",
  ).bind(receipt.eventId).first();
  if (existing) {
    const stored = await recordVerifiedStripeWebhookReceipt(env, { ...receipt, processingStatus: "accepted_noop", resultCode: "duplicate" });
    return { ...stored, resultCode: "duplicate" };
  }

  let resolution = await resolveCheckoutCompletion(db, event.checkoutSession);
  if (!resolution.valid && !resolution.linked && await checkoutIsDisabled(db)) {
    resolution = invalidResolution("checkout_disabled");
  }
  const stored = await recordVerifiedStripeWebhookReceipt(env, {
    ...receipt,
    processingStatus: resolution.valid ? "processed" : "accepted_noop",
    resultCode: resolution.resultCode,
  }, resolution.transition);
  return { ...stored, resultCode: stored.duplicate ? "duplicate" : resolution.resultCode };
}

export async function commerceOrdersPayload(env, session) {
  const access = await commerceAccessForSession(env, session);
  if (!env?.THIRDRAILIFY_COMMERCE_DB) return { ok: true, databaseConfigured: false, access, orders: [] };
  const result = await requireCommerceDb(env).prepare(
    `SELECT id, checkout_status, payment_status, fulfillment_status, currency_code,
            customer_gross_amount, stripe_checkout_session_id, stripe_payment_intent_id,
            created_at, updated_at, checkout_created_at, payment_confirmed_at
     FROM commerce_orders ORDER BY created_at DESC LIMIT 100`,
  ).all();
  return {
    ok: true,
    databaseConfigured: true,
    access,
    orders: (result?.results || []).map((row) => ({
      id: cleanText(row.id, 160),
      checkoutStatus: cleanText(row.checkout_status, 40),
      paymentStatus: cleanText(row.payment_status, 40),
      fulfillmentStatus: cleanText(row.fulfillment_status, 40),
      currencyCode: cleanText(row.currency_code, 3).toUpperCase(),
      expectedAmount: Number(row.customer_gross_amount || 0),
      stripeSessionId: safeStripeId(row.stripe_checkout_session_id, "cs_test_"),
      stripePaymentIntentId: safeStripeId(row.stripe_payment_intent_id, "pi_"),
      createdAt: cleanText(row.created_at, 80),
      updatedAt: cleanText(row.updated_at, 80),
      checkoutCreatedAt: cleanText(row.checkout_created_at, 80) || null,
      paymentConfirmedAt: cleanText(row.payment_confirmed_at, 80) || null,
    })),
  };
}

async function requireCheckoutConfiguration(env, db) {
  const [provider, settingsResult] = await Promise.all([
    db.prepare(
      "SELECT status, environment, integration_mode, currency_code, safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe' LIMIT 1",
    ).first(),
    db.prepare(
      `SELECT setting_key, value_json FROM commerce_settings
       WHERE setting_key IN ('checkout_enabled', 'stripe_api_configured', 'stripe_webhook_configured',
                             'live_payment_capture_enabled', 'fulfillment_submission_enabled', 'checkout_turnstile_required')`,
    ).all(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, parseJson(row.value_json, null)]));
  const metadata = parseJson(provider?.safe_metadata_json, {});
  if (settings.checkout_enabled !== true || metadata.checkout_enabled !== true) {
    throw new AuthFailure(409, "checkout_disabled", "Public checkout is not enabled.");
  }
  if (settings.live_payment_capture_enabled === true || metadata.live_payments_enabled === true) {
    throw new AuthFailure(409, "live_payments_not_supported", "This endpoint accepts Stripe test payments only.");
  }
  if (!provider || provider.status !== "connected" || provider.environment !== "test" || provider.integration_mode !== "direct_merchant") {
    throw new AuthFailure(503, "stripe_provider_not_ready", "The Stripe test provider is not ready for Checkout.");
  }
  if (String(provider.currency_code || "").toUpperCase() !== "CAD") {
    throw new AuthFailure(503, "stripe_provider_currency_invalid", "The Stripe provider currency is invalid.");
  }
  if (settings.stripe_api_configured !== true || metadata.api_configured !== true || !isStripeTestCredentialConfigured(env)) {
    throw new AuthFailure(503, "stripe_api_not_configured", "Stripe test API verification is not configured.");
  }
  if (settings.stripe_webhook_configured !== true || metadata.webhook_configured !== true || !isStripeWebhookSigningConfigured(env)) {
    throw new AuthFailure(503, "stripe_webhook_not_configured", "Stripe signed webhook verification is not configured.");
  }
  if (!new Set(["staging", "test"]).has(cleanText(env?.AUTH_ENVIRONMENT, 20).toLowerCase())) {
    throw new AuthFailure(503, "checkout_environment_invalid", "Stripe Checkout is restricted to the staging test environment.");
  }
  configuredPublicOrigin(env);
  return { turnstileRequired: settings.checkout_turnstile_required === true };
}

function validateCheckoutRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthFailure(400, "checkout_request_invalid", "The checkout request is invalid.");
  }
  const allowedKeys = new Set(["checkoutRequestId", "items", "turnstileToken"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new AuthFailure(400, "checkout_request_fields_invalid", "The checkout request contains unsupported fields.");
  }
  const checkoutRequestId = String(input.checkoutRequestId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(checkoutRequestId)) {
    throw new AuthFailure(400, "checkout_request_id_invalid", "A valid checkout request UUID is required.");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new AuthFailure(400, "checkout_cart_empty", "At least one cart line is required.");
  }
  if (input.items.length > CHECKOUT_MAX_LINES) {
    throw new AuthFailure(400, "checkout_cart_too_large", "The cart contains too many lines.");
  }
  const items = input.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !new Set(["productId", "variantId", "quantity"]).has(key))) {
      throw new AuthFailure(400, "checkout_line_invalid", "Each cart line may contain only productId, variantId, and quantity.");
    }
    const productId = cleanText(item.productId, 160);
    if (!productId || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(productId)) {
      throw new AuthFailure(400, "checkout_product_id_invalid", "A cart line contains an invalid product identifier.");
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > CHECKOUT_MAX_QUANTITY) {
      throw new AuthFailure(400, "checkout_quantity_invalid", "Cart quantities must be bounded positive integers.");
    }
    const variantId = item.variantId === undefined || item.variantId === null ? null : cleanText(item.variantId, 160);
    if (variantId !== null && (!variantId || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(variantId))) {
      throw new AuthFailure(400, "checkout_variant_id_invalid", "A cart line contains an invalid variant identifier.");
    }
    return { productId, variantId, quantity: item.quantity };
  }).sort((left, right) => `${left.productId}:${left.variantId || ""}`.localeCompare(`${right.productId}:${right.variantId || ""}`));
  if (new Set(items.map((item) => `${item.productId}:${item.variantId || ""}`)).size !== items.length) {
    throw new AuthFailure(400, "checkout_line_duplicate", "A product variant may appear only once in a checkout request.");
  }
  return { checkoutRequestId, items };
}

async function authoritativeCartLines(db, items) {
  const placeholders = items.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT id, title, currency_code, status, unit_amount, checkout_environment,
            visibility, max_checkout_quantity, requires_shipping
     FROM commerce_products WHERE id IN (${placeholders})`,
  ).bind(...items.map((item) => item.productId)).all();
  const rows = new Map((result?.results || []).map((row) => [row.id, row]));
  const variantIds = items.map((item) => item.variantId).filter(Boolean);
  const variantResult = variantIds.length ? await db.prepare(
    `SELECT id, product_id, status, visibility, is_sellable, availability_status,
            unit_amount, currency_code, sku, size_label, color_label, option_values_json,
            fulfillment_provider, fulfillment_mapping_status, target_printful_sync_variant_id
     FROM commerce_product_variants WHERE id IN (${variantIds.map(() => "?").join(",")})`,
  ).bind(...variantIds).all() : { results: [] };
  const variants = new Map((variantResult?.results || []).map((row) => [row.id, row]));
  const variantCountResult = await db.prepare(
    `SELECT product_id, COUNT(*) AS variant_count FROM commerce_product_variants
     WHERE product_id IN (${placeholders}) GROUP BY product_id`,
  ).bind(...items.map((item) => item.productId)).all();
  const variantCounts = new Map((variantCountResult?.results || []).map((row) => [row.product_id, Number(row.variant_count)]));
  return items.map((item) => {
    const product = rows.get(item.productId);
    if (!product) throw new AuthFailure(400, "checkout_product_unknown", "A requested product does not exist.");
    if (product.status !== "active" || product.visibility !== "public" || product.checkout_environment !== "test") {
      throw new AuthFailure(409, "checkout_product_unavailable", "A requested product is not available for test checkout.");
    }
    if (String(product.currency_code || "").toUpperCase() !== "CAD") {
      throw new AuthFailure(409, "checkout_product_currency_invalid", "A requested product is not priced in CAD.");
    }
    const hasVariants = (variantCounts.get(item.productId) || 0) > 0;
    if (hasVariants && !item.variantId) throw new AuthFailure(400, "checkout_variant_required", "A concrete product variant is required.");
    if (!hasVariants && item.variantId) throw new AuthFailure(400, "checkout_variant_unknown", "The requested product does not have variants.");
    const variant = item.variantId ? variants.get(item.variantId) : null;
    if (item.variantId && (!variant || variant.product_id !== item.productId)) throw new AuthFailure(400, "checkout_variant_unknown", "The requested product variant does not exist.");
    if (variant && (variant.status !== "active" || variant.visibility !== "public" || variant.is_sellable !== 1 || variant.availability_status !== "active")) {
      throw new AuthFailure(409, "checkout_variant_unavailable", "The requested product variant is not sellable and available.");
    }
    if (variant && (variant.fulfillment_provider !== "printful" || variant.fulfillment_mapping_status !== "mapped" || !variant.target_printful_sync_variant_id)) {
      throw new AuthFailure(409, "checkout_variant_fulfillment_unavailable", "The requested product variant has no authoritative fulfillment mapping.");
    }
    if (variant && String(variant.currency_code || "").toUpperCase() !== "CAD") throw new AuthFailure(409, "checkout_variant_currency_invalid", "The requested product variant is not priced in CAD.");
    const unitAmount = Number(variant ? variant.unit_amount : product.unit_amount);
    const maxQuantity = Number(product.max_checkout_quantity);
    if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0 || unitAmount > 100_000_000) {
      throw new AuthFailure(409, "checkout_product_price_invalid", "A requested product has no valid authoritative price.");
    }
    if (!Number.isSafeInteger(maxQuantity) || item.quantity > maxQuantity) {
      throw new AuthFailure(409, "checkout_quantity_unavailable", "A requested quantity is not permitted.");
    }
    const productName = cleanText(product.title, 240);
    if (!productName) throw new AuthFailure(409, "checkout_product_name_invalid", "A requested product has no valid authoritative name.");
    return {
      productId: item.productId,
      variantId: variant?.id || null,
      productName,
      variantName: variant ? [cleanText(variant.size_label, 120), cleanText(variant.color_label, 120)].filter(Boolean).join(" / ") || null : null,
      sku: variant ? cleanText(variant.sku, 240) || null : null,
      optionValues: variant ? parseJson(variant.option_values_json, {}) : {},
      currencyCode: "CAD",
      unitAmount,
      quantity: item.quantity,
      lineTotalAmount: unitAmount * item.quantity,
      requiresShipping: product.requires_shipping === 1,
      fulfillmentProvider: variant?.fulfillment_provider || null,
      fulfillmentVariantId: variant?.target_printful_sync_variant_id || null,
    };
  });
}

async function loadOrderItems(db, orderId) {
  const result = await db.prepare(
    `SELECT product_id, variant_id, product_name, variant_name, sku, option_values_json,
            currency_code, unit_amount, quantity, line_total_amount, requires_shipping,
            fulfillment_provider, fulfillment_variant_id
     FROM commerce_order_items WHERE order_id = ? ORDER BY line_number`,
  ).bind(orderId).all();
  return (result?.results || []).map((row) => ({
    productId: row.product_id,
    variantId: row.variant_id || null,
    productName: row.product_name,
    variantName: row.variant_name || null,
    sku: row.sku || null,
    optionValues: parseJson(row.option_values_json, {}),
    currencyCode: row.currency_code,
    unitAmount: Number(row.unit_amount),
    quantity: Number(row.quantity),
    lineTotalAmount: Number(row.line_total_amount),
    requiresShipping: row.requires_shipping === 1,
    fulfillmentProvider: row.fulfillment_provider || null,
    fulfillmentVariantId: row.fulfillment_variant_id || null,
  }));
}

async function loadOrderByCheckoutRequest(db, checkoutRequestId) {
  return db.prepare("SELECT * FROM commerce_orders WHERE checkout_request_id = ? LIMIT 1").bind(checkoutRequestId).first();
}

function linkedCheckoutResponse(order) {
  if (!order?.stripe_checkout_session_id || !order?.stripe_checkout_url) return null;
  if (!/^cs_test_[A-Za-z0-9_]+$/.test(order.stripe_checkout_session_id)) return null;
  const url = safeCheckoutUrl(order.stripe_checkout_url);
  return url ? { ok: true, orderId: order.id, sessionId: order.stripe_checkout_session_id, checkoutUrl: url } : null;
}

function stripeCheckoutBody(order, lines, publicOrigin) {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("payment_method_types[0]", "card");
  form.set("client_reference_id", order.id);
  form.set("metadata[order_id]", order.id);
  form.set("metadata[checkout_request_id]", order.checkout_request_id);
  form.set("metadata[cart_digest]", order.cart_digest);
  form.set("success_url", `${publicOrigin}/shop?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${publicOrigin}/shop?checkout=canceled`);
  lines.forEach((line, index) => {
    form.set(`line_items[${index}][price_data][currency]`, "cad");
    form.set(`line_items[${index}][price_data][unit_amount]`, String(line.unitAmount));
    form.set(`line_items[${index}][price_data][product_data][name]`, line.variantName ? `${line.productName} — ${line.variantName}` : line.productName);
    form.set(`line_items[${index}][quantity]`, String(line.quantity));
  });
  return form.toString();
}

function normalizeCreatedCheckoutSession(value, order, expectedAmount) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.object !== "checkout.session") return null;
  const id = safeStripeId(value.id, "cs_test_");
  const url = safeCheckoutUrl(value.url);
  if (!id || !url || value.livemode !== false || value.mode !== "payment" || value.currency !== "cad") return null;
  if (!Number.isSafeInteger(value.amount_total) || value.amount_total !== expectedAmount) return null;
  if (value.client_reference_id !== order.id || value.metadata?.order_id !== order.id || value.metadata?.checkout_request_id !== order.checkout_request_id) return null;
  return { id, url };
}

async function resolveCheckoutCompletion(db, session) {
  if (!session) return invalidResolution("checkout_session_invalid");
  const correlationId = session.metadataOrderId || session.clientReferenceId;
  if (!correlationId) return invalidResolution("checkout_order_reference_missing");
  if (session.metadataOrderId && session.clientReferenceId && session.metadataOrderId !== session.clientReferenceId) {
    return invalidResolution("checkout_order_reference_mismatch");
  }
  const result = await db.prepare(
    "SELECT * FROM commerce_orders WHERE id = ? OR stripe_checkout_session_id = ?",
  ).bind(correlationId, session.id).all();
  const rows = result?.results || [];
  const byId = rows.find((row) => row.id === correlationId);
  const bySession = rows.find((row) => row.stripe_checkout_session_id === session.id);
  if (!byId || !bySession) return invalidResolution("checkout_order_unlinked");
  if (byId.id !== bySession.id) return invalidResolution("checkout_order_session_mismatch");
  const order = byId;
  if (order.stripe_checkout_session_id !== session.id) return invalidResolution("checkout_session_mismatch", true);
  if (session.metadataCheckoutRequestId && session.metadataCheckoutRequestId !== order.checkout_request_id) return invalidResolution("checkout_request_mismatch", true);
  if (session.mode !== "payment") return invalidResolution("checkout_mode_invalid", true);
  if (session.currency !== "cad" || String(order.currency_code).toUpperCase() !== "CAD") return invalidResolution("checkout_currency_mismatch", true);
  if (!Number.isSafeInteger(session.amountTotal) || session.amountTotal !== Number(order.customer_gross_amount)) return invalidResolution("checkout_amount_mismatch", true);
  if (session.paymentStatus !== "paid") return invalidResolution("checkout_payment_incomplete", true);
  if (session.livemode !== false || order.environment !== "test") return invalidResolution("checkout_environment_mismatch", true);
  if (order.checkout_status !== "checkout_created") return invalidResolution("checkout_order_not_ready", true);
  if (order.payment_status === "paid") return invalidResolution("payment_already_confirmed", true);
  if (order.payment_status !== "pending") return invalidResolution("checkout_payment_state_invalid", true);
  return {
    valid: true,
    resultCode: "payment_confirmed",
    linked: true,
    transition: { orderId: order.id, sessionId: session.id, paymentIntentId: session.paymentIntentId },
  };
}

function invalidResolution(resultCode, linked = false) {
  return { valid: false, linked, resultCode, transition: null };
}

async function checkoutIsDisabled(db) {
  const setting = await db.prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'checkout_enabled'").first();
  return parseJson(setting?.value_json, false) !== true;
}

function totalAmount(lines) {
  const total = lines.reduce((sum, line) => sum + line.lineTotalAmount, 0);
  if (!Number.isSafeInteger(total) || total <= 0 || total > CHECKOUT_MAX_TOTAL) {
    throw new AuthFailure(409, "checkout_total_invalid", "The authoritative cart total is outside the permitted range.");
  }
  return total;
}

async function authoritativeCartDigest(lines) {
  return sha256Hex(JSON.stringify(lines.map((line) => ({
    productId: line.productId,
    variantId: line.variantId,
    productName: line.productName,
    currencyCode: line.currencyCode,
    unitAmount: line.unitAmount,
    quantity: line.quantity,
    lineTotalAmount: line.lineTotalAmount,
    requiresShipping: line.requiresShipping,
    fulfillmentProvider: line.fulfillmentProvider,
    fulfillmentVariantId: line.fulfillmentVariantId,
  }))));
}

async function stripeCheckoutIdempotencyKey(orderId, checkoutRequestId) {
  return `thirdrailify-checkout-v1-${await sha256Hex(`${orderId}\n${checkoutRequestId}`)}`;
}

async function markCheckoutFailure(db, orderId, failureCode) {
  try {
    await db.prepare(
      "UPDATE commerce_orders SET checkout_status = 'checkout_failed', checkout_failure_code = ?, updated_at = ? WHERE id = ? AND payment_status = 'pending'",
    ).bind(failureCode, nowIso(), orderId).run();
  } catch {
    // The original provider error remains authoritative; a retry uses the same local order and Stripe idempotency key.
  }
}

function configuredPublicOrigin(env) {
  const raw = String(env?.THIRDRAILIFY_PUBLIC_ORIGIN || "");
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid");
    return url.origin;
  } catch {
    throw new AuthFailure(503, "checkout_public_origin_invalid", "The Public checkout origin is not configured.");
  }
}

function safeCheckoutUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password) return "";
    return url.toString().slice(0, 2048);
  } catch {
    return "";
  }
}

function safeStripeId(value, prefix) {
  const id = cleanText(value, 255);
  return id.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(id) ? id : null;
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
