import { PAYPAL_WEBHOOK_EVENTS } from "./paypal-client.js";

export const PAYPAL_WEBHOOK_PATH = "/api/webhooks/paypal";

export function paypalWebhookUrl(env) {
  const rawOrigin = String(env?.THIRDRAILIFY_ADMIN_ORIGIN || "").trim();
  let origin;
  try { origin = new URL(rawOrigin); }
  catch { throw new Error("paypal_admin_origin_invalid"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("paypal_admin_origin_invalid");
  }
  return `${origin.origin}${PAYPAL_WEBHOOK_PATH}`;
}

export function paypalTechnicalReadiness({ credentials, metadata = {}, configured = false, webhookConfigured = false }) {
  const credentialsConfigured = Boolean(credentials?.clientId && credentials?.clientSecret && configured);
  const oauthVerified = credentialsConfigured && metadata.oauth_verified === true;
  const webhookSecretConfigured = Boolean(credentials?.webhookId && webhookConfigured);
  const webhookReadbackVerified = webhookSecretConfigured
    && metadata.webhook_configured === true
    && metadata.webhook_readback_verified === true
    && exactEventSet(metadata.webhook_events);
  return {
    credentialsConfigured,
    oauthVerified,
    webhookSecretConfigured,
    webhookReadbackVerified,
    ready: credentialsConfigured && oauthVerified && webhookSecretConfigured && webhookReadbackVerified,
  };
}

export function paypalAcceptanceStatus(rows, environment, kind) {
  const accepted = (rows || []).some((row) => row.environment === environment
    && row.kind === kind
    && row.normalized_state === "completed"
    && Number(row.count || 0) > 0);
  return accepted ? "passed" : "not_run";
}

export function exactEventSet(events) {
  if (!Array.isArray(events) || events.length !== PAYPAL_WEBHOOK_EVENTS.length) return false;
  const actual = [...new Set(events.map(String))].sort();
  const expected = [...PAYPAL_WEBHOOK_EVENTS].sort();
  return actual.length === expected.length && actual.every((event, index) => event === expected[index]);
}

export function safePayPalConfigurationEvidence({ environment, oauth, webhookUrl, checkedAt }) {
  if (!new Set(["sandbox", "live"]).has(environment)) throw new Error("paypal_environment_invalid");
  if (!oauth || oauth.verified !== true || oauth.httpStatus < 200 || oauth.httpStatus > 299 || oauth.tokenType !== "Bearer" || !Number.isSafeInteger(oauth.expiresIn) || oauth.expiresIn <= 0) {
    throw new Error("paypal_oauth_evidence_invalid");
  }
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== PAYPAL_WEBHOOK_PATH || url.search || url.hash) throw new Error("paypal_webhook_url_invalid");
  const timestamp = new Date(checkedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("paypal_checked_at_invalid");
  return {
    client_id_configured: true,
    client_secret_configured: true,
    oauth_verified: true,
    oauth_http_status: oauth.httpStatus,
    oauth_token_type: "Bearer",
    oauth_expires_in: oauth.expiresIn,
    oauth_debug_id: safeIdentifier(oauth.debugId),
    oauth_checked_at: timestamp.toISOString(),
    webhook_configured: true,
    webhook_readback_verified: true,
    webhook_url: url.toString(),
    webhook_events: [...PAYPAL_WEBHOOK_EVENTS],
    webhook_checked_at: timestamp.toISOString(),
  };
}

function safeIdentifier(value) {
  const text = String(value || "").trim();
  return text && text.length <= 100 && /^[A-Za-z0-9_-]+$/.test(text) ? text : null;
}
