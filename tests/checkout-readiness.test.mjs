import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCheckoutReadiness } from "../functions/_shared/checkout-readiness.js";

const active = () => ({ settings: { commerce_environment: "production", preferred_payment_provider: "paypal", paypal_live_configured: true, paypal_live_webhook_configured: true, paypal_store_checkout_enabled: true, checkout_enabled: true, live_payment_capture_enabled: true, paypal_live_capture_enabled: true, internet_agreement_disclosure_enabled: true, fulfillment_submission_enabled: true, tax_calculation_provider: "not_collecting" }, launch: { state: "active", revision: 2 }, state: { preferred_provider: "paypal", paypal_store_checkout_enabled: 1, paypal_live_capture_enabled: 1 }, credentialsReady: true, providerStates: { paypal: "connected", printful: "connected" }, printfulConfigured: true, destinations: ["AU", "CA"] });

test("active checkout accepts optional unsigned Printful delivery and recoverable email failure", () => {
  const input = active();
  input.settings.printful_v2_signed_delivery_verified = false;
  input.settings.transactional_email_enabled = false;
  input.settings.resend_domain_verified = false;
  const r = evaluateCheckoutReadiness(input);
  assert.equal(r.checkoutEnabled, true); assert.equal(r.state, "active"); assert.deepEqual(r.blockers, []); assert.ok(r.destinations.includes("AU"));
});

for (const [label, mutate, code] of [
  ["preflight", i => i.launch.state = "preflight", "store_not_active"],
  ["pause", i => i.settings.commerce_emergency_paused = true, "store_paused"],
  ["payment credential failure", i => i.credentialsReady = false, "payment_service_unavailable"],
  ["provider disconnection", i => i.providerStates.paypal = "disconnected", "payment_service_unavailable"],
  ["fulfillment disabled", i => i.settings.fulfillment_submission_enabled = false, "fulfillment_unavailable"],
  ["checkout flag drift", i => i.settings.checkout_enabled = false, "store_configuration_unavailable"],
  ["no destination", i => i.destinations = [], "shipping_unavailable"],
]) test(label + " returns an explicit fail-closed blocker", () => {
  const input = active(); mutate(input); const r = evaluateCheckoutReadiness(input);
  assert.equal(r.checkoutEnabled, false); assert.ok(r.blockers.some(b => b.code === code));
});
