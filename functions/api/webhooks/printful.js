import {
  AuthFailure,
  enforceRateLimit,
  errorResponse,
  jsonResponse,
  nowIso,
} from "../../_shared/auth-core.js";
import { requireCommerceDb } from "../../_shared/commerce-core.js";
import {
  canonicalPrintfulWebhookDigest,
  normalizePrintfulV2WebhookEnvelope,
  processPrintfulWebhookEvidence,
} from "../../_shared/printful-fulfillment.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export const PRINTFUL_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "POST" });
    return await handlePrintfulWebhook(request, env);
  } catch (error) {
    if (error instanceof AuthFailure) return errorResponse(error, request, env);
    return jsonResponse({ ok: false, error: "printful_webhook_unavailable", message: "Printful webhook delivery is temporarily unavailable." }, { status: 500 });
  }
}

export async function handlePrintfulWebhook(request, env, now = Date.now()) {
  const configuration = webhookConfiguration(env);
  if (!configuration) throw new AuthFailure(503, "printful_webhook_not_configured", "Printful webhook verification is not configured.");
  requireCommerceDb(env);
  const contentType = String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new AuthFailure(415, "content_type_unsupported", "Printful webhook content type must be application/json.");
  await enforceRateLimit(env, request, "printful_webhook", configuration.publicKey);
  const rawBody = await readBoundedRawBody(request);
  await verifyPrintfulV2Signature(configuration, request.headers, rawBody);

  let payload;
  try { payload = JSON.parse(decoder.decode(rawBody)); }
  catch { throw new AuthFailure(400, "printful_webhook_payload_invalid", "The Printful webhook payload is invalid."); }
  const envelope = normalizePrintfulV2WebhookEnvelope(payload, configuration.storeId);
  const digest = await canonicalPrintfulWebhookDigest(payload);
  const stored = await processPrintfulWebhookEvidence(env, envelope, digest, nowIso(now));
  return jsonResponse({
    ok: true,
    received: true,
    duplicate: stored.duplicate,
    eventType: envelope.type,
    result: stored.resultCode,
  });
}

export async function verifyPrintfulV2Signature(configuration, headers, rawBody) {
  const publicKey = String(headers.get("x-pf-webhook-public-key") || "").trim();
  const signature = String(headers.get("x-pf-webhook-signature") || "").trim().toLowerCase();
  if (!publicKey || !signature) throw new AuthFailure(400, "printful_webhook_signature_required", "Printful webhook signature headers are required.");
  if (!constantTimeTextEqual(publicKey, configuration.publicKey) || !/^[0-9a-f]{64}$/.test(signature)) {
    throw new AuthFailure(403, "printful_webhook_signature_invalid", "The Printful webhook signature is invalid.");
  }
  const key = await crypto.subtle.importKey("raw", hexToBytes(configuration.secretHex), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, hexToBytes(signature), rawBody);
  if (!valid) throw new AuthFailure(403, "printful_webhook_signature_invalid", "The Printful webhook signature is invalid.");
}

export async function readBoundedRawBody(request) {
  const declared = String(request.headers.get("content-length") || "").trim();
  if (/^\d+$/.test(declared) && Number(declared) > PRINTFUL_WEBHOOK_MAX_BODY_BYTES) throw new AuthFailure(413, "request_too_large", "The request body is too large.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > PRINTFUL_WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new AuthFailure(413, "request_too_large", "The request body is too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function webhookConfiguration(env) {
  const publicKey = String(env?.PRINTFUL_WEBHOOK_V2_PUBLIC_KEY || "").trim();
  const secretHex = String(env?.PRINTFUL_WEBHOOK_V2_SECRET_HEX || "").trim().toLowerCase();
  const storeId = String(env?.PRINTFUL_STORE_ID || "").trim();
  if (!/^[A-Za-z0-9+/_=-]{4,512}$/.test(publicKey) || !/^[0-9a-f]{64,1024}$/.test(secretHex) || secretHex.length % 2 || !/^\d{1,40}$/.test(storeId)) return null;
  return { publicKey, secretHex, storeId };
}

function constantTimeTextEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) mismatch |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  return mismatch === 0;
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
