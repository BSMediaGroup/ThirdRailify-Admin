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
  decryptCommerceSecret,
  encryptCommerceSecret,
  isStripeTestCredentialConfigured,
  isStripeWebhookSigningConfigured,
  recordVerifiedStripeWebhookReceipt,
  requireCommerceDb,
} from "./commerce-core.js";
import {
  authoritativeCartLines,
  authoritativeSubtotal,
  normalizeCartItems,
  normalizeDeliveryRecipient,
  resolveShippingSelection,
  stripeShippingRateFields,
} from "./shipping-core.js";
import { orderCustomerProjection, prepareCheckoutCustomer, validateCheckoutCustomer } from "./commerce-customers.js";
import { fulfillmentDetailForOrder } from "./printful-fulfillment.js";

const encoder = new TextEncoder();
const STRIPE_CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";

export const CHECKOUT_MAX_LINES = 20;
export const CHECKOUT_MAX_QUANTITY = 20;
export const CHECKOUT_MAX_TOTAL = 2_147_483_647;

export async function createStripeCheckoutSession(env, request, input, fetchImpl = fetch, options = {}) {
  const db = requireCommerceDb(env);
  const gate = options.gate === "controlled_test" ? "controlled_test" : "normal";
  const configuration = await requireCheckoutConfiguration(env, db, gate);
  const cartRequest = validateCheckoutRequest(input, options.session, gate);
  if (gate === "controlled_test") requireControlledTestCart(cartRequest, configuration.candidate);
  const checkoutRequestDigest = await sha256Hex(JSON.stringify({
    items: cartRequest.items,
    recipient: cartRequest.recipient,
    customer: cartRequest.customer,
    quoteId: cartRequest.quoteId,
    shippingOptionId: cartRequest.shippingOptionId,
  }));
  let order = await loadOrderByCheckoutRequest(db, cartRequest.checkoutRequestId);

  if (order) {
    if (order.checkout_request_digest !== checkoutRequestDigest) {
      throw new AuthFailure(409, "checkout_request_conflict", "This checkout request identifier is already associated with a different cart.");
    }
    const linked = linkedCheckoutResponse(order);
    if (linked) return linked;
  } else if (gate === "controlled_test") {
    const existing = await db.prepare(
      `SELECT COUNT(DISTINCT o.id) AS count
       FROM commerce_orders o
       JOIN commerce_order_items i ON i.order_id = o.id
       WHERE json_extract(o.safe_metadata_json, '$.checkoutGate') = 'controlled_test'
         AND i.product_id = ? AND i.variant_id = ?`,
    ).bind(configuration.candidate.productId, configuration.candidate.variantId).first();
    if (Number(existing?.count || 0) !== 0) {
      throw new AuthFailure(409, "stripe_test_checkout_already_created", "The configured controlled Stripe TEST candidate already has an acceptance order.");
    }
  }

  if (configuration.turnstileRequired) {
    await verifyTurnstile(env, request, input.turnstileToken, "commerce_checkout", fetchImpl);
  }
  await enforceRateLimit(env, request, "checkout", cartRequest.checkoutRequestId);

  let lines;
  let shippingSelection = null;
  if (order) {
    lines = await loadOrderItems(db, order.id);
    if (!lines.length) throw new AuthFailure(503, "checkout_order_incomplete", "The existing checkout order is incomplete.");
    shippingSelection = await loadOrderDeliverySelection(db, order.id);
    if (lines.some((line) => line.requiresShipping) && !shippingSelection) throw new AuthFailure(503, "checkout_order_incomplete", "The existing checkout order has no delivery snapshot.");
  } else {
    lines = await authoritativeCartLines(db, cartRequest.items, { gate, environment: configuration.environment });
    if (lines.some((line) => line.requiresShipping)) {
      shippingSelection = await resolveShippingSelection(db, {
        lines,
        recipient: cartRequest.recipient,
        quoteId: cartRequest.quoteId,
        optionId: cartRequest.shippingOptionId,
        environment: configuration.environment,
      });
    }
    const timestamp = nowIso();
    const orderId = `ord_${randomId()}`;
    const cartDigest = await authoritativeCartDigest(lines);
    const expectedAmount = totalAmount(lines, shippingSelection?.option.amount || 0);
    const recipientCiphertext = shippingSelection
      ? await encryptCommerceSecret(env, JSON.stringify({ ...shippingSelection.recipient, customerContact: cartRequest.customer ? { name: cartRequest.customer.name, email: cartRequest.customer.email } : null }), `order-delivery:${orderId}`)
      : null;
    const customer = cartRequest.customer ? await prepareCheckoutCustomer(env, db, cartRequest.customer) : null;
    const statements = [
      ...(customer ? [customer.statement, ...(customer.auditStatement ? [customer.auditStatement] : [])] : []),
      db.prepare(
        `INSERT INTO commerce_orders (
           id, customer_payment_provider, payment_status, fulfillment_provider, fulfillment_status, currency_code,
           customer_gross_amount, checkout_request_id, checkout_request_digest, cart_digest,
           environment, checkout_status, customer_id, safe_metadata_json, created_at, updated_at
         ) VALUES (?, 'stripe', 'pending', ?, 'disabled', 'CAD', ?, ?, ?, ?, ?, 'checkout_pending', ?, ?, ?, ?)`,
      ).bind(
        orderId, shippingSelection?.provider || null, expectedAmount, cartRequest.checkoutRequestId, checkoutRequestDigest, cartDigest, configuration.environment,
        customer?.id || null,
        JSON.stringify(gate === "controlled_test" ? { checkoutGate: "controlled_test", fulfillment: "disabled" } : {}),
        timestamp, timestamp,
      ),
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
      ...(shippingSelection ? [db.prepare(
        `INSERT INTO commerce_order_delivery_snapshots (
           order_id,recipient_ciphertext,destination_country_code,destination_region_code,
           shipping_strategy,provider,provider_shipping_method_id,display_shipping_method,
           shipping_amount,currency_code,source_quote_id,quoted_at,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,'CAD',?,?,?,?)`,
      ).bind(
        orderId, recipientCiphertext, shippingSelection.recipient.countryCode, shippingSelection.recipient.region,
        shippingSelection.strategy, shippingSelection.provider, shippingSelection.option.providerRateId,
        shippingSelection.option.name, shippingSelection.option.amount, shippingSelection.quoteId,
        shippingSelection.quotedAt, timestamp, timestamp,
      )] : []),
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
  if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= 0 || expectedAmount !== totalAmount(lines, shippingSelection?.option.amount || 0)) {
    throw new AuthFailure(503, "checkout_order_incomplete", "The checkout order total is invalid.");
  }

  await db.prepare(
    "UPDATE commerce_orders SET checkout_status = 'checkout_pending', checkout_failure_code = NULL, updated_at = ? WHERE id = ? AND payment_status = 'pending'",
  ).bind(nowIso(), order.id).run();

  const publicOrigin = configuredPublicOrigin(env);
  const body = stripeCheckoutBody(order, lines, publicOrigin, shippingSelection, cartRequest.customer);
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

export async function commerceOrdersPayload(env, session, input = {}) {
  const access = await commerceAccessForSession(env, session);
  const options = normalizeOrderListOptions(input);
  if (!env?.THIRDRAILIFY_COMMERCE_DB) return emptyOrdersPayload(access, options);
  const db = requireCommerceDb(env);
  const { sql: whereSql, params } = orderListWhere(options);
  const countRow = await db.prepare(`SELECT COUNT(*) AS total_matching FROM commerce_orders o ${whereSql}`).bind(...params).first();
  const totalMatching = Number(countRow?.total_matching || 0);
  const totalPages = totalMatching ? Math.ceil(totalMatching / options.pageSize) : 0;
  const page = totalPages ? Math.min(options.page, totalPages) : 1;
  const offset = (page - 1) * options.pageSize;
  const [result, summary] = await Promise.all([
    db.prepare(
      `WITH item_counts AS (
         SELECT order_id, COUNT(*) AS line_count, COALESCE(SUM(quantity), 0) AS item_count
         FROM commerce_order_items GROUP BY order_id
       ), document_counts AS (
         SELECT order_id, COUNT(*) AS document_count FROM commerce_order_documents GROUP BY order_id
       ), email_counts AS (
         SELECT order_id, COUNT(*) AS email_count FROM commerce_email_deliveries WHERE order_id IS NOT NULL GROUP BY order_id
       )
       SELECT o.id, o.checkout_status, o.payment_status, o.fulfillment_status, o.currency_code, o.environment,
              o.customer_gross_amount, o.refund_amount, o.stripe_checkout_session_id, o.stripe_payment_intent_id,
              o.printful_order_id, o.customer_id, c.customer_kind, c.linked_account_id,
              f.provider_state normalized_provider_state,f.fulfillment_state normalized_fulfillment_state,
              f.confirmation_state normalized_confirmation_state,f.provider_order_id normalized_provider_order_id,
              (SELECT COUNT(*) FROM commerce_fulfillment_shipments fs WHERE fs.fulfillment_order_id=f.id) normalized_shipment_count,
              EXISTS(SELECT 1 FROM commerce_fulfillment_shipments fs WHERE fs.fulfillment_order_id=f.id AND fs.tracking_available=1) normalized_tracking_available,
              o.created_at, o.updated_at, o.checkout_created_at, o.payment_confirmed_at,
              COALESCE(i.line_count, 0) AS line_count, COALESCE(i.item_count, 0) AS item_count,
              COALESCE(d.document_count, 0) AS document_count, COALESCE(e.email_count, 0) AS email_count
       FROM commerce_orders o
       LEFT JOIN item_counts i ON i.order_id = o.id
       LEFT JOIN document_counts d ON d.order_id = o.id
       LEFT JOIN email_counts e ON e.order_id = o.id
       LEFT JOIN commerce_customers c ON c.id = o.customer_id
       LEFT JOIN commerce_fulfillment_orders f ON f.order_id=o.id AND f.provider='printful'
       ${whereSql}
       ORDER BY ${orderSortSql(options.sort)}, o.id ASC LIMIT ? OFFSET ?`,
    ).bind(...params, options.pageSize, offset).all(),
    db.prepare(
      `SELECT COUNT(*) AS total_matching,
              SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
              SUM(CASE WHEN payment_status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN payment_status IN ('refunded','partially_refunded') THEN 1 ELSE 0 END) AS refunded,
              SUM(CASE WHEN fulfillment_status IN ('submitted','fulfilled') THEN 1 ELSE 0 END) AS fulfillment_active,
              SUM(CASE WHEN environment = 'test' THEN 1 ELSE 0 END) AS test_orders,
              SUM(CASE WHEN environment = 'live' THEN 1 ELSE 0 END) AS live_orders,
              SUM(CASE WHEN environment = 'live' AND payment_status IN ('paid','refunded','partially_refunded') THEN customer_gross_amount ELSE 0 END) AS live_gross_amount,
              SUM(CASE WHEN environment = 'live' AND payment_status IN ('paid','refunded','partially_refunded') THEN MAX(customer_gross_amount - refund_amount, 0) ELSE 0 END) AS live_net_amount
       FROM commerce_orders o ${whereSql}`,
    ).bind(...params).first(),
  ]);
  const rows = result?.results || [];
  return {
    ok: true,
    databaseConfigured: true,
    access,
    controlledTest: await controlledTestAcceptancePayload(env),
    orders: rows.map(serializeOrderListRow),
    page,
    pageSize: options.pageSize,
    totalMatching,
    totalPages,
    startIndex: totalMatching ? offset + 1 : 0,
    endIndex: totalMatching ? offset + rows.length : 0,
    filters: { query: options.query, environment: options.environment, payment: options.payment, fulfillment: options.fulfillment, sort: options.sort },
    summary: {
      totalMatching,
      paid: Number(summary?.paid || 0),
      pending: Number(summary?.pending || 0),
      refunded: Number(summary?.refunded || 0),
      fulfillmentActive: Number(summary?.fulfillment_active || 0),
      testOrders: Number(summary?.test_orders || 0),
      liveOrders: Number(summary?.live_orders || 0),
      liveGrossAmount: Number(summary?.live_gross_amount || 0),
      liveNetAmount: Number(summary?.live_net_amount || 0),
      currencyCode: "CAD",
    },
  };
}

export async function commerceOrderDetailPayload(env, session, rawOrderId) {
  const access = await commerceAccessForSession(env, session);
  const db = requireCommerceDb(env);
  const orderId = safeLocalId(rawOrderId);
  if (!orderId) throw new AuthFailure(400, "commerce_order_id_invalid", "The commerce order identifier is invalid.");
  const order = await db.prepare(
    `SELECT id, customer_payment_provider, payment_status, fulfillment_provider, fulfillment_status,
            currency_code, customer_gross_amount, refund_amount, printful_product_cost_amount,
            printful_shipping_cost_amount, printful_tax_amount, printful_refund_credit_amount,
            stripe_checkout_session_id, stripe_payment_intent_id, printful_order_id, checkout_request_id,
            environment, checkout_status, checkout_failure_code, checkout_created_at, payment_confirmed_at,
            payment_failed_at, customer_id, created_at, updated_at
     FROM commerce_orders WHERE id = ? LIMIT 1`,
  ).bind(orderId).first();
  if (!order) throw new AuthFailure(404, "commerce_order_not_found", "The commerce order was not found.");
  const [itemsResult, webhooksResult, documentsResult, deliveriesResult, auditResult, deliverySnapshot, fulfillmentLifecycle] = await Promise.all([
    db.prepare(
      `SELECT i.id, i.line_number, i.product_id, i.variant_id, i.product_name, i.variant_name, i.sku,
              i.option_values_json, i.currency_code, i.unit_amount, i.quantity, i.line_total_amount,
              i.requires_shipping, i.fulfillment_provider, i.fulfillment_variant_id,
              json_extract(p.safe_metadata_json, '$.publicImage') AS current_image_url
       FROM commerce_order_items i LEFT JOIN commerce_products p ON p.id = i.product_id
       WHERE i.order_id = ? ORDER BY i.line_number`,
    ).bind(orderId).all(),
    db.prepare(
      `SELECT provider_event_id, event_type, event_created_at, received_at, livemode, related_object_id,
              related_object_type, processing_status, processed_at, result_code
       FROM commerce_webhook_events
       WHERE provider = 'stripe' AND (related_object_id = ? OR related_object_id = ?)
       ORDER BY received_at ASC, provider_event_id ASC LIMIT 100`,
    ).bind(order.stripe_checkout_session_id || "", order.stripe_payment_intent_id || "").all(),
    db.prepare(
      `SELECT id, document_type, display_reference, environment, status, template_key, template_revision,
              issued_at, created_at, updated_at
       FROM commerce_order_documents WHERE order_id = ? ORDER BY created_at ASC, id ASC LIMIT 20`,
    ).bind(orderId).all(),
    db.prepare(
      `SELECT id, template_key, template_revision, event_key, purpose, status, attempt_count,
              created_at, updated_at, sent_at
       FROM commerce_email_deliveries WHERE order_id = ? ORDER BY created_at ASC, id ASC LIMIT 100`,
    ).bind(orderId).all(),
    db.prepare(
      `SELECT id, action, target_type, result, created_at
       FROM commerce_audit WHERE target_id = ? ORDER BY created_at ASC, id ASC LIMIT 100`,
    ).bind(orderId).all(),
    db.prepare(
      `SELECT recipient_ciphertext,destination_country_code,destination_region_code,shipping_strategy,provider,
              display_shipping_method,shipping_amount,currency_code,source_quote_id,quoted_at,created_at
       FROM commerce_order_delivery_snapshots WHERE order_id=? LIMIT 1`,
    ).bind(orderId).first(),
    fulfillmentDetailForOrder(env, orderId, { includeTracking: true }),
  ]);
  const items = (itemsResult?.results || []).map(serializeOrderItem);
  const webhooks = (webhooksResult?.results || []).map((row) => ({
    eventId: cleanText(row.provider_event_id, 255), eventType: cleanText(row.event_type, 255),
    eventCreatedAt: stripeEventTimestamp(row.event_created_at), receivedAt: cleanText(row.received_at, 80),
    processedAt: cleanText(row.processed_at, 80) || null, test: row.livemode !== 1,
    relatedObjectId: safeStripeObjectId(row.related_object_id), relatedObjectType: cleanText(row.related_object_type, 120) || null,
    processingStatus: cleanText(row.processing_status, 40), resultCode: cleanText(row.result_code, 80) || null,
  }));
  const documents = (documentsResult?.results || []).map((row) => ({
    id: cleanText(row.id, 160), type: cleanText(row.document_type, 20), displayReference: cleanText(row.display_reference, 180),
    test: row.environment === "test", status: cleanText(row.status, 20), templateKey: cleanText(row.template_key, 60),
    templateRevision: Number(row.template_revision), issuedAt: cleanText(row.issued_at, 80) || null,
    createdAt: cleanText(row.created_at, 80), updatedAt: cleanText(row.updated_at, 80),
  }));
  const deliveries = (deliveriesResult?.results || []).map((row) => ({
    id: cleanText(row.id, 160), templateKey: cleanText(row.template_key, 60), templateRevision: Number(row.template_revision),
    eventKey: cleanText(row.event_key, 200), purpose: cleanText(row.purpose, 30), status: cleanText(row.status, 30),
    attemptCount: Number(row.attempt_count || 0), createdAt: cleanText(row.created_at, 80),
    updatedAt: cleanText(row.updated_at, 80), sentAt: cleanText(row.sent_at, 80) || null,
  }));
  const audit = (auditResult?.results || []).map((row) => ({
    id: cleanText(row.id, 160), action: cleanText(row.action, 160), targetType: cleanText(row.target_type, 160),
    result: cleanText(row.result, 20), createdAt: cleanText(row.created_at, 80),
  }));
  const subtotalAmount = items.reduce((sum, item) => sum + item.lineTotalAmount, 0);
  const totalAmount = safeMinorAmount(order.customer_gross_amount);
  const refundAmount = safeMinorAmount(order.refund_amount);
  const shippingAmount = deliverySnapshot ? safeMinorAmount(deliverySnapshot.shipping_amount) : null;
  const [customerRelationship, recipientSnapshot] = await Promise.all([
    orderCustomerProjection(env, order.customer_id),
    deliverySnapshot?.recipient_ciphertext
      ? decryptCommerceSecret(env, deliverySnapshot.recipient_ciphertext, `order-delivery:${orderId}`).then((value) => parseJson(value, null))
      : Promise.resolve(null),
  ]);
  const delivery = deliverySnapshot ? {
    available: true, recipientConfigured: true,
    destinationCountryCode: cleanText(deliverySnapshot.destination_country_code, 2).toUpperCase(),
    destinationRegionCode: cleanText(deliverySnapshot.destination_region_code, 80) || null,
    strategy: cleanText(deliverySnapshot.shipping_strategy, 80), provider: cleanText(deliverySnapshot.provider, 40) || null,
    method: cleanText(deliverySnapshot.display_shipping_method, 100), amount: shippingAmount,
    currencyCode: cleanText(deliverySnapshot.currency_code, 3).toUpperCase(),
    quoteReference: cleanText(deliverySnapshot.source_quote_id, 80), quotedAt: cleanText(deliverySnapshot.quoted_at, 80),
    capturedAt: cleanText(deliverySnapshot.created_at, 80), addressExternallyVerified: false,
  } : {
    available: false, recipientConfigured: false, destinationCountryCode: null, destinationRegionCode: null,
    strategy: null, provider: null, method: null, amount: null, currencyCode: null,
    quoteReference: null, quotedAt: null, capturedAt: null, addressExternallyVerified: false,
  };
  return {
    ok: true,
    databaseConfigured: true,
    access,
    order: {
      id: cleanText(order.id, 160), test: order.environment === "test", environment: order.environment === "live" ? "live" : "test",
      checkoutStatus: cleanText(order.checkout_status, 40), paymentStatus: cleanText(order.payment_status, 40),
      fulfillmentStatus: cleanText(order.fulfillment_status, 40), paymentProvider: cleanText(order.customer_payment_provider, 40),
      fulfillmentProvider: cleanText(order.fulfillment_provider, 40) || null, currencyCode: cleanText(order.currency_code, 3).toUpperCase(),
      createdAt: cleanText(order.created_at, 80), updatedAt: cleanText(order.updated_at, 80),
      checkoutCreatedAt: cleanText(order.checkout_created_at, 80) || null, paymentConfirmedAt: cleanText(order.payment_confirmed_at, 80) || null,
      paymentFailedAt: cleanText(order.payment_failed_at, 80) || null, checkoutFailureCode: cleanText(order.checkout_failure_code, 80) || null,
      customer: {
        ...customerRelationship,
        available: customerRelationship.linked,
        snapshot: recipientSnapshot?.customerContact ? {
          name: cleanText(recipientSnapshot.customerContact.name, 120) || null,
          email: cleanText(recipientSnapshot.customerContact.email, 254) || null,
          historical: true,
        } : null,
        phone: cleanText(recipientSnapshot?.phone, 32) || null,
        billingAddress: null, shippingAddress: null,
      },
      delivery,
      items,
      financial: { subtotalAmount, discountAmount: null, shippingAmount, taxAmount: null, totalAmount, refundAmount, netAmount: refundAmount <= totalAmount ? totalAmount - refundAmount : null, currencyCode: cleanText(order.currency_code, 3).toUpperCase() },
      payment: { provider: cleanText(order.customer_payment_provider, 40), status: cleanText(order.payment_status, 40), environment: order.environment === "live" ? "live" : "test", stripeSessionId: safeStripeObjectId(order.stripe_checkout_session_id), stripePaymentIntentId: safeStripeObjectId(order.stripe_payment_intent_id) },
      fulfillment: { provider: cleanText(order.fulfillment_provider, 40) || null, status: cleanText(order.fulfillment_status, 40), printfulOrderId: fulfillmentLifecycle.providerOrderId || cleanText(order.printful_order_id, 255) || null, orderMode: "draft_only", submissionEnabled: false, tracking: null, carrier: null, failureReason: cleanText(order.checkout_failure_code, 80) || null, providerCosts: { product: safeMinorAmount(order.printful_product_cost_amount), shipping: safeMinorAmount(order.printful_shipping_cost_amount), tax: safeMinorAmount(order.printful_tax_amount), refundCredit: safeMinorAmount(order.printful_refund_credit_amount) }, lifecycle: fulfillmentLifecycle },
      documents, deliveries, webhooks, audit,
      technical: { checkoutRequestId: cleanText(order.checkout_request_id, 36) || null, stripeSessionId: safeStripeObjectId(order.stripe_checkout_session_id), stripePaymentIntentId: safeStripeObjectId(order.stripe_payment_intent_id), printfulOrderId: cleanText(order.printful_order_id, 255) || null },
      timeline: orderTimeline(order, webhooks, documents, deliveries, audit, fulfillmentLifecycle),
    },
  };
}

export async function controlledTestAcceptancePayload(env) {
  const db = requireCommerceDb(env);
  const [stripe, printful, settingsResult, orderCount] = await Promise.all([
    db.prepare("SELECT status, environment, integration_mode, currency_code, safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe' LIMIT 1").first(),
    db.prepare("SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider = 'printful' LIMIT 1").first(),
    db.prepare(
      `SELECT setting_key, value_json FROM commerce_settings
       WHERE setting_key IN ('checkout_enabled', 'live_payment_capture_enabled', 'fulfillment_submission_enabled',
                             'stripe_test_checkout_enabled', 'stripe_test_checkout_product_id', 'stripe_test_checkout_variant_id')`,
    ).all(),
    db.prepare("SELECT COUNT(*) AS count FROM commerce_orders").first(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, parseJson(row.value_json, null)]));
  const stripeMetadata = parseJson(stripe?.safe_metadata_json, {});
  const printfulMetadata = parseJson(printful?.safe_metadata_json, {});
  const productId = safeLocalId(settings.stripe_test_checkout_product_id);
  const variantId = safeLocalId(settings.stripe_test_checkout_variant_id);
  const candidate = productId && variantId ? await db.prepare(
    `SELECT p.id AS product_id, p.slug, p.title, p.status AS product_status, p.visibility AS product_visibility,
            p.currency_code AS product_currency, p.migration_status AS product_migration_status,
            v.id AS variant_id, v.status AS variant_status, v.visibility AS variant_visibility,
            v.is_sellable, v.availability_status, v.unit_amount, v.currency_code,
            v.size_label, v.color_label, v.option_values_json, v.fulfillment_mapping_status, v.migration_status
     FROM commerce_products p JOIN commerce_product_variants v ON v.product_id = p.id
     WHERE p.id = ? AND v.id = ? LIMIT 1`,
  ).bind(productId, variantId).first() : null;
  return {
    enabled: settings.stripe_test_checkout_enabled === true,
    normalCheckoutEnabled: settings.checkout_enabled === true || stripeMetadata.checkout_enabled === true,
    livePaymentsEnabled: settings.live_payment_capture_enabled === true || stripeMetadata.live_payments_enabled === true,
    fulfillmentEnabled: settings.fulfillment_submission_enabled === true || printfulMetadata.fulfillment_enabled === true,
    existingOrderCount: Number(orderCount?.count || 0),
    stripe: {
      status: cleanText(stripe?.status, 40),
      environment: cleanText(stripe?.environment, 20),
      integrationMode: cleanText(stripe?.integration_mode, 40),
      currencyCode: cleanText(stripe?.currency_code, 3).toUpperCase(),
    },
    candidate: candidate ? {
      productId: cleanText(candidate.product_id, 160),
      variantId: cleanText(candidate.variant_id, 160),
      slug: cleanText(candidate.slug, 180),
      title: cleanText(candidate.title, 240),
      variantLabel: [cleanText(candidate.size_label, 120), cleanText(candidate.color_label, 120)].filter(Boolean).join(" / ") || "Standard",
      options: parseJson(candidate.option_values_json, {}),
      unitAmount: Number(candidate.unit_amount),
      currencyCode: cleanText(candidate.currency_code, 3).toUpperCase(),
      sellable: candidate.is_sellable === 1,
      mappingStatus: cleanText(candidate.fulfillment_mapping_status, 40),
      migrationStatus: cleanText(candidate.migration_status, 40),
    } : null,
  };
}

export async function publicOrderStatusPayload(env, rawSessionId) {
  const sessionId = safeStripeId(rawSessionId, "cs_test_");
  if (!sessionId) throw new AuthFailure(400, "checkout_session_id_invalid", "A valid Stripe TEST Checkout Session identifier is required.");
  const row = await requireCommerceDb(env).prepare(
    `SELECT id, checkout_status, payment_status, fulfillment_status, currency_code,
            customer_gross_amount, stripe_checkout_session_id
     FROM commerce_orders WHERE stripe_checkout_session_id = ? LIMIT 1`,
  ).bind(sessionId).first();
  if (!row || row.stripe_checkout_session_id !== sessionId) {
    throw new AuthFailure(404, "checkout_order_not_found", "No checkout order was found for this Session.");
  }
  return {
    ok: true,
    order: {
      reference: cleanText(row.id, 160),
      paymentStatus: row.payment_status === "paid" ? "paid" : row.payment_status === "pending" ? "pending" : "not_confirmed",
      orderStatus: cleanText(row.checkout_status, 40),
      fulfillmentStatus: cleanText(row.fulfillment_status, 40),
      amount: Number(row.customer_gross_amount),
      currency: cleanText(row.currency_code, 3).toUpperCase(),
    },
  };
}

async function requireCheckoutConfiguration(env, db, gate) {
  const [provider, printfulProvider, settingsResult] = await Promise.all([
    db.prepare(
      "SELECT status, environment, integration_mode, currency_code, safe_metadata_json FROM commerce_provider_connections WHERE provider = 'stripe' LIMIT 1",
    ).first(),
    db.prepare(
      "SELECT safe_metadata_json FROM commerce_provider_connections WHERE provider = 'printful' LIMIT 1",
    ).first(),
    db.prepare(
      `SELECT setting_key, value_json FROM commerce_settings
       WHERE setting_key IN ('checkout_enabled', 'stripe_api_configured', 'stripe_webhook_configured',
                             'live_payment_capture_enabled', 'fulfillment_submission_enabled', 'checkout_turnstile_required',
                             'stripe_test_checkout_enabled', 'stripe_test_checkout_product_id', 'stripe_test_checkout_variant_id')`,
    ).all(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, parseJson(row.value_json, null)]));
  const metadata = parseJson(provider?.safe_metadata_json, {});
  const printfulMetadata = parseJson(printfulProvider?.safe_metadata_json, {});
  let candidate = null;
  if (gate === "controlled_test") {
    if (settings.checkout_enabled === true || metadata.checkout_enabled === true) {
      throw new AuthFailure(409, "test_checkout_requires_public_disabled", "Controlled test checkout requires normal checkout to remain disabled.");
    }
    if (settings.stripe_test_checkout_enabled !== true) {
      throw new AuthFailure(409, "stripe_test_checkout_disabled", "Controlled Stripe TEST checkout is not enabled.");
    }
    const productId = safeLocalId(settings.stripe_test_checkout_product_id);
    const variantId = safeLocalId(settings.stripe_test_checkout_variant_id);
    if (!productId || !variantId) throw new AuthFailure(503, "stripe_test_candidate_invalid", "The controlled test checkout candidate is not configured.");
    candidate = { productId, variantId };
  } else if (settings.checkout_enabled !== true || metadata.checkout_enabled !== true) {
    throw new AuthFailure(409, "checkout_disabled", "Public checkout is not enabled.");
  }
  if (settings.live_payment_capture_enabled === true || metadata.live_payments_enabled === true) {
    throw new AuthFailure(409, "live_payments_not_supported", "This endpoint accepts Stripe test payments only.");
  }
  if (settings.fulfillment_submission_enabled === true || printfulMetadata.fulfillment_enabled === true) {
    throw new AuthFailure(409, "fulfillment_must_remain_disabled", "Checkout acceptance requires fulfillment submission to remain disabled.");
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
  return { turnstileRequired: gate === "normal" && settings.checkout_turnstile_required === true, candidate, environment: "test" };
}

function requireControlledTestCart(cartRequest, candidate) {
  if (!candidate || cartRequest.items.length !== 1) {
    throw new AuthFailure(409, "stripe_test_candidate_only", "Only the configured acceptance candidate may use controlled test checkout.");
  }
  const [item] = cartRequest.items;
  if (item.productId !== candidate.productId || item.variantId !== candidate.variantId) {
    throw new AuthFailure(409, "stripe_test_candidate_only", "Only the configured acceptance candidate may use controlled test checkout.");
  }
  if (item.quantity !== 1) throw new AuthFailure(409, "stripe_test_quantity_locked", "Controlled test checkout is limited to quantity one.");
}

function validateCheckoutRequest(input, session, gate) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthFailure(400, "checkout_request_invalid", "The checkout request is invalid.");
  }
  const allowedKeys = new Set(["checkoutRequestId", "items", "recipient", "quoteId", "shippingOptionId", "turnstileToken", "customer"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new AuthFailure(400, "checkout_request_fields_invalid", "The checkout request contains unsupported fields.");
  }
  const checkoutRequestId = String(input.checkoutRequestId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(checkoutRequestId)) {
    throw new AuthFailure(400, "checkout_request_id_invalid", "A valid checkout request UUID is required.");
  }
  const items = normalizeCartItems(input.items);
  const recipient = input.recipient === undefined || input.recipient === null ? null : normalizeDeliveryRecipient(input.recipient);
  const quoteId = input.quoteId === undefined || input.quoteId === null ? null : cleanText(input.quoteId, 80);
  const shippingOptionId = input.shippingOptionId === undefined || input.shippingOptionId === null ? null : cleanText(input.shippingOptionId, 40);
  const customer = validateCheckoutCustomer(input.customer, gate === "normal" ? session : null);
  return { checkoutRequestId, items, recipient, quoteId, shippingOptionId, customer };
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

async function loadOrderDeliverySelection(db, orderId) {
  const row = await db.prepare(
    `SELECT source_quote_id,quoted_at,shipping_strategy,provider,provider_shipping_method_id,
            display_shipping_method,shipping_amount,currency_code
     FROM commerce_order_delivery_snapshots WHERE order_id=? LIMIT 1`,
  ).bind(orderId).first();
  if (!row) return null;
  const amount = Number(row.shipping_amount);
  if (!Number.isSafeInteger(amount) || amount < 0 || String(row.currency_code).toUpperCase() !== "CAD") return null;
  return {
    quoteId: cleanText(row.source_quote_id, 80), quotedAt: cleanText(row.quoted_at, 80),
    strategy: cleanText(row.shipping_strategy, 80), provider: cleanText(row.provider, 40) || null,
    option: {
      providerRateId: cleanText(row.provider_shipping_method_id, 120) || null,
      name: cleanText(row.display_shipping_method, 100), amount,
      currency: "CAD", minDeliveryDays: null, maxDeliveryDays: null,
    },
  };
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

function stripeCheckoutBody(order, lines, publicOrigin, shippingSelection = null, customer = null) {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("payment_method_types[0]", "card");
  form.set("client_reference_id", order.id);
  form.set("metadata[order_id]", order.id);
  form.set("metadata[checkout_request_id]", order.checkout_request_id);
  form.set("metadata[cart_digest]", order.cart_digest);
  if (order.customer_id) form.set("metadata[customer_id]", order.customer_id);
  if (customer?.email) form.set("customer_email", customer.email);
  form.set("success_url", `${publicOrigin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${publicOrigin}/shop?checkout=canceled`);
  lines.forEach((line, index) => {
    form.set(`line_items[${index}][price_data][currency]`, "cad");
    form.set(`line_items[${index}][price_data][unit_amount]`, String(line.unitAmount));
    form.set(`line_items[${index}][price_data][product_data][name]`, line.variantName ? `${line.productName} — ${line.variantName}` : line.productName);
    form.set(`line_items[${index}][quantity]`, String(line.quantity));
  });
  stripeShippingRateFields(form, shippingSelection);
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
  if (!session.metadataOrderId || !session.clientReferenceId) return invalidResolution("checkout_order_reference_missing");
  const correlationId = session.metadataOrderId;
  if (session.metadataOrderId !== session.clientReferenceId) {
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
  if (session.metadataCheckoutRequestId !== order.checkout_request_id) return invalidResolution("checkout_request_mismatch", true);
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

function totalAmount(lines, shippingAmount = 0) {
  const total = authoritativeSubtotal(lines) + shippingAmount;
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

function safeLocalId(value) {
  const id = cleanText(value, 160);
  return /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(id) ? id : "";
}

function normalizeOrderListOptions(input = {}) {
  const allowedPageSizes = new Set([20, 50, 75, 100]);
  const pageSize = Number(input.pageSize ?? 20);
  if (!allowedPageSizes.has(pageSize)) throw new AuthFailure(400, "commerce_orders_page_size_invalid", "Order page size must be 20, 50, 75, or 100.");
  const requestedPage = Number(input.page ?? 1);
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 1_000_000) throw new AuthFailure(400, "commerce_orders_page_invalid", "The order page is invalid.");
  const query = cleanText(input.query, 120);
  const environment = cleanText(input.environment, 20).toLowerCase() || "all";
  const payment = cleanText(input.payment, 40).toLowerCase() || "all";
  const fulfillment = cleanText(input.fulfillment, 40).toLowerCase() || "all";
  const sort = cleanText(input.sort, 30).toLowerCase() || "newest";
  if (!new Set(["all", "test", "live"]).has(environment)) throw new AuthFailure(400, "commerce_orders_environment_invalid", "The order environment filter is invalid.");
  if (!new Set(["all", "pending", "paid", "failed", "refunded", "partially_refunded", "disputed", "canceled"]).has(payment)) throw new AuthFailure(400, "commerce_orders_payment_invalid", "The order payment filter is invalid.");
  if (!new Set(["all", "disabled", "pending", "draft", "submitted", "fulfilled", "canceled", "error"]).has(fulfillment)) throw new AuthFailure(400, "commerce_orders_fulfillment_invalid", "The order fulfillment filter is invalid.");
  if (!new Set(["newest", "oldest", "highest_total", "lowest_total"]).has(sort)) throw new AuthFailure(400, "commerce_orders_sort_invalid", "The order sort is invalid.");
  return { page: requestedPage, pageSize, query, environment, payment, fulfillment, sort };
}

function orderListWhere(options) {
  const clauses = [];
  const params = [];
  if (options.query) {
    const query = `%${escapeSqlLike(options.query)}%`;
    clauses.push("(o.id LIKE ? ESCAPE '\\' OR COALESCE(o.stripe_checkout_session_id,'') LIKE ? ESCAPE '\\' OR COALESCE(o.stripe_payment_intent_id,'') LIKE ? ESCAPE '\\' OR COALESCE(o.printful_order_id,'') LIKE ? ESCAPE '\\' OR COALESCE(o.checkout_request_id,'') LIKE ? ESCAPE '\\')");
    params.push(query, query, query, query, query);
  }
  if (options.environment !== "all") { clauses.push("o.environment = ?"); params.push(options.environment); }
  if (options.payment !== "all") { clauses.push("o.payment_status = ?"); params.push(options.payment); }
  if (options.fulfillment !== "all") { clauses.push("o.fulfillment_status = ?"); params.push(options.fulfillment); }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function orderSortSql(value) {
  if (value === "oldest") return "o.created_at ASC";
  if (value === "highest_total") return "o.customer_gross_amount DESC, o.created_at DESC";
  if (value === "lowest_total") return "o.customer_gross_amount ASC, o.created_at DESC";
  return "o.created_at DESC";
}

function serializeOrderListRow(row) {
  return {
    id: cleanText(row.id, 160), test: row.environment === "test", environment: row.environment === "live" ? "live" : "test",
    checkoutStatus: cleanText(row.checkout_status, 40), paymentStatus: cleanText(row.payment_status, 40),
    fulfillmentStatus: cleanText(row.fulfillment_status, 40), currencyCode: cleanText(row.currency_code, 3).toUpperCase(),
    totalAmount: safeMinorAmount(row.customer_gross_amount), refundAmount: safeMinorAmount(row.refund_amount),
    stripeSessionId: safeStripeObjectId(row.stripe_checkout_session_id), stripePaymentIntentId: safeStripeObjectId(row.stripe_payment_intent_id),
    hasPrintfulOrder: Boolean(cleanText(row.printful_order_id, 255)), createdAt: cleanText(row.created_at, 80),
    updatedAt: cleanText(row.updated_at, 80), checkoutCreatedAt: cleanText(row.checkout_created_at, 80) || null,
    paymentConfirmedAt: cleanText(row.payment_confirmed_at, 80) || null, lineCount: Number(row.line_count || 0),
    itemCount: Number(row.item_count || 0), documentCount: Number(row.document_count || 0), emailCount: Number(row.email_count || 0),
    customer: row.customer_id ? { id: cleanText(row.customer_id, 80), kind: row.customer_kind === "account" ? "account" : "guest", accountId: cleanText(row.linked_account_id, 160) || null } : null,
    fulfillment: {
      available: Boolean(row.normalized_provider_order_id), providerOrderId: cleanText(row.normalized_provider_order_id, 80) || null,
      providerState: cleanText(row.normalized_provider_state, 40) || "none", state: cleanText(row.normalized_fulfillment_state, 40) || "unfulfilled",
      confirmationState: cleanText(row.normalized_confirmation_state, 40) || "none", shipmentCount: Number(row.normalized_shipment_count || 0),
      trackingAvailable: row.normalized_tracking_available === 1,
    },
  };
}

function serializeOrderItem(row) {
  return {
    id: cleanText(row.id, 160), lineNumber: Number(row.line_number), productId: cleanText(row.product_id, 160),
    variantId: cleanText(row.variant_id, 160) || null, productName: cleanText(row.product_name, 240),
    variantName: cleanText(row.variant_name, 300) || null, sku: cleanText(row.sku, 240) || null,
    options: parseJson(row.option_values_json, {}), currencyCode: cleanText(row.currency_code, 3).toUpperCase(),
    unitAmount: safeMinorAmount(row.unit_amount), quantity: Number(row.quantity), lineTotalAmount: safeMinorAmount(row.line_total_amount),
    requiresShipping: row.requires_shipping === 1, fulfillmentProvider: cleanText(row.fulfillment_provider, 40) || null,
    fulfillmentVariantId: cleanText(row.fulfillment_variant_id, 240) || null,
    imageUrl: safeCommerceMediaUrl(row.current_image_url),
  };
}

function emptyOrdersPayload(access, options) {
  return { ok: true, databaseConfigured: false, access, controlledTest: null, orders: [], page: 1, pageSize: options.pageSize, totalMatching: 0, totalPages: 0, startIndex: 0, endIndex: 0, filters: { query: options.query, environment: options.environment, payment: options.payment, fulfillment: options.fulfillment, sort: options.sort }, summary: { totalMatching: 0, paid: 0, pending: 0, refunded: 0, fulfillmentActive: 0, testOrders: 0, liveOrders: 0, liveGrossAmount: 0, liveNetAmount: 0, currencyCode: "CAD" } };
}

function orderTimeline(order, webhooks, documents, deliveries, audit, fulfillmentLifecycle = null) {
  const entries = [];
  const add = (timestamp, kind, title, detail, status = null, id = "") => {
    const value = cleanText(timestamp, 80);
    if (value) entries.push({ id: `${kind}:${id || entries.length}`, timestamp: value, kind, title, detail, status });
  };
  add(order.created_at, "order", "Order record created", "Authoritative local order and immutable line snapshots were persisted.", cleanText(order.checkout_status, 40), order.id);
  add(order.checkout_created_at, "checkout", "Stripe Checkout Session linked", "The stored Checkout Session was linked to this order.", "checkout_created", order.stripe_checkout_session_id);
  add(order.payment_confirmed_at, "payment", "Payment confirmed", "Stored payment state was confirmed through the signed webhook path.", "paid", order.stripe_payment_intent_id);
  add(order.payment_failed_at, "payment", "Payment failed", "The persisted payment failure timestamp was recorded.", "failed", order.id);
  for (const event of webhooks) add(event.processedAt || event.receivedAt || event.eventCreatedAt, "webhook", event.eventType || "Stripe webhook", `${event.processingStatus}${event.resultCode ? ` / ${event.resultCode}` : ""}`, event.processingStatus, event.eventId);
  for (const document of documents) add(document.issuedAt || document.createdAt, "document", `${document.type === "receipt" ? "Receipt" : "Invoice"} ${document.status}`, `Template ${document.templateKey} revision ${document.templateRevision}.`, document.status, document.id);
  for (const delivery of deliveries) add(delivery.sentAt || delivery.createdAt, "email", `Email delivery ${delivery.status}`, `${delivery.templateKey} / ${delivery.eventKey} / ${delivery.purpose}.`, delivery.status, delivery.id);
  for (const event of audit) add(event.createdAt, "audit", event.action, `${event.targetType} / ${event.result}.`, event.result, event.id);
  if (fulfillmentLifecycle?.available) {
    add(fulfillmentLifecycle.providerCreatedAt || fulfillmentLifecycle.lastProviderEvidenceAt, "fulfillment", "Provider order recorded", `${fulfillmentLifecycle.providerState} / ${fulfillmentLifecycle.fulfillmentState}.`, fulfillmentLifecycle.providerState, fulfillmentLifecycle.id);
    for (const shipment of fulfillmentLifecycle.shipments) add(shipment.shippedAt || shipment.returnedAt || shipment.lastProviderEvidenceAt, "shipment", shipment.reshipment ? "Reshipment evidence" : "Shipment evidence", `${shipment.state}${shipment.carrier ? ` / ${shipment.carrier}` : ""}.`, shipment.state, shipment.id);
  }
  return entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
}

function safeMinorAmount(value) { const amount = Number(value || 0); return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0; }
function stripeEventTimestamp(value) { const seconds = Number(value); return Number.isSafeInteger(seconds) && seconds >= 0 ? new Date(seconds * 1000).toISOString() : null; }
function safeStripeObjectId(value) { const id = cleanText(value, 255); return /^(?:cs_(?:test|live)_|pi_|evt_)[A-Za-z0-9_]+$/.test(id) ? id : null; }
function safeCommerceMediaUrl(value) { try { const url = new URL(String(value || "")); return url.protocol === "https:" && !url.username && !url.password && /^\/commerce-media\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(url.pathname) ? url.toString().slice(0, 4096) : null; } catch { return null; } }
function escapeSqlLike(value) { return String(value).replace(/[\\%_]/g, (character) => `\\${character}`); }

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
