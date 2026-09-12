import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44221";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACTS = path.resolve(".artifacts/workshop-access");
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

test("Workshop Access uses the premium Admin system and keeps Overview first", async (t) => {
  await mkdir(ARTIFACTS, { recursive: true });
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44221"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (entry) => { if (entry.type() === "error") errors.push(entry.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", fixture);
    await page.goto(`${ORIGIN}/workshop/access`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.getByRole("heading", { level: 1, name: "Workshop Access" }).waitFor();
    await page.getByText("Bubble Bob", { exact: true }).waitFor();

    const topLevel = await page.locator(".primary-nav > .nav-link, .primary-nav > .nav-group > .nav-group__row > .nav-link").evaluateAll((links) => links.map((link) => ({ href: link.getAttribute("href"), label: link.textContent?.trim() })));
    assert.equal(topLevel[0]?.href, "/", `Overview is the first destination at ${viewport.width}px`);
    assert.equal(topLevel[0]?.label, "Overview");
    const usersIndex = topLevel.findIndex((entry) => entry.href === "/access");
    const workshopIndex = topLevel.findIndex((entry) => entry.href === "/workshop/access");
    assert.equal(workshopIndex, usersIndex + 1, `Workshop Access follows Users / Access at ${viewport.width}px`);
    assert.match(await page.locator('.primary-nav a[href="/workshop/access"] svg').innerHTML(), /M4 10\.5 12 4l8 6\.5/, "Workshop navigation uses the dedicated Workshop glyph");

    const metrics = await page.locator(".workshop-access__metrics strong").allTextContents();
    assert.deepEqual(metrics, ["42", "3", "2", "1"], `truthful loaded-page metrics render at ${viewport.width}px`);
    assert.equal(await page.locator(".workshop-row").count(), 3);
    assert.equal(await page.locator(".workshop-access-status.is-enabled").count(), 2);
    assert.equal(await page.locator(".workshop-access-status.is-denied").count(), 1);
    assert.equal(await page.locator(".workshop-row__locked").count(), 1);
    assert.equal(await page.locator(".workshop-access__orbit--outer").evaluate((node) => getComputedStyle(node).animationName), "none", "reduced motion produces a complete static gateway");

    const geometry = await page.evaluate(() => {
      const hero = document.querySelector(".workshop-access__hero")?.getBoundingClientRect();
      const directory = document.querySelector(".workshop-directory")?.getBoundingClientRect();
      const rows = [...document.querySelectorAll(".workshop-row")].map((node) => node.getBoundingClientRect());
      const metricColumns = getComputedStyle(document.querySelector(".workshop-access__metrics")).gridTemplateColumns.split(" ").length;
      const directoryColor = getComputedStyle(document.querySelector(".workshop-directory")).backgroundColor;
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        heroWidth: hero?.width || 0,
        directoryWidth: directory?.width || 0,
        rowsInside: rows.every((row) => directory && row.left >= directory.left && row.right <= directory.right + 1),
        metricColumns,
        directoryColor,
      };
    });
    assert.equal(geometry.overflow, false, `no horizontal overflow at ${viewport.width}px`);
    assert.ok(geometry.heroWidth > 0 && geometry.directoryWidth > 0 && geometry.rowsInside, `major surfaces retain valid geometry at ${viewport.width}px`);
    assert.equal(geometry.metricColumns, viewport.width > 1100 ? 4 : 2, `metric rail responds at ${viewport.width}px`);
    assert.equal(geometry.directoryColor, "rgb(11, 10, 10)", "Workshop directory uses the charcoal authority surface instead of the old grey fallback");

    const profileTrigger = page.getByRole("button", { name: /Provider profiles/ }).nth(1);
    const profileResponse = page.waitForResponse((candidate) => /\/api\/workshop\/accounts\/[^/]+\/profiles$/.test(new URL(candidate.url()).pathname));
    await profileTrigger.click();
    assert.equal((await profileResponse).status(), 200);
    const profileDialog = page.getByRole("dialog", { name: "Provider profile access" });
    await profileDialog.waitFor({ state: "visible" });
    assert.equal(await profileDialog.locator(".profile-policy-card").count(), 6, `all profile providers render at ${viewport.width}px`);
    assert.equal(await profileDialog.locator(".profile-policy-card--pexels img, .profile-policy-card--pixabay img, .profile-policy-card--unsplash img").count(), 3, "stock providers use their supplied SVG marks");
    assert.equal(await page.locator(".profile-restriction-panel").count(), 0, "the legacy expanding drawer is removed");
    const dialogGeometry = await profileDialog.evaluate((node) => { const rect = node.getBoundingClientRect(), cards = [...node.querySelectorAll(".profile-policy-card")].map((card) => card.getBoundingClientRect()); return { modal: node instanceof HTMLDialogElement && node.open, withinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, cardsInside: cards.every((card) => card.left >= rect.left && card.right <= rect.right + 1), columns: getComputedStyle(node.querySelector(".profile-provider-group > div")).gridTemplateColumns.split(" ").length }; });
    assert.equal(dialogGeometry.modal, true, "provider access uses the native modal top layer");
    assert.equal(dialogGeometry.withinViewport && dialogGeometry.cardsInside, true, `lightbox geometry remains inside ${viewport.width}px`);
    assert.equal(dialogGeometry.columns, viewport.width > 820 ? 2 : 1, `provider cards respond at ${viewport.width}px`);
    await page.screenshot({ path: path.join(ARTIFACTS, `provider-profile-lightbox-${viewport.width}.png`) });
    await profileDialog.locator('.profile-provider-group').nth(1).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(ARTIFACTS, `provider-profile-stock-${viewport.width}.png`) });
    await profileDialog.getByRole("button", { name: "Done" }).click();
    await profileDialog.waitFor({ state: "hidden" });
    assert.equal(await profileTrigger.evaluate((node) => node === document.activeElement), true, "closing restores focus to the launcher");

    if (viewport.width === 1440) {
      const audit = page.getByRole("button", { name: /Access audit/ }).nth(1);
      const response = page.waitForResponse((candidate) => /\/api\/workshop\/accounts\/[^/]+\/history$/.test(new URL(candidate.url()).pathname));
      await audit.click();
      assert.equal((await response).status(), 200);
      await page.getByText("Recorded access decisions", { exact: true }).waitFor({ timeout: 5_000 });
      assert.equal(await audit.getAttribute("aria-expanded"), "true");
      await audit.click();
      assert.equal(await audit.getAttribute("aria-expanded"), "false");
    }

    await page.screenshot({ path: path.join(ARTIFACTS, `workshop-access-order-${viewport.width}.png`), fullPage: true });
    assert.deepEqual(errors, [], `no console or page errors at ${viewport.width}x${viewport.height}`);
    await context.close();
  }
});

async function fixture(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.com", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (pathname === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "workshop-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: account("master", "Master Admin", "master", true) });
  if (pathname === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  if (pathname === "/api/workshop/accounts") return json(route, { ok: true, total: 42, page: 1, pageSize: 20, canOpen: true, items: [
    { account: account("bubble", "Bubble Bob", "none"), workshop: policy(false, "approval_required", false, false, null) },
    { account: account("creator", "Creative Operator", "none"), workshop: policy(true, "explicit_grant", false, false, { state: "granted", expires_at: null, revision: 3, changed_by: "master", changed_at: "2026-09-12T18:45:00.000Z", note: "Approved creative operator" }) },
    { account: account("master", "Master Admin", "master", true), workshop: policy(true, "master_policy", true, true, null) },
  ] });
  if (/^\/api\/workshop\/accounts\/[^/]+\/history$/.test(pathname)) return json(route, { ok: true, items: [{ id: "audit-1", actor_name: "Master Admin", created_at: "2026-09-12T18:45:00.000Z", next_json: JSON.stringify({ state: "granted" }) }] });
  if (/^\/api\/workshop\/accounts\/[^/]+\/profiles$/.test(pathname)) return json(route, { ok: true, accountId: pathname.split("/").at(-2), providers: ["replicate", "openai", "xai", "pexels", "pixabay", "unsplash"].map((provider, index) => profileProvider(provider, index === 4)), audit: [{ id: "profile-audit-1", provider: "pexels", actor_name: "Master Admin", created_at: "2026-09-12T18:45:00.000Z", next_json: JSON.stringify({ mode: "selected" }) }] });
  return json(route, { ok: false, error: "fixture_unavailable", message: "Focused Workshop fixture unavailable." }, 503);
}

function account(id, displayName, adminLevel, locked = false) {
  return { id, email: `${id}@example.test`, displayName, username: null, avatarUrl: null, providers: ["email"], role: adminLevel === "none" ? "user" : "admin", adminLevel, status: "active", emailVerified: true, createdAt: "2026-09-01T00:00:00.000Z", lastLoginAt: null, source: "test", locked };
}

function policy(allowed, source, canManageAccess, canManageProviders, grant) { return { allowed, source, canManageAccess, canManageProviders, grant }; }
function profileProvider(provider, selected) { return { provider, profiles: [{ id: `runtime:${provider}`, provider, label: "Runtime Default", enabled: true, is_default: true, verification_status: "saved", runtime: true }, { id: `${provider}:editorial`, provider, label: "Editorial Studio", enabled: true, is_default: false, verification_status: "verified", runtime: false }], policy: { mode: selected ? "selected" : "all", defaultProfileId: selected ? `${provider}:editorial` : null, revision: selected ? 3 : 0, allowedProfileIds: selected ? [`${provider}:editorial`] : [] } }; }
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Workshop browser server did not start."); }
