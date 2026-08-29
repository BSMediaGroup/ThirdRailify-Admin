import { AuthFailure, nowIso } from "./auth-core.js";
import {
  decryptCommerceSecret,
  encryptCommerceSecret,
  requireCommerceDb,
  writeCommerceAudit,
} from "./commerce-core.js";
import { buildPrintfulOrderExternalId } from "./printful-api.js";

const encoder = new TextEncoder();
const PRINTFUL_ORDERS_URL = "https://api.printful.com/orders";

export const PRINTFUL_V2_WEBHOOK_EVENTS = Object.freeze([
  "order_created",
  "order_updated",
  "order_failed",
  "order_canceled",
  "order_put_hold",
  "order_remove_hold",
  "shipment_sent",
  "shipment_delivered",
  "shipment_returned",
  "shipment_canceled",
]);

const PROVIDER_STATE_RANK = Object.freeze({
  unknown: 0,
  draft: 1,
  submitted: 2,
  failed: 2,
  processing: 3,
  on_hold: 3,
  partial: 4,
  complete: 5,
  archived: 6,
  canceled: 9,
});

export function normalizePrintfulOrderEvidence(value, options = {}) {
  const source = unwrapOrder(value);
  if (!source) throw new AuthFailure(400, "printful_order_evidence_invalid", "Printful order evidence is invalid.");
  const providerOrderId = requiredNumericId(source.id, "printful_order_id_invalid");
  const externalId = safeExternalId(source.external_id);
  if (!externalId) throw new AuthFailure(400, "printful_external_id_invalid", "Printful order evidence has no valid external identifier.");
  const providerStoreId = optionalNumericId(source.store_id ?? source.store);
  const expectedStoreId = optionalNumericId(options.expectedStoreId);
  if (expectedStoreId && providerStoreId && providerStoreId !== expectedStoreId) {
    throw new AuthFailure(409, "printful_store_mismatch", "Printful order evidence belongs to a different store.");
  }
  if (options.expectedExternalId && externalId !== options.expectedExternalId) {
    throw new AuthFailure(409, "printful_external_id_mismatch", "Printful order evidence belongs to a different local order.");
  }
  const providerStatus = boundedToken(source.status, 40) || "unknown";
  const providerState = mapPrintfulProviderState(providerStatus);
  const occurredAt = normalizedTimestamp(options.occurredAt ?? source.updated_at ?? source.updated ?? source.created_at ?? source.created);
  if (!occurredAt) throw new AuthFailure(400, "printful_evidence_timestamp_invalid", "Printful order evidence has no valid timestamp.");
  return {
    provider: "printful",
    providerStoreId: providerStoreId || expectedStoreId,
    providerOrderId,
    externalId,
    providerStatus,
    providerState,
    confirmationState: providerStatus === "draft" ? "unconfirmed" : providerState === "unknown" ? "unknown" : "submitted",
    providerCreatedAt: normalizedTimestamp(source.created_at ?? source.created),
    providerUpdatedAt: normalizedTimestamp(source.updated_at ?? source.updated),
    occurredAt,
    failureCategory: boundedFailureCategory(options.failureCategory),
    items: normalizeOrderItems(source.items),
    shipments: Array.isArray(source.shipments)
      ? source.shipments.map((shipment) => normalizePrintfulShipmentEvidence(shipment, { occurredAt })).filter(Boolean)
      : [],
  };
}

export function normalizePrintfulShipmentEvidence(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const providerShipmentId = optionalNumericId(value.id);
  if (!providerShipmentId) throw new AuthFailure(400, "printful_shipment_id_invalid", "Printful shipment evidence is invalid.");
  const eventType = boundedToken(options.eventType, 40);
  const providerStatus = boundedToken(value.shipment_status ?? value.status, 40) || null;
  const deliveredAt = normalizedTimestamp(value.delivered_at);
  const returnedAt = eventType === "shipment_returned" ? normalizedTimestamp(options.occurredAt) : null;
  let shipmentState = "unknown";
  if (eventType === "shipment_returned") shipmentState = "returned";
  else if (eventType === "shipment_canceled" || providerStatus === "canceled") shipmentState = "canceled";
  else if (eventType === "shipment_delivered" || deliveredAt || boundedToken(value.delivery_status, 40) === "delivered") shipmentState = "delivered";
  else if (eventType === "shipment_sent" || normalizedTimestamp(value.shipped_at ?? value.created_at ?? value.created)) shipmentState = "shipped";
  const trackingNumber = boundedTracking(value.tracking_number, 180);
  const trackingUrl = safeTrackingUrl(value.tracking_url);
  const itemSource = Array.isArray(value.shipment_items) ? value.shipment_items : Array.isArray(value.items) ? value.items : [];
  return {
    providerShipmentId,
    shipmentState,
    providerStatus,
    carrier: boundedText(value.carrier, 80) || null,
    service: boundedText(value.service, 120) || null,
    trackingNumber,
    trackingUrl,
    trackingAvailable: Boolean(trackingNumber || trackingUrl),
    reshipment: value.is_reshipment === true || value.reshipment === true,
    reshipmentOfProviderShipmentId: optionalNumericId(value.reshipment_of_shipment_id),
    returnedReasonCategory: boundedFailureCategory(options.returnedReasonCategory),
    providerCreatedAt: normalizedTimestamp(value.created_at ?? value.created),
    shippedAt: normalizedTimestamp(value.shipped_at ?? value.created),
    deliveredAt,
    returnedAt,
    occurredAt: normalizedTimestamp(options.occurredAt ?? value.updated_at ?? value.shipped_at ?? value.created_at ?? value.created),
    items: itemSource.map(normalizeShipmentItem).filter(Boolean),
  };
}

export function mapPrintfulProviderState(value) {
  const status = boundedToken(value, 40);
  if (status === "draft") return "draft";
  if (new Set(["pending", "inreview"]).has(status)) return "submitted";
  if (status === "inprocess") return "processing";
  if (status === "onhold") return "on_hold";
  if (status === "partial") return "partial";
  if (status === "fulfilled") return "complete";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  if (status === "archived") return "archived";
  return "unknown";
}

export function reducePrintfulProviderState(current, evidence) {
  const currentState = current?.providerState || "unknown";
  const nextState = evidence?.providerState || "unknown";
  const currentTime = Date.parse(current?.lastProviderEvidenceAt || "");
  const nextTime = Date.parse(evidence?.occurredAt || "");
  if (!Number.isFinite(nextTime)) throw new AuthFailure(400, "printful_evidence_timestamp_invalid", "Printful evidence has no valid timestamp.");
  if (Number.isFinite(currentTime) && nextTime < currentTime) return { applied: false, stale: true, state: currentState };
  if (currentState === "canceled" && nextState !== "canceled") return { applied: false, stale: false, state: currentState };
  if (new Set(["complete", "archived"]).has(currentState) && !new Set(["complete", "archived"]).has(nextState)) {
    return { applied: false, stale: false, state: currentState };
  }
  if (nextState === "unknown" && currentState !== "unknown") return { applied: false, stale: false, state: currentState };
  if (currentState === "partial" && (PROVIDER_STATE_RANK[nextState] || 0) < PROVIDER_STATE_RANK.partial) {
    return { applied: false, stale: false, state: currentState };
  }
  if (currentState === nextState && Number.isFinite(currentTime) && nextTime === currentTime) {
    return { applied: false, stale: false, state: currentState };
  }
  return { applied: true, stale: false, state: nextState };
}

export function deriveFulfillmentState(items, shipments, providerState = "unknown") {
  if (providerState === "canceled") return { state: "canceled", required: totalOrdered(items), covered: 0 };
  if (providerState === "failed" || providerState === "on_hold") return { state: "action_required", required: totalOrdered(items), covered: coveredQuantity(items, shipments) };
  const required = totalOrdered(items);
  const covered = coveredQuantity(items, shipments);
  const originalShipments = shipments.filter((shipment) => shipment.reshipment !== true);
  const returned = originalShipments.some((shipment) => shipment.shipmentState === "returned");
  if (returned) return { state: "returned", required, covered };
  if (!required || !covered) {
    if (providerState === "draft") return { state: "unfulfilled", required, covered };
    if (new Set(["submitted", "processing", "partial"]).has(providerState)) return { state: "processing", required, covered };
    return { state: providerState === "unknown" ? "unknown" : "unfulfilled", required, covered };
  }
  if (covered < required) return { state: "partial", required, covered };
  const relevant = originalShipments.filter((shipment) => shipment.items?.length && !new Set(["canceled", "unknown"]).has(shipment.shipmentState));
  if (relevant.length && relevant.every((shipment) => shipment.shipmentState === "delivered")) return { state: "delivered", required, covered: required };
  return { state: "shipped", required, covered: required };
}

export async function reconcilePrintfulOrderEvidence(env, rawEvidence, options = {}) {
  const db = requireCommerceDb(env);
  const expectedStoreId = requiredNumericId(options.expectedStoreId ?? env?.PRINTFUL_STORE_ID, "printful_store_not_configured");
  const evidence = rawEvidence?.providerOrderId ? rawEvidence : normalizePrintfulOrderEvidence(rawEvidence, { ...options, expectedStoreId });
  if (evidence.provider !== "printful" || evidence.providerStoreId !== expectedStoreId) {
    throw new AuthFailure(409, "printful_store_mismatch", "Printful evidence does not match the configured store.");
  }
  const explicitLocalOrderId = safeExternalId(options.localOrderId);
  const existingRelationship = explicitLocalOrderId ? null : await db.prepare(`SELECT order_id FROM commerce_fulfillment_orders
    WHERE provider='printful' AND provider_store_id=? AND external_id=? LIMIT 1`).bind(expectedStoreId, evidence.externalId).first();
  const localOrderId = explicitLocalOrderId || existingRelationship?.order_id || evidence.externalId;
  const order = await db.prepare("SELECT id,environment,fulfillment_provider,printful_order_id FROM commerce_orders WHERE id=? LIMIT 1").bind(localOrderId).first();
  if (!order) throw new AuthFailure(404, "printful_local_order_not_found", "No local commerce order matches the Printful external identifier.");
  if (order.fulfillment_provider !== "printful") throw new AuthFailure(409, "printful_local_provider_conflict", "The local order has a different fulfillment provider.");
  const environment = order.environment === "live" ? "live" : "test";
  const localItemsResult = await db.prepare("SELECT id,quantity,fulfillment_variant_id FROM commerce_order_items WHERE order_id=? ORDER BY line_number").bind(order.id).all();
  const localItems = localItemsResult?.results || [];
  let fulfillment = await db.prepare("SELECT * FROM commerce_fulfillment_orders WHERE order_id=? AND provider='printful' LIMIT 1").bind(order.id).first();
  if (fulfillment && (fulfillment.provider_order_id !== evidence.providerOrderId || fulfillment.external_id !== evidence.externalId || fulfillment.provider_store_id !== expectedStoreId)) {
    throw new AuthFailure(409, "printful_order_relationship_conflict", "Printful evidence conflicts with the existing local provider-order authority.");
  }
  if (order.printful_order_id && order.printful_order_id !== evidence.providerOrderId) {
    throw new AuthFailure(409, "printful_legacy_order_conflict", "Printful evidence conflicts with the existing local order link.");
  }

  const timestamp = nowIso();
  let providerStateChanged = false;
  let created = false;
  if (!fulfillment) {
    const id = prefixedId("flo");
    const initialFulfillment = deriveFulfillmentState(localItems.map((item) => ({ orderedQuantity: Number(item.quantity) })), evidence.shipments, evidence.providerState);
    await db.prepare(`INSERT INTO commerce_fulfillment_orders (
      id,order_id,provider,provider_store_id,provider_order_id,external_id,environment,
      provider_state,fulfillment_state,confirmation_state,provider_status,failure_category,
      provider_created_at,provider_updated_at,last_provider_evidence_at,created_at,updated_at
    ) VALUES (?,?,'printful',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, order.id, expectedStoreId, evidence.providerOrderId, evidence.externalId, environment,
      evidence.providerState, initialFulfillment.state, evidence.confirmationState, evidence.providerStatus,
      evidence.failureCategory || null, evidence.providerCreatedAt || null, evidence.providerUpdatedAt || null,
      evidence.occurredAt, timestamp, timestamp,
    ).run();
    fulfillment = await db.prepare("SELECT * FROM commerce_fulfillment_orders WHERE id=?").bind(id).first();
    created = true;
    providerStateChanged = true;
  } else {
    const reduction = reducePrintfulProviderState({ providerState: fulfillment.provider_state, lastProviderEvidenceAt: fulfillment.last_provider_evidence_at }, evidence);
    if (reduction.applied) {
      await db.prepare(`UPDATE commerce_fulfillment_orders SET
        provider_state=?,confirmation_state=?,provider_status=?,failure_category=?,
        provider_created_at=COALESCE(provider_created_at,?),provider_updated_at=COALESCE(?,provider_updated_at),
        last_provider_evidence_at=?,revision=revision+1,updated_at=? WHERE id=?`).bind(
        reduction.state, evidence.confirmationState, evidence.providerStatus, evidence.failureCategory || fulfillment.failure_category,
        evidence.providerCreatedAt || null, evidence.providerUpdatedAt || null, evidence.occurredAt, timestamp, fulfillment.id,
      ).run();
      providerStateChanged = reduction.state !== fulfillment.provider_state;
      fulfillment = await db.prepare("SELECT * FROM commerce_fulfillment_orders WHERE id=?").bind(fulfillment.id).first();
    }
  }

  await reconcileFulfillmentItems(db, fulfillment.id, localItems, evidence.items, timestamp);
  let shipmentChanged = false;
  for (const shipment of evidence.shipments) {
    shipmentChanged = (await reconcileShipment(env, db, fulfillment, shipment, timestamp)) || shipmentChanged;
  }
  const projection = await recomputeFulfillmentState(db, fulfillment.id, timestamp);
  await db.prepare("UPDATE commerce_orders SET printful_order_id=COALESCE(printful_order_id,?),updated_at=CASE WHEN printful_order_id IS NULL THEN ? ELSE updated_at END WHERE id=? AND (printful_order_id IS NULL OR printful_order_id=?)")
    .bind(evidence.providerOrderId, timestamp, order.id, evidence.providerOrderId).run();

  if (created) await safeFulfillmentAudit(env, "fulfillment.provider_order_recorded", order.id, environment);
  else if (providerStateChanged) await safeFulfillmentAudit(env, "fulfillment.provider_status_changed", order.id, environment);
  if (shipmentChanged) await safeFulfillmentAudit(env, projection.state === "returned" ? "fulfillment.shipment_returned" : "fulfillment.shipment_recorded", order.id, environment);
  return { created, providerStateChanged, shipmentChanged, fulfillmentOrderId: fulfillment.id, orderId: order.id, environment, ...projection };
}

export function normalizePrintfulV2WebhookEnvelope(value, expectedStoreId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthFailure(400, "printful_webhook_payload_invalid", "The Printful webhook payload is invalid.");
  const type = boundedToken(value.type, 60);
  if (!PRINTFUL_V2_WEBHOOK_EVENTS.includes(type)) throw new AuthFailure(400, "printful_webhook_type_unsupported", "The Printful webhook event type is unsupported.");
  const storeId = requiredNumericId(value.store_id, "printful_webhook_store_invalid");
  if (storeId !== requiredNumericId(expectedStoreId, "printful_store_not_configured")) throw new AuthFailure(403, "printful_webhook_store_mismatch", "The Printful webhook store is not accepted.");
  const occurredAt = normalizedTimestamp(value.occurred_at);
  const retries = Number(value.retries);
  if (!occurredAt || !Number.isSafeInteger(retries) || retries < 0 || retries > 1_000_000 || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
    throw new AuthFailure(400, "printful_webhook_payload_invalid", "The Printful webhook payload is invalid.");
  }
  const order = value.data.order;
  if (!order || typeof order !== "object" || Array.isArray(order)) throw new AuthFailure(400, "printful_webhook_order_invalid", "The Printful webhook order evidence is invalid.");
  const failureCategory = type === "order_failed" ? "provider_failure" : type === "order_canceled" ? "provider_canceled" : type === "order_put_hold" ? "provider_hold" : null;
  const orderEvidence = normalizePrintfulOrderEvidence(order, { expectedStoreId: storeId, occurredAt, failureCategory });
  if (type === "order_failed") { orderEvidence.providerState = "failed"; orderEvidence.confirmationState = "submitted"; }
  if (type === "order_canceled") { orderEvidence.providerState = "canceled"; orderEvidence.confirmationState = "submitted"; }
  if (type === "order_put_hold") { orderEvidence.providerState = "on_hold"; orderEvidence.confirmationState = "submitted"; }
  if (type.startsWith("shipment_")) {
    const returnedReasonCategory = type === "shipment_returned" ? "package_returned" : type === "shipment_canceled" ? "shipment_canceled" : null;
    orderEvidence.shipments = [normalizePrintfulShipmentEvidence(value.data.shipment, { eventType: type, occurredAt, returnedReasonCategory })];
  }
  return { type, occurredAt, retries, storeId, orderEvidence };
}

export async function canonicalPrintfulWebhookDigest(value) {
  const canonical = value && typeof value === "object" && !Array.isArray(value)
    ? { type: value.type, occurred_at: value.occurred_at, store_id: value.store_id, data: value.data }
    : value;
  return sha256Hex(encoder.encode(stableJson(canonical)));
}

export async function processPrintfulWebhookEvidence(env, envelope, payloadSha256, receivedAt = nowIso()) {
  const db = requireCommerceDb(env);
  const eventId = `pwe_${payloadSha256}`;
  const providerShipmentId = envelope.orderEvidence.shipments[0]?.providerShipmentId || null;
  const existing = await db.prepare("SELECT processing_status,result_code,retry_count FROM commerce_provider_webhook_events WHERE id=?").bind(eventId).first();
  if (existing) {
    await db.prepare("UPDATE commerce_provider_webhook_events SET retry_count=MAX(retry_count,?) WHERE id=?").bind(envelope.retries, eventId).run();
    return { duplicate: true, status: existing.processing_status, resultCode: existing.result_code || "duplicate" };
  }
  await db.prepare(`INSERT INTO commerce_provider_webhook_events (
    id,provider,event_type,occurred_at,provider_store_id,provider_order_id,provider_shipment_id,
    payload_sha256,processing_status,retry_count,received_at
  ) VALUES (?,'printful',?,?,?,?,?,?,'received',?,?)`).bind(
    eventId, envelope.type, envelope.occurredAt, envelope.storeId, envelope.orderEvidence.providerOrderId,
    providerShipmentId, payloadSha256, envelope.retries, receivedAt,
  ).run();
  try {
    const result = await reconcilePrintfulOrderEvidence(env, envelope.orderEvidence, { expectedStoreId: envelope.storeId });
    const email = await shipmentNotificationIntent(env, result, envelope.type);
    const processedAt = nowIso();
    const resultCode = result.shipmentChanged ? "shipment_reconciled" : result.providerStateChanged || result.created ? "provider_order_reconciled" : "accepted_noop";
    await db.prepare("UPDATE commerce_provider_webhook_events SET processing_status='processed',result_code=?,processed_at=? WHERE id=?").bind(resultCode, processedAt, eventId).run();
    return { duplicate: false, status: "processed", resultCode, email, result };
  } catch (error) {
    if (error instanceof AuthFailure && new Set(["printful_local_order_not_found", "printful_local_provider_conflict", "printful_order_relationship_conflict", "printful_legacy_order_conflict"]).has(error.code)) {
      await db.prepare("UPDATE commerce_provider_webhook_events SET processing_status='unresolved',result_code=?,processed_at=? WHERE id=?").bind(error.code, nowIso(), eventId).run();
      return { duplicate: false, status: "unresolved", resultCode: error.code };
    }
    await db.prepare("UPDATE commerce_provider_webhook_events SET processing_status='error',result_code='processing_failed',processed_at=? WHERE id=?").bind(nowIso(), eventId).run();
    throw error;
  }
}

export async function shipmentNotificationIntent(env, transition, eventType) {
  if (!String(eventType || "").startsWith("shipment_")) return { requested: false, status: "not_applicable", deliveryCreated: false, providerCallMade: false };
  const row = await requireCommerceDb(env).prepare("SELECT value_json FROM commerce_settings WHERE setting_key='transactional_email_enabled'").first();
  const enabled = parseJson(row?.value_json, false) === true;
  return {
    requested: false,
    status: enabled ? "workflow_not_activated" : "disabled_global_gate",
    templateKey: "shipment_notification",
    orderId: transition?.orderId || null,
    deliveryCreated: false,
    providerCallMade: false,
  };
}

export async function fulfillmentDetailForOrder(env, rawOrderId, { includeTracking = true } = {}) {
  const db = requireCommerceDb(env);
  const orderId = safeExternalId(rawOrderId);
  const fulfillment = orderId ? await db.prepare("SELECT * FROM commerce_fulfillment_orders WHERE order_id=? AND provider='printful' LIMIT 1").bind(orderId).first() : null;
  if (!fulfillment) return emptyFulfillmentDetail();
  const [itemsResult, shipmentsResult, coverageResult, eventsResult] = await Promise.all([
    db.prepare(`SELECT fi.id,fi.order_item_id,fi.provider_order_item_id,fi.ordered_quantity,
      i.product_name,i.variant_name FROM commerce_fulfillment_order_items fi
      JOIN commerce_order_items i ON i.id=fi.order_item_id WHERE fi.fulfillment_order_id=? ORDER BY i.line_number`).bind(fulfillment.id).all(),
    db.prepare("SELECT * FROM commerce_fulfillment_shipments WHERE fulfillment_order_id=? ORDER BY provider_created_at,provider_shipment_id").bind(fulfillment.id).all(),
    db.prepare("SELECT shipment_id,fulfillment_item_id,quantity FROM commerce_fulfillment_shipment_items WHERE shipment_id IN (SELECT id FROM commerce_fulfillment_shipments WHERE fulfillment_order_id=?) ORDER BY shipment_id,fulfillment_item_id").bind(fulfillment.id).all(),
    db.prepare(`SELECT id,event_type,occurred_at,processing_status,result_code,retry_count,received_at,processed_at
      FROM commerce_provider_webhook_events WHERE provider='printful' AND provider_order_id=?
      ORDER BY occurred_at DESC,id DESC LIMIT 40`).bind(fulfillment.provider_order_id).all(),
  ]);
  const coverage = new Map();
  for (const row of coverageResult?.results || []) {
    if (!coverage.has(row.shipment_id)) coverage.set(row.shipment_id, []);
    coverage.get(row.shipment_id).push({ fulfillmentItemId: row.fulfillment_item_id, quantity: Number(row.quantity) });
  }
  const shipments = [];
  for (const row of shipmentsResult?.results || []) {
    let trackingReference = null;
    let trackingUrl = null;
    if (includeTracking && row.tracking_number_ciphertext) trackingReference = boundedTracking(await decryptCommerceSecret(env, row.tracking_number_ciphertext, `shipment-tracking-number:${row.id}`), 180);
    if (includeTracking && row.tracking_url_ciphertext) trackingUrl = safeTrackingUrl(await decryptCommerceSecret(env, row.tracking_url_ciphertext, `shipment-tracking-url:${row.id}`));
    shipments.push({
      id: row.id, providerShipmentId: row.provider_shipment_id, state: row.shipment_state,
      providerStatus: row.provider_status || null, carrier: row.carrier || null, service: row.service || null,
      trackingAvailable: row.tracking_available === 1, trackingReference, trackingUrl,
      reshipment: row.reshipment === 1, reshipmentOfShipmentId: row.reshipment_of_shipment_id || null,
      returnedReasonCategory: row.returned_reason_category || null, shippedAt: row.shipped_at || null,
      deliveredAt: row.delivered_at || null, returnedAt: row.returned_at || null,
      lastProviderEvidenceAt: row.last_provider_evidence_at, items: coverage.get(row.id) || [],
    });
  }
  return {
    available: true,
    id: fulfillment.id,
    provider: "printful",
    providerOrderId: fulfillment.provider_order_id,
    externalId: fulfillment.external_id,
    environment: fulfillment.environment,
    providerState: fulfillment.provider_state,
    fulfillmentState: fulfillment.fulfillment_state,
    confirmationState: fulfillment.confirmation_state,
    providerStatus: fulfillment.provider_status,
    failureCategory: fulfillment.failure_category || null,
    providerCreatedAt: fulfillment.provider_created_at || null,
    providerUpdatedAt: fulfillment.provider_updated_at || null,
    lastProviderEvidenceAt: fulfillment.last_provider_evidence_at,
    shipmentCount: shipments.length,
    trackingAvailable: shipments.some((shipment) => shipment.trackingAvailable),
    items: (itemsResult?.results || []).map((row) => ({ id: row.id, orderItemId: row.order_item_id, providerOrderItemId: row.provider_order_item_id || null, orderedQuantity: Number(row.ordered_quantity), productName: row.product_name, variantName: row.variant_name || null })),
    shipments,
    evidence: (eventsResult?.results || []).map((row) => ({ id: row.id, type: row.event_type, occurredAt: row.occurred_at, status: row.processing_status, resultCode: row.result_code || null, retryCount: Number(row.retry_count), receivedAt: row.received_at, processedAt: row.processed_at || null })),
    shipmentNotification: { status: "disabled_global_gate", sendsEnabled: false, deliveryCreated: false },
  };
}

export async function fulfillmentOperationsPayload(env, input = {}) {
  const db = requireCommerceDb(env);
  const pageSize = [20, 50, 75, 100].includes(Number(input.pageSize)) ? Number(input.pageSize) : 20;
  const requestedPage = Number(input.page || 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const requiredTables = ["commerce_fulfillment_order_items", "commerce_fulfillment_orders", "commerce_fulfillment_shipment_items", "commerce_fulfillment_shipments", "commerce_provider_webhook_events"];
  const tables = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${requiredTables.map(() => "?").join(",")})`).bind(...requiredTables).all();
  const schemaReady = new Set((tables?.results || []).map((row) => row.name)).size === requiredTables.length;
  if (!schemaReady) return emptyFulfillmentOperations(pageSize, "migration_required");
  const count = await db.prepare("SELECT COUNT(*) count FROM commerce_fulfillment_orders").first();
  const total = Number(count?.count || 0);
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  const boundedPage = totalPages ? Math.min(page, totalPages) : 1;
  const offset = (boundedPage - 1) * pageSize;
  const [rowsResult, counts] = await Promise.all([
    db.prepare(`SELECT f.*,o.payment_status,
      (SELECT COUNT(*) FROM commerce_fulfillment_shipments s WHERE s.fulfillment_order_id=f.id) shipment_count,
      EXISTS(SELECT 1 FROM commerce_fulfillment_shipments s WHERE s.fulfillment_order_id=f.id AND s.tracking_available=1) tracking_available
      FROM commerce_fulfillment_orders f JOIN commerce_orders o ON o.id=f.order_id
      ORDER BY f.updated_at DESC,f.id DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all(),
    db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN environment='test' THEN 1 ELSE 0 END) test_orders,
      SUM(CASE WHEN environment='live' THEN 1 ELSE 0 END) live_orders,
      SUM(CASE WHEN environment='test' THEN 0 ELSE CASE WHEN fulfillment_state='partial' THEN 1 ELSE 0 END END) live_partial,
      SUM(CASE WHEN environment='test' THEN 0 ELSE CASE WHEN fulfillment_state IN ('shipped','delivered') THEN 1 ELSE 0 END END) live_shipped,
      (SELECT COUNT(*) FROM commerce_fulfillment_shipments) shipments,
      (SELECT SUM(CASE WHEN f2.environment='test' THEN 1 ELSE 0 END) FROM commerce_fulfillment_shipments s2 JOIN commerce_fulfillment_orders f2 ON f2.id=s2.fulfillment_order_id) test_shipments,
      (SELECT SUM(CASE WHEN f2.environment='live' THEN 1 ELSE 0 END) FROM commerce_fulfillment_shipments s2 JOIN commerce_fulfillment_orders f2 ON f2.id=s2.fulfillment_order_id) live_shipments
      FROM commerce_fulfillment_orders`).first(),
  ]);
  return {
    state: "ready",
    rows: (rowsResult?.results || []).map((row) => ({
      id: row.id, orderId: row.order_id, environment: row.environment, paymentStatus: row.payment_status,
      provider: row.provider, providerOrderId: row.provider_order_id, confirmationState: row.confirmation_state,
      providerState: row.provider_state, providerStatus: row.provider_status, fulfillmentState: row.fulfillment_state,
      shipmentCount: Number(row.shipment_count || 0), trackingAvailable: row.tracking_available === 1,
      lastProviderEvidenceAt: row.last_provider_evidence_at,
    })),
    page: boundedPage, pageSize, total, totalPages,
    counts: {
      total: Number(counts?.total || 0), testOrders: Number(counts?.test_orders || 0), liveOrders: Number(counts?.live_orders || 0),
      livePartial: Number(counts?.live_partial || 0), liveShipped: Number(counts?.live_shipped || 0),
      shipments: Number(counts?.shipments || 0), testShipments: Number(counts?.test_shipments || 0), liveShipments: Number(counts?.live_shipments || 0),
    },
  };
}

function emptyFulfillmentOperations(pageSize, state = "ready") {
  return {
    state, rows: [], page: 1, pageSize, total: 0, totalPages: 0,
    counts: { total: 0, testOrders: 0, liveOrders: 0, livePartial: 0, liveShipped: 0, shipments: 0, testShipments: 0, liveShipments: 0 },
  };
}

export async function reconcileStoredPrintfulOrder(env, rawOrderId, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new AuthFailure(503, "printful_reconciliation_fetch_required", "Printful reconciliation requires an explicitly injected provider boundary.");
  const db = requireCommerceDb(env);
  const orderId = safeExternalId(rawOrderId);
  if (!orderId) throw new AuthFailure(400, "order_id_invalid", "The commerce order identifier is invalid.");
  const token = String(env?.PRINTFUL_API_TOKEN || "").trim();
  const storeId = requiredNumericId(env?.PRINTFUL_STORE_ID, "printful_store_not_configured");
  if (!token || token.length > 4096) throw new AuthFailure(503, "printful_api_not_configured", "Printful reconciliation is not configured.");
  const externalId = await buildPrintfulOrderExternalId(orderId);
  const response = await fetchImpl(`${PRINTFUL_ORDERS_URL}/@${encodeURIComponent(externalId)}`, {
    method: "GET", redirect: "manual", headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "X-PF-Store-Id": storeId },
  });
  if (!response?.ok) throw new AuthFailure(502, "printful_reconciliation_failed", "Printful order reconciliation failed.");
  let payload;
  try { payload = await response.json(); } catch { throw new AuthFailure(502, "printful_reconciliation_response_invalid", "Printful returned invalid reconciliation evidence."); }
  const evidence = normalizePrintfulOrderEvidence(payload, { expectedStoreId: storeId, expectedExternalId: externalId });
  const existing = await db.prepare("SELECT provider_order_id FROM commerce_fulfillment_orders WHERE order_id=? AND provider='printful'").bind(orderId).first();
  if (existing && existing.provider_order_id !== evidence.providerOrderId) throw new AuthFailure(409, "printful_order_relationship_conflict", "Printful reconciliation conflicts with local authority.");
  return reconcilePrintfulOrderEvidence(env, evidence, { expectedStoreId: storeId, localOrderId: orderId });
}

async function reconcileFulfillmentItems(db, fulfillmentOrderId, localItems, providerItems, timestamp) {
  const providerByExternal = new Map(providerItems.filter((item) => item.externalId).map((item) => [item.externalId, item]));
  const providerByPosition = providerItems.length === localItems.length ? providerItems : [];
  for (let index = 0; index < localItems.length; index += 1) {
    const local = localItems[index];
    const provider = providerByExternal.get(local.id) || providerByPosition[index] || null;
    await db.prepare(`INSERT INTO commerce_fulfillment_order_items (
      id,fulfillment_order_id,order_item_id,provider_order_item_id,provider_variant_id,ordered_quantity,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(fulfillment_order_id,order_item_id) DO UPDATE SET
      provider_order_item_id=COALESCE(excluded.provider_order_item_id,commerce_fulfillment_order_items.provider_order_item_id),
      provider_variant_id=COALESCE(excluded.provider_variant_id,commerce_fulfillment_order_items.provider_variant_id),
      updated_at=excluded.updated_at`).bind(
      prefixedId("fli"), fulfillmentOrderId, local.id, provider?.providerOrderItemId || null,
      provider?.providerVariantId || local.fulfillment_variant_id || null, Number(local.quantity), timestamp, timestamp,
    ).run();
  }
}

async function reconcileShipment(env, db, fulfillment, shipment, timestamp) {
  if (!shipment?.providerShipmentId || !shipment.occurredAt) return false;
  let row = await db.prepare("SELECT * FROM commerce_fulfillment_shipments WHERE fulfillment_order_id=? AND provider_shipment_id=?").bind(fulfillment.id, shipment.providerShipmentId).first();
  if (row && Date.parse(shipment.occurredAt) < Date.parse(row.last_provider_evidence_at)) return false;
  const shipmentId = row?.id || prefixedId("fls");
  const trackingNumberCiphertext = shipment.trackingNumber ? await encryptCommerceSecret(env, shipment.trackingNumber, `shipment-tracking-number:${shipmentId}`) : row?.tracking_number_ciphertext || null;
  const trackingUrlCiphertext = shipment.trackingUrl ? await encryptCommerceSecret(env, shipment.trackingUrl, `shipment-tracking-url:${shipmentId}`) : row?.tracking_url_ciphertext || null;
  let reshipmentOf = null;
  if (shipment.reshipmentOfProviderShipmentId) {
    const original = await db.prepare("SELECT id FROM commerce_fulfillment_shipments WHERE fulfillment_order_id=? AND provider_shipment_id=?").bind(fulfillment.id, shipment.reshipmentOfProviderShipmentId).first();
    reshipmentOf = original?.id || null;
  }
  if (!row) {
    await db.prepare(`INSERT INTO commerce_fulfillment_shipments (
      id,fulfillment_order_id,provider_shipment_id,shipment_state,provider_status,carrier,service,
      tracking_available,tracking_number_ciphertext,tracking_url_ciphertext,reshipment,reshipment_of_shipment_id,
      returned_reason_category,provider_created_at,shipped_at,delivered_at,returned_at,last_provider_evidence_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      shipmentId, fulfillment.id, shipment.providerShipmentId, shipment.shipmentState, shipment.providerStatus,
      shipment.carrier, shipment.service, shipment.trackingAvailable ? 1 : 0, trackingNumberCiphertext, trackingUrlCiphertext,
      shipment.reshipment ? 1 : 0, reshipmentOf, shipment.returnedReasonCategory, shipment.providerCreatedAt,
      shipment.shippedAt, shipment.deliveredAt, shipment.returnedAt, shipment.occurredAt, timestamp, timestamp,
    ).run();
  } else {
    await db.prepare(`UPDATE commerce_fulfillment_shipments SET shipment_state=?,provider_status=COALESCE(?,provider_status),
      carrier=COALESCE(?,carrier),service=COALESCE(?,service),tracking_available=?,tracking_number_ciphertext=?,tracking_url_ciphertext=?,
      reshipment=?,reshipment_of_shipment_id=COALESCE(?,reshipment_of_shipment_id),returned_reason_category=COALESCE(?,returned_reason_category),
      provider_created_at=COALESCE(provider_created_at,?),shipped_at=COALESCE(?,shipped_at),delivered_at=COALESCE(?,delivered_at),
      returned_at=COALESCE(?,returned_at),last_provider_evidence_at=?,revision=revision+1,updated_at=? WHERE id=?`).bind(
      shipment.shipmentState, shipment.providerStatus, shipment.carrier, shipment.service,
      shipment.trackingAvailable || row.tracking_available === 1 ? 1 : 0, trackingNumberCiphertext, trackingUrlCiphertext,
      shipment.reshipment || row.reshipment === 1 ? 1 : 0, reshipmentOf, shipment.returnedReasonCategory,
      shipment.providerCreatedAt, shipment.shippedAt, shipment.deliveredAt, shipment.returnedAt,
      shipment.occurredAt, timestamp, shipmentId,
    ).run();
  }
  const fulfillmentItemsResult = await db.prepare("SELECT id,order_item_id,provider_order_item_id,ordered_quantity FROM commerce_fulfillment_order_items WHERE fulfillment_order_id=?").bind(fulfillment.id).all();
  const fulfillmentItems = fulfillmentItemsResult?.results || [];
  for (const item of shipment.items) {
    const match = fulfillmentItems.find((candidate) =>
      (item.orderItemExternalId && candidate.order_item_id === item.orderItemExternalId)
      || (item.providerOrderItemId && candidate.provider_order_item_id === item.providerOrderItemId));
    if (!match || item.quantity > Number(match.ordered_quantity)) throw new AuthFailure(409, "printful_shipment_item_conflict", "Printful shipment item evidence conflicts with the local order.");
    await db.prepare(`INSERT INTO commerce_fulfillment_shipment_items (shipment_id,fulfillment_item_id,quantity,created_at)
      VALUES (?,?,?,?) ON CONFLICT(shipment_id,fulfillment_item_id) DO UPDATE SET quantity=MAX(quantity,excluded.quantity)`).bind(shipmentId, match.id, item.quantity, timestamp).run();
  }
  return true;
}

async function recomputeFulfillmentState(db, fulfillmentOrderId, timestamp) {
  const fulfillment = await db.prepare("SELECT provider_state,fulfillment_state FROM commerce_fulfillment_orders WHERE id=?").bind(fulfillmentOrderId).first();
  const [itemsResult, shipmentsResult, coverageResult] = await Promise.all([
    db.prepare("SELECT id,ordered_quantity FROM commerce_fulfillment_order_items WHERE fulfillment_order_id=?").bind(fulfillmentOrderId).all(),
    db.prepare("SELECT id,shipment_state,reshipment FROM commerce_fulfillment_shipments WHERE fulfillment_order_id=?").bind(fulfillmentOrderId).all(),
    db.prepare("SELECT shipment_id,fulfillment_item_id,quantity FROM commerce_fulfillment_shipment_items WHERE shipment_id IN (SELECT id FROM commerce_fulfillment_shipments WHERE fulfillment_order_id=?)").bind(fulfillmentOrderId).all(),
  ]);
  const coverage = coverageResult?.results || [];
  const shipments = (shipmentsResult?.results || []).map((shipment) => ({
    shipmentState: shipment.shipment_state, reshipment: shipment.reshipment === 1,
    items: coverage.filter((row) => row.shipment_id === shipment.id).map((row) => ({ fulfillmentItemId: row.fulfillment_item_id, quantity: Number(row.quantity) })),
  }));
  const items = (itemsResult?.results || []).map((item) => ({ id: item.id, orderedQuantity: Number(item.ordered_quantity) }));
  const derived = deriveFulfillmentState(items, shipments, fulfillment.provider_state);
  if (derived.state !== fulfillment.fulfillment_state) {
    await db.prepare("UPDATE commerce_fulfillment_orders SET fulfillment_state=?,revision=revision+1,updated_at=? WHERE id=?").bind(derived.state, timestamp, fulfillmentOrderId).run();
  }
  return derived;
}

function normalizeOrderItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) return null;
    return {
      providerOrderItemId: optionalNumericId(item.id),
      externalId: safeExternalId(item.external_id),
      providerVariantId: boundedText(item.sync_variant_id ?? item.variant_id ?? item.catalog_variant_id, 160) || null,
      quantity,
    };
  }).filter(Boolean);
}

function normalizeShipmentItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const quantity = Number(item.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) return null;
  return {
    providerOrderItemId: optionalNumericId(item.order_item_id ?? item.item_id),
    orderItemExternalId: safeExternalId(item.order_item_external_id ?? item.external_id),
    quantity,
  };
}

function coveredQuantity(items, shipments) {
  const ordered = new Map(items.map((item) => [item.id, Number(item.orderedQuantity || 0)]));
  const coverage = new Map();
  for (const shipment of shipments) {
    if (shipment.reshipment === true || new Set(["canceled", "unknown"]).has(shipment.shipmentState)) continue;
    for (const item of shipment.items || []) {
      const id = item.fulfillmentItemId || item.id;
      if (!ordered.has(id)) continue;
      coverage.set(id, Math.min(ordered.get(id), (coverage.get(id) || 0) + Number(item.quantity || 0)));
    }
  }
  return [...coverage.values()].reduce((sum, quantity) => sum + quantity, 0);
}

function totalOrdered(items) { return items.reduce((sum, item) => sum + Number(item.orderedQuantity || item.quantity || 0), 0); }
function unwrapOrder(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.code === 200 && value.result && typeof value.result === "object" && !Array.isArray(value.result)) return value.result;
  if (value.data && typeof value.data === "object" && !Array.isArray(value.data) && value.data.id != null) return value.data;
  return value.id != null ? value : null;
}
function prefixedId(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function requiredNumericId(value, code) { const id = optionalNumericId(value); if (!id) throw new AuthFailure(503, code, "Printful numeric identity is not configured or invalid."); return id; }
function optionalNumericId(value) { const id = String(value ?? "").trim(); return /^\d{1,40}$/.test(id) ? id : ""; }
function safeExternalId(value) { const id = boundedText(value, 160); return /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(id) ? id : ""; }
function boundedToken(value, max) { const text = boundedText(value, max).toLowerCase(); return /^[a-z0-9_.-]+$/.test(text) ? text : ""; }
function boundedText(value, max) { const text = String(value ?? "").trim(); return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : ""; }
function boundedTracking(value, max = 180) { const text = boundedText(value, max); return text && /^[\p{L}\p{N} .:_\/-]+$/u.test(text) ? text : null; }
function safeTrackingUrl(value) { try { const url = new URL(String(value || "")); return url.protocol === "https:" && !url.username && !url.password && url.toString().length <= 2048 ? url.toString() : null; } catch { return null; } }
function boundedFailureCategory(value) { const category = boundedToken(value, 80); return category || null; }
function normalizedTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const milliseconds = Number.isFinite(numeric) && String(value).trim() !== "" ? numeric * (numeric < 10_000_000_000 ? 1000 : 1) : Date.parse(String(value));
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return new Date(milliseconds).toISOString();
}
function parseJson(value, fallback) { try { return JSON.parse(String(value || "")); } catch { return fallback; } }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function sha256Hex(bytes) { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function safeFulfillmentAudit(env, action, orderId, environment) {
  await writeCommerceAudit(env, { actorAccountId: null, action, targetType: "commerce_order", targetId: orderId, result: "success", metadata: { provider: "printful", environment } });
}
function emptyFulfillmentDetail() {
  return { available: false, provider: null, providerOrderId: null, externalId: null, environment: null, providerState: "none", fulfillmentState: "unfulfilled", confirmationState: "none", providerStatus: null, failureCategory: null, providerCreatedAt: null, providerUpdatedAt: null, lastProviderEvidenceAt: null, shipmentCount: 0, trackingAvailable: false, items: [], shipments: [], evidence: [], shipmentNotification: { status: "not_applicable", sendsEnabled: false, deliveryCreated: false } };
}
