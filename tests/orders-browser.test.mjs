import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:4197";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("Orders renders the accepted TEST payment and canonicalizes /ORDERS without a Not found shell", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4197"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForPreview();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());

  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/auth/config") return json(route, authConfig());
      if (pathname === "/api/auth/session") return json(route, session());
      if (pathname === "/api/admin/commerce/orders") return json(route, orders());
      return json(route, { ok: false, error: "not_found" }, 404);
    });

    await page.goto(`${ORIGIN}/ORDERS`);
    await page.getByRole("heading", { level: 1, name: "Orders" }).waitFor();
    await page.waitForURL(`${ORIGIN}/orders`);
    assert.equal(await page.locator(".topbar-title strong").innerText(), "Orders");
    assert.equal(await page.getByText("Not found", { exact: true }).count(), 0);
    assert.equal(await page.getByText("STRIPE TEST ACCEPTANCE", { exact: true }).count(), 1);
    assert.equal(await page.getByRole("heading", { level: 2, name: "Passed" }).count(), 1);
    assert.equal(await page.getByText(/TEST .* ord_e47b94a4-4252-438b-8ca7-c47470029940/).count(), 1);
    assert.equal(await page.getByText("Payment confirmed", { exact: true }).count(), 1);
    assert.equal(await page.getByText(/(?:CA)?\$15\.00/).count() >= 1, true);
    assert.equal(await page.getByText("None", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

function orders() {
  return {
    ok: true,
    databaseConfigured: true,
    access: { isMasterAdmin: true, capabilities: ["commerce.view", "commerce.payments.manage"] },
    controlledTest: { enabled: false, normalCheckoutEnabled: false, livePaymentsEnabled: false, fulfillmentEnabled: false, stripe: { status: "connected", environment: "test", integrationMode: "direct_merchant", currencyCode: "CAD" }, candidate: null },
    orders: [{
      id: "ord_e47b94a4-4252-438b-8ca7-c47470029940", test: true, checkoutStatus: "checkout_created", paymentStatus: "paid", fulfillmentStatus: "disabled",
      currencyCode: "CAD", expectedAmount: 1500, stripeSessionId: "cs_test_a1vXUK8hmsaKfXmciNGnU25zL1PdhbkyjFJ0KgDRoHFUkaYvROZiWoG5OC", checkoutUrl: null, stripePaymentIntentId: "pi_test_safe",
      createdAt: "2026-08-28T12:17:12.217Z", updatedAt: "2026-08-28T12:34:03.094Z", checkoutCreatedAt: "2026-08-28T12:17:13.196Z", paymentConfirmedAt: "2026-08-28T12:34:03.094Z",
      webhookReceiptCount: 1, webhookVerified: true, hasPrintfulOrder: false,
      items: [{ productId: "product-397267935", variantId: "variant-5019554081", productName: "Third Rail Farm | Black Glossy Mug", variantName: "11 oz / Black", options: { Size: "11 oz", Color: "Black" }, currencyCode: "CAD", unitAmount: 1500, quantity: 1, lineTotalAmount: 1500 }],
    }],
  };
}

function session() { return { ok: true, authenticated: true, csrfToken: "browser-fixture-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-28T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } }; }
function authConfig() { return { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: "https://thirdrailify-admin.pages.dev", environment: "test", cookieMode: "host-only" }; }
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForPreview() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* still starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Vite preview did not start."); }
