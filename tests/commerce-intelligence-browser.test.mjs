import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44219";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const VIEWPORTS = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }];

test("Commerce Intelligence is responsive, currency-safe, and explicit about unknown direct costs", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44219"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.route("**/api/**", (route) => respond(route, "ready"));
    await page.goto(`${ORIGIN}/commerce/analytics`);
    await page.getByRole("heading", { level: 1, name: "Commerce Intelligence" }).waitFor();
    const nav = page.getByRole("link", { name: "Commerce Intelligence" });
    assert.match(await nav.getAttribute("class"), /nav-link--active/);
    for (const heading of ["CAD", "CAD collection path", "Collected value without interpolation.", "Historical line snapshots, not today’s catalogue price.", "Analytical transaction ledger.", "Precision has a provenance."]) assert.equal(await page.getByRole("heading", { name: heading, exact: true }).count(), 1, heading);
    assert.equal(await page.getByText("Unknown", { exact: true }).count() > 0, true);
    assert.equal(await page.getByText("TEST", { exact: true }).count(), 0);
    assert.equal(await page.getByText(/^Profit$/i).count(), 0);
    assert.equal(await page.getByRole("link", { name: "ord-live-browser" }).getAttribute("href"), "/orders?query=ord-live-browser");
    const reportingGutter = await page.locator(".intelligence-method").evaluate((card) => {
      const heading = card.querySelector("h2")?.getBoundingClientRect(); const box = card.getBoundingClientRect();
      return heading ? heading.left - box.left : 0;
    });
    assert.ok(reportingGutter >= 20, `reporting title keeps its card gutter at ${viewport.width}px`);
    for (const button of await page.getByRole("button", { name: "Reset columns" }).all()) {
      const gutter = await button.evaluate((node) => { const wrapper = node.parentElement?.getBoundingClientRect(); const box = node.getBoundingClientRect(); return wrapper ? wrapper.right - box.right : 0; });
      assert.ok(gutter >= (viewport.width <= 480 ? 13 : 19), `table reset control keeps a right gutter at ${viewport.width}px`);
    }
    const geometry = await page.evaluate(() => ({ fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth, viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(geometry.fits, true, `no page overflow at ${viewport.width}px: ${JSON.stringify(geometry)}`);
    assert.deepEqual(errors, [], `no browser errors at ${viewport.width}px`);
    await context.close();
  }
});

test("Commerce Intelligence empty period is not presented as failed or synthetic", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44219"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage(); await page.route("**/api/**", (route) => respond(route, "empty"));
  await page.goto(`${ORIGIN}/commerce/analytics`);
  await page.getByRole("heading", { name: "No successfully collected LIVE transactions." }).waitFor();
  assert.equal(await page.getByText("No financial activity has been invented.", { exact: false }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await context.close();
});

async function respond(route, mode) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (pathname === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "intelligence-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-31T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } });
  if (pathname === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  if (pathname === "/api/admin/commerce/analytics") return json(route, intelligence(mode));
  return json(route, { ok: false, error: "not_found" }, 404);
}

function intelligence(mode) {
  const current = summary();
  const empty = mode === "empty";
  return { ok: true, environment: "live", range: "30d", generatedAt: "2026-08-31T12:00:00.000Z", timezone: "UTC", currencyMode: "single", currencies: empty ? [] : [current], trend: empty ? [] : [{ currencyCode: "CAD", bucket: "2026-08-30T00:00:00.000Z", merchandise: 10000, donations: 2500, refundsReversals: 1200, netCollected: 12300, complete: true }, { currencyCode: "CAD", bucket: "2026-08-31T00:00:00.000Z", merchandise: 5000, donations: 0, refundsReversals: 0, netCollected: 5000, complete: true }], products: empty ? [] : [{ productId: "product-browser", variantId: "variant-browser", product: "Third Rail shirt", variant: "Black / XL", currencyCode: "CAD", quantity: 2, grossMerchandise: 10000, refundedValue: null, netMerchandise: null, fulfillmentCost: null, costCoverage: { knownOrders: 0, totalOrders: 1 }, complete: false }], orders: { items: empty ? [] : [{ id: "ord-live-browser", capturedAt: "2026-08-30T10:00:00.000Z", status: "partially_refunded", provider: "stripe", fulfillmentStatus: "disabled", currencyCode: "CAD", charged: 12000, merchandise: 10000, customerShipping: 1000, tax: 1000, refundReversal: 1200, netCollected: 10800, fulfillmentCost: null, processorFee: null, contributionMargin: null, completeness: "direct_costs_incomplete" }], page: 1, pageSize: 20, total: empty ? 0 : 1, totalPages: empty ? 0 : 1, truncated: false }, donations: empty ? [] : [{ currencyCode: "CAD", count: 1, gross: 2500, refundsReversals: 0, net: 2500, average: 2500, complete: true }], refunds: empty ? [] : [{ currencyCode: "CAD", orderRefunds: 1, fullOrderRefunds: 0, partialOrderRefunds: 1, refundValue: 1200, refundRate: .1, refundRateBasis: "Completed order refunds and reversals divided by captured order value in the selected cohort.", donationRefunds: 0, donationReversals: 0, disputes: 0, unresolvedDisputes: 0 }], coverage: { orders: empty ? 0 : 1, fulfillmentCost: { known: 0, unknown: empty ? 0 : 1 }, processorFees: { known: 0, unknown: empty ? 0 : 2 }, allocation: { complete: empty ? 0 : 1, incomplete: 0 }, donationReversals: { complete: 0, incomplete: 0 }, unresolvedDisputes: 0, currencies: empty ? [] : ["CAD"], oldestTransactionAt: empty ? null : "2026-08-01T00:00:00.000Z", latestTransactionAt: empty ? null : "2026-08-30T10:00:00.000Z", latestFinancialUpdateAt: empty ? null : "2026-08-31T10:00:00.000Z", latestProviderUpdateAt: null, truncated: { orders: false, donations: false, attempts: false, items: false }, complete: true }, semantics: { basis: "Captured transaction cohorts in the selected UTC window.", merchandise: "Persisted LIVE product subtotal only when the order reconciles.", donations: "Persisted LIVE completed donations.", grossCollected: "Captured orders plus donations.", netCollected: "Gross less completed reversals.", directCosts: "Positive provider-linked values only.", processorFees: "Persisted fees only.", contributionMargin: "Fully evidenced merchandise orders only." } };
}

function summary() {
  const metric = (value, complete = true, knownValue = value || 0) => ({ value: complete ? value : null, knownValue, complete });
  const metrics = { merchandiseSales: metric(15000), donations: metric(2500), customerShipping: metric(1000), taxCollected: metric(1000), grossCollected: metric(19500), refundsReversals: metric(1200), netCollected: metric(18300), knownDirectCosts: metric(null, false, 0), processorFees: metric(null, false, 0), contributionMargin: metric(null, false, 0), averageOrderValue: metric(17000) };
  const previousMetrics = Object.fromEntries(Object.keys(metrics).map((key) => [key, metric(0)]));
  const deltas = Object.fromEntries(Object.keys(metrics).map((key) => [key, { available: metrics[key].complete, value: metrics[key].complete ? null : null, direction: metrics[key].complete ? "new" : "unavailable" }]));
  return { currencyCode: "CAD", metrics, counts: { orders: 1, donations: 1, transactions: 2, refundedOrders: 1, disputes: 0 }, comparisonComplete: true, previous: { metrics: previousMetrics, counts: { orders: 0, donations: 0, transactions: 0, refundedOrders: 0, disputes: 0 } }, deltas };
}
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Commerce Intelligence browser server did not start."); }
