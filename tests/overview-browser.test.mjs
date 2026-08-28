import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44201";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("Admin overview reports real cross-system state responsively without deferred-era copy", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44201"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());

  for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage(); const errors = []; let statusReads = 0;
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", (route) => routeFixture(route, () => { statusReads += 1; }));
    await page.goto(ORIGIN); await page.getByRole("heading", { level: 1, name: "Every signal. One control room." }).waitFor();
    await page.getByText("5/5", { exact: true }).waitFor();

    assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
    assert.equal((await page.locator(".overview-pulse__credential").innerText()).includes("MASTER"), true);
    assert.equal((await page.locator(".overview-pulse__credential").innerText()).includes("ACCOUNT LEVEL / SERVER VERIFIED"), true);
    const shieldAlignment = await page.locator(".overview-pulse__shield").evaluate((node) => {
      const shield = node.getBoundingClientRect(); const icon = node.querySelector("svg")?.getBoundingClientRect();
      return icon ? { x: Math.abs((shield.left + shield.width / 2) - (icon.left + icon.width / 2)), y: Math.abs((shield.top + shield.height / 2) - (icon.top + icon.height / 2)) } : null;
    });
    assert.equal(Boolean(shieldAlignment && shieldAlignment.x <= 1 && shieldAlignment.y <= 1), true, `shield icon centered at ${width}x${height}`);
    const rolePresentation = await page.locator(".overview-pulse__credential strong").evaluate((node) => {
      const style = getComputedStyle(node); const box = node.getBoundingClientRect();
      return { text: node.textContent?.trim(), overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace, width: box.width, scrollWidth: node.scrollWidth };
    });
    assert.equal(rolePresentation.text, "Master");
    assert.equal(rolePresentation.overflow, "visible");
    assert.equal(rolePresentation.textOverflow, "clip");
    assert.equal(rolePresentation.whiteSpace, "normal");
    assert.equal(rolePresentation.scrollWidth <= Math.ceil(rolePresentation.width), true, `account level is fully readable at ${width}x${height}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `no horizontal overflow at ${width}x${height}`);
    assert.deepEqual(errors, [], `no page errors at ${width}x${height}`);
    const copy = await page.locator("body").innerText(); const normalizedCopy = copy.replace(/\s+/g, " ");
    assert.doesNotMatch(copy, /Authenticated foundation|Still intentionally deferred|Products and orders remain provider-neutral shells/);
    for (const value of [/3\s*\/\s*24 RETAINED EPISODES/, /50 CATALOGUE PRODUCTS/, /2 AWAITING MODERATION/, /2 ANNOUNCEMENT MESSAGES/, /4 TOTAL ACCOUNTS/]) assert.match(normalizedCopy, value);
    assert.match(copy, /2 GOATS submissions awaiting review/);
    assert.match(copy, /1 community email failed/);
    assert.match(normalizedCopy, /CHECKOUT DISABLED/);
    assert.equal(await page.locator('a[href="/watch"]').count() >= 1, true);
    assert.equal(await page.locator('a[href="/commerce"]').count() >= 1, true);
    assert.equal(await page.locator('a[href="/goats/pending"]').count() >= 1, true);
    assert.equal(await page.locator('a[href="/content"]').count() >= 1, true);
    assert.equal(await page.locator('a[href="/access"]').count() >= 1, true);
    const refresh = page.getByRole("button", { name: "Refresh overview" }); await refresh.click(); await page.getByRole("button", { name: "Refresh overview" }).waitFor();
    assert.equal(statusReads >= 2, true, "manual refresh rereads authority");
    if (process.env.OVERVIEW_BROWSER_SCREENSHOTS === "1") await page.screenshot({ path: path.join(process.env.TEMP || ".", `thirdrailify-admin-overview-${width}-PROOF.png`), fullPage: true });
    await context.close();
  }
});

test("Admin overview fails soft per authority and disables nonessential motion", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44201"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, reducedMotion: "reduce" });
  const page = await context.newPage(); const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); }); page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => routeFixture(route, () => {}, { bannerUnavailable: true }));
  await page.goto(ORIGIN); await page.getByText("Partial operational snapshot", { exact: true }).waitFor();
  assert.equal(await page.getByText("4/5", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Site content unavailable", { exact: true }).count(), 1);
  assert.doesNotMatch(await page.locator(".overview-module--content").innerText(), /0 announcement messages/);
  assert.equal(await page.locator(".overview-hero__signal span").evaluate((node) => getComputedStyle(node).animationName), "none");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.equal(errors.length > 0 && errors.every((message) => /503 \(Service Unavailable\)/.test(message)), true, "only the deliberate authority failure reaches the browser console");
  await context.close();

  let protectedReads = 0;
  const fullAdminContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const fullAdminPage = await fullAdminContext.newPage();
  await fullAdminPage.route("**/api/**", (route) => routeFixture(route, () => {}, { fullAdmin: true, onProtected: () => { protectedReads += 1; } }));
  await fullAdminPage.goto(ORIGIN); await fullAdminPage.getByText("2/2", { exact: true }).waitFor();
  assert.equal((await fullAdminPage.locator(".overview-pulse__credential").innerText()).includes("FULL ADMIN"), true);
  assert.equal(await fullAdminPage.locator(".overview-pulse__credential strong").evaluate((node) => getComputedStyle(node).overflow === "visible" && node.scrollWidth <= Math.ceil(node.getBoundingClientRect().width)), true, "Full Admin role is fully readable on phone");
  assert.equal(await fullAdminPage.getByText("Restricted", { exact: true }).count(), 3);
  assert.equal(protectedReads, 0, "Full Admin overview does not request Master-only authorities");
  assert.equal(await fullAdminPage.getByText("Partial operational snapshot", { exact: true }).count(), 0, "restricted modules are not reported as service failures");
  assert.equal(await fullAdminPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await fullAdminContext.close();
});

test("Admin inbox, sidebar queue counts, and account indicator render without overflow", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44201"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage(); const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); }); page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", (route) => routeFixture(route, () => {}));
    await page.goto(`${ORIGIN}/inbox`); await page.getByRole("heading", { level: 1, name: "Inbox" }).waitFor();
    assert.equal(await page.locator('.nav-link[href="/inbox"] .nav-badge').textContent(), "2");
    assert.equal(await page.locator('.nav-link[href="/goats"] .nav-badge').textContent(), "4");
    assert.equal(await page.getByRole("heading", { level: 2, name: "GOATS submission awaiting review" }).count(), 1);
    assert.equal(await page.locator(".admin-account__badge").textContent(), "2");
    await page.locator(".admin-account__trigger").click();
    assert.equal(await page.getByRole("menuitem", { name: /Admin Inbox/ }).count(), 1);
    const signOutAlignment = await page.getByRole("menuitem", { name: "Sign out" }).evaluate((button) => {
      const buttonBox = button.getBoundingClientRect();
      const iconBox = button.querySelector("svg")?.getBoundingClientRect();
      const labelBox = button.querySelector("span")?.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        justifyContent: style.justifyContent,
        textAlign: style.textAlign,
        iconOffset: iconBox ? iconBox.left - buttonBox.left : Number.POSITIVE_INFINITY,
        labelFollowsIcon: Boolean(iconBox && labelBox && labelBox.left > iconBox.right),
      };
    });
    assert.equal(signOutAlignment.justifyContent, "flex-start", `Sign out is left-justified at ${width}x${height}`);
    assert.equal(signOutAlignment.textAlign, "left", `Sign out text is left-aligned at ${width}x${height}`);
    assert.equal(signOutAlignment.iconOffset < 20, true, `Sign out starts at the menu's left padding at ${width}x${height}`);
    assert.equal(signOutAlignment.labelFollowsIcon, true, `Sign out label follows its icon at ${width}x${height}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `no horizontal overflow at ${width}x${height}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

async function routeFixture(route, onStatus, options = {}) {
  const url = new URL(route.request().url()); const apiPath = url.pathname;
  if (apiPath === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: "fixture-site-key", oauthProviders: ["discord", "github", "twitter"], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (apiPath === "/api/auth/session") return json(route, session(Boolean(options.fullAdmin)));
  if (apiPath === "/api/admin/status") { onStatus(); return json(route, status()); }
  if (apiPath === "/api/admin/watch") { options.onProtected?.(); return json(route, watch()); }
  if (apiPath === "/api/admin/commerce/overview") return json(route, commerce());
  if (apiPath === "/api/admin/goats/overview") { options.onProtected?.(); return json(route, goats()); }
  if (apiPath === "/api/admin/inbox/summary") return json(route, inboxSummary());
  if (apiPath === "/api/admin/inbox") return json(route, { ok: true, items: inboxSummary().latest, total: 2 });
  if (apiPath.startsWith("/api/admin/inbox/") && route.request().method() === "POST") return json(route, { ok: true });
  if (apiPath === "/api/admin/banner") { options.onProtected?.(); return options.bannerUnavailable ? json(route, { ok: false, error: "fixture_unavailable", message: "Banner authority fixture unavailable." }, 503) : json(route, banner()); }
  return json(route, { ok: false, error: "not_found" }, 404);
}

function session(fullAdmin = false) { return { ok: true, authenticated: true, csrfToken: "fixture-csrf", access: { isAdmin: true, isMasterAdmin: !fullAdmin }, account: { id: fullAdmin ? "full" : "master", email: "admin@example.test", displayName: fullAdmin ? "Full Admin" : "Master", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: fullAdmin ? "full" : "master", status: "active", emailVerified: true, createdAt: "2026-08-29T00:00:00Z", lastLoginAt: null, source: "test", locked: true } }; }
function status() { return { ok: true, authenticatedAccount: { displayName: "Master", adminLevel: "master" }, access: { isAdmin: true, isMasterAdmin: true }, configuration: { d1Configured: true, turnstileConfigured: true, resendConfigured: true, oauthProviders: ["discord", "github", "twitter"] }, accounts: { total: 4, regular: 1, admins: 3, disabled: 0, pending: 1 }, checkedAt: "2026-08-29T01:30:00Z" }; }
function watch() { return { ok: true, current: { freshness: "delayed", liveNow: [], primary: { title: "Latest validated Third Railify episode", platform: "rumble", presentationState: "archive", scheduledStart: null, actualStart: "2026-08-28T01:30:00Z", publishedAt: "2026-08-28T01:30:00Z" }, upcoming: null }, summary: { retained: 3, visible: 3, hidden: 0, remaining: 21, newest: { id: "episode-3", title: "Latest validated Third Railify episode", date: "2026-08-28T01:30:00Z" }, oldest: null }, episodes: [] }; }
function commerce() { return { ok: true, databaseConfigured: true, encryptionConfigured: true, stripeSecretConfigured: true, printfulSecretConfigured: true, access: { isMasterAdmin: true, capabilities: ["commerce.view"] }, printfulCatalogueSnapshot: { available: false, configurationReady: true, actionPath: "", sourceTargetDistinct: true, source: { id: "source", name: "Legacy", type: "wix" }, target: { id: "target", name: "Third Railify API", type: "native" } }, posture: { checkout: "disabled", livePaymentCapture: "disabled", fulfillmentSubmission: "disabled" }, providers: [], business: { tradingName: "Third Railify Official", countryCode: "CA", provinceCode: "ON", currencyCode: "CAD", publicAddress: {}, publicContactEmail: "info@thirdrailify.com", supportEmail: "", publicPhone: "", websiteUrl: "", invoicePrefix: "", documentFooter: "", taxProviderState: "unavailable", invoiceAccentColor: "#f3c928", receiptAccentColor: "#f3c928" }, completeness: { businessProfile: "pending", tax: "setup_required", templates: "pending" }, counts: { products: 50, orders: 1, templates: 9 }, readiness: { ok: true, authority: "Commerce D1", phase: "pre_cutover", productionReady: false, mandatoryDomains: [], domains: {}, checkedAt: "2026-08-29T01:30:00Z" }, checkedAt: "2026-08-29T01:30:00Z" }; }
function goats() { return { ok: true, counts: { pending: 2, approved: 11, rejected: 1, hidden: 0 }, email: { pending: 0, failed: 1 }, recent: [{ id: "goat-1", reference: "GOAT-001", displayName: "Rail Viewer", status: "pending", published: false, submittedAt: "2026-08-29T01:00:00Z", updatedAt: "2026-08-29T01:00:00Z", product: { id: "product-1", slug: "cap", name: "Third Railify Cap" }, rating: null, location: "London, Ontario", mediaCount: 2, mainMediaUrl: null, emailState: "failed", version: 1 }] }; }
function banner() { return { ok: true, config: { normal: { enabled: true, messages: [{ text: "Watch Third Railify", ctaLabel: "Watch", href: "/watch", newTab: false }, { text: "Explore GOATS", ctaLabel: null, href: null, newTab: false }], mode: "crossfade", speed: "normal" }, homeRail: { enabled: true, items: ["THIRD RAILIFY", "NEWS HANGOUT"], mode: "marquee", speed: "normal", easing: "linear", glyph: "zap" }, live: { enabled: true, label: "LIVE NOW", showTitle: true, supportingText: null, ctaLabel: "Watch live", animation: "sweep", intensity: "subtle" } }, revision: 4, updatedAt: "2026-08-29T01:15:00Z" }; }
function inboxSummary() { return { ok: true, unread: 2, actionable: { goats: { submissions: 2, comments: 1, emailFailures: 1, total: 4 }, total: 4 }, latest: [{ id: "notice-1", category: "moderation", sourceType: "goat_submission", sourceId: "goat-1", title: "GOATS submission awaiting review", preview: "Rail Viewer submitted Third Railify Cap.", body: "Validate the submission before publication.", actionUrl: "/goats/goat-1", actionLabel: "Review submission", createdAt: "2026-08-29T01:00:00Z", resolvedAt: null, readAt: null, unread: true }, { id: "notice-2", category: "delivery", sourceType: "goat_email_failure", sourceId: "email-1", title: "GOATS email delivery needs attention", preview: "An Admin alert could not be delivered.", body: "Inspect the transactional outbox.", actionUrl: "/goats/emails", actionLabel: "Inspect delivery", createdAt: "2026-08-29T00:30:00Z", resolvedAt: null, readAt: null, unread: true }] }; }
function json(route, body, statusCode = 200) { return route.fulfill({ status: statusCode, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Vite overview test server did not start."); }
