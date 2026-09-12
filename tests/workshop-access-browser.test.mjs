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
    assert.equal(topLevel[1]?.href, "/workshop/access");
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

    await page.screenshot({ path: path.join(ARTIFACTS, `workshop-access-${viewport.width}.png`), fullPage: true });
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
  return json(route, { ok: false, error: "fixture_unavailable", message: "Focused Workshop fixture unavailable." }, 503);
}

function account(id, displayName, adminLevel, locked = false) {
  return { id, email: `${id}@example.test`, displayName, username: null, avatarUrl: null, providers: ["email"], role: adminLevel === "none" ? "user" : "admin", adminLevel, status: "active", emailVerified: true, createdAt: "2026-09-01T00:00:00.000Z", lastLoginAt: null, source: "test", locked };
}

function policy(allowed, source, canManageAccess, canManageProviders, grant) { return { allowed, source, canManageAccess, canManageProviders, grant }; }
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Workshop browser server did not start."); }


