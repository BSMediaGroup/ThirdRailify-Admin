import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:4196";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const VIEWPORTS = [[1440,900],[1024,768],[768,1024],[390,844]];

test("Site Content banner editor previews, validates unsaved state, and confirms server saves responsively", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4196"], { stdio: "ignore" }); t.after(() => server.kill());
  await waitForPreview();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());
  for (const [width,height] of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); const errors = []; let revision = 1; let stored = initialConfig();
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); }); page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request(); const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/auth/config") return json(route, authConfig());
      if (pathname === "/api/auth/session") return json(route, session());
      if (pathname === "/api/admin/banner") {
        if (request.method() === "GET") return json(route, { ok: true, config: stored, revision, updatedAt: "2026-08-28T00:00:00.000Z" });
        assert.equal(request.method(), "PUT"); assert.equal(request.headers()["x-csrf-token"], "browser-fixture-csrf");
        const body = request.postDataJSON(); assert.equal(body.expectedRevision, revision); stored = body.config; revision += 1;
        return json(route, { ok: true, config: stored, revision, updatedAt: "2026-08-28T01:00:00.000Z" });
      }
      return json(route, { ok: false, error: "not_found" }, 404);
    });
    await page.goto(`${ORIGIN}/content`); await page.getByRole("heading", { level: 1, name: "Public banner" }).waitFor();
    const publicLink = page.getByRole("link", { name: "Open Public site in a new tab" });
    const publicLinkLabel = publicLink.locator("span"); const publicLinkIcon = publicLink.locator("svg");
    const [linkBox, labelBox, iconBox] = await Promise.all([publicLink.boundingBox(), publicLinkLabel.boundingBox(), publicLinkIcon.boundingBox()]);
    assert.ok(linkBox && labelBox && iconBox, `${width}px renders the Public link and its contents`);
    assert.ok(["flex", "inline-flex"].includes(await publicLink.evaluate((element) => getComputedStyle(element).display)), `${width}px Public link uses flex alignment`);
    assert.ok(linkBox.height >= 48, `${width}px Public link has a full pointer target`);
    assert.ok(labelBox.x - linkBox.x >= 19, `${width}px Public link has deliberate left padding`);
    assert.ok(linkBox.x + linkBox.width - iconBox.x - iconBox.width >= 17, `${width}px external icon has deliberate right padding`);
    assert.ok(Math.abs((labelBox.y + labelBox.height / 2) - (iconBox.y + iconBox.height / 2)) <= 1, `${width}px label and external icon are vertically aligned`);
    if (width <= 760) assert.ok(linkBox.width >= 300, `${width}px Public link uses the available mobile width`);
    await page.getByText("Fixture preview only").waitFor();
    assert.equal(await page.getByText("SAMPLE PREVIEW — Third Railify live broadcast title").count(), 1);
    assert.equal(await page.locator("code").filter({ hasText: "/watch/live" }).count(), 1);
    const newTabChoice = page.getByText("Open external link in a new tab").locator("..");
    const [newTabBox, checkboxBox, checkboxLabelBox] = await Promise.all([newTabChoice.boundingBox(), newTabChoice.locator("input").boundingBox(), newTabChoice.locator("span").boundingBox()]);
    assert.ok(newTabBox && checkboxBox && checkboxLabelBox, `${width}px renders the external-link choice`);
    assert.ok(Math.abs((checkboxBox.y + checkboxBox.height / 2) - (checkboxLabelBox.y + checkboxLabelBox.height / 2)) <= 1, `${width}px checkbox and label stay vertically aligned`);
    const removeButton = page.getByRole("button", { name: "Remove" });
    assert.notEqual(await removeButton.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(243, 201, 40)", `${width}px destructive action does not use the gold primary fill`);
    const message = page.getByLabel(/Message text/).first(); await message.fill("Updated staging announcement");
    await page.getByText("Unsaved changes").waitFor(); await page.getByRole("button", { name: "Save banner settings" }).click();
    await page.getByText("Saved revision 2.").waitFor(); assert.equal(stored.normal.messages[0].text, "Updated staging announcement");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px has no horizontal overflow`);
    assert.deepEqual(errors, [], `${width}px has no console errors`);
    if (process.env.BANNER_BROWSER_SCREENSHOTS === "1") await page.screenshot({ path: path.join(process.env.TEMP || ".", `thirdrailify-admin-banner-${width}.png`), fullPage: true });
    await context.close();
  }
});

function initialConfig() { return { normal: { enabled: true, messages: [{ text: "Initial announcement", ctaLabel: "Watch", href: "/watch", newTab: false }], mode: "static", speed: "normal" }, live: { enabled: true, label: "LIVE NOW", showTitle: true, supportingText: "Confirmed Watch signal", ctaLabel: "WATCH NOW", animation: "pulse-sweep", intensity: "normal" } }; }
function session() { return { ok: true, authenticated: true, csrfToken: "browser-fixture-csrf", access: { isAdmin: true, isMasterAdmin: true }, account: { id: "master", email: "master@example.test", displayName: "Master Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: "master", status: "active", emailVerified: true, createdAt: "2026-08-28T00:00:00.000Z", lastLoginAt: null, source: "test", locked: true } }; }
function authConfig() { return { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.pages.dev", adminOrigin: "https://thirdrailify-admin.pages.dev", environment: "test", cookieMode: "host-only" }; }
function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForPreview() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* still starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Vite preview did not start."); }
