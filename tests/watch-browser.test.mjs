import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { chromium } from "playwright-core";

const PREVIEW_ORIGIN = "http://127.0.0.1:4195";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }];

test("Watch Admin renders the truthful empty archive responsively", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "4195"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForPreview();
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(() => browser.close());

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/auth/config") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authConfig()) });
      if (pathname === "/api/auth/session") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session()) });
      if (pathname === "/api/admin/watch") {
        assert.equal(request.method(), "POST");
        assert.equal(request.headers()["x-csrf-token"], "browser-fixture-csrf");
        assert.deepEqual(request.postDataJSON(), { action: "read" });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyArchive()) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "not_found" }) });
    });

    await page.goto(`${PREVIEW_ORIGIN}/watch`);
    await page.getByRole("heading", { level: 1, name: "Watch archive" }).waitFor();
    await page.getByText("No retained episodes yet").waitFor();
    assert.equal(await page.locator("h1").count(), 1);
    assert.equal(await page.getByText("Retained").locator(".. ").getByText("0", { exact: true }).count(), 1);
    await page.getByText("24", { exact: true }).last().waitFor();
    assert.equal(await page.getByRole("button", { name: "Show all" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Hide all" }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${viewport.width}px has no horizontal overflow`);
    assert.deepEqual(consoleErrors, [], `${viewport.width}px has no console errors`);
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
