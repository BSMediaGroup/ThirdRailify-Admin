import { requireCommerceDb } from "./commerce-core.js";
import { paypalCredentials } from "./paypal-client.js";

// Safe global checkout projection. Cart/address/rate eligibility is resolved later.
export async function checkoutReadiness(env) {
  const db = requireCommerceDb(env);
  const [rows, launch, state, providers, markets] = await Promise.all([
    db.prepare("SELECT setting_key,value_json,updated_at FROM commerce_settings").all(),
    db.prepare("SELECT state,revision FROM commerce_launch_state WHERE id='production'").first(),
    db.prepare("SELECT preferred_provider,stripe_enabled,paypal_store_checkout_enabled,paypal_live_capture_enabled,emergency_paused FROM commerce_payment_provider_state WHERE id='primary'").first(),
    db.prepare("SELECT provider,status FROM commerce_provider_connections WHERE provider IN ('paypal','printful')").all(),
    db.prepare("SELECT country_code FROM commerce_shipping_markets WHERE status='active' AND strategy='printful_dynamic' ORDER BY country_code").all(),
  ]);
  const settings = Object.fromEntries((rows.results || []).map(row => { try { return [row.setting_key, JSON.parse(row.value_json)]; } catch { return [row.setting_key, null]; } }));
  const live = settings.commerce_environment === "production";
  const credentials = paypalCredentials(env, live ? "live" : "sandbox");
  const providerStates = Object.fromEntries((providers.results || []).map(row => [row.provider, row.status]));
  const result = evaluateCheckoutReadiness({ settings, launch, state, credentialsReady: credentials.configured && Boolean(credentials.webhookId), providerStates, printfulConfigured: Boolean(env.PRINTFUL_API_TOKEN), destinations: (markets.results || []).map(row => row.country_code) });
  const bytes = new TextEncoder().encode(JSON.stringify([result, (rows.results || []).map(row => [row.setting_key, row.updated_at]).sort()]));
  result.revision = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return result;
}

export function evaluateCheckoutReadiness({ settings: s, launch, state, credentialsReady, providerStates, printfulConfigured, destinations }) {
  const live = s.commerce_environment === "production";
  const paused = s.commerce_emergency_paused === true || Number(state?.emergency_paused) === 1 || launch?.state === "paused";
  const paymentReady = credentialsReady && providerStates.paypal === "connected" && s.preferred_payment_provider === "paypal" && state?.preferred_provider === "paypal" && s[live ? "paypal_live_configured" : "paypal_sandbox_configured"] === true && s[live ? "paypal_live_webhook_configured" : "paypal_sandbox_webhook_configured"] === true;
  const fulfillmentReady = printfulConfigured && providerStates.printful === "connected" && (!live || s.fulfillment_submission_enabled === true);
  const flagsReady = s.paypal_store_checkout_enabled === true && (!live || (s.checkout_enabled === true && s.live_payment_capture_enabled === true && s.paypal_live_capture_enabled === true && s.internet_agreement_disclosure_enabled === true && Number(state?.paypal_store_checkout_enabled) === 1 && Number(state?.paypal_live_capture_enabled) === 1));
  const blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  if (paused) block("store_paused", "The store is temporarily paused.");
  if (live && launch?.state !== "active" && !paused) block("store_not_active", "The store is not open for checkout.");
  if (!paymentReady) block("payment_service_unavailable", "Checkout is temporarily unavailable while the payment service recovers.");
  if (!fulfillmentReady) block("fulfillment_unavailable", "Fulfilment is temporarily unavailable.");
  if (!flagsReady) block("store_configuration_unavailable", "The store checkout configuration needs attention. Please try again later.");
  if (!destinations.length) block("shipping_unavailable", "Shipping destinations are temporarily unavailable.");
  if (s.tax_calculation_provider !== "not_collecting") block("tax_policy_unavailable", "Checkout totals are temporarily unavailable.");
  const enabled = blockers.length === 0;
  return { state: paused ? "paused" : live && launch?.state !== "active" ? "preflight" : enabled ? "active" : "degraded", storeActive: launch?.state === "active", paused, checkoutEnabled: enabled, paymentReady, fulfillmentReady, paymentProvider: "paypal", destinations, blockers, revision: String(launch?.revision || 0) };
}
