import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44212";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CUSTOMER_ID = "cst_11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "account-buyer-1";

test("Customers, Account details, and Admin table resizing remain responsive and safely linked", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44212"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  const page = await context.newPage(); const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
  await page.route("**/api/**", respond);

  await page.goto(`${ORIGIN}/customers`);
  await page.getByRole("heading", { level: 1, name: "Customers" }).waitFor();
  await page.getByText("Guest Buyer", { exact: true }).waitFor();
  assert.match(await page.locator(".customer-table").innerText(), /Guest Buyer[\s\S]*Guest[\s\S]*guest@example\.test/i);
  assert.match(await page.locator(".customer-table").innerText(), /TEST · 1/);
  assert.doesNotMatch(await page.locator("body").innerText(), /ciphertext-fixture|fingerprint-fixture|session-token-fixture|password-hash-fixture/);
  await assertNoPhantomHorizontalScrollbar(page, ".customer-table-wrap");
  await capture(page, "customers-1920.png");

  const resize = page.getByRole("separator", { name: "Resize Customer" });
  const initialWidth = Number(await resize.getAttribute("aria-valuenow"));
  await resize.focus(); await page.keyboard.press("ArrowRight");
  const resizedWidth = Number(await resize.getAttribute("aria-valuenow"));
  assert.equal(resizedWidth, initialWidth + 12);
  assert.equal(await page.evaluate(() => localStorage.getItem("thirdrailify.admin.table-widths.v1:customers") !== null), true);
  await page.reload(); await page.getByText("Guest Buyer", { exact: true }).waitFor();
  assert.equal(Number(await page.getByRole("separator", { name: "Resize Customer" }).getAttribute("aria-valuenow")), resizedWidth);
  await page.getByRole("button", { name: "Reset columns" }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem("thirdrailify.admin.table-widths.v1:customers")), null);
  await assertNoPhantomHorizontalScrollbar(page, ".customer-table-wrap");
  await page.evaluate(() => localStorage.setItem("thirdrailify.admin.table-widths.v1:customers", JSON.stringify(Array(8).fill(560))));
  await page.reload(); await page.getByText("Guest Buyer", { exact: true }).waitFor();
  await page.getByRole("separator", { name: "Resize Customer" }).waitFor();
  assert.equal(await page.locator(".customer-table-wrap").evaluate((wrapper) => wrapper.scrollWidth > wrapper.clientWidth), true, "Customers retains horizontal scrolling for genuinely oversized columns");
  await page.getByRole("button", { name: "Reset columns" }).click();
  await page.waitForFunction(() => { const wrapper = document.querySelector(".customer-table-wrap"); return wrapper && wrapper.scrollWidth <= wrapper.clientWidth + 1; });
  await assertNoPhantomHorizontalScrollbar(page, ".customer-table-wrap");

  const guestRow = page.getByRole("row", { name: /Open customer Guest Buyer/ });
  await guestRow.focus(); await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Guest Buyer" }).waitFor();
  assert.match(new URL(page.url()).search, /customer=cst_/);
  assert.match(await page.getByRole("dialog").innerText(), /No Account linkage[\s\S]*TEST gross[\s\S]*historical delivery snapshot/i);
  await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await guestRow.evaluate((element) => element === document.activeElement), true);

  await page.goto(`${ORIGIN}/access`);
  await page.getByRole("heading", { level: 1, name: "Accounts & access" }).waitFor();
  await page.getByText("Buyer Account", { exact: true }).waitFor();
  assert.equal(await page.getByRole("separator").count(), 7);
  await assertNoPhantomHorizontalScrollbar(page, ".accounts-table-wrap");
  await capture(page, "access-1920.png");
  const buyerRow = page.getByRole("row", { name: /Open account Buyer Account/ });
  await buyerRow.getByRole("button", { name: "Disable" }).click();
  await page.getByRole("alertdialog", { name: "Disable account?" }).waitFor();
  assert.doesNotMatch(page.url(), /account=/);
  await page.getByRole("button", { name: "Cancel" }).click();
  await buyerRow.click();
  await page.getByRole("dialog", { name: "Buyer Account" }).waitFor();
  assert.match(await page.getByRole("dialog").innerText(), /1 active · 1 retained[\s\S]*Connected Customer/i);
  await page.getByRole("dialog").getByText("Technical and audit metadata", { exact: true }).click();
  assert.match(await page.getByRole("dialog").innerText(), /Session tokens[\s\S]*Never exposed/i);
  assert.match(new URL(page.url()).search, /account=account-buyer-1/);
  assert.deepEqual(errors, []);
  await context.close();

  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    const mobile = await browser.newContext({ viewport, reducedMotion: "reduce" }); const mobilePage = await mobile.newPage();
    await mobilePage.route("**/api/**", respond); await mobilePage.goto(`${ORIGIN}/customers`);
    await mobilePage.getByText("Guest Buyer", { exact: true }).waitFor();
    if (viewport.width === 1440 || viewport.width === 390) await capture(mobilePage, `customers-${viewport.width}.png`);
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `Customers has no horizontal overflow at ${viewport.width}px`);
    assert.equal(await mobilePage.getByRole("separator").first().isVisible(), viewport.width > 760, `resize handle visibility matches the responsive table mode at ${viewport.width}px`);
    await mobilePage.getByRole("row", { name: /Open customer Guest Buyer/ }).click();
    await mobilePage.getByRole("dialog", { name: "Guest Buyer" }).waitFor();
    const drawer = await mobilePage.getByRole("dialog").boundingBox();
    assert.ok(drawer && drawer.width <= viewport.width, `detail drawer fits ${viewport.width}px`);
    await mobile.close();
  }
});

async function respond(route) {
  const url = new URL(route.request().url()); const path = url.pathname;
  if (path === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (path === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "safe-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: masterAccount() });
  if (path === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  if (path === "/api/admin/commerce/customers" && !url.searchParams.has("customer")) return json(route, customersPayload());
  if (path === `/api/admin/commerce/customers/${CUSTOMER_ID}`) return json(route, customerDetail());
  if (path === "/api/admin/accounts") return json(route, accountsPayload());
  if (path === `/api/admin/accounts/${ACCOUNT_ID}`) return json(route, accountDetail());
  return json(route, { ok: false, error: "not_found" }, 404);
}

function customerSummary() { return { orderCount: 1, paidOrderCount: 1, liveOrderCount: 0, testOrderCount: 1, livePaidOrderCount: 0, testPaidOrderCount: 1, liveSpendAmount: 0, testSpendAmount: 2500, currencyCode: "CAD", firstOrderAt: "2026-08-29T01:00:00.000Z", lastOrderAt: "2026-08-29T01:00:00.000Z" }; }
function guestCustomer() { return { id: CUSTOMER_ID, kind: "guest", contact: { name: "Guest Buyer", email: "guest@example.test" }, account: null, createdAt: "2026-08-29T01:00:00.000Z", updatedAt: "2026-08-29T01:00:00.000Z", revision: 1, summary: customerSummary() }; }
function customersPayload() { return { ok: true, databaseConfigured: true, authority: "THIRDRAILIFY_COMMERCE_DB", access: { canView: true }, customers: [guestCustomer()], page: 1, pageSize: 20, totalMatching: 1, totalPages: 1, startIndex: 1, endIndex: 1, filters: { page: 1, pageSize: 20, query: "", type: "all", environment: "all", purchase: "any", sort: "latest_order" } }; }
function customerDetail() { return { ...customersPayload(), customer: { ...guestCustomer(), orders: [{ id: "ord_11111111-1111-4111-8111-111111111111", environment: "test", paymentStatus: "paid", fulfillmentStatus: "disabled", fulfillment: { state: "unfulfilled", shipped: false, trackingAvailable: false, shipmentCount: 0 }, totalAmount: 2500, refundAmount: 0, currencyCode: "CAD", createdAt: "2026-08-29T01:00:00.000Z", paymentConfirmedAt: "2026-08-29T01:01:00.000Z", delivery: { countryCode: "CA", regionCode: "ON", method: "Standard delivery", historicalSnapshot: true }, documentCount: 0, emailCount: 0 }], orderPage: 1, orderPageSize: 20, orderTotalPages: 1, communication: { documents: 0, deliveries: 0, boundedToVisibleOrders: true }, technical: { revision: 1, linkedAccountId: null } } }; }
function masterAccount() { return { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], identities: [], role: "admin", adminLevel: "master", status: "active", emailVerified: true, emailVerifiedAt: "2026-08-29T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", lastLoginAt: "2026-08-29T00:00:00.000Z", source: "test", locked: true, customer: null }; }
function buyerAccount() { return { id: ACCOUNT_ID, email: "buyer@example.test", displayName: "Buyer Account", username: "buyer", avatarUrl: null, providers: ["email"], identities: [{ provider: "email", subject: "buyer@example.test", username: "buyer", email: "buyer@example.test", emailVerified: true }], role: "user", adminLevel: "none", status: "active", emailVerified: true, emailVerifiedAt: "2026-08-20T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", lastLoginAt: "2026-08-29T00:00:00.000Z", source: "email", locked: false, customer: { id: CUSTOMER_ID, orderCount: 1, lastOrderAt: "2026-08-29T01:00:00.000Z" } }; }
function accountsPayload() { return { ok: true, accounts: [masterAccount(), buyerAccount()], access: { isAdmin: true, isMasterAdmin: true }, checkedAt: "2026-08-29T02:00:00.000Z" }; }
function accountDetail() { return { ok: true, account: buyerAccount(), sessions: [{ id: "session-safe-id", createdAt: "2026-08-29T00:00:00.000Z", expiresAt: "2099-08-29T00:00:00.000Z", lastSeenAt: "2026-08-29T01:00:00.000Z", revokedAt: null, sourceOrigin: ORIGIN, userAgentRecorded: true }], audit: [{ id: "audit-safe-id", eventType: "auth_signin", result: "success", provider: "email", createdAt: "2026-08-29T01:00:00.000Z" }], access: { isAdmin: true, isMasterAdmin: true }, checkedAt: "2026-08-29T02:00:00.000Z" }; }
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function capture(page, filename) {
  if (!process.env.CUSTOMERS_SCREENSHOT_DIR) return;
  await mkdir(process.env.CUSTOMERS_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.CUSTOMERS_SCREENSHOT_DIR, filename), fullPage: true });
}
async function assertNoPhantomHorizontalScrollbar(page, selector) {
  const geometry = await page.locator(selector).evaluate((wrapper) => {
    const table = wrapper.querySelector("table");
    const finalHandle = wrapper.querySelector("th:last-child .column-resize-handle");
    const wrapperBox = wrapper.getBoundingClientRect();
    const tableBox = table?.getBoundingClientRect();
    const handleBox = finalHandle?.getBoundingClientRect();
    return {
      overflowX: getComputedStyle(wrapper).overflowX,
      clientWidth: wrapper.clientWidth,
      scrollWidth: wrapper.scrollWidth,
      tableRight: tableBox?.right ?? 0,
      handleRight: handleBox?.right ?? 0,
      wrapperRight: wrapperBox.right,
    };
  });
  assert.equal(geometry.overflowX, "auto", `${selector} retains scrolling for genuine overflow`);
  assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `${selector} has no horizontal scroll range when its table fits: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.tableRight <= geometry.wrapperRight + 1, `${selector} table stays inside its wrapper`);
  assert.ok(geometry.handleRight <= geometry.wrapperRight + 1, `${selector} final resize handle stays inside its wrapper`);
}
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Customer browser test server did not start."); }
