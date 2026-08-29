import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:4204";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ORDER_ID = "ord_e47b94a4-4252-438b-8ca7-c47470029940";

test("Payments and Payouts renders truthful responsive TEST-only control plane", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4204"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());
  for (const [width, height] of [[1920, 1080], [1440, 900], [768, 1024], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" }); const page = await context.newPage(); const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); }); page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", routeFixture);
    await page.goto(`${ORIGIN}/commerce/payments`); await page.getByRole("heading", { level: 1, name: "Payments & payouts" }).waitFor();
    assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.deepEqual(errors, []);
    assert.equal(await page.getByText("TEST / SANDBOX EVIDENCE", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Direct merchant", { exact: true }).count() >= 1, true);
    assert.equal(await page.getByText("No Connect · no platform transfers · payouts managed in Stripe", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Managed directly in Stripe", { exact: true }).count(), 1);
    const stripeCard = page.locator(".payments-provider-card");
    const stripeLogo = stripeCard.locator(".provider-feature-icon");
    const paypalCard = page.locator(".paypal-scaffold");
    const paypalLogo = paypalCard.locator(".provider-feature-icon");
    assert.equal(await stripeLogo.count(), 1); assert.equal(await stripeLogo.evaluate((image) => image.complete && image.naturalWidth > 0), true);
    assert.equal(await paypalCard.count(), 1); assert.equal(await paypalLogo.evaluate((image) => image.complete && image.naturalWidth > 0), true);
    for (const [card, icon] of [[stripeCard, stripeLogo], [paypalCard, paypalLogo]]) {
      const cardBox = await card.boundingBox(); const iconBox = await icon.boundingBox(); assert.ok(cardBox && iconBox);
      assert.equal(Math.round(iconBox.width), 48); assert.equal(Math.round(iconBox.height), 48);
      assert.equal(iconBox.x + iconBox.width <= cardBox.x + cardBox.width, true); assert.equal(cardBox.x + cardBox.width - iconBox.x - iconBox.width <= 25, true); assert.equal(iconBox.y - cardBox.y <= 25, true);
    }
    assert.equal(await paypalCard.getByText("Deferred", { exact: true }).count(), 1);
    assert.equal(await paypalCard.getByText("Disabled / future phase", { exact: true }).count(), 2);
    assert.equal(await paypalCard.getByRole("button").count(), 0);
    assert.equal(await paypalCard.evaluate((element) => getComputedStyle(element).filter), "none");
    for (const method of ["apple_pay", "google_pay"]) {
      const mark = page.locator(`.payment-method-mark.is-${method}`); assert.equal(await mark.count(), 1);
      const style = await mark.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, mask: getComputedStyle(element).webkitMaskImage }));
      assert.equal(style.background, "rgb(243, 201, 40)"); assert.notEqual(style.mask, "none");
    }
    assert.equal(await page.getByText("Not externally verified", { exact: true }).count(), 1);
    assert.equal(await page.getByText("$15.00", { exact: true }).count() >= 2, true);
    assert.equal(await page.getByText("$0.00", { exact: true }).count() >= 4, true);
    for (const label of ["Public checkout: disabled", "Live payment capture: disabled", "Fulfillment submission: disabled"]) {
      const control = page.getByRole("checkbox", { name: label }); assert.equal(await control.isDisabled(), true); assert.equal(await control.isChecked(), false);
    }
    assert.equal(await page.getByRole("link", { name: /View in Orders/ }).getAttribute("href"), "/orders");
    assert.equal(await page.getByRole("link", { name: /Business information/ }).first().getAttribute("href"), "/commerce/business");
    const advanced = page.getByText("Advanced architecture and evidence boundaries", { exact: true }); await advanced.focus(); assert.equal(await page.evaluate(() => document.activeElement?.tagName), "SUMMARY"); await advanced.press("Enter");
    assert.equal(await page.getByText("Connected accounts", { exact: true }).count(), 1);
    assert.equal(await page.locator("body").innerText().then((text) => /secret_key|whsec_|bank account number/i.test(text)), false);
    if (process.env.PAYMENTS_SCREENSHOT_DIR) { await mkdir(process.env.PAYMENTS_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.PAYMENTS_SCREENSHOT_DIR, `payments-${width}.png`), fullPage: true }); }
    await context.close();
  }
});

async function routeFixture(route) {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (path === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "fixture-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-29T00:00:00Z", lastLoginAt: null, source: "test", locked: true } });
  if (path === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  if (path === "/api/admin/commerce/payments") return json(route, payments());
  return json(route, { ok: false, error: "not_found" }, 404);
}

function payments() {
  const disabled = (id, label, detail, href = null) => ({ id, label, state: "disabled", detail, href });
  return {
    ok: true, databaseConfigured: true, authority: "Commerce D1 and server runtime configuration", access: { isMasterAdmin: true, capabilities: ["commerce.view", "commerce.payments.manage"] },
    overall: { stripeState: "verified", technicalConfiguration: "verified", testAcceptance: "verified", productionPayments: "disabled", payoutReadiness: "unverified", productionReady: false },
    merchant: { displayName: "Third Railify Official", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicContactEmail: "info@thirdrailify.com", supportEmail: "info@thirdrailify.com", completeness: "incomplete", legalIdentityStored: false, privateAddressStored: false, businessRegistrationStored: false },
    stripe: { provider: "stripe", displayName: "Third Railify Official", integrationMode: "direct_merchant", environment: "test", accountCreated: true, accountId: "acct_FixtureMerchant123456789", accountIdRestricted: false, countryCode: "CA", currencyCode: "CAD", apiCredentialConfigured: true, apiVerified: true, webhookSigningSecretConfigured: true, webhookAcceptanceVerified: true, checkoutEnabled: false, livePaymentsEnabled: false, chargesEnabledInTest: true, payoutsEnabledInTest: false, detailsSubmittedInTest: true, lastVerifiedAt: "2026-08-28T12:00:00.000Z" },
    paypal: { provider: "paypal", state: "deferred", integrationMode: "direct_merchant", environment: "deferred", countryCode: "CA", currencyCode: "CAD", credentialConfigured: false, donationsEnabled: false, membershipEnabled: false, shopCheckoutEnabled: false, providerMutationAvailable: false, lastVerifiedAt: null },
    gates: [{ id: "direct_merchant", label: "Stripe direct merchant architecture", state: "ready", detail: "Dedicated merchant account; no Connect or connected-account flow.", href: null }, { id: "api_verification", label: "Stripe TEST API verification", state: "ready", detail: "Persisted CA/CAD verification evidence is present.", href: null }, { id: "webhook_acceptance", label: "Webhook TEST acceptance", state: "ready", detail: "Persisted signed sandbox receipt proof is present.", href: null }, { id: "business", label: "Business profile", state: "action_required", detail: "Legal business fields remain incomplete.", href: "/commerce/business" }, disabled("tax", "Tax configuration", "Tax strategy is unconfigured.", "/commerce/tax"), disabled("communications", "Customer receipts and email", "Production email sending is disabled.", "/commerce/emails"), disabled("fulfillment", "Fulfillment", "Fulfillment submission is disabled.", "/commerce/fulfillment"), disabled("checkout", "Public checkout", "Normal checkout remains explicitly disabled."), disabled("live_payments", "Live payment capture", "Live payment capture remains explicitly disabled."), { id: "payouts", label: "Payout readiness", state: "unverified", detail: "Balance and payout state are not integrated.", href: null }],
    productionActivation: { checkout: { enabled: false, state: "disabled" }, livePayments: { enabled: false, state: "disabled" }, fulfillment: { enabled: false, state: "disabled" }, controlledTestCheckout: { enabled: false, state: "disabled" }, mutableFromThisRoute: false },
    testEvidence: { orderId: ORDER_ID, environment: "test", amount: 1500, refundAmount: 0, currencyCode: "CAD", paymentStatus: "paid", checkoutStatus: "checkout_created", fulfillmentStatus: "disabled", productName: "Third Rail Farm | Black Glossy Mug", variantName: "11 oz / Black", quantity: 1, stripeSessionId: "cs_test_safe_fixture", paymentIntentId: "pi_test_safe_fixture", webhookEventId: "evt_safe_fixture", webhookResult: "payment_confirmed", createdAt: "2026-08-28T12:17:12.217Z", checkoutCreatedAt: "2026-08-28T12:17:13.196Z", paymentConfirmedAt: "2026-08-28T12:34:03.094Z", webhookReceivedAt: "2026-08-28T12:34:03.000Z" },
    webhookHealth: { endpointImplemented: true, signingSecretConfigured: true, acceptanceVerified: true, externallyVerified: false, environment: "test", counts: { total: 1, processed: 1, failed: 0, test: 1, live: 0, duplicates: null }, latestProcessed: { eventId: "evt_safe_fixture", eventType: "checkout.session.completed", eventCreatedAt: 1787920442, receivedAt: "2026-08-28T12:34:03.000Z", processedAt: "2026-08-28T12:34:03.094Z", environment: "test", relatedObjectId: "cs_test_safe_fixture", relatedObjectType: "checkout.session", processingStatus: "processed", resultCode: "payment_confirmed" }, latestFailed: null, idempotency: { implemented: true, evidence: "Unique provider and event ID ledger; duplicate count is not persisted." } },
    paymentSummary: { currencyCode: "CAD", live: { available: true, successfulPayments: 0, grossAmount: 0, refundedPayments: 0, refundAmount: 0, netAfterRefunds: 0 }, test: { available: true, successfulPayments: 1, grossAmount: 1500, refundedPayments: 0, refundAmount: 0, netAfterRefunds: 1500 }, processingFees: { available: false, reason: "Stripe processing fees are not included because no authoritative fee projection is available." } },
    paymentMethods: [{ id: "card", label: "Card payments", state: "configured", detail: "Stripe-hosted Checkout architecture supported; production checkout is disabled." }, { id: "apple_pay", label: "Apple Pay", state: "unverified", detail: "Provider-managed eligibility is not verified." }, { id: "google_pay", label: "Google Pay", state: "unverified", detail: "Provider-managed eligibility is not verified." }],
    payoutState: { state: "unverified", management: "managed_in_stripe", balanceIntegrationAvailable: false, payoutIntegrationAvailable: false, bankDestinationStored: false, nextPayout: null, availableBalance: null, pendingBalance: null, schedule: null, testCapabilityObserved: false },
    dependencies: [{ id: "business", label: "Business information", state: "action_required", detail: "Legal identity remains incomplete.", href: "/commerce/business" }, { id: "tax", label: "Tax configuration", state: "action_required", detail: "Tax strategy is unconfigured.", href: "/commerce/tax" }, { id: "documents", label: "Receipts and invoices", state: "action_required", detail: "Receipt ready; invoice blocked.", href: "/commerce/tax" }, { id: "communications", label: "Customer emails", state: "disabled", detail: "Production sending is disabled.", href: "/commerce/emails" }, { id: "fulfillment", label: "Fulfillment", state: "disabled", detail: "Fulfillment submission is disabled.", href: "/commerce/fulfillment" }],
    technical: { checkoutArchitecture: "stripe_hosted_checkout_sessions", directMerchant: true, stripeConnect: false, connectedAccounts: false, stripeAccountHeader: false, destinationCharges: false, applicationFees: false, transfers: false, publishableKeyRequired: false, providerMutationAvailable: false }, checkedAt: "2026-08-29T00:00:00Z",
  };
}

function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Vite server did not start."); }
