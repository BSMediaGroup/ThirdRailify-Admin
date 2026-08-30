import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44209";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("Admin messages open full details and support individual and bulk controls", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44209"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());

  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    const actions = [];
    let item = message();
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.com", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
      if (path === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "inbox-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "admin-fixture", email: "admin@example.test", displayName: "Rail Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-01T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } });
      if (path === "/api/admin/inbox/summary") return json(route, { ok: true, unread: item?.unread ? 1 : 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: item ? [item] : [] });
      if (path === "/api/admin/inbox" && route.request().method() === "GET") return json(route, { ok: true, items: item ? [item] : [], total: item ? 1 : 0 });
      if (path === "/api/admin/inbox/bulk") {
        const body = route.request().postDataJSON(); actions.push(body.action);
        if (body.action === "delete") item = null;
        else if (item) item = { ...item, unread: body.action === "unread", readAt: body.action === "read" ? new Date().toISOString() : null };
        return json(route, { ok: true, updated: 1 });
      }
      return json(route, { ok: false, error: "fixture_unavailable", message: "Not required by the inbox fixture." }, 503);
    });

    await page.goto(`${ORIGIN}/inbox`);
    await page.getByRole("heading", { level: 1, name: "Inbox" }).waitFor();
    const geometry = await page.locator(".inbox-message").evaluate((row) => {
      const box = (selector) => {
        const element = selector ? row.querySelector(selector) : row;
        if (!element) throw new Error(`Missing ${selector}`);
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return { row: box(""), select: box(".inbox-message__select"), state: box(".inbox-message__state"), content: box(".inbox-message__content"), actions: box(".inbox-message__actions") };
    });
    assert.ok(geometry.select.x < geometry.state.x && geometry.state.x < geometry.content.x, `leading Inbox controls must precede content at ${viewport.width}px`);
    assert.ok(geometry.content.width >= Math.min(420, geometry.row.width * .42), `Inbox content must retain readable width at ${viewport.width}px`);
    if (viewport.width > 760) {
      assert.ok(geometry.content.right < geometry.actions.x, "desktop actions must remain to the right of message content");
      assert.ok(geometry.actions.width >= 240, "desktop actions must not collapse into vertical words");
    } else {
      assert.ok(geometry.actions.x >= geometry.content.x - 1, "mobile actions must align with message content");
      assert.ok(geometry.actions.y >= geometry.content.bottom, "mobile actions must follow message content without overlap");
    }
    await page.getByRole("button", { name: "Open Production review required" }).click();
    const dialog = page.getByRole("dialog", { name: "Production review required" });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Full operational detail.*source-fixture.*Open/is);
    await dialog.getByRole("button", { name: "Close message" }).click();
    await page.getByLabel("Select Production review required").check();
    await page.locator(".inbox-bulk").getByRole("button", { name: "Unread", exact: true }).click();
    await page.locator(".inbox-message.is-unread").waitFor();
    await page.getByRole("button", { name: "Open Production review required" }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Close message" }).click();
    await page.getByRole("button", { name: "Delete Production review required" }).click();
    await page.getByText("Inbox clear").waitFor();
    assert.deepEqual(actions, ["read", "unread", "read", "delete"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await context.close();
  }
});

function message() { return { id: "admin-message-1", category: "Operations", sourceType: "commerce_review", sourceId: "source-fixture", title: "Production review required", preview: "A concise Admin list preview.", body: "Full operational detail for the authorized Admin.", actionUrl: "/commerce", actionLabel: "Open Commerce", createdAt: "2026-08-31T00:00:00.000Z", resolvedAt: null, readAt: null, unread: true, deletedAt: null }; }
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Admin inbox test server did not start."); }
