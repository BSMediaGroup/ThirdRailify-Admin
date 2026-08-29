import {
  AuthFailure,
  errorResponse,
  jsonResponse,
  nowIso,
} from "../../_shared/auth-core.js";
import {
  recordVerifiedStripeWebhookReceipt,
  requireCommerceDb,
} from "../../_shared/commerce-core.js";
import { processStripeCheckoutCompleted, processStripeCheckoutFailed } from "../../_shared/checkout-core.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
export const STRIPE_WEBHOOK_EVENT_ALLOWLIST = Object.freeze([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method !== "POST") {
      throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "POST" });
    }
    return await handleStripeWebhook(request, env);
  } catch (error) {
    if (error instanceof AuthFailure) return errorResponse(error, request, env);
    return jsonResponse(
      { ok: false, error: "stripe_webhook_unavailable", message: "Stripe webhook delivery is temporarily unavailable." },
      { status: 500 },
    );
  }
}

export async function handleStripeWebhook(request, env, now = Date.now()) {
  requireCommerceDb(env);
  const rawBody = await readBoundedRawBody(request);
  let event;
  try {
    event = JSON.parse(decoder.decode(rawBody));
  } catch {
    throw new AuthFailure(400, "stripe_event_invalid", "The Stripe event payload is invalid.");
  }
  const normalized = normalizeStripeEvent(event);
  const webhookSecret = configuredWebhookSecret(env, normalized.livemode);
  if (!webhookSecret) throw new AuthFailure(503, "stripe_webhook_not_configured", `Stripe ${normalized.livemode ? "LIVE" : "TEST"} webhook signing is not configured.`);
  const signature = parseStripeSignature(request.headers.get("stripe-signature"));
  await verifyStripeSignature(webhookSecret, signature, rawBody, now);

  const accepted = STRIPE_WEBHOOK_EVENT_ALLOWLIST.includes(normalized.type);
  const receivedAt = nowIso(now);
  const payloadSha256 = await sha256Hex(rawBody);
  const receipt = {
    eventId: normalized.id,
    eventType: normalized.type,
    eventCreatedAt: normalized.created,
    receivedAt,
    apiVersion: normalized.apiVersion,
    relatedObjectId: normalized.relatedObjectId,
    relatedObjectType: normalized.relatedObjectType,
    payloadSha256,
    livemode: normalized.livemode,
  };
  let stored;
  if (normalized.type === "checkout.session.async_payment_failed") {
    stored = await processStripeCheckoutFailed(env, normalized, receipt);
  } else if (accepted) {
    stored = await processStripeCheckoutCompleted(env, normalized, receipt);
  } else {
    const result = await recordVerifiedStripeWebhookReceipt(env, {
      ...receipt,
      processingStatus: "ignored",
      resultCode: "event_type_ignored",
    });
    stored = { ...result, resultCode: result.duplicate ? "duplicate" : "event_type_ignored" };
  }
  return jsonResponse({
    ok: true,
    received: true,
    duplicate: stored.duplicate,
    eventId: normalized.id,
    result: stored.resultCode,
  });
}

export function parseStripeSignature(headerValue) {
  const value = String(headerValue || "").trim();
  if (!value) throw new AuthFailure(400, "stripe_signature_required", "A Stripe-Signature header is required.");

  const timestamps = [];
  const v1Signatures = [];
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const scheme = part.slice(0, separator).trim();
    const candidate = part.slice(separator + 1).trim();
    if (scheme === "t") timestamps.push(candidate);
    if (scheme === "v1" && /^[0-9a-fA-F]{64}$/.test(candidate)) v1Signatures.push(candidate.toLowerCase());
  }
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0]) || v1Signatures.length === 0) {
    throw new AuthFailure(400, "stripe_signature_invalid", "The Stripe signature header is invalid.");
  }
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp)) {
    throw new AuthFailure(400, "stripe_signature_invalid", "The Stripe signature header is invalid.");
  }
  return { timestamp, v1Signatures };
}

export async function verifyStripeSignature(secret, signature, rawBody, now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  if (signature.timestamp < nowSeconds - STRIPE_WEBHOOK_TOLERANCE_SECONDS
      || signature.timestamp > nowSeconds + STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    throw new AuthFailure(400, "stripe_signature_timestamp_invalid", "The Stripe signature timestamp is outside the accepted window.");
  }

  const prefix = encoder.encode(`${signature.timestamp}.`);
  const signedPayload = new Uint8Array(prefix.length + rawBody.length);
  signedPayload.set(prefix);
  signedPayload.set(rawBody, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const candidate of signature.v1Signatures) {
    if (await crypto.subtle.verify("HMAC", key, hexToBytes(candidate), signedPayload)) return;
  }
  throw new AuthFailure(400, "stripe_signature_invalid", "The Stripe signature is invalid.");
}

export async function readBoundedRawBody(request) {
  const declared = String(request.headers.get("content-length") || "").trim();
  if (/^\d+$/.test(declared) && Number(declared) > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
    throw new AuthFailure(413, "request_too_large", "The request body is too large.");
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new AuthFailure(413, "request_too_large", "The request body is too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function configuredWebhookSecret(env, livemode) {
  const secret = String(livemode ? env?.STRIPE_LIVE_WEBHOOK_SECRET : env?.STRIPE_WEBHOOK_SECRET || "");
  return /^whsec_[^\s]{6,}$/.test(secret) && secret.length <= 512 ? secret : "";
}

function normalizeStripeEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.object !== "event") {
    throw new AuthFailure(400, "stripe_event_invalid", "The Stripe event envelope is invalid.");
  }
  const id = boundedStripeText(value.id, 255);
  const type = boundedStripeText(value.type, 255);
  if (!id || !type || !/^evt_[A-Za-z0-9_]+$/.test(id) || !/^[a-z0-9_.]+$/.test(type)) {
    throw new AuthFailure(400, "stripe_event_invalid", "The Stripe event envelope is invalid.");
  }
  if (typeof value.livemode !== "boolean") {
    throw new AuthFailure(400, "stripe_event_invalid", "The Stripe event envelope is invalid.");
  }
  const created = value.created == null ? null : Number(value.created);
  if (created !== null && (!Number.isSafeInteger(created) || created < 0)) {
    throw new AuthFailure(400, "stripe_event_invalid", "The Stripe event envelope is invalid.");
  }
  const related = value.data?.object;
  return {
    id,
    type,
    created,
    livemode: value.livemode,
    apiVersion: boundedStripeText(value.api_version, 80) || null,
    relatedObjectId: safeStripeIdentifier(related?.id, 255),
    relatedObjectType: safeStripeObjectType(related?.object),
    checkoutSession: type.startsWith("checkout.session.") ? normalizeCheckoutSession(related) : null,
  };
}

function normalizeCheckoutSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.object !== "checkout.session") return null;
  const id = safeStripeIdentifier(value.id, 255);
  if (!id || !/^cs_(?:test|live)_/.test(id)) return null;
  const amountTotal = Number(value.amount_total);
  return {
    id,
    mode: boundedStripeText(value.mode, 40),
    currency: boundedStripeText(value.currency, 3).toLowerCase(),
    amountTotal: Number.isSafeInteger(amountTotal) && amountTotal >= 0 ? amountTotal : null,
    paymentStatus: boundedStripeText(value.payment_status, 40),
    livemode: typeof value.livemode === "boolean" ? value.livemode : null,
    clientReferenceId: safeStripeIdentifier(value.client_reference_id, 255),
    metadataOrderId: safeStripeIdentifier(value.metadata?.order_id, 255),
    metadataCheckoutRequestId: safeStripeIdentifier(value.metadata?.checkout_request_id, 255),
    paymentIntentId: safeStripeIdentifier(typeof value.payment_intent === "string" ? value.payment_intent : value.payment_intent?.id, 255),
    taxAmount: Number.isSafeInteger(Number(value.total_details?.amount_tax)) && Number(value.total_details.amount_tax) >= 0 ? Number(value.total_details.amount_tax) : null,
    automaticTaxStatus: boundedStripeText(value.automatic_tax?.status, 40) || null,
  };
}

function boundedStripeText(value, maxLength) {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return "";
  return value;
}

function safeStripeIdentifier(value, maxLength) {
  const identifier = boundedStripeText(value, maxLength);
  return identifier && /^[A-Za-z0-9_:-]+$/.test(identifier) ? identifier : null;
}

function safeStripeObjectType(value) {
  const objectType = boundedStripeText(value, 120);
  return objectType && /^[a-z0-9_.]+$/.test(objectType) ? objectType : null;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
