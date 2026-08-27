import {
  AuthFailure,
  errorResponse,
  jsonResponse,
  nowIso,
} from "../../_shared/auth-core.js";
import { requireCommerceDb } from "../../_shared/commerce-core.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
export const STRIPE_WEBHOOK_EVENT_ALLOWLIST = Object.freeze(["checkout.session.completed"]);

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
  const webhookSecret = configuredWebhookSecret(env);
  if (!webhookSecret) {
    throw new AuthFailure(503, "stripe_webhook_not_configured", "Stripe webhook signing is not configured.");
  }
  const db = requireCommerceDb(env);
  const rawBody = await readBoundedRawBody(request);
  const signature = parseStripeSignature(request.headers.get("stripe-signature"));
  await verifyStripeSignature(webhookSecret, signature, rawBody, now);

  let event;
  try {
    event = JSON.parse(decoder.decode(rawBody));
  } catch {
    throw new AuthFailure(400, "stripe_event_invalid", "The Stripe event payload is invalid.");
  }
  const normalized = normalizeStripeEvent(event);
  if (normalized.livemode) {
    throw new AuthFailure(400, "stripe_live_event_rejected", "Live-mode Stripe events are not accepted by this staging endpoint.");
  }

  const accepted = STRIPE_WEBHOOK_EVENT_ALLOWLIST.includes(normalized.type);
  const receivedAt = nowIso(now);
  const processingStatus = accepted ? "accepted_noop" : "ignored";
  const resultCode = accepted ? "checkout_disabled" : "event_type_ignored";
  const payloadSha256 = await sha256Hex(rawBody);
  let insert;
  try {
    insert = await db
      .prepare(
        `INSERT OR IGNORE INTO commerce_webhook_events (
           provider, provider_event_id, event_type, event_created_at, received_at, livemode,
           api_version, related_object_id, related_object_type, processing_status,
           processed_at, result_code, payload_sha256
         ) VALUES ('stripe', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        normalized.id,
        normalized.type,
        normalized.created,
        receivedAt,
        normalized.apiVersion,
        normalized.relatedObjectId,
        normalized.relatedObjectType,
        processingStatus,
        receivedAt,
        resultCode,
        payloadSha256,
      )
      .run();
  } catch {
    throw new AuthFailure(503, "stripe_webhook_storage_unavailable", "Stripe webhook receipt storage is unavailable.");
  }

  const duplicate = Number(insert?.meta?.changes || 0) === 0;
  return jsonResponse({
    ok: true,
    received: true,
    duplicate,
    eventId: normalized.id,
    result: duplicate ? "duplicate" : resultCode,
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

function configuredWebhookSecret(env) {
  const secret = String(env?.STRIPE_WEBHOOK_SECRET || "");
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
