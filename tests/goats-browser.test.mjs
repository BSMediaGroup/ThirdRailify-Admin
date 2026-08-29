import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

const PREVIEW_ORIGIN = "http://127.0.0.1:4175";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }];

test("GOATS navigation and branded email workspace render responsively", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "4175"], { stdio: "ignore" });
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
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/config") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authConfig()) });
      if (path === "/api/auth/session") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session()) });
      if (path === "/api/admin/inbox/summary") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] }) });
      if (path === "/api/admin/goats/templates") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, templates: templates() }) });
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "not_found" }) });
    });

    await page.goto(`${PREVIEW_ORIGIN}/goats/emails`);
    await page.getByRole("heading", { level: 1, name: "GOATS emails" }).waitFor();
    if (viewport.width < 760) await page.getByRole("button", { name: "Open navigation" }).click();
    for (const label of ["Pending Submissions", "Approved & Published", "Rejected Submissions", "Comment Moderation", "GOATS Emails"]) await page.getByRole("link", { name: label }).waitFor();
    await page.getByText("Recipient-ready community email design").waitFor();
    await page.getByText("Available variables").waitFor();
    const preview = page.frameLocator('iframe[title="Sandboxed branded GOATS email preview"]');
    await preview.getByText("THIRD RAILIFY OFFICIAL", { exact: true }).waitFor();
    await preview.getByText("GOATS in the Wild", { exact: true }).waitFor();
    await preview.getByText("Submission received", { exact: true }).first().waitFor();
    const typography = await preview.locator("html").evaluate(async (root) => {
      await root.ownerDocument.fonts.ready;
      const heading = root.ownerDocument.querySelector(".content h1");
      const body = root.ownerDocument.body;
      const label = root.ownerDocument.querySelector(".type");
      return {
        heading: heading ? getComputedStyle(heading).fontFamily : "",
        body: getComputedStyle(body).fontFamily,
        label: label ? getComputedStyle(label).fontFamily : "",
        captainLoaded: root.ownerDocument.fonts.check('32px "American Captain"'),
        blinkerLoaded: root.ownerDocument.fonts.check('16px "Blinker"'),
        geistLoaded: root.ownerDocument.fonts.check('12px "Geist Mono"'),
      };
    });
    assert.match(typography.heading, /American Captain/);
    assert.match(typography.body, /Blinker/);
    assert.match(typography.label, /Geist Mono/);
    assert.equal(typography.captainLoaded, true);
    assert.equal(typography.blinkerLoaded, true);
    assert.equal(typography.geistLoaded, true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${viewport.width}px has no horizontal overflow`);
    assert.deepEqual(consoleErrors, [], `${viewport.width}px has no console errors`);
    if (process.env.GOATS_BROWSER_SCREENSHOTS === "1") await page.screenshot({ path: path.join(process.env.TEMP || ".", `thirdrailify-admin-goats-emails-${viewport.width}.png`), fullPage: true });
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

function templates() {
  return [
    { templateKey: "goat_submission_received", subject: "We received {{submission_reference}}", htmlBody: "<h1>Submission received</h1><p>Hi {{display_name}},</p><p>Your {{product_name}} story is private until approved.</p>", textBody: "Submission received\n\nHi {{display_name}},\n\nYour story is private until approved.", variables: ["display_name", "submission_reference", "product_name"], status: "draft", revision: 2 },
    { templateKey: "goat_submission_admin_alert", subject: "New GOATS submission", htmlBody: "<h1>Moderation requested</h1>", textBody: "Moderation requested", variables: ["moderation_url"], status: "ready", revision: 1 },
    { templateKey: "goat_submission_approved", subject: "Your GOAT is live", htmlBody: "<h1>You are in the Wild</h1>", textBody: "You are in the Wild", variables: ["public_listing_url"], status: "ready", revision: 1 },
    { templateKey: "goat_submission_rejected", subject: "Submission update", htmlBody: "<h1>Submission update</h1>", textBody: "Submission update", variables: ["rejection_reason"], status: "draft", revision: 1 },
  ];
}
