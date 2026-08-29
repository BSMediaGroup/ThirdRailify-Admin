import { AuthFailure, cleanText } from "./auth-core.js";

export const PRINTFUL_ORDERS_URL = "https://api.printful.com/orders";
export const PRINTFUL_TARGET_STORE_ID = "18668025";
export const PRINTFUL_SOURCE_WIX_STORE_ID = "16847493";
export const PRINTFUL_SAFE_MESSAGE_MAX = 300;

const LOCAL_ORDER_ID = /^ord_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_EXTERNAL_ID = /^tr_[0-9a-f]{29}$/;
const PROVIDER_SHIPPING_CODE = /^[A-Z0-9][A-Z0-9_.:-]{0,119}$/;
const RECIPIENT_FIELDS = Object.freeze(["name", "address1", "address2", "city", "state_code", "country_code", "zip", "phone"]);

export class PrintfulApiError extends Error {
  constructor({ operation, httpStatus = null, providerCode = null, providerErrorCode = null, safeMessage, requestId = null, retryable = false, payloadDigest = null, responseContentType = null, responseJsonParsed = false }) {
    super(cleanSafeMessage(safeMessage) || "Printful rejected the request.");
    this.name = "PrintfulApiError";
    this.operation = boundedToken(operation, 80) || "printful_request";
    this.httpStatus = Number.isInteger(Number(httpStatus)) ? Number(httpStatus) : null;
    this.providerCode = boundedToken(providerCode, 80);
    this.providerErrorCode = boundedToken(providerErrorCode, 100);
    this.safeMessage = this.message;
    this.requestId = boundedToken(requestId, 160);
    this.retryable = retryable === true;
    this.payloadDigest = /^[0-9a-f]{64}$/.test(String(payloadDigest || "")) ? String(payloadDigest) : null;
    this.responseContentType = boundedContentType(responseContentType);
    this.responseJsonParsed = responseJsonParsed === true;
  }

  toSafeJSON() {
    return {
      operation: this.operation,
      httpStatus: this.httpStatus,
      providerCode: this.providerCode,
      providerErrorCode: this.providerErrorCode,
      safeMessage: this.safeMessage,
      requestId: this.requestId,
      retryable: this.retryable,
      payloadDigest: this.payloadDigest,
    };
  }
}

export async function buildPrintfulOrderExternalId(localOrderId) {
  const value = String(localOrderId || "").trim().toLowerCase();
  if (!LOCAL_ORDER_ID.test(value)) throw new AuthFailure(400, "printful_local_order_id_invalid", "A canonical local commerce order identifier is required.");
  return `tr_${(await sha256Hex(value)).slice(0, 29)}`;
}

export function assertCanonicalPrintfulOrderExternalId(value) {
  const normalized = String(value || "").trim();
  if (!CANONICAL_EXTERNAL_ID.test(normalized) || normalized.length !== 32) {
    throw new AuthFailure(400, "printful_external_id_invalid", "The Printful order external identifier must use the canonical 32-character format.");
  }
  return normalized;
}

export async function buildPrintfulDraftCreateRequest({ localOrderId, targetStoreId, shippingCode, recipient, syncVariantId, quantity }) {
  const storeId = assertPrintfulTargetStore(targetStoreId);
  const externalId = assertCanonicalPrintfulOrderExternalId(await buildPrintfulOrderExternalId(localOrderId));
  const shipping = String(shippingCode || "").trim();
  if (!PROVIDER_SHIPPING_CODE.test(shipping)) throw new AuthFailure(409, "printful_shipping_code_invalid", "The persisted Printful shipping method code is invalid.");
  const syncVariant = Number(syncVariantId);
  if (!Number.isSafeInteger(syncVariant) || syncVariant < 1) throw new AuthFailure(409, "printful_sync_variant_invalid", "The configured Printful Sync Variant identifier is invalid.");
  const itemQuantity = Number(quantity);
  if (!Number.isSafeInteger(itemQuantity) || itemQuantity !== 1) throw new AuthFailure(409, "printful_quantity_invalid", "The controlled Printful draft requires quantity one.");
  const normalizedRecipient = normalizeRecipient(recipient);
  const body = {
    external_id: externalId,
    recipient: normalizedRecipient,
    shipping,
    items: [{ sync_variant_id: syncVariant, quantity: itemQuantity }],
  };
  const payloadDigest = await sha256Hex(JSON.stringify(body));
  return {
    url: PRINTFUL_ORDERS_URL,
    method: "POST",
    queryParameters: {},
    targetStoreId: storeId,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body,
    payloadDigest,
    diagnostic: {
      httpMethod: "POST",
      endpointPath: "/orders",
      queryParameters: {},
      targetStoreId: storeId,
      authorizationHeaderPresent: true,
      externalId,
      externalIdLength: externalId.length,
      externalIdAllowedCharacters: CANONICAL_EXTERNAL_ID.test(externalId),
      itemIdentifierFieldNames: ["sync_variant_id", "quantity"],
      syncVariantId: String(syncVariant),
      quantity: itemQuantity,
      shippingMethodCode: shipping,
      recipientFieldNames: Object.keys(normalizedRecipient),
      payloadSha256: payloadDigest,
      confirmBehavior: "query_parameter_omitted_draft_default",
    },
  };
}

export async function buildPrintfulProductionDraftCreateRequest({ localOrderId, targetStoreId, shippingCode, recipient, items }) {
  const storeId = assertPrintfulTargetStore(targetStoreId);
  const externalId = assertCanonicalPrintfulOrderExternalId(await buildPrintfulOrderExternalId(localOrderId));
  const shipping = String(shippingCode || "").trim();
  if (!PROVIDER_SHIPPING_CODE.test(shipping)) throw new AuthFailure(409, "printful_shipping_code_invalid", "The persisted Printful shipping method code is invalid.");
  if (!Array.isArray(items) || !items.length || items.length > 20) throw new AuthFailure(409, "printful_items_invalid", "The authoritative Printful item set is invalid.");
  const normalizedItems = items.map((item) => {
    const syncVariant = Number(item?.syncVariantId ?? item?.sync_variant_id);
    const itemQuantity = Number(item?.quantity);
    if (!Number.isSafeInteger(syncVariant) || syncVariant < 1) throw new AuthFailure(409, "printful_sync_variant_invalid", "A configured Printful Sync Variant identifier is invalid.");
    if (!Number.isSafeInteger(itemQuantity) || itemQuantity < 1 || itemQuantity > 20) throw new AuthFailure(409, "printful_quantity_invalid", "A Printful quantity is invalid.");
    return { sync_variant_id: syncVariant, quantity: itemQuantity };
  });
  if (normalizedItems.reduce((sum, item) => sum + item.quantity, 0) > 100) throw new AuthFailure(409, "printful_quantity_total_invalid", "The Printful order quantity is too large.");
  const body = { external_id: externalId, recipient: normalizeRecipient(recipient), shipping, items: normalizedItems };
  const payloadDigest = await sha256Hex(JSON.stringify(body));
  return { url: PRINTFUL_ORDERS_URL, method: "POST", targetStoreId: storeId, body, payloadDigest, externalId };
}

export function assertPrintfulTargetStore(value) {
  const storeId = String(value || "").trim();
  if (storeId === PRINTFUL_SOURCE_WIX_STORE_ID) throw new AuthFailure(409, "printful_source_store_rejected", "The legacy Wix source store cannot receive order writes.");
  if (storeId !== PRINTFUL_TARGET_STORE_ID) throw new AuthFailure(409, "printful_target_store_mismatch", "The Printful order target store is invalid.");
  return storeId;
}

export async function normalizePrintfulApiError(response, { operation, payloadDigest = null } = {}) {
  const httpStatus = Number(response?.status);
  const responseContentType = boundedContentType(response?.headers?.get?.("content-type"));
  const requestId = requestIdHeader(response?.headers);
  let text = "";
  try { text = String(await response.text()).slice(0, 4096); } catch { text = ""; }
  let parsed = null;
  if (/json/i.test(responseContentType || "") || /^[\s]*[\[{]/.test(text)) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  const providerCode = parsed?.code ?? parsed?.status ?? null;
  const providerError = parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
  const providerErrorCode = providerError?.code ?? providerError?.name ?? parsed?.error_code ?? parsed?.error_name ?? null;
  const rawMessage = providerError?.reason ?? providerError?.message ?? parsed?.reason ?? parsed?.message
    ?? (typeof parsed?.error === "string" ? parsed.error : null) ?? text ?? "Printful rejected the request.";
  return new PrintfulApiError({
    operation,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    providerCode,
    providerErrorCode,
    safeMessage: rawMessage,
    requestId,
    retryable: httpStatus === 408 || httpStatus === 409 || httpStatus === 425 || httpStatus === 429 || httpStatus >= 500,
    payloadDigest,
    responseContentType,
    responseJsonParsed: parsed !== null,
  });
}

function normalizeRecipient(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthFailure(409, "printful_recipient_invalid", "The encrypted delivery recipient is invalid.");
  const recipient = {};
  for (const field of RECIPIENT_FIELDS) {
    const maximum = field === "country_code" ? 2 : field === "zip" ? 24 : field === "phone" ? 32 : 180;
    const normalized = cleanText(value[field], maximum);
    if (normalized) recipient[field] = field === "country_code" ? normalized.toUpperCase() : normalized;
  }
  for (const required of ["name", "address1", "city", "country_code", "zip"]) {
    if (!recipient[required]) throw new AuthFailure(409, "printful_recipient_incomplete", "The encrypted delivery recipient is incomplete.");
  }
  return recipient;
}

function cleanSafeMessage(value) {
  let message = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ");
  message = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted-secret]")
    .replace(/\b(?:sk|pk|whsec|pi|cs|evt)_(?:test|live)?_[A-Za-z0-9_-]+\b/gi, "[redacted-secret]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi, "[redacted-postcode]")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "[redacted-postcode]")
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, "[redacted-contact]")
    .replace(/\b\d{1,6}\s+[A-Za-z0-9.' -]{1,80}\s(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way)\b/gi, "[redacted-address]")
    .replace(/\b(?:name|address1|address2|street|city|zip|postcode|postal(?:_code)?|phone|email)\s*[:=]\s*["']?[^,;\]}]{1,180}/gi, "$1=[redacted]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\s+/g, " ")
    .trim();
  return message.slice(0, PRINTFUL_SAFE_MESSAGE_MAX);
}

function boundedToken(value, maximum) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text && text.length <= maximum && /^[A-Za-z0-9_.:-]+$/.test(text) ? text : null;
}

function boundedContentType(value) {
  const type = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type.slice(0, 100) : null;
}

function requestIdHeader(headers) {
  for (const name of ["x-request-id", "x-correlation-id", "cf-ray", "request-id"]) {
    const value = boundedToken(headers?.get?.(name), 160);
    if (value) return value;
  }
  return null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
