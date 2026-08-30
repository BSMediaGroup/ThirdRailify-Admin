import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRINTFUL_V2_WEBHOOK_EVENTS } from "../functions/_shared/printful-fulfillment.js";

try { loadEnvFile(new URL("../.env", import.meta.url)); } catch { /* Cloudflare-only credentials are valid. */ }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = resolve(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const PROJECT = "thirdrailify-admin";
const ENDPOINT = "https://api.printful.com/v2/webhooks";
export const PRINTFUL_WEBHOOK_URL = "https://admin.thirdrailify.com/api/webhooks/printful";

export class PrintfulProviderSupportRequired extends Error {
  constructor(packet) {
    super("PRINTFUL_PROVIDER_SUPPORT_REQUIRED");
    this.name = "PrintfulProviderSupportRequired";
    this.packet = packet;
  }
}

export async function configurePrintfulV2Webhook(options) {
  const token = String(options?.token || "").trim();
  const storeId = String(options?.storeId || "").trim();
  const tokenClass = String(options?.tokenClass || "").trim();
  const fetchImpl = options?.fetchImpl || fetch;
  const storeSecrets = options?.storeSecrets || storeCloudflareSecrets;
  if (!token) throw new Error("printful_api_token_unavailable");
  if (storeId !== "18668025") throw new Error("printful_target_store_mismatch");
  if (tokenClass !== "store_level_private_token") throw new Error("printful_token_class_unproven");

  const calls = { get: 0, post: 0 };
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const before = await readWebhook(fetchImpl, headers, calls);
  if (hasConfiguration(before.result)) {
    return {
      configured: exactConfiguration(before.result),
      readbackVerified: exactConfiguration(before.result),
      created: false,
      calls,
      defaultUrl: safeDefaultUrl(before.result),
      expiresAt: before.result.expires_at || null,
      events: eventTypes(before.result),
      publicKeyPresent: validPublicKey(before.result.public_key),
      secretsStored: false,
    };
  }

  const requestBody = JSON.stringify({
    default_url: PRINTFUL_WEBHOOK_URL,
    expires_at: null,
    events: PRINTFUL_V2_WEBHOOK_EVENTS.map((type) => ({ type })),
  });
  calls.post += 1;
  if (calls.post > 1) throw new Error("printful_webhook_post_budget_exceeded");
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: requestBody,
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = await parseResponse(response);
  const created = webhookResult(parsed.payload);
  const publicKey = String(created?.public_key || "").trim();
  const secretHex = String(created?.secret_key || "").trim().toLowerCase();
  if (!response.ok || !validPublicKey(publicKey) || !validSecretHex(secretHex) || !exactConfiguration(created)) {
    throw new PrintfulProviderSupportRequired(supportPacket({
      response,
      payload: parsed.payload,
      result: created,
      contentType: parsed.contentType,
      requestBody,
      tokenClass,
      storeId,
    }));
  }

  await storeSecrets({
    PRINTFUL_WEBHOOK_V2_PUBLIC_KEY: publicKey,
    PRINTFUL_WEBHOOK_V2_SECRET_HEX: secretHex,
  });

  const after = await readWebhook(fetchImpl, headers, calls);
  const readbackPublicKey = String(after.result?.public_key || "").trim();
  const readbackVerified = exactConfiguration(after.result)
    && validPublicKey(readbackPublicKey)
    && constantTimeTextEqual(readbackPublicKey, publicKey);
  if (!readbackVerified) throw new Error("printful_webhook_readback_mismatch");

  return {
    configured: true,
    readbackVerified: true,
    created: true,
    calls,
    defaultUrl: PRINTFUL_WEBHOOK_URL,
    expiresAt: null,
    events: eventTypes(after.result),
    publicKeyPresent: true,
    secretsStored: true,
  };
}

async function readWebhook(fetchImpl, headers, calls) {
  calls.get += 1;
  if (calls.get > 2) throw new Error("printful_webhook_get_budget_exceeded");
  const response = await fetchImpl(`${ENDPOINT}?show_expired=true`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = await parseResponse(response);
  if (!response.ok) throw new Error(`printful_webhook_get_failed_http_${response.status}`);
  return { response, ...parsed, result: webhookResult(parsed.payload) || {} };
}

async function parseResponse(response) {
  const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const text = await response.text();
  let payload = null;
  if (contentType === "application/json" && text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  return { contentType, payload };
}

export function webhookResult(payload) {
  if (payload?.result && typeof payload.result === "object" && !Array.isArray(payload.result)) return payload.result;
  return payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data
    : null;
}

export function eventTypes(result) {
  return (Array.isArray(result?.events) ? result.events : [])
    .map((event) => String(event?.type || "").trim())
    .filter(Boolean)
    .sort();
}

function exactConfiguration(result) {
  return safeDefaultUrl(result) === PRINTFUL_WEBHOOK_URL
    && !result?.expires_at
    && eventTypes(result).join("\n") === [...PRINTFUL_V2_WEBHOOK_EVENTS].sort().join("\n");
}

function hasConfiguration(result) {
  return Boolean(safeDefaultUrl(result) || eventTypes(result).length || result?.public_key || result?.expires_at);
}

function safeDefaultUrl(result) {
  return typeof result?.default_url === "string" ? result.default_url : null;
}

function validPublicKey(value) {
  return /^[A-Za-z0-9+/_=-]{4,512}$/.test(String(value || "").trim());
}

function validSecretHex(value) {
  const secret = String(value || "").trim();
  return /^[0-9a-f]{64,1024}$/.test(secret) && secret.length % 2 === 0;
}

function constantTimeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBuffer.length; index += 1) mismatch |= leftBuffer[index] ^ rightBuffer[index];
  return mismatch === 0;
}

function supportPacket({ response, payload, result, contentType, requestBody, tokenClass, storeId }) {
  const resultType = result === null
    ? "null_or_missing"
    : Array.isArray(result) ? "array" : typeof result;
  return {
    operation: "configure_printful_v2_webhooks",
    endpoint: ENDPOINT,
    httpStatus: response.status,
    responseContentType: contentType || null,
    topLevelJsonKeys: payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload).sort() : [],
    resultType,
    requestId: providerRequestId(response.headers),
    payloadDigest: createHash("sha256").update(requestBody).digest("hex"),
    tokenClass,
    storeId,
    eventCount: PRINTFUL_V2_WEBHOOK_EVENTS.length,
  };
}

function providerRequestId(headers) {
  for (const name of ["x-pf-request-id", "x-printful-request-id", "x-request-id", "x-correlation-id"]) {
    const value = String(headers.get(name) || "").trim();
    if (/^[A-Za-z0-9._:-]{1,160}$/.test(value)) return value;
  }
  return null;
}

async function storeCloudflareSecrets(secrets) {
  const result = spawnSync(process.execPath, [WRANGLER, "pages", "secret", "bulk", "--project-name", PROJECT], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    input: JSON.stringify(secrets),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error("printful_cloudflare_secret_custody_failed");
}

async function main() {
  const outcome = await configurePrintfulV2Webhook({
    token: process.env.PRINTFUL_API_TOKEN,
    storeId: process.env.PRINTFUL_STORE_ID || "18668025",
    tokenClass: "store_level_private_token",
  });
  console.log(JSON.stringify(outcome, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof PrintfulProviderSupportRequired) {
      console.error(JSON.stringify({ error: error.message, supportPacket: error.packet }, null, 2));
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof Error ? error.message : "printful_webhook_configuration_failed");
    process.exitCode = 1;
  });
}
