import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44216";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("Admin quick search ranks permitted pages and supports mouse, keyboard, collapsed, and mobile use", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44216", "--strictPort"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", respond);
  await page.goto(`${ORIGIN}/customers`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Customers" }).waitFor();

  const trigger = page.getByRole("button", { name: "Open quick search" });
  assert.equal(await trigger.count(), 1);
  assert.equal(await page.getByText("Workspace", { exact: true }).count(), 0);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Quick navigation" });
  const input = page.getByRole("combobox", { name: "Search Admin pages" });
  await dialog.waitFor();
  assert.equal(await input.evaluate((element) => document.activeElement === element), true);
  await input.fill("payments");
  const options = dialog.getByRole("option");
  assert.ok(await options.count() >= 1);
  assert.match(await options.first().innerText(), /^Payments & Payouts/m);
  assert.equal(await options.first().getAttribute("aria-selected"), "true");
  await page.keyboard.press("ArrowDown");
  if (await options.count() > 1) assert.equal(await options.nth(1).getAttribute("aria-selected"), "true");
  await page.keyboard.press("ArrowUp");
  assert.equal(await options.first().getAttribute("aria-selected"), "true");
  await evidence(page, "desktop");
  assert.deepEqual(errors, []);
  await page.keyboard.press("Enter");
  await page.waitForURL(`${ORIGIN}/commerce/payments`);
  assert.equal(await dialog.count(), 0);

  await page.goto(`${ORIGIN}/customers`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Customers" }).waitFor();
  errors.length = 0;
  const restoredTrigger = page.getByRole("button", { name: "Open quick search" });
  await restoredTrigger.focus();
  await page.keyboard.press("Control+K");
  await input.waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open quick search");
  assert.equal(await restoredTrigger.evaluate((element) => document.activeElement === element), true);
  await page.keyboard.press("Meta+K");
  await input.waitFor();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  const collapsedBox = await restoredTrigger.boundingBox();
  assert.ok(collapsedBox && Math.abs(collapsedBox.width - 48) <= 1);
  assert.equal(await restoredTrigger.locator(":scope > span").isVisible(), false);
  await restoredTrigger.click();
  await dialog.waitFor();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Open quick search" }).click();
  await dialog.waitFor();
  const geometry = await dialog.evaluate((element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; });
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewportWidth);
  assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight);
  assert.equal(geometry.pageOverflow, false);
  await input.fill("zzzz-no-route");
  assert.equal(await dialog.getByText("No matching destination", { exact: true }).count(), 1);
  await evidence(page, "mobile");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});

async function respond(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (pathname === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "quick-search-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-09-13T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } });
  if (pathname === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  if (pathname === "/api/admin/commerce/customers") return json(route, customerPayload());
  return json(route, { ok: true });
}

function customerPayload() { return { ok: true, databaseConfigured: true, authority: "THIRDRAILIFY_COMMERCE_DB", access: { canView: true }, customers: [], page: 1, pageSize: 20, totalMatching: 0, totalPages: 1, startIndex: 0, endIndex: 0, filters: { page: 1, pageSize: 20, query: "", type: "all", environment: "all", purchase: "any", sort: "latest_order" } }; }
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Quick-search browser server did not start."); }
async function evidence(page, name) { if (process.env.QUICK_SEARCH_SCREENSHOTS !== "1") return; await page.screenshot({ path: path.join(process.env.TEMP || ".", `thirdrailify-admin-quick-search-${name}.png`), fullPage: false }); }
