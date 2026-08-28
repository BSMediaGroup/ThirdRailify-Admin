import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:4204";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("Business Information is responsive, accessible, validation-safe, and supports explicit save/discard", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4204"], { stdio: "ignore" }); t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());
  for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844]]) {
    const savedBodies = []; let payload = fixture(); const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" }); const page = await context.newPage(); const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); }); page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
      if (path === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "fixture-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-29T00:00:00Z", lastLoginAt: null, source: "test", locked: true } });
      if (path === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
      if (path === "/api/admin/commerce/business" && route.request().method() === "POST") { const body = JSON.parse(route.request().postData() || "{}"); savedBodies.push(body); payload = fixture({ supportEmail: body.supportEmail, revision: payload.profile.revision + 1 }); return json(route, payload); }
      if (path === "/api/admin/commerce/business") return json(route, payload);
      return json(route, { ok: false, error: "not_found" }, 404);
    });
    await page.goto(`${ORIGIN}/commerce/business`); await page.getByRole("heading", { level: 1, name: "Business information" }).waitFor();
    assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.doesNotMatch(await page.locator("body").innerText(), /Sensitive Legal Entity|1 Private Way|CORP-PRIVATE|A256GCM|ciphertext/);
    assert.equal(await page.getByRole("button", { name: "Save changes" }).isDisabled(), true);
    const support = page.getByLabel("Customer support email"); await support.fill("draft@thirdrailify.com"); assert.equal(await page.getByText("Unsaved business changes", { exact: true }).count(), 1);
    await page.getByRole("button", { name: "Discard" }).click(); assert.equal(await support.inputValue(), "");
    await page.getByLabel("Public contact email").fill("invalid-email"); await page.getByRole("button", { name: "Save changes" }).click();
    assert.equal(await page.getByText("Enter a valid public contact email.", { exact: true }).count(), 1); assert.equal(savedBodies.length, 0);
    await page.getByLabel("Public contact email").fill("info@thirdrailify.com"); await support.fill("support@thirdrailify.com"); await page.getByRole("button", { name: "Save changes" }).click();
    await page.locator(".auth-success").getByText(/Business profile revision 2 saved/).waitFor(); assert.equal(savedBodies.length, 1); assert.equal(savedBodies[0].revision, 1); assert.equal(savedBodies[0].countryCode, "CA"); assert.equal(savedBodies[0].currencyCode, "CAD"); assert.equal("legalBusinessName" in savedBodies[0], false); assert.equal("privateAddress" in savedBodies[0], false);
    assert.equal(await page.getByRole("link", { name: /Tax & documents/ }).getAttribute("href"), "/commerce/tax"); assert.equal(await page.getByRole("link", { name: /Manage Customer Emails/ }).getAttribute("href"), "/commerce/emails");
    await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement !== document.body), true); assert.deepEqual(errors, []);
    await page.evaluate(() => { window.scrollTo(0, 0); (document.activeElement instanceof HTMLElement) && document.activeElement.blur(); }); await page.waitForTimeout(100);
    await page.screenshot({ path: `output/business-information-${width}.png`, fullPage: true }); await context.close();
  }
});

function fixture(overrides = {}) {
  const supportEmail = overrides.supportEmail || ""; const revision = overrides.revision || 1; const completeContact = Boolean(supportEmail);
  const blocked = (summary, details = {}) => ({ ready: false, status: "blocked", summary, details });
  const domains = { business: blocked("Legal identity remains incomplete."), tax: blocked("Tax calculation provider is unconfigured."), communications: blocked("Transactional sending is disabled.", { providerConfigured: true, readyTemplates: 1, sendEnabled: false }), documents: blocked("Invoice readiness is blocked.", { receiptTemplateReady: true, invoiceReady: false }), fulfillment: blocked("Fulfillment is disabled.", { enabled: false }), payments: blocked("Stripe TEST acceptance only."), checkout: blocked("Normal checkout is disabled.", { normalCheckoutEnabled: false }) };
  const groups = [{ id: "core", label: "Core merchant identity", state: "complete", items: [{ id: "trading", label: "Trading name", state: "complete", detail: "Third Railify Official" }] }, { id: "contact", label: "Customer contact", state: completeContact ? "complete" : "action_required", items: [{ id: "public", label: "Public contact email", state: "complete", detail: "info@thirdrailify.com" }, { id: "support", label: "Customer support email", state: completeContact ? "complete" : "incomplete", detail: supportEmail || "Not configured" }] }, { id: "legal", label: "Legal / document identity", state: "action_required", items: [{ id: "legal", label: "Legal business name", state: "incomplete", detail: "Not configured" }] }];
  const canonicalReadiness = { ok: true, authority: "Commerce D1", phase: "pre_cutover", productionReady: false, mandatoryDomains: Object.keys(domains), domains, checkedAt: "2026-08-29T00:00:00Z" };
  return { ok: true, databaseConfigured: true, encryptionConfigured: true, access: { isMasterAdmin: true, capabilities: ["commerce.view", "commerce.business.manage"] }, authority: "Commerce D1", privacy: { publicSafe: ["trading_name", "public_contact_email"], adminOnly: ["revision"], sensitive: ["legal_business_name", "legal_business_address"] }, profile: { tradingName: "Third Railify Official", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicAddress: {}, publicContactEmail: "info@thirdrailify.com", supportEmail, publicPhone: "", websiteUrl: "", invoicePrefix: "", documentFooter: "", taxProviderState: "unavailable", invoiceAccentColor: "#f3c928", receiptAccentColor: "#f3c928", revision, updatedAt: "2026-08-29T00:00:00Z", private: { legalBusinessNameStored: false, privateAddressStored: false, privatePhoneStored: false, businessRegistrationNumberStored: false, legalBusinessNameMasked: "", privateAddressMasked: "", privatePhoneMasked: "", businessRegistrationNumberMasked: "", registrations: [] } }, readiness: { overallStatus: "action_required", completion: { complete: completeContact ? 6 : 5, total: 9, percent: completeContact ? 67 : 56 }, groups, profile: { coreIdentity: "complete", publicContact: completeContact ? "complete" : "partial", legalIdentity: "not_configured", address: "not_configured", tax: "not_configured", documents: "partial", productionCommerce: "action_required" }, dependencies: { ...domains, paypalRequired: false }, documentIdentity: { tradingName: "Third Railify Official", legalNameStored: false, addressStored: false, contactEmail: supportEmail || "info@thirdrailify.com", taxRegistrationState: "not_configured", receiptTemplate: { state: "complete", revision: 1 }, invoiceTemplate: { state: "incomplete", revision: 1 } } }, canonicalReadiness };
}
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Vite server did not start."); }
