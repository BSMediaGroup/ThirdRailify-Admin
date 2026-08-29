import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44208";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROUTES = [
  "/", "/inbox", "/watch", "/content", "/shop", "/products", "/collections", "/orders", "/customers",
  "/commerce", "/commerce/payments", "/commerce/business", "/commerce/tax", "/commerce/emails", "/commerce/fulfillment",
  "/media", "/goats", "/goats/pending", "/goats/approved", "/goats/rejected", "/goats/comments", "/goats/settings", "/goats/emails",
  "/wheels", "/wheels/access", "/wheels/results", "/membership", "/access", "/integrations", "/settings",
];

test("every configured Admin route rejects browser-default controls at desktop and phone widths", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44208"], { stdio: "ignore" });
  t.after(() => server.kill());
  await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/**", respond);

    for (const route of ROUTES) {
      await page.goto(`${ORIGIN}${route}`);
      await page.locator("main").first().waitFor({ timeout: 5_000 }).catch((reason) => { throw new Error(`${route} did not render the Admin workspace`, { cause: reason }); });
      await page.waitForTimeout(80);
      const audit = await page.locator("button, a[role='button'], a.primary-button, a.secondary-button, a.ghost-button, a.danger-button, a.danger-outline-button, a.button-link").evaluateAll((controls) => controls.filter((control) => {
        const box = control.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && !control.matches(":disabled");
      }).map((control) => {
        const style = getComputedStyle(control);
        const background = style.backgroundColor.replaceAll(" ", "");
        const reasons = [];
        if (!style.fontFamily.toLowerCase().includes("blinker")) reasons.push(`font:${style.fontFamily}`);
        if (["outset", "ridge"].includes(style.borderStyle)) reasons.push(`border:${style.borderStyle}`);
        if (["rgb(239,239,239)", "rgb(240,240,240)", "rgb(221,221,221)", "rgba(239,239,239,1)"].includes(background) && style.backgroundImage === "none") reasons.push(`background:${style.backgroundColor}`);
        return { label: control.getAttribute("aria-label") || control.textContent?.trim().slice(0, 60) || control.className, reasons };
      }).filter((item) => item.reasons.length));
      assert.deepEqual(audit, [], `${route} uses the Admin control system at ${viewport.width}px`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${route} has no horizontal overflow at ${viewport.width}px`);
    }
    assert.deepEqual(pageErrors, [], `route matrix has no React page errors at ${viewport.width}px`);
    await context.close();
  }
});

async function respond(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (pathname === "/api/auth/session") return json(route, { ok: true, authenticated: true, csrfToken: "route-audit-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-29T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } });
  if (pathname === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  return json(route, { ok: false, error: "route_audit_unavailable", message: "Authority intentionally unavailable in the visual route audit." }, 503);
}

function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Admin route audit server did not start.");
}
