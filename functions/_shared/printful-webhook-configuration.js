import { AuthFailure, nowIso } from "./auth-core.js";
import { requireCommerceDb, writeCommerceAudit } from "./commerce-core.js";
import { PRINTFUL_V2_WEBHOOK_EVENTS } from "./printful-fulfillment.js";

export const PRINTFUL_WEBHOOK_URL = "https://admin.thirdrailify.com/api/webhooks/printful";
export async function publicKeyFingerprint(env) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(env.PRINTFUL_WEBHOOK_V2_PUBLIC_KEY || "").trim())))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function printfulWebhookConfigurationStatus(env, metadata = {}) {
  const evidence = metadata.webhook_v2 || {};
  const custody = /^[A-Za-z0-9+/_=-]{4,512}$/.test(String(env.PRINTFUL_WEBHOOK_V2_PUBLIC_KEY || "")) && /^(?:[a-fA-F0-9]{2}){32,512}$/.test(String(env.PRINTFUL_WEBHOOK_V2_SECRET_HEX || ""));
  const active = evidence.url === PRINTFUL_WEBHOOK_URL && evidence.fingerprint === await publicKeyFingerprint(env) && evidence.verified === true;
  const last = await requireCommerceDb(env).prepare("SELECT event_type,occurred_at,processing_status,result_code FROM commerce_provider_webhook_events WHERE provider='printful' AND provider_store_id=? ORDER BY received_at DESC LIMIT 1").bind(String(env.PRINTFUL_STORE_ID || "")).first();
  return { subscription: active ? "active" : "not_verified", custody: custody ? "ready" : "missing", verifier: custody && active ? "ready" : "not_verified", signedDelivery: last ? "verified" : "not_yet_observed", lastEvent: last || null, url: PRINTFUL_WEBHOOK_URL, events: active ? evidence.events : [], fingerprint: active ? evidence.fingerprint.slice(0, 12) : null, checkedAt: evidence.checkedAt || null };
}
export async function reconcilePrintfulWebhookConfiguration(env, input, actorAccountId, fetchImpl = fetch) {
  if (input?.confirmation !== "RECONCILE WEBHOOK CONFIG" || Object.keys(input).some(k => k !== "confirmation")) throw new AuthFailure(400, "printful_webhook_confirmation_required", "Review webhook configuration before reconciling.");
  const db = requireCommerceDb(env);
  const before = await db.prepare("SELECT safe_metadata_json,external_account_id FROM commerce_provider_connections WHERE provider='printful'").first();
  if (!before || before.external_account_id !== String(env.PRINTFUL_STORE_ID)) throw new AuthFailure(409, "printful_store_mismatch", "Printful target store authority does not match.");
  const response = await fetchImpl("https://api.printful.com/v2/webhooks?show_expired=true", { headers: { Authorization: `Bearer ${env.PRINTFUL_API_TOKEN}`, "X-PF-Store-Id": String(env.PRINTFUL_STORE_ID), Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new AuthFailure(502, "printful_webhook_readback_failed", "Printful configuration readback failed.");
  const payload = await response.json(); const config = payload.result || payload.data || {};
  const events = (config.events || []).map(e => e.type).sort();
  const verified = config.default_url === PRINTFUL_WEBHOOK_URL && !config.expires_at && config.public_key === String(env.PRINTFUL_WEBHOOK_V2_PUBLIC_KEY || "").trim() && events.join() === [...PRINTFUL_V2_WEBHOOK_EVENTS].sort().join() && config.events.every(e => !e.url || e.url === PRINTFUL_WEBHOOK_URL);
  const evidence = { verified, url: PRINTFUL_WEBHOOK_URL, events: verified ? events : [], fingerprint: await publicKeyFingerprint(env), checkedAt: nowIso() };
  const updated = await db.prepare("UPDATE commerce_provider_connections SET safe_metadata_json=json_set(safe_metadata_json,'$.webhook_v2',json(?)) WHERE provider='printful' AND safe_metadata_json=?").bind(JSON.stringify(evidence), before.safe_metadata_json).run();
  if (Number(updated.meta?.changes) !== 1) throw new AuthFailure(409, "printful_configuration_changed", "Provider configuration changed. Refresh before reconciling.");
  await writeCommerceAudit(env, { actorAccountId, action: "printful.webhook_configuration_reconciled", targetType: "commerce_provider_connection", targetId: "printful", result: verified ? "success" : "failure", metadata: { verified, fingerprint: evidence.fingerprint, eventCount: events.length } });
  return { ok: true, ...await printfulWebhookConfigurationStatus(env, { webhook_v2: evidence }) };
}
