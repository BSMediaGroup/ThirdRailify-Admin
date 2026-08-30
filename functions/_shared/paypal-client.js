import { AuthFailure, cleanText } from "./auth-core.js";

export const PAYPAL_API_BASE = Object.freeze({
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
});

export const PAYPAL_WEBHOOK_EVENTS = Object.freeze([
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
]);

const tokenCache = new Map();
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 12_000;

export class PayPalApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PayPalApiError";
    this.operation = details.operation || "paypal_request";
    this.httpStatus = Number(details.httpStatus || 0) || null;
    this.providerCode = safeCode(details.providerCode) || "paypal_unavailable";
    this.providerReason = cleanText(details.providerReason, 300) || "PayPal did not complete the request.";
    this.debugId = safeIdentifier(details.debugId, 100);
    this.retryable = Boolean(details.retryable);
    this.payloadDigest = /^[0-9a-f]{64}$/.test(String(details.payloadDigest || "")) ? details.payloadDigest : null;
  }
}

export function paypalCredentials(env, environment) {
  if (!Object.hasOwn(PAYPAL_API_BASE, environment)) throw new AuthFailure(400, "paypal_environment_invalid", "The PayPal environment is invalid.");
  const prefix = environment === "live" ? "PAYPAL_LIVE" : "PAYPAL_SANDBOX";
  const clientId = cleanText(env?.[`${prefix}_CLIENT_ID`], 512);
  const clientSecret = cleanText(env?.[`${prefix}_CLIENT_SECRET`], 1024);
  const webhookId = cleanText(env?.[`${prefix}_WEBHOOK_ID`], 80);
  const expectedMerchantId = cleanText(env?.[`${prefix}_MERCHANT_ID`], 80);
  return {
    environment,
    baseUrl: PAYPAL_API_BASE[environment],
    clientId,
    clientSecret,
    webhookId,
    expectedMerchantId,
    configured: Boolean(clientId && clientSecret),
  };
}

export function paypalBrowserConfiguration(env, environment) {
  const credentials = paypalCredentials(env, environment);
  return {
    environment,
    clientId: credentials.configured ? credentials.clientId : null,
    currency: "CAD",
    intent: "CAPTURE",
  };
}

export async function createPayPalOrder(env, environment, body, requestId, fetchImpl = fetch) {
  return paypalRequest(env, environment, {
    operation: "paypal_order_create",
    method: "POST",
    path: "/v2/checkout/orders",
    body,
    requestId,
    prefer: "return=representation",
  }, fetchImpl);
}

export async function getPayPalOrder(env, environment, providerOrderId, fetchImpl = fetch) {
  const orderId = requireProviderId(providerOrderId, "paypal_order_id_invalid");
  return paypalRequest(env, environment, {
    operation: "paypal_order_get",
    method: "GET",
    path: `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
  }, fetchImpl);
}

export async function capturePayPalOrder(env, environment, providerOrderId, requestId, fetchImpl = fetch) {
  const orderId = requireProviderId(providerOrderId, "paypal_order_id_invalid");
  return paypalRequest(env, environment, {
    operation: "paypal_order_capture",
    method: "POST",
    path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    body: {},
    requestId,
    prefer: "return=representation",
  }, fetchImpl);
}

export async function verifyPayPalWebhook(env, environment, verification, rawEventText, fetchImpl = fetch) {
  const prefix = JSON.stringify(verification);
  const rawBody = `${prefix.slice(0, -1)},"webhook_event":${rawEventText}}`;
  const result = await paypalRequest(env, environment, {
    operation: "paypal_webhook_verify",
    method: "POST",
    path: "/v1/notifications/verify-webhook-signature",
    rawBody,
  }, fetchImpl);
  if (result.body?.verification_status !== "SUCCESS") {
    throw new AuthFailure(400, "paypal_webhook_signature_invalid", "The PayPal webhook signature is invalid.");
  }
  return true;
}

export async function listPayPalWebhooks(env, environment, fetchImpl = fetch) {
  return paypalRequest(env, environment, { operation: "paypal_webhook_list", method: "GET", path: "/v1/notifications/webhooks" }, fetchImpl);
}

export async function getPayPalWebhook(env, environment, webhookId, fetchImpl = fetch) {
  const id = requireProviderId(webhookId, "paypal_webhook_id_invalid");
  return paypalRequest(env, environment, { operation: "paypal_webhook_get", method: "GET", path: `/v1/notifications/webhooks/${encodeURIComponent(id)}` }, fetchImpl);
}

export async function createPayPalWebhook(env, environment, url, fetchImpl = fetch) {
  return paypalRequest(env, environment, {
    operation: "paypal_webhook_create",
    method: "POST",
    path: "/v1/notifications/webhooks",
    body: { url, event_types: PAYPAL_WEBHOOK_EVENTS.map((name) => ({ name })) },
  }, fetchImpl);
}

export async function updatePayPalWebhook(env, environment, webhookId, url, fetchImpl = fetch) {
  const id = requireProviderId(webhookId, "paypal_webhook_id_invalid");
  return paypalRequest(env, environment, {
    operation: "paypal_webhook_update",
    method: "PATCH",
    path: `/v1/notifications/webhooks/${encodeURIComponent(id)}`,
    body: [
      { op: "replace", path: "/url", value: requireWebhookUrl(url) },
      { op: "replace", path: "/event_types", value: PAYPAL_WEBHOOK_EVENTS.map((name) => ({ name })) },
    ],
  }, fetchImpl);
}

export async function validatePayPalOAuth(env, environment, fetchImpl = fetch) {
  const credentials = paypalCredentials(env, environment);
  if (!credentials.configured) throw new AuthFailure(503, "paypal_credentials_unavailable", `PayPal ${environment.toUpperCase()} credentials are not configured.`);
  const token = await accessTokenFor(credentials, fetchImpl);
  return { environment, configured: true, verified: true, httpStatus: token.httpStatus, debugId: token.debugId, tokenType: token.tokenType, expiresIn: token.expiresIn };
}

export async function reconcilePayPalWebhook(env, environment, url, fetchImpl = fetch) {
  const expectedUrl = requireWebhookUrl(url);
  const listed = await listPayPalWebhooks(env, environment, fetchImpl);
  const webhooks = Array.isArray(listed.body?.webhooks) ? listed.body.webhooks : [];
  const matches = webhooks.filter((item) => item?.url === expectedUrl && safeIdentifier(item?.id, 80));
  if (matches.length > 1) throw new PayPalApiError("Duplicate PayPal webhooks require operator review", { operation: "paypal_webhook_list", httpStatus: listed.httpStatus, providerCode: "duplicate_webhooks", providerReason: "More than one PayPal webhook uses the canonical callback URL.", debugId: listed.debugId, retryable: false });
  let webhook = matches[0] || null;
  let action = "unchanged";
  if (!webhook) {
    const created = await createPayPalWebhook(env, environment, expectedUrl, fetchImpl);
    webhook = created.body;
    action = "created";
  } else if (!exactWebhook(webhook, expectedUrl)) {
    const updated = await updatePayPalWebhook(env, environment, webhook.id, expectedUrl, fetchImpl);
    webhook = updated.body && updated.body.id ? updated.body : webhook;
    action = "updated";
  }
  const webhookId = requireProviderId(webhook?.id, "paypal_webhook_id_invalid");
  const readback = await getPayPalWebhook(env, environment, webhookId, fetchImpl);
  if (!exactWebhook(readback.body, expectedUrl)) throw new PayPalApiError("PayPal webhook readback did not match", { operation: "paypal_webhook_get", httpStatus: readback.httpStatus, providerCode: "webhook_readback_mismatch", providerReason: "The PayPal webhook URL or event subscriptions did not match the canonical configuration.", debugId: readback.debugId, retryable: false });
  return { environment, action, webhookId, url: expectedUrl, events: [...PAYPAL_WEBHOOK_EVENTS], httpStatus: readback.httpStatus, debugId: readback.debugId, readbackVerified: true };
}

export function minorUnitsToPayPal(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 2_147_483_647) throw new AuthFailure(409, "paypal_amount_invalid", "The payment amount is invalid.");
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}

export function paypalAmountToMinor(value) {
  const amount = String(value || "");
  if (!/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(amount)) return null;
  const [whole, decimal] = amount.split(".");
  const result = Number(whole) * 100 + Number(decimal);
  return Number.isSafeInteger(result) && result <= 2_147_483_647 ? result : null;
}

export async function paypalRequest(env, environment, options, fetchImpl = fetch) {
  const credentials = paypalCredentials(env, environment);
  if (!credentials.configured) throw new AuthFailure(503, "paypal_credentials_unavailable", `PayPal ${environment.toUpperCase()} credentials are not configured.`);
  const accessToken = await accessTokenFor(credentials, fetchImpl);
  const headers = { Accept: "application/json", Authorization: `Bearer ${accessToken.value}` };
  if (options.body !== undefined || options.rawBody !== undefined) headers["Content-Type"] = "application/json";
  if (options.requestId) headers["PayPal-Request-Id"] = boundedRequestId(options.requestId);
  if (options.prefer) headers.Prefer = options.prefer;
  const response = await boundedFetch(fetchImpl, `${credentials.baseUrl}${options.path}`, {
    method: options.method,
    headers,
    body: options.rawBody !== undefined ? options.rawBody : options.body === undefined ? undefined : JSON.stringify(options.body),
  }, options.operation);
  const text = await boundedText(response);
  const payload = parseJson(text);
  const debugId = safeIdentifier(response.headers.get("paypal-debug-id") || payload?.debug_id, 100);
  if (!response.ok) {
    const issue = Array.isArray(payload?.details) ? payload.details[0] : null;
    throw new PayPalApiError("PayPal request failed", {
      operation: options.operation,
      httpStatus: response.status,
      providerCode: payload?.name || issue?.issue,
      providerReason: issue?.description || payload?.message,
      debugId,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new PayPalApiError("PayPal response invalid", { operation: options.operation, httpStatus: response.status, providerCode: "invalid_response", debugId, retryable: true });
  return { body: payload, httpStatus: response.status, debugId };
}

async function accessTokenFor(credentials, fetchImpl) {
  const key = `${credentials.environment}:${credentials.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
  const response = await boundedFetch(fetchImpl, `${credentials.baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${base64(`${credentials.clientId}:${credentials.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  }, "paypal_oauth_token");
  const text = await boundedText(response);
  const payload = parseJson(text);
  const debugId = safeIdentifier(response.headers.get("paypal-debug-id") || payload?.debug_id, 100);
  const tokenType = String(payload?.token_type || "");
  const expiresIn = Number(payload?.expires_in);
  if (!response.ok || !payload || typeof payload.access_token !== "string" || payload.access_token.length < 8 || payload.access_token.length > 4096 || tokenType.toLowerCase() !== "bearer" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) {
    throw new PayPalApiError("PayPal OAuth failed", { operation: "paypal_oauth_token", httpStatus: response.status, providerCode: payload?.error || payload?.name, providerReason: payload?.error_description || payload?.message, debugId, retryable: response.status === 429 || response.status >= 500 });
  }
  const token = { value: payload.access_token, expiresAt: Date.now() + Math.max(60, Math.min(expiresIn, 28_800)) * 1000, expiresIn, tokenType: "Bearer", httpStatus: response.status, debugId };
  tokenCache.set(key, token);
  return token;
}

async function boundedFetch(fetchImpl, url, init, operation) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch {
    throw new PayPalApiError("PayPal request unavailable", { operation, providerCode: "network_unavailable", providerReason: "PayPal is temporarily unavailable.", retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedText(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new PayPalApiError("PayPal response too large", { httpStatus: response.status, providerCode: "response_too_large", retryable: true });
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new PayPalApiError("PayPal response too large", { httpStatus: response.status, providerCode: "response_too_large", retryable: true });
  return text;
}

function boundedRequestId(value) {
  const id = String(value || "");
  if (!id || id.length > 108 || /[\u0000-\u001f\u007f]/.test(id)) throw new AuthFailure(500, "paypal_request_id_invalid", "The PayPal request identifier is invalid.");
  return id;
}
function requireProviderId(value, code) { const id = safeIdentifier(value, 80); if (!id) throw new AuthFailure(400, code, "The PayPal identifier is invalid."); return id; }
function requireWebhookUrl(value) { let url; try { url = new URL(String(value || "")); } catch { throw new AuthFailure(400, "paypal_webhook_url_invalid", "The PayPal webhook URL is invalid."); } if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new AuthFailure(400, "paypal_webhook_url_invalid", "The PayPal webhook URL is invalid."); return url.toString(); }
function exactWebhook(value, url) { const names = Array.isArray(value?.event_types) ? value.event_types.map((event) => String(event?.name || "")) : []; const actual = [...new Set(names)].sort(); const expected = [...PAYPAL_WEBHOOK_EVENTS].sort(); return value?.url === url && names.length === expected.length && actual.length === expected.length && actual.every((name, index) => name === expected[index]); }
function safeIdentifier(value, max) { const text = cleanText(value, max); return /^[A-Za-z0-9_-]+$/.test(text) ? text : null; }
function safeCode(value) { const text = cleanText(value, 100); return /^[A-Za-z0-9_.-]+$/.test(text) ? text : null; }
function parseJson(value) { try { return JSON.parse(String(value || "")); } catch { return null; } }
function base64(value) { const bytes = new TextEncoder().encode(value); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
