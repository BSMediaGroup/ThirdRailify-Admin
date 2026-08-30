import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44218";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const VIEWPORTS = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 390, height: 844 }];

test("Audience Analytics renders explicit migration and ready states responsively", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44218"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());

  for (const viewport of VIEWPORTS) {
    for (const mode of ["migration", "ready"]) {
      const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
      const page = await context.newPage();
      const pageErrors = [];
      const mapRequestFailures = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => { const reason = request.failure()?.errorText || "failed"; if (request.url().startsWith("https://tiles.openfreemap.org/") && reason !== "net::ERR_ABORTED") mapRequestFailures.push(`${request.url()} ${reason}`); });
      await page.route("**/api/**", (route) => respond(route, mode));
      await page.goto(`${ORIGIN}/analytics`);

      const analyticsLink = page.getByRole("link", { name: "Audience Analytics" });
      await analyticsLink.waitFor();
      assert.match(await analyticsLink.getAttribute("class"), /nav-link--active/);
      const analyticsIcon = await analyticsLink.locator("svg").innerHTML();
      const overviewIcon = await page.getByRole("link", { name: "Overview", exact: true }).locator("svg").innerHTML();
      assert.notEqual(analyticsIcon, overviewIcon, "Analytics uses its dedicated chart icon");

      if (mode === "migration") {
        await page.getByRole("heading", { name: "Analytics database migration required" }).waitFor();
        await page.getByText("No traffic has been reported as zero.").waitFor();
        assert.equal(await page.getByText("Analytics query failed.").count(), 0);
      } else {
        await page.getByText("Collection active").waitFor();
        await page.getByRole("heading", { name: "Where the signal lands." }).waitFor();
        await page.getByText("Sydney, New South Wales").waitFor();
        await page.locator('[data-analytics-map-state="ready"]').waitFor({ timeout: 25_000 });
        assert.equal(await page.locator('[data-analytics-map-engine="maplibre"] .maplibregl-canvas').count(), 1);
        assert.equal(await page.locator(".analytics-map-marker").count(), 2);
        assert.equal(await page.locator(".analytics-trend__line.is-views").getAttribute("pathLength"), "1");
        if (viewport.width === 1440) {
          await page.getByRole("button", { name: "Fullscreen map" }).click();
          const dialog = page.getByRole("dialog", { name: "Fullscreen audience activity map" });
          await dialog.waitFor();
          const box = await dialog.boundingBox();
          assert.ok(box && box.width > 1300 && box.height > 800, `fullscreen map fills viewport: ${JSON.stringify(box)}`);
          await page.screenshot({ path: join(tmpdir(), "thirdrailify-analytics-map-v2-1440x900.png") });
          await page.keyboard.press("Escape");
          assert.equal(await dialog.count(), 0);
          await page.locator(".analytics-trend").scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(tmpdir(), "thirdrailify-analytics-trend-v2-1440x900.png") });
        }
      }

      const overflow = await page.evaluate(() => ({ fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth, viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll("body *")].filter((node) => node instanceof HTMLElement && node.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 8).map((node) => ({ tag: node.tagName, className: node.className, right: Math.round(node.getBoundingClientRect().right), width: Math.round(node.getBoundingClientRect().width) })) }));
      assert.equal(overflow.fits, true, `${mode} state has no horizontal overflow at ${viewport.width}px: ${JSON.stringify(overflow)}`);
      assert.deepEqual(pageErrors, [], `${mode} state has no page errors at ${viewport.width}px`);
      assert.deepEqual(mapRequestFailures, [], `${mode} state has no failed OpenFreeMap requests at ${viewport.width}px`);
      await context.close();
    }
  }
});

async function respond(route, mode) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (pathname === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "analytics-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-31T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } });
  if (pathname === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  if (pathname === "/api/admin/analytics") return mode === "migration"
    ? json(route, { ok: false, error: "analytics_migration_required", message: "Analytics database migration required." }, 503)
    : json(route, readyReport());
  return json(route, { ok: false, error: "not_found" }, 404);
}

function readyReport() {
  const metric = { views: 3, sessions: 2, pagesPerSession: 1.5, comparisonComplete: false, previous: { views: 0, sessions: 0, pagesPerSession: null }, deltas: { views: { available: false, value: null, direction: "unavailable" }, sessions: { available: false, value: null, direction: "unavailable" } } };
  return { ok: true, range: "7d", generatedAt: new Date().toISOString(), timezone: "UTC", configured: true, coverage: { start: "2026-08-30T00:00:00.000Z", end: new Date().toISOString(), totalEvents: 3, lastIngestedAt: new Date().toISOString() }, windows: { "24h": metric, "7d": metric, "30d": metric, "90d": metric }, selected: metric, bucket: "day", series: [{ bucket: "2026-08-29T00:00:00.000Z", views: 1, sessions: 1 }, { bucket: "2026-08-30T00:00:00.000Z", views: 3, sessions: 2 }, { bucket: "2026-08-31T00:00:00.000Z", views: 2, sessions: 2 }], pages: [{ path: "/watch", views: 3, sessions: 2, latestAt: new Date().toISOString() }], sources: [{ source: "direct", views: 3, sessions: 2 }], devices: [{ device: "mobile", views: 3, sessions: 2 }], geography: [{ countryCode: "AU", countryName: "Australia", region: "New South Wales", city: "Sydney", latitude: -33.9, longitude: 151.2, views: 3, sessions: 2, latestAt: new Date().toISOString(), topPath: "/watch", topSource: "direct", memberViews: 1 }, { countryCode: "US", countryName: "United States", region: "California", city: "Los Angeles", latitude: 34.05, longitude: -118.24, views: 12, sessions: 8, latestAt: new Date().toISOString(), topPath: "/", topSource: "direct", memberViews: 0 }], revenue: { available: true, partial: false, sources: { merchandise: true, donations: true }, unavailableReason: null, profitAvailable: false, profitUnavailableReason: "Complete direct-cost evidence is unavailable.", currencies: [] } };
}

function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Analytics browser server did not start."); }
