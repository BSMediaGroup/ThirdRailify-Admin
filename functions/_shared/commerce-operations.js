import { AuthFailure, cleanText, nowIso, randomId, sendAccountEmail } from "./auth-core.js";
import { decryptCommerceSecret, encryptCommerceSecret, requireCommerceDb, writeCommerceAudit } from "./commerce-core.js";
import { commerceEmailDeliveryKey, prepareStoredPrintfulDraftOrder, renderOrderLifecycleEmail } from "./commerce-control-plane.js";
import {
  PRINTFUL_ORDERS_URL,
  PrintfulApiError,
  buildPrintfulProductionDraftCreateRequest,
  normalizePrintfulApiError,
} from "./printful-api.js";
import { normalizePrintfulOrderEvidence, reconcilePrintfulOrderEvidence } from "./printful-fulfillment.js";
import { PayPalApiError } from "./paypal-client.js";
import { processPayPalRecoveryJob } from "./paypal-commerce.js";

const MAX_BATCH = 10;
const LEASE_MS = 2 * 60 * 1000;
const TERMINAL_PROVIDER_STATES = new Set(["complete", "archived", "canceled"]);

export async function processCommerceJobs(env, fetchImpl = fetch, now = Date.now()) {
  const db = requireCommerceDb(env);
  await enqueueDueReconciliationJobs(db, nowIso(now));
  const due = await db.prepare(`SELECT id FROM commerce_operation_jobs
    WHERE (state IN ('pending','retry') AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?)
    ORDER BY next_attempt_at,created_at LIMIT ?`).bind(nowIso(now), nowIso(now), MAX_BATCH).all();
  const results = [];
  for (const candidate of due?.results || []) {
    const leaseToken = randomId();
    const leased = await db.prepare(`UPDATE commerce_operation_jobs SET state='leased',lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=?
      WHERE id=? AND ((state IN ('pending','retry') AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?))`)
      .bind(leaseToken, nowIso(now + LEASE_MS), nowIso(now), candidate.id, nowIso(now), nowIso(now)).run();
    if (Number(leased?.meta?.changes || 0) !== 1) continue;
    const job = await db.prepare("SELECT * FROM commerce_operation_jobs WHERE id=? AND lease_token=?").bind(candidate.id, leaseToken).first();
    if (!job) continue;
    try {
      const result = job.job_kind === "fulfillment_submit"
        ? await submitPaidLiveOrder(env, job.order_id, fetchImpl)
        : job.job_kind === "fulfillment_reconcile"
          ? await reconcileLiveProviderOrder(env, job.order_id, fetchImpl)
          : job.job_kind.startsWith("paypal_")
            ? await processPayPalRecoveryJob(env, job, fetchImpl)
            : await processEmailJob(env, job, fetchImpl);
      await db.prepare("UPDATE commerce_operation_jobs SET state='completed',lease_token=NULL,lease_expires_at=NULL,last_error_json='{}',completed_at=?,updated_at=? WHERE id=? AND lease_token=?")
        .bind(nowIso(now), nowIso(now), job.id, leaseToken).run();
      results.push({ id: job.id, state: "completed", result });
    } catch (error) {
      const safe = await persistProviderDiagnostic(env, error, job);
      const retryable = error instanceof PrintfulApiError || error instanceof PayPalApiError ? error.retryable : error instanceof AuthFailure ? error.status >= 500 : true;
      const terminal = !retryable || Number(job.attempt_count) >= Number(job.max_attempts);
      const delay = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(8, Number(job.attempt_count))));
      await db.prepare(`UPDATE commerce_operation_jobs SET state=?,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=?,last_error_json=?,updated_at=?
        WHERE id=? AND lease_token=?`).bind(terminal ? "action_required" : "retry", nowIso(now + delay), JSON.stringify(safe).slice(0, 4096), nowIso(now), job.id, leaseToken).run();
      results.push({ id: job.id, state: terminal ? "action_required" : "retry", error: safe });
    }
  }
  return { ok: true, processed: results.length, results };
}

export async function retryCommerceJob(env, rawJobId, actorAccountId) {
  const db = requireCommerceDb(env);
  const jobId = localId(rawJobId, "commerce_job_id_invalid");
  const job = await db.prepare("SELECT id,state,order_id FROM commerce_operation_jobs WHERE id=?").bind(jobId).first();
  if (!job) throw new AuthFailure(404, "commerce_job_not_found", "The commerce operations job was not found.");
  if (job.state !== "action_required") throw new AuthFailure(409, "commerce_job_retry_unavailable", "Only an action-required job can be retried.");
  const timestamp = nowIso();
  await db.prepare("UPDATE commerce_operation_jobs SET state='pending',attempt_count=0,next_attempt_at=?,last_error_json='{}',completed_at=NULL,updated_at=? WHERE id=? AND state='action_required'").bind(timestamp, timestamp, jobId).run();
  await writeCommerceAudit(env, { actorAccountId, action: "commerce.job_retry_requested", targetType: "commerce_operation_job", targetId: jobId, result: "success", metadata: { orderId: job.order_id, reconcileBeforeMutation: true } });
  return { ok: true, jobId, state: "pending", reconcilesBeforeMutation: true };
}

export async function commerceJobsPayload(env) {
  const db = requireCommerceDb(env);
  const [counts, recent] = await Promise.all([
    db.prepare("SELECT state,COUNT(*) count FROM commerce_operation_jobs GROUP BY state").all(),
    db.prepare("SELECT id,job_kind,order_id,environment,state,attempt_count,max_attempts,next_attempt_at,updated_at,last_error_json FROM commerce_operation_jobs ORDER BY updated_at DESC LIMIT 50").all(),
  ]);
  return {
    counts: Object.fromEntries((counts?.results || []).map((row) => [row.state, Number(row.count || 0)])),
    recent: (recent?.results || []).map((row) => ({ id: row.id, kind: row.job_kind, orderId: row.order_id, environment: row.environment, state: row.state, attempts: Number(row.attempt_count), maxAttempts: Number(row.max_attempts), nextAttemptAt: row.next_attempt_at, updatedAt: row.updated_at, lastError: safeJson(row.last_error_json) })),
  };
}

async function submitPaidLiveOrder(env, orderId, fetchImpl) {
  const db = requireCommerceDb(env);
  const [order, settingsResult, paymentAuthority] = await Promise.all([
    db.prepare("SELECT id,environment,customer_payment_provider,payment_status,fulfillment_status,currency_code,customer_gross_amount,cart_digest,stripe_checkout_session_id,printful_order_id FROM commerce_orders WHERE id=?").bind(orderId).first(),
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('fulfillment_submission_enabled','commerce_emergency_paused','printful_order_mode')").all(),
    db.prepare(`SELECT provider,evidence_id FROM (
      SELECT 'paypal' provider,id evidence_id,updated_at evidence_at FROM commerce_payment_attempts
        WHERE commerce_order_id=? AND provider='paypal' AND environment='live' AND normalized_state='completed'
      UNION ALL
      SELECT 'stripe' provider,provider_event_id evidence_id,processed_at evidence_at FROM commerce_webhook_events
        WHERE provider='stripe' AND livemode=1 AND processing_status='processed' AND result_code='payment_confirmed'
          AND related_object_id=(SELECT stripe_checkout_session_id FROM commerce_orders WHERE id=?))
      ORDER BY evidence_at DESC LIMIT 1`).bind(orderId,orderId).first(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, parseJson(row.value_json, null)]));
  requireLiveOrder(order, paymentAuthority, settings);
  const prepared = await prepareStoredPrintfulDraftOrder(env, orderId);
  if (!prepared.eligible || !prepared.internalDraftPayload) throw new AuthFailure(409, prepared.blockers[0]?.code || "printful_order_not_eligible", prepared.blockers[0]?.message || "The order is not eligible for Printful submission.");
  const request = await buildPrintfulProductionDraftCreateRequest({
    localOrderId: orderId,
    targetStoreId: env.PRINTFUL_STORE_ID,
    shippingCode: prepared.internalDraftPayload.shipping,
    recipient: prepared.internalDraftPayload.recipient,
    items: prepared.internalDraftPayload.items,
  });
  const headers = printfulHeaders(env);
  let providerOrder = await getPrintfulOrderByExternalId(fetchImpl, headers, request.externalId, request.payloadDigest);
  if (!providerOrder) {
    const response = await boundedFetch(fetchImpl, request.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
    if (!response.ok) throw await normalizePrintfulApiError(response, { operation: "printful_order_draft_create", payloadDigest: request.payloadDigest });
    providerOrder = await readPrintfulResult(response, "printful_order_draft_response_invalid");
  }
  validateDraft(providerOrder, request);
  if (String(providerOrder.id) === "174104132") throw new AuthFailure(409, "preserved_printful_order_rejected", "The preserved TEST Printful draft can never enter automatic fulfillment.");
  await reconcilePrintfulOrderEvidence(env, normalizePrintfulOrderEvidence(providerOrder, { expectedStoreId: env.PRINTFUL_STORE_ID, expectedExternalId: request.externalId, occurredAt: nowIso() }), { expectedStoreId: env.PRINTFUL_STORE_ID, localOrderId: orderId });
  const fresh = await getPrintfulOrderByExternalId(fetchImpl, headers, request.externalId, request.payloadDigest);
  validateDraft(fresh, request);
  const confirmResponse = await boundedFetch(fetchImpl, `${PRINTFUL_ORDERS_URL}/${encodeURIComponent(String(fresh.id))}/confirm`, { method: "POST", headers });
  if (!confirmResponse.ok) throw await normalizePrintfulApiError(confirmResponse, { operation: "printful_order_confirm", payloadDigest: request.payloadDigest });
  const confirmed = await readPrintfulResult(confirmResponse, "printful_order_confirm_response_invalid");
  if (String(confirmed.id) !== String(fresh.id) || String(confirmed.status || "").toLowerCase() === "draft") throw new AuthFailure(502, "printful_order_confirm_response_invalid", "Printful did not return the confirmed provider order.");
  await reconcilePrintfulOrderEvidence(env, normalizePrintfulOrderEvidence(confirmed, { expectedStoreId: env.PRINTFUL_STORE_ID, expectedExternalId: request.externalId, occurredAt: nowIso() }), { expectedStoreId: env.PRINTFUL_STORE_ID, localOrderId: orderId });
  await db.prepare("UPDATE commerce_orders SET printful_order_id=?,fulfillment_status='submitted',updated_at=? WHERE id=? AND environment='live' AND payment_status='paid'").bind(String(confirmed.id), nowIso(), orderId).run();
  await writeCommerceAudit(env, { actorAccountId: "commerce-operations-worker", action: "printful.live_order_confirmed", targetType: "commerce_order", targetId: orderId, result: "success", metadata: { provider: "printful", environment: "live", externalId: request.externalId, reconciledBeforeCreate: true, confirmed: true } });
  return { orderId, providerOrderId: String(confirmed.id), state: "submitted", reconciledBeforeCreate: true };
}

async function reconcileLiveProviderOrder(env, orderId, fetchImpl) {
  const db = requireCommerceDb(env);
  const fulfillment = await db.prepare("SELECT provider_order_id,external_id,environment FROM commerce_fulfillment_orders WHERE order_id=? AND provider='printful'").bind(orderId).first();
  if (!fulfillment || fulfillment.environment !== "live") throw new AuthFailure(409, "printful_live_order_missing", "No LIVE provider order is available for reconciliation.");
  if (String(fulfillment.provider_order_id) === "174104132") throw new AuthFailure(409, "preserved_printful_order_rejected", "The preserved TEST Printful draft can never enter automatic fulfillment.");
  const response = await boundedFetch(fetchImpl, `${PRINTFUL_ORDERS_URL}/${encodeURIComponent(String(fulfillment.provider_order_id))}`, { method: "GET", headers: printfulHeaders(env) });
  if (!response.ok) throw await normalizePrintfulApiError(response, { operation: "printful_order_reconcile" });
  const providerOrder = await readPrintfulResult(response, "printful_order_response_invalid");
  const evidence = normalizePrintfulOrderEvidence(providerOrder, { expectedStoreId: env.PRINTFUL_STORE_ID, expectedExternalId: fulfillment.external_id, occurredAt: nowIso() });
  const result = await reconcilePrintfulOrderEvidence(env, evidence, { expectedStoreId: env.PRINTFUL_STORE_ID, localOrderId: orderId });
  return { orderId, providerState: result.providerState, terminal: TERMINAL_PROVIDER_STATES.has(result.providerState) };
}

async function processEmailJob(env, job, fetchImpl) {
  const db = requireCommerceDb(env);
  const [order, delivery, settingsResult] = await Promise.all([
    db.prepare("SELECT id,environment,payment_status FROM commerce_orders WHERE id=?").bind(job.order_id).first(),
    db.prepare("SELECT recipient_ciphertext FROM commerce_order_delivery_snapshots WHERE order_id=?").bind(job.order_id).first(),
    db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('transactional_email_enabled','resend_domain_verified','commerce_emergency_paused')").all(),
  ]);
  const settings = Object.fromEntries((settingsResult?.results || []).map((row) => [row.setting_key, parseJson(row.value_json, null)]));
  if (!order || order.environment !== "live" || order.payment_status !== "paid") throw new AuthFailure(409, "transactional_email_order_invalid", "Only a paid LIVE order can trigger transactional email.");
  if (settings.transactional_email_enabled !== true || settings.resend_domain_verified !== true || settings.commerce_emergency_paused === true) throw new AuthFailure(409, "transactional_email_gate_closed", "Transactional email is not enabled and verified.");
  if (!delivery?.recipient_ciphertext) throw new AuthFailure(409, "transactional_email_recipient_unavailable", "The encrypted order recipient is unavailable.");
  const recipientSnapshot = parseJson(await decryptCommerceSecret(env, delivery.recipient_ciphertext, `order-delivery:${order.id}`), null);
  const recipient = normalizedEmail(recipientSnapshot?.customerContact?.email);
  const templateKey = String(job.event_key || "").includes("order_confirmation") ? "order_confirmation" : String(job.event_key || "").startsWith("shipment:") ? "shipment_notification" : "";
  if (!templateKey) throw new AuthFailure(409, "transactional_email_event_invalid", "The transactional email event is unsupported.");
  const overrides = { customer_name: cleanText(recipientSnapshot?.customerContact?.name, 120) || "Customer" };
  if (templateKey === "shipment_notification") {
    const shipment = await db.prepare(`SELECT id,tracking_number_ciphertext FROM commerce_fulfillment_shipments
      WHERE fulfillment_order_id=(SELECT id FROM commerce_fulfillment_orders WHERE order_id=? AND provider='printful')
      AND tracking_available=1 ORDER BY COALESCE(shipped_at,last_provider_evidence_at) DESC LIMIT 1`).bind(order.id).first();
    if (shipment?.tracking_number_ciphertext) overrides.tracking_number = await decryptCommerceSecret(env, shipment.tracking_number_ciphertext, `shipment-tracking-number:${shipment.id}`);
  }
  const message = await renderOrderLifecycleEmail(env, order.id, templateKey, overrides);
  const deliveryKey = await commerceEmailDeliveryKey({ templateKey, templateRevision: message.templateRevision, orderId: order.id, eventKey: job.event_key, recipient });
  const deliveryId = randomId();
  const timestamp = nowIso();
  const recipientCiphertext = await encryptCommerceSecret(env, recipient, `commerce-email-delivery:${deliveryId}`);
  await db.prepare(`INSERT OR IGNORE INTO commerce_email_deliveries
    (id,delivery_key,template_key,template_revision,order_id,event_key,recipient_email,recipient_email_ciphertext,purpose,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'transactional','pending',?,?)`).bind(deliveryId, deliveryKey, templateKey, message.templateRevision, order.id, job.event_key, maskEmail(recipient), recipientCiphertext, timestamp, timestamp).run();
  const ledger = await db.prepare("SELECT id,status,provider_message_id FROM commerce_email_deliveries WHERE delivery_key=?").bind(deliveryKey).first();
  if (ledger.status === "sent") return { orderId: order.id, templateKey, status: "sent", duplicate: true };
  await db.prepare("UPDATE commerce_email_deliveries SET status='sending',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status IN ('pending','failed','sending')").bind(timestamp, ledger.id).run();
  try {
    const result = await sendAccountEmail(env, { to: recipient, subject: message.rendered.subject, html: message.rendered.html, text: message.rendered.text, replyTo: env?.MAIL_REPLY_TO, idempotencyKey: deliveryKey }, fetchImpl);
    await db.prepare("UPDATE commerce_email_deliveries SET status='sent',provider_message_id=?,safe_metadata_json='{}',sent_at=?,updated_at=? WHERE id=?").bind(result?.providerMessageId || null, nowIso(), nowIso(), ledger.id).run();
  } catch (error) {
    await db.prepare("UPDATE commerce_email_deliveries SET status='failed',safe_metadata_json=?,updated_at=? WHERE id=?").bind(JSON.stringify({ error: cleanText(error?.code, 100) || "email_unavailable" }), nowIso(), ledger.id).run();
    throw error;
  }
  return { orderId: order.id, templateKey, status: "sent", duplicate: false };
}

async function enqueueDueReconciliationJobs(db, timestamp) {
  const result = await db.prepare(`SELECT order_id,external_id FROM commerce_fulfillment_orders
    WHERE environment='live' AND provider='printful' AND provider_state NOT IN ('complete','archived','canceled') LIMIT ?`).bind(MAX_BATCH).all();
  for (const row of result?.results || []) {
    const bucket = timestamp.slice(0, 13);
    const digest = await sha256Hex(`${row.order_id}:${row.external_id}:${bucket}`);
    await db.prepare(`INSERT OR IGNORE INTO commerce_operation_jobs
      (id,job_kind,event_key,order_id,environment,payload_digest,state,next_attempt_at,created_at,updated_at)
      VALUES (?,'fulfillment_reconcile',?,?,'live',?,'pending',?,?,?)`)
      .bind(`coj_${randomId()}`, `reconcile:${row.order_id}:${bucket}`, row.order_id, digest, timestamp, timestamp, timestamp).run();
  }
}

function requireLiveOrder(order, paymentAuthority, settings) {
  if (!order || order.environment !== "live" || order.payment_status !== "paid" || !paymentAuthority || paymentAuthority.provider !== order.customer_payment_provider || order.currency_code !== "CAD" || !order.cart_digest) throw new AuthFailure(409, "live_payment_authority_invalid", "Genuine provider-confirmed LIVE payment authority is required.");
  if (settings.fulfillment_submission_enabled !== true || settings.commerce_emergency_paused === true || settings.printful_order_mode !== "draft_then_confirm") throw new AuthFailure(409, "fulfillment_gate_closed", "New provider submission is currently paused.");
  if (String(order.printful_order_id || "") === "174104132") throw new AuthFailure(409, "preserved_printful_order_rejected", "The preserved TEST Printful draft can never enter automatic fulfillment.");
}

function validateDraft(providerOrder, request) {
  if (!providerOrder || String(providerOrder.external_id || "") !== request.externalId || String(providerOrder.status || "").toLowerCase() !== "draft" || String(providerOrder.shipping || "") !== request.body.shipping) throw new AuthFailure(502, "printful_draft_validation_failed", "The reconciled Printful draft does not match the authoritative order.");
  const expectedItems = request.body.items.map((item) => `${item.sync_variant_id}:${item.quantity}`).sort();
  const actualItems = Array.isArray(providerOrder.items) ? providerOrder.items.map((item) => `${Number(item.sync_variant_id)}:${Number(item.quantity)}`).sort() : [];
  if (JSON.stringify(expectedItems) !== JSON.stringify(actualItems)) throw new AuthFailure(502, "printful_draft_items_mismatch", "The reconciled Printful draft items do not match the authoritative order.");
  const expectedRecipient = request.body.recipient;
  const actualRecipient = providerOrder.recipient || {};
  for (const field of ["name", "address1", "city", "country_code", "zip"]) if (String(actualRecipient[field] || "").trim() !== String(expectedRecipient[field] || "").trim()) throw new AuthFailure(502, "printful_draft_recipient_mismatch", "The reconciled Printful draft recipient does not match the encrypted order snapshot.");
}

async function getPrintfulOrderByExternalId(fetchImpl, headers, externalId, payloadDigest) {
  const response = await boundedFetch(fetchImpl, `${PRINTFUL_ORDERS_URL}/@${encodeURIComponent(externalId)}`, { method: "GET", headers });
  if (response.status === 404) return null;
  if (!response.ok) throw await normalizePrintfulApiError(response, { operation: "printful_order_reconcile_before_create", payloadDigest });
  return readPrintfulResult(response, "printful_order_response_invalid");
}

async function readPrintfulResult(response, code) {
  let payload;
  try { payload = await response.json(); } catch { throw new AuthFailure(502, code, "Printful returned an invalid order response."); }
  if (payload?.code !== 200 || !payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) throw new AuthFailure(502, code, "Printful returned an invalid order response.");
  return payload.result;
}

function printfulHeaders(env) {
  const token = String(env?.PRINTFUL_API_TOKEN || "").trim();
  const storeId = String(env?.PRINTFUL_STORE_ID || "").trim();
  if (!token || storeId !== "18668025") throw new AuthFailure(503, "printful_provider_not_configured", "The Printful provider is not configured for the native target store.");
  return { Accept: "application/json", Authorization: `Bearer ${token}`, "X-PF-Store-Id": storeId };
}

async function boundedFetch(fetchImpl, url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try { return await fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal }); }
  catch { throw new PrintfulApiError({ operation: "printful_transport", safeMessage: "Printful transport failed before a complete response was received.", retryable: true }); }
  finally { clearTimeout(timeout); }
}

async function persistProviderDiagnostic(env, error, job) {
  const safe = error instanceof PrintfulApiError ? error.toSafeJSON() : error instanceof PayPalApiError ? { operation:error.operation,httpStatus:error.httpStatus,providerCode:error.providerCode,safeMessage:error.providerReason,requestId:error.debugId,retryable:error.retryable,payloadDigest:error.payloadDigest||job.payload_digest } : { operation: job.job_kind, httpStatus: error instanceof AuthFailure ? error.status : null, providerCode: error instanceof AuthFailure ? error.code : "operation_failed", providerErrorCode: null, safeMessage: cleanText(error?.message, 300) || "Commerce operation failed.", requestId: null, retryable: error instanceof AuthFailure ? error.status >= 500 : true, payloadDigest: job.payload_digest };
  if (job.job_kind.startsWith("fulfillment") || job.job_kind.startsWith("paypal_") || job.job_kind === "email_send") {
    const provider = job.job_kind === "email_send" ? "resend" : job.job_kind.startsWith("paypal_") ? "paypal" : "printful";
    await requireCommerceDb(env).prepare(`INSERT INTO commerce_provider_diagnostics
      (id,provider,operation_kind,http_status,provider_code,provider_reason,request_id,payload_digest,retryable,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(`cpd_${randomId()}`, provider, safe.operation || job.job_kind, safe.httpStatus, safe.providerCode || safe.providerErrorCode, safe.safeMessage, safe.requestId, safe.payloadDigest || job.payload_digest, safe.retryable ? 1 : 0, nowIso()).run();
  }
  return safe;
}

function localId(value, code) { const id = cleanText(value, 160); if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(id)) throw new AuthFailure(400, code, "The identifier is invalid."); return id; }
function parseJson(value, fallback) { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }
function safeJson(value) { const parsed = parseJson(value, {}); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
function normalizedEmail(value) { const email = cleanText(value, 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthFailure(409, "transactional_email_recipient_invalid", "The encrypted order recipient is invalid."); return email; }
function maskEmail(value) { const [local, domain] = value.split("@"); return `${local.slice(0, 1)}***@${domain}`; }
async function sha256Hex(value) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
