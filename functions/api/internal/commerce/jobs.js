import { AuthFailure, errorResponse, jsonResponse } from "../../../_shared/auth-core.js";
import { requireCommerceDb } from "../../../_shared/commerce-core.js";
import { processCommerceJobs } from "../../../_shared/commerce-operations.js";
import { reconcileRequestedResendDomain } from "../../../_shared/resend-domain.js";

const encoder = new TextEncoder();

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "POST" });
    const raw = await request.text();
    if (raw.length > 256) throw new AuthFailure(413, "request_too_large", "The request body is too large.");
    let body;
    try { body = JSON.parse(raw); } catch { throw new AuthFailure(400, "commerce_worker_request_invalid", "The worker request is invalid."); }
    const timestamp = Number(body?.timestamp);
    const secret = String(env?.COMMERCE_WORKER_SECRET || "");
    const signature = String(request.headers.get("x-commerce-worker-signature") || "").toLowerCase();
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 300_000 || secret.length < 32 || !/^[0-9a-f]{64}$/.test(signature)) throw new AuthFailure(403, "commerce_worker_signature_invalid", "The worker request signature is invalid.");
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, hexBytes(signature), encoder.encode(raw))) throw new AuthFailure(403, "commerce_worker_signature_invalid", "The worker request signature is invalid.");
    const db = requireCommerceDb(env);
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at)
      VALUES ('commerce_operations_worker_configured','true','safe',?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json='true',updated_at=excluded.updated_at`).bind(now).run();
    const providerMaintenance = await reconcileRequestedResendDomain(env);
    return jsonResponse({ ...(await processCommerceJobs(env)), providerMaintenance });
  } catch (error) {
    if (error instanceof AuthFailure) return errorResponse(error, request, env);
    return jsonResponse({ ok: false, error: "commerce_operations_unavailable", message: "Commerce operations are temporarily unavailable." }, { status: 500 });
  }
}

function hexBytes(value) { const bytes = new Uint8Array(value.length / 2); for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16); return bytes; }
