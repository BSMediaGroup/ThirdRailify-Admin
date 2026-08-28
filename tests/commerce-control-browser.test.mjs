import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:4201";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("permanent commerce control pages are truthful, focusable, and responsive", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4201"], { stdio: "ignore" }); t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());
  for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
    for (const [path, heading] of [["/commerce", "Commerce overview"], ["/commerce/business", "Business information"], ["/commerce/tax", "Tax & documents"], ["/commerce/emails", "Customer emails"], ["/orders", "Orders"]]) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" }); const page = await context.newPage(); const errors = [];
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); }); page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/**", routeFixture);
      await page.goto(`${ORIGIN}${path}`); await page.getByRole("heading", { level: 1, name: heading }).waitFor();
      assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); assert.deepEqual(errors, []);
      assert.doesNotMatch(await page.locator("body").innerText(), /identifier_ciphertext|A256GCM|cs_test_|evt_1U9Oys/);
      await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
      if (path === "/commerce") { assert.equal(await page.getByText("Production commerce remains blocked", { exact: true }).count(), 1); assert.equal(await page.getByText("49 public products", { exact: true }).count(), 1); }
      if (path === "/commerce/tax") { assert.equal(await page.getByText("Tax calculation provider", { exact: true }).count() >= 1, true); assert.equal(await page.getByText("Not enabled / unverified", { exact: true }).count(), 1); }
      if (path === "/commerce/emails") { assert.equal(await page.getByRole("button", { name: "Preview synthetic fixture" }).count(), 1); assert.equal(await page.getByRole("button", { name: "Send TEST/PREVIEW email" }).isDisabled(), true); }
      if (path === "/orders") { await page.getByRole("button", { name: "View receipt" }).click(); assert.equal(await page.getByText("TEST / SANDBOX", { exact: true }).count(), 1); assert.equal(await page.getByText("Third Rail Farm | Black Glossy Mug", { exact: true }).count() >= 1, true); assert.equal(await page.getByText("Not configured / omitted", { exact: true }).count(), 2); }
      await context.close();
    }
  }
});

async function routeFixture(route) {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (path === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "fixture-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-29T00:00:00Z", lastLoginAt: null, source: "test", locked: true } });
  if (path === "/api/admin/commerce/overview") return json(route, overview());
  if (path === "/api/admin/commerce/business") return json(route, business());
  if (path === "/api/admin/commerce/tax") return json(route, tax());
  if (path === "/api/admin/commerce/templates") return json(route, templates());
  if (path === "/api/admin/commerce/orders") return json(route, orders());
  if (/\/api\/admin\/commerce\/orders\/[^/]+\/documents\/receipt$/.test(path)) return json(route, { ok: true, access: access(), document: receipt() });
  return json(route, { ok: false, error: "not_found" }, 404);
}
function access() { return { isMasterAdmin: true, capabilities: ["commerce.view", "commerce.business.manage", "commerce.payments.manage", "commerce.integrations.manage", "commerce.templates.manage"] }; }
function overview() { const domains = Object.fromEntries(["business", "tax", "payments", "shipping", "fulfillment", "communications", "documents", "checkout"].map((key) => [key, { ready: false, status: "blocked", summary: `${key} configuration remains blocked.`, details: key === "payments" ? { testAcceptancePassed: true } : {} }])); domains.catalogue = { ready: true, status: "ready", summary: "49 public products are served from permanent Commerce D1 authority.", details: { publicProducts: 49 } }; return { ok: true, databaseConfigured: true, encryptionConfigured: true, stripeSecretConfigured: true, printfulSecretConfigured: true, access: access(), printfulCatalogueSnapshot: { available: false, configurationReady: true, actionPath: "", sourceTargetDistinct: true, source: { id: "16847493", name: "Third Railify Official", type: "wix" }, target: { id: "18668025", name: "Third Railify API", type: "native" } }, posture: {}, providers: [], business: business().profile, completeness: { businessProfile: "pending", tax: "setup_required", templates: "pending" }, counts: { products: 50, orders: 1, templates: 9 }, readiness: { ok: true, authority: "Commerce D1", phase: "pre_cutover", productionReady: false, mandatoryDomains: Object.keys(domains), domains, checkedAt: "2026-08-29T00:00:00Z" }, checkedAt: "2026-08-29T00:00:00Z" }; }
function business() { return { ok: true, databaseConfigured: true, encryptionConfigured: true, access: access(), profile: { tradingName: "Third Railify Official", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicAddress: {}, publicContactEmail: "info@thirdrailify.com", supportEmail: "", publicPhone: "", websiteUrl: "", invoicePrefix: "", documentFooter: "", taxProviderState: "unavailable", invoiceAccentColor: "#f3c928", receiptAccentColor: "#f3c928", private: { legalBusinessNameStored: false, privateAddressStored: false, privatePhoneStored: false, businessRegistrationNumberStored: false, legalBusinessName: "", privateAddress: {}, privatePhone: "", businessRegistrationNumber: "", registrations: [] } } }; }
function tax() { return { ok: true, access: access(), registrations: [], calculation: { provider: "unconfigured", stripeTax: "not_enabled_unverified", ratesConfigured: false }, readiness: { ready: false, status: "blocked", reason: "Explicit configuration required." } }; }
function template(key, kind = "email") { return { templateKey: key, templateKind: kind, displayName: key.replaceAll("_", " "), subject: "Order {{order_reference}}", preheader: "", heading: "Third Railify", introduction: "", bodyBlocks: [], ctaLabel: "", ctaUrl: "", supportText: "Questions? Contact {{support_email}}.", footer: "Third Railify Official", accentColor: "#f3c928", status: key === "payment_receipt" ? "ready" : "draft", enabled: key === "payment_receipt", revision: 1 }; }
function templates() { return { ok: true, databaseConfigured: true, access: access(), templates: ["order_confirmation", "shipment_notification", "cancellation", "refund", "payment_failure", "invoice_notification", "receipt_notification"].map((key) => template(key)).concat([template("payment_receipt", "document"), template("invoice_document", "document")]) }; }
function orders() { return { ok: true, databaseConfigured: true, access: access(), controlledTest: { enabled: false, normalCheckoutEnabled: false, livePaymentsEnabled: false, fulfillmentEnabled: false, stripe: { status: "connected", environment: "test", integrationMode: "direct_merchant", currencyCode: "CAD" }, candidate: null }, orders: [{ id: "ord_e47b94a4-4252-438b-8ca7-c47470029940", test: true, checkoutStatus: "checkout_created", paymentStatus: "paid", fulfillmentStatus: "disabled", currencyCode: "CAD", expectedAmount: 1500, stripeSessionId: "redacted", checkoutUrl: null, stripePaymentIntentId: null, createdAt: "2026-08-28T00:00:00Z", updatedAt: "2026-08-28T00:00:00Z", checkoutCreatedAt: "2026-08-28T00:00:00Z", paymentConfirmedAt: "2026-08-28T00:00:00Z", webhookReceiptCount: 1, webhookVerified: true, hasPrintfulOrder: false, items: [{ productId: "p", variantId: "v", productName: "Third Rail Farm | Black Glossy Mug", variantName: "11 oz / Black", options: {}, currencyCode: "CAD", unitAmount: 1500, quantity: 1, lineTotalAmount: 1500 }] }] }; }
function receipt() { return { type: "receipt", available: true, reason: "", test: true, marker: "TEST / SANDBOX", displayReference: "receipt", orderReference: "ord_e47b94a4-4252-438b-8ca7-c47470029940", merchantName: "Third Railify Official", legalName: null, legalAddress: null, supportEmail: "info@thirdrailify.com", issuedAt: "2026-08-28T00:00:00Z", payment: "Confirmed", fulfillment: "Disabled / not started", items: [{ productName: "Third Rail Farm | Black Glossy Mug", variantName: "11 oz / Black", options: {}, unitAmount: 1500, quantity: 1, lineTotalAmount: 1500 }], subtotal: 1500, shipping: null, tax: null, total: 1500, currency: "CAD", templateKey: "payment_receipt", templateRevision: 1, disclosures: [] }; }
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Vite server did not start."); }
