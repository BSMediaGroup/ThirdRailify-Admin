import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

const PREVIEW_ORIGIN = "http://127.0.0.1:4195";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }];

test("Watch Admin renders empty and retained archives with direct source links responsively", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4195"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForPreview();
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(() => browser.close());

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    let archivePayload = emptyArchive();
    const consoleErrors = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/auth/config") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authConfig()) });
      if (pathname === "/api/auth/session") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session()) });
      if (pathname === "/api/admin/inbox/summary") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] }) });
      if (pathname === "/api/admin/watch") {
        assert.equal(request.method(), "POST");
        assert.equal(request.headers()["x-csrf-token"], "browser-fixture-csrf");
        assert.deepEqual(request.postDataJSON(), { action: "read" });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(archivePayload) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "not_found" }) });
    });

    await page.goto(`${PREVIEW_ORIGIN}/watch`);
    await page.getByRole("heading", { level: 1, name: "Watch / Broadcast" }).waitFor();
    await page.getByText("No retained episodes yet").waitFor();
    assert.equal(await page.locator("h1").count(), 1);
    assert.equal(await page.getByText("Retained").locator("..").getByText("0 / 24", { exact: true }).count(), 1);
    await page.getByText("24", { exact: true }).last().waitFor();
    assert.equal(await page.getByRole("button", { name: "Show all" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Hide all" }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${viewport.width}px has no horizontal overflow`);
    assert.deepEqual(consoleErrors, [], `${viewport.width}px has no console errors`);
    if (process.env.WATCH_BROWSER_SCREENSHOTS === "1") await page.screenshot({ path: path.join(process.env.TEMP || ".", `thirdrailify-admin-watch-${viewport.width}.png`), fullPage: true });

    archivePayload = populatedArchive();
    await page.reload();
    await page.getByRole("heading", { level: 3, name: "Rumble retained episode" }).waitFor();
    const rumbleSource = page.getByRole("link", { name: "Watch on Rumble" });
    const youtubeSource = page.getByRole("link", { name: "Watch on YouTube" });
    assert.equal(await rumbleSource.getAttribute("href"), "https://rumble.com/vfixture-rumble.html");
    assert.equal(await youtubeSource.getAttribute("href"), "https://www.youtube.com/watch?v=abc123DEF45");
    assert.match(await rumbleSource.locator("img").getAttribute("src"), /rumble\.svg/);
    assert.match(await youtubeSource.locator("img").getAttribute("src"), /youtube\.svg/);
    assert.equal(await page.getByText("Preview unavailable while hidden", { exact: true }).count(), 1, "hidden episodes retain their source link but not a Public preview");
    assert.equal(await page.getByRole("link", { name: /Preview/ }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${viewport.width}px populated archive has no horizontal overflow`);
    assert.deepEqual(consoleErrors, [], `${viewport.width}px populated archive has no console errors`);
    if (process.env.WATCH_BROWSER_SCREENSHOTS === "1") await page.screenshot({ path: path.join(process.env.TEMP || ".", `thirdrailify-admin-watch-populated-${viewport.width}.png`), fullPage: true });
    await context.close();
  }
});

async function waitForPreview() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(PREVIEW_ORIGIN)).ok) return; }
    catch { /* Preview is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vite preview did not start.");
}

function authConfig() {
  return { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: "https://thirdrailify-admin.pages.dev", environment: "test", cookieMode: "host-only" };
}

function session() {
  return { ok: true, authenticated: true, csrfToken: "browser-fixture-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-28T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } };
}

function emptyArchive() {
  return {
    ok: true,
    current: null,
    summary: { retained: 0, visible: 0, hidden: 0, remaining: 24, newest: null, oldest: null },
    episodes: [],
  };
}

function populatedArchive() {
  const rumble = { id: "ep_rumble", identityKey: "rumble:vfixture-rumble", platform: "rumble", contentId: "vfixture-rumble", title: "Rumble retained episode", description: null, thumbnailUrl: null, thumbnailState: "fallback", watchUrl: "https://rumble.com/vfixture-rumble.html", archiveDate: "2026-08-28T00:00:00.000Z", visible: true, archiveOrder: 1, publicRoute: "https://thirdrailify.pages.dev/watch/v/ep_rumble" };
  const youtube = { id: "ep_youtube", identityKey: "youtube:abc123DEF45", platform: "youtube", contentId: "abc123DEF45", title: "Hidden YouTube retained episode", description: null, thumbnailUrl: null, thumbnailState: "fallback", watchUrl: "https://www.youtube.com/watch?v=abc123DEF45", archiveDate: "2026-08-27T00:00:00.000Z", visible: false, archiveOrder: 2, publicRoute: null };
  return { ok: true, current: null, summary: { retained: 2, visible: 1, hidden: 1, remaining: 22, newest: { id: rumble.id, title: rumble.title, date: rumble.archiveDate }, oldest: { id: youtube.id, title: youtube.title, date: youtube.archiveDate } }, episodes: [rumble, youtube] };
}
