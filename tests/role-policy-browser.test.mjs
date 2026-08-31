import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:44209";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const capabilities = [
  ["overview.view", "overview", "View Overview"], ["analytics.view", "analytics", "View audience analytics"],
  ["inbox.view", "inbox", "View Admin Inbox"], ["inbox.manage", "inbox", "Manage Admin Inbox"],
  ["watch.view", "watch", "View Watch archive"], ["watch.manage", "watch", "Manage Watch archive"],
  ["content.view", "content", "View site content"], ["content.manage", "content", "Manage site content"],
  ["commerce.view", "commerce", "View shop and commerce"], ["commerce.catalogue.manage", "commerce", "Manage products and collections"],
  ["commerce.business.manage", "commerce", "Manage business and tax"], ["commerce.payments.manage", "commerce", "Manage payments"],
  ["commerce.integrations.manage", "commerce", "Manage commerce integrations"], ["commerce.templates.manage", "commerce", "Manage customer documents and emails"],
  ["commerce.operations.manage", "commerce", "Manage commerce operations"], ["wheels.view", "wheels", "View Wheels"],
  ["wheels.manage", "wheels", "Manage Wheels"], ["media.view", "media", "View media"],
  ["goats.view", "goats", "View GOATS"], ["goats.manage", "goats", "Manage GOATS"],
  ["membership.view", "membership", "View VIP and membership"],
  ["users.view", "users", "View users and access"], ["users.manage", "users", "Manage users and access"],
  ["integrations.view", "integrations", "View integrations"],
  ["settings.view", "settings", "View settings"], ["settings.manage", "settings", "Manage settings"],
  ["role_permissions.view", "role_permissions", "View role permissions"], ["role_permissions.manage", "role_permissions", "Manage role permissions"],
];
const groups = [...new Set(capabilities.map((item) => item[1]))].map((id) => ({ id, label: id === "role_permissions" ? "Role Permissions & Scopes" : id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), description: `Effective ${id.replaceAll("_", " ")} authority.` }));
const allIds = capabilities.map((item) => item[0]);

test("Role Permissions & Scopes is editable by Master and inspectable read-only by Full Admin", async (t) => {
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "44209"], { stdio: "ignore" });
  t.after(() => server.kill()); await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true }); t.after(() => browser.close());

  let denied = [];
  const writes = [];
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    const masterContext = await browser.newContext({ viewport });
    const masterPage = await masterContext.newPage();
    const errors = [];
    masterPage.on("console", (entry) => { if (entry.type() === "error") errors.push(entry.text()); });
    masterPage.on("pageerror", (error) => errors.push(error.message));
    await masterPage.route("**/api/**", (route) => fixture(route, "master", denied, (next, method) => { denied = next; writes.push({ method, denied: [...next] }); }));
    await masterPage.goto(`${ORIGIN}/settings`);
    await masterPage.getByRole("heading", { level: 2, name: "Role Permissions & Scopes" }).waitFor();
    assert.equal(await masterPage.locator(".permission-group").count(), groups.length);
    assert.equal(await masterPage.getByRole("radio").count(), 3, `three role selectors render at ${viewport.width}px`);
    assert.equal(await masterPage.getByRole("radio", { name: /Full Admin/ }).isChecked(), true, `Full Admin is the clear initial policy at ${viewport.width}px`);
    assert.equal(await masterPage.locator('.selected-role-context[aria-label="Selected role: Full Admin"]').count(), 1);
    assert.equal(await masterPage.getByRole("switch").count(), capabilities.length, `custom switches preserve native semantics at ${viewport.width}px`);
    assert.equal(await masterPage.locator(".policy-switch__track").count(), capabilities.length, `every native switch has a visible track at ${viewport.width}px`);
    const topLevelHrefs = await masterPage.locator(".primary-nav > .nav-link").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    const watchIndex = topLevelHrefs.indexOf("/watch");
    assert.deepEqual(topLevelHrefs.slice(watchIndex, watchIndex + 3), ["/watch", "/access", "/analytics"], "Users / Access is directly between Watch / Broadcast and Audience Analytics");
    await assertPolicyGeometry(masterPage, viewport);
    if (process.env.ROLE_POLICY_BROWSER_SCREENSHOTS === "1") {
      await masterPage.screenshot({ path: path.join(process.env.TEMP || ".", `thirdrailify-admin-role-policy-${viewport.width}.png`), fullPage: true });
      await masterPage.locator(".role-permissions__heading").scrollIntoViewIfNeeded();
      await masterPage.screenshot({ path: path.join(process.env.TEMP || ".", `thirdrailify-admin-role-policy-${viewport.width}-viewport.png`), fullPage: false });
    }

    if (viewport.width === 1440) {
      const fullRadio = masterPage.getByRole("radio", { name: /Full Admin/ });
      const masterRadio = masterPage.getByRole("radio", { name: /Master Admin/ });
      const regularRadio = masterPage.getByRole("radio", { name: /Regular User/ });
      await fullRadio.focus(); await fullRadio.press("ArrowLeft");
      assert.equal(await masterRadio.isChecked(), true, "native role radios support arrow-key selection");
      assert.equal(await masterPage.locator('.selected-role-context[aria-label="Selected role: Master Admin"]').count(), 1);
      assert.equal(await masterPage.getByRole("switch", { checked: true }).count(), capabilities.length, "Master policy shows every capability enabled");
      assert.equal(await masterPage.getByRole("switch").evaluateAll((items) => items.every((item) => item.disabled)), true, "Master policy switches are locked");
      assert.equal(await masterPage.getByRole("button", { name: "Apply policy" }).count(), 0);
      assert.equal(await masterPage.getByRole("button", { name: "Reset to defaults" }).count(), 0);

      await regularRadio.click();
      assert.equal(await masterPage.locator('.selected-role-context[aria-label="Selected role: Regular User"]').count(), 1);
      assert.equal(await masterPage.getByRole("switch", { checked: true }).count(), 0, "Regular User shows no Admin authority");
      assert.equal(await masterPage.getByRole("switch").evaluateAll((items) => items.every((item) => item.disabled)), true, "Regular User switches are locked");

      await fullRadio.click();
      const wheelsManage = masterPage.getByRole("switch", { name: /Manage Wheels for Full Admin/ });
      assert.equal(await wheelsManage.isEnabled(), true);
      assert.equal(await wheelsManage.isChecked(), true);
      const immutable = masterPage.getByRole("switch", { name: /Manage role permissions for Full Admin/ });
      assert.equal(await immutable.isDisabled(), true);
      assert.match(await immutable.getAttribute("aria-label"), /Master only/);
      await wheelsManage.focus(); await wheelsManage.press("Space");
      await masterPage.getByText("1 unsaved policy change", { exact: true }).waitFor();
      assert.equal(await wheelsManage.isChecked(), false, "keyboard operation updates the switch");
      await masterPage.getByRole("button", { name: "Apply policy" }).click();
      await masterPage.getByText("Full Admin permission policy saved.", { exact: true }).waitFor();
      assert.deepEqual(writes[0], { method: "PUT", denied: ["wheels.manage"] });
      assert.match(await wheelsManage.getAttribute("aria-label"), /Restricted/);

      await masterPage.getByRole("searchbox", { name: "Search permissions" }).fill("wheels.manage");
      assert.equal(await masterPage.locator(".permission-group").count(), 1, "permission search filters domains and capability IDs");
      assert.equal(await masterPage.locator(".permission-row").count(), 1);
      await masterPage.getByRole("searchbox", { name: "Search permissions" }).fill("");

      masterPage.once("dialog", (dialog) => { assert.equal(dialog.message(), "Reset every Full Admin restriction to default access?"); dialog.accept(); });
      await masterPage.getByRole("button", { name: "Reset to defaults" }).click();
      await masterPage.getByText("Full Admin default access restored.", { exact: true }).waitFor();
      assert.deepEqual(writes[1], { method: "POST", denied: [] });
    }

    if (viewport.width === 1920) {
      await masterPage.goto(`${ORIGIN}/access`);
      await masterPage.getByRole("heading", { level: 1, name: "Accounts & access" }).waitFor();
      assert.match(await masterPage.locator('.primary-nav > .nav-link[href="/access"]').getAttribute("class"), /nav-link--active/, "reordered Users / Access retains active-state behavior");
    }
    assert.deepEqual(errors, [], `no role-policy console or page errors at ${viewport.width}x${viewport.height}`);
    await masterContext.close();
  }

  denied = ["analytics.view", "settings.manage", "users.manage", "wheels.manage"];
  const fullContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const fullPage = await fullContext.newPage();
  await fullPage.route("**/api/**", (route) => fixture(route, "full", denied, () => { throw new Error("Full Admin attempted a policy mutation"); }));
  await fullPage.goto(`${ORIGIN}/settings`);
  await fullPage.getByRole("heading", { level: 2, name: "Role Permissions & Scopes" }).waitFor();
  assert.equal(await fullPage.getByRole("radio").count(), 3);
  assert.equal(await fullPage.getByRole("radio", { name: /Full Admin/ }).isChecked(), true);
  assert.equal(await fullPage.locator(".permission-row input:not(:disabled)").count(), 0);
  assert.equal(await fullPage.getByRole("button", { name: "Apply policy" }).count(), 0);
  assert.equal(await fullPage.getByRole("button", { name: "Reset to defaults" }).count(), 0);
  assert.equal(await fullPage.locator('.permission-state.is-restricted').count(), 4);
  await fullPage.getByRole("radio", { name: /Master Admin/ }).click();
  assert.equal(await fullPage.getByRole("switch", { checked: true }).count(), capabilities.length);
  assert.equal(await fullPage.getByRole("switch").evaluateAll((items) => items.every((item) => item.disabled)), true);
  await fullPage.getByRole("radio", { name: /Regular User/ }).click();
  assert.equal(await fullPage.getByRole("switch", { checked: true }).count(), 0);
  await fullPage.getByRole("radio", { name: /Full Admin/ }).click();
  assert.equal(await fullPage.locator('.permission-state.is-restricted').count(), 4, "Full Admin can inspect current restrictions after changing inspected role");
  assert.equal(await fullPage.getByText("Read-only access", { exact: true }).count(), 1, "settings.manage denial leaves Settings and policy inspection available");
  await fullPage.goto(`${ORIGIN}/analytics`);
  await fullPage.getByRole("heading", { level: 1, name: "Access restricted" }).waitFor();
  assert.equal(await fullPage.locator('.primary-nav a[href="/analytics"]').count(), 0, "analytics.view denial removes the destination from navigation");
  await fullPage.goto(`${ORIGIN}/access`);
  await fullPage.locator(".capability-readonly-callout strong", { hasText: "Read-only access" }).waitFor();
  assert.equal(await fullPage.locator(".capability-readonly-surface:disabled").count(), 1, "users.manage denial keeps the account workspace read-only");
  await fullPage.goto(`${ORIGIN}/wheels`);
  await fullPage.locator(".capability-readonly-callout strong", { hasText: "Read-only access" }).waitFor();
  assert.equal(await fullPage.locator(".capability-readonly-surface:disabled").count(), 1, "wheels.manage denial keeps Wheels inspectable and disables its controls");
  assert.equal(await fullPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await fullContext.close();
});

async function assertPolicyGeometry(page, viewport) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(50);
  const geometry = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".role-option__card")].map((item) => item.getBoundingClientRect());
    const rows = [...document.querySelectorAll(".permission-row")];
    const overlap = rows.some((row) => { const copy = row.querySelector(".permission-row__copy")?.getBoundingClientRect(); const control = row.querySelector(".permission-row__control")?.getBoundingClientRect(); return copy && control ? copy.left < control.right && copy.right > control.left && copy.top < control.bottom && copy.bottom > control.top : true; });
    const tracks = [...document.querySelectorAll(".policy-switch__track")].map((item) => item.getBoundingClientRect());
    const lastGroup = document.querySelector(".permission-group:last-child")?.getBoundingClientRect();
    const savebar = document.querySelector(".role-permissions__savebar")?.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, overlap, trackSize: tracks.every((box) => box.width >= 48 && box.height >= 27), cardsHorizontal: cards.length === 3 && cards[1].left > cards[0].left && Math.abs(cards[1].top - cards[0].top) < 2, cardsVertical: cards.length === 3 && cards[1].top > cards[0].bottom, savebarClear: Boolean(lastGroup && savebar && lastGroup.bottom <= savebar.top + 1), savebarInViewport: Boolean(savebar && savebar.left >= 0 && savebar.right <= document.documentElement.clientWidth + 1) };
  });
  assert.equal(geometry.overflow, false, `no horizontal overflow at ${viewport.width}px`);
  assert.equal(geometry.overlap, false, `permission copy and controls do not overlap at ${viewport.width}px`);
  assert.equal(geometry.trackSize, true, `switch tracks retain usable geometry at ${viewport.width}px`);
  assert.equal(viewport.width <= 720 ? geometry.cardsVertical : geometry.cardsHorizontal, true, `role selector uses the intended layout at ${viewport.width}px`);
  assert.equal(geometry.savebarClear, true, `save bar does not cover the final capability group at ${viewport.width}px`);
  assert.equal(geometry.savebarInViewport, true, `save bar remains inside the viewport at ${viewport.width}px`);
}

async function fixture(route, role, denied, write) {
  const request = route.request(); const pathname = new URL(request.url()).pathname;
  if (pathname === "/api/auth/config") return json(route, { configured: true, emailSignupConfigured: true, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: "https://thirdrailify.com", adminOrigin: ORIGIN, environment: "test", cookieMode: "host-only" });
  if (pathname === "/api/auth/session") return json(route, session(role, denied));
  if (pathname === "/api/admin/role-permissions") {
    if (request.method() === "PUT") { const body = request.postDataJSON(); write(body.deniedCapabilities, "PUT"); return json(route, policy(role, body.deniedCapabilities)); }
    return json(route, policy(role, denied));
  }
  if (pathname === "/api/admin/role-permissions/reset") { write([], "POST"); return json(route, policy(role, [])); }
  if (pathname === "/api/admin/inbox/summary") return json(route, { ok: true, unread: 0, actionable: { goats: { submissions: 0, comments: 0, emailFailures: 0, total: 0 }, total: 0 }, latest: [] });
  if (pathname === "/api/admin/banner") return json(route, { ok: true, config: { normal: { enabled: false } }, revision: 1, updatedAt: "2026-08-31T00:00:00Z" });
  if (pathname === "/api/admin/goats/settings") return json(route, { ok: true, comments: "approval_required", reactions: "enabled" });
  if (pathname === "/api/admin/wheels/settings") return json(route, { ok: true, settings: {}, revision: 1, updatedAt: "2026-08-31T00:00:00Z" });
  if (pathname === "/api/admin/status") return json(route, { ok: true, checkedAt: "2026-08-31T00:00:00Z", configuration: { d1Configured: true, turnstileConfigured: true, resendConfigured: false, oauthProviders: [] }, accounts: { total: 0, regular: 0, admins: 0, disabled: 0, pending: 0 } });
  if (pathname === "/api/admin/accounts") return json(route, { ok: true, accounts: [], access: { isAdmin: true, isMasterAdmin: role === "master" }, checkedAt: "2026-08-31T00:00:00Z" });
  return json(route, { ok: false, error: "fixture_unavailable", message: "Settings authority unavailable in this focused test." }, 503);
}

function session(role, denied = []) {
  const master = role === "master";
  const effective = master ? allIds : allIds.filter((id) => id !== "role_permissions.manage" && !denied.includes(id));
  return { ok: true, authenticated: true, csrfToken: "policy-csrf", access: { isAdmin: true, isMasterAdmin: master, capabilities: effective }, account: { id: role, email: `${role}@example.test`, displayName: master ? "Master Admin" : "Full Admin", username: null, avatarUrl: null, providers: ["email"], role: "admin", adminLevel: role, status: "active", emailVerified: true, createdAt: "2026-08-31T00:00:00Z", lastLoginAt: null, source: "test", locked: master } };
}

function policy(role, denied) {
  const master = role === "master";
  return { ok: true, targetRole: "full", access: session(role, denied).access, groups, deniedCapabilities: denied, restrictedCount: denied.length, canManage: master, checkedAt: "2026-08-31T00:00:00Z", capabilities: capabilities.map(([id, group, label]) => { const masterOnly = id === "role_permissions.manage"; const mutable = !id.startsWith("role_permissions."); const restricted = denied.includes(id); return { id, group, label, description: `${label} through server-owned authority.`, mutable, masterOnly, effective: !masterOnly && !restricted, state: masterOnly ? "master_only" : !mutable ? "required" : restricted ? "restricted" : "default" }; }) };
}

function json(route, body, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function waitForServer() { for (let attempt = 0; attempt < 80; attempt += 1) { try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Role-policy browser server did not start."); }
